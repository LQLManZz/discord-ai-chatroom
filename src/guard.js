// Keeps agents from clobbering each other's work:
//  - every task declares the files it may write ("ownership");
//  - tasks that could run in parallel but claim the same file are forced to run one after another;
//  - workspace snapshots before/after each task show which files really changed, so the engine can flag
//    out-of-scope edits and overwrites of a teammate's files for the Orchestrator to resolve;
//  - a task's declared files are backed up before it runs.
import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n.js';

const SKIP = new Set(['.git', 'node_modules', '.chatroom', '__pycache__', '.venv', 'venv', '.next', '.pytest_cache']);
const MAX_FILES = 20000;
const IS_WIN = process.platform === 'win32';

/** Comparison key for a workspace-relative path (case-insensitive on Windows). */
export const fileKey = (rel) => (IS_WIN ? rel.toLowerCase() : rel);

/** Normalise a path the Orchestrator wrote (absolute or relative, any slashes) to "dir/file" relative to cwd. */
export function relFile(cwd, f) {
  const s = String(f).trim().replace(/^["'`]|["'`]$/g, '');
  if (!s) return null;
  const rel = path.isAbsolute(s) ? path.relative(cwd, s) : path.normalize(s);
  if (!rel || rel.startsWith('..')) return null; // outside the workspace: not ours to guard
  return rel.replace(/\\/g, '/');
}

/** key -> { path, sig } for every file in the workspace (size + mtime is enough to see a change). */
export function snapshot(root) {
  const out = new Map();
  const stack = [''];
  while (stack.length && out.size < MAX_FILES) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(r); continue; }
      if (!e.isFile()) continue;
      try {
        const s = fs.statSync(path.join(root, r));
        out.set(fileKey(r), { path: r, sig: `${s.size}:${s.mtimeMs}`, mtime: s.mtimeMs });
      } catch { /* deleted mid-walk */ }
    }
  }
  return out;
}

/** Files created, modified or deleted between two snapshots. */
export function changes(before, after) {
  const list = [];
  for (const [k, v] of after) {
    const old = before.get(k);
    if (!old) list.push({ key: k, path: v.path, kind: 'created', sig: v.sig, mtime: v.mtime });
    else if (old.sig !== v.sig) list.push({ key: k, path: v.path, kind: 'modified', sig: v.sig, mtime: v.mtime });
  }
  for (const [k, v] of before) if (!after.has(k)) list.push({ key: k, path: v.path, kind: 'deleted', sig: 'deleted' });
  return list;
}

/**
 * Tasks that could run at the same time but claim the same file get an "after" edge (run later, but unlike
 * depends_on it does not skip the task when the earlier one fails). Returns human-readable notes.
 */
export function serializeSharedFiles(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const reaches = (a, b, seen = new Set()) => {
    if (a === b) return true;
    if (seen.has(a)) return false;
    seen.add(a);
    const node = byId.get(a);
    return [...(node?.depends_on || []), ...(node?.after || [])].some((d) => reaches(d, b, seen));
  };
  const notes = [];
  for (let j = 0; j < tasks.length; j++) {
    for (let i = 0; i < j; i++) {
      const mine = new Set(tasks[j].files.map(fileKey));
      const shared = tasks[i].files.filter((f) => mine.has(fileKey(f)));
      if (!shared.length || reaches(tasks[i].id, tasks[j].id) || reaches(tasks[j].id, tasks[i].id)) continue;
      tasks[j].after.push(tasks[i].id);
      notes.push(t('plan.serialized', { a: tasks[j].id, b: tasks[i].id, files: shared.join(', ') }));
    }
  }
  return notes;
}

/** Copy the task's existing declared files to <jobDir>/backup/<taskId>/ so an overwrite can be undone. */
export function backupFiles(cwd, jobDir, task) {
  for (const f of task.files) {
    const src = path.join(cwd, f);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const dst = path.join(jobDir, 'backup', task.id, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/**
 * Attribute the files that changed while `task` ran.
 *   owners:  fileKey -> Set of taskIds that declared the file this round (several when serialized)
 *   ledger:  fileKey -> { path, taskId, agent, round } of who last wrote each file (whole job)
 *   windows: taskId -> { start, end } run windows, used to tell which teammates were running at the time
 * Returns { mine: [paths], issues: [{ kind, file, owner?, suspects }] } and updates the ledger for `mine`.
 */
export function attribute({ task, changed, owners, ledger, windows, round, reported }) {
  const w = windows[task.id];
  const overlapping = Object.entries(windows)
    .filter(([, o]) => o.start < w.end && (o.end ?? Infinity) > w.start)
    .map(([id]) => id);
  const mine = [];
  const issues = [];
  for (const c of changed) {
    const declared = owners.get(c.key) || new Set();
    if (declared.has(task.id)) {
      mine.push(c.path);
      ledger[c.key] = { path: c.path, taskId: task.id, agent: task.agent, round };
      continue;
    }
    if ([...declared].some((o) => overlapping.includes(o))) continue; // an owner was running too; it accounts for its own file
    // Narrow the suspects to tasks that were running when the file was last written (mtime), with 250ms slack (NTFS/ext4 mtimes are precise)
    const atWrite = c.mtime ? overlapping.filter((id) => windows[id].start - 250 <= c.mtime && c.mtime <= (windows[id].end ?? Infinity) + 250) : [];
    const suspects = atWrite.length ? atWrite : overlapping;
    const owner = [...declared].join('/');
    const tag = `${c.key}@${c.sig}`;
    if (reported.has(tag)) continue; // a parallel task already reported this exact change
    reported.add(tag);
    const prev = ledger[c.key];
    if (owner) issues.push({ kind: 'foreign_owner', file: c.path, owner, suspects });
    else if (prev && prev.taskId !== task.id) issues.push({ kind: 'overwrote_earlier', file: c.path, owner: prev.taskId, suspects });
    else issues.push({ kind: 'undeclared', file: c.path, suspects });
    if (suspects.length === 1) {
      const only = suspects[0];
      ledger[c.key] = { path: c.path, taskId: only, agent: only === task.id ? task.agent : '?', round };
    }
  }
  return { mine, issues };
}

export function describeIssue(i) {
  const who = i.suspects.length === 1 ? i.suspects[0] : t('issue.oneOf', { list: i.suspects.join(', ') });
  const key = { foreign_owner: 'issue.foreign', overwrote_earlier: 'issue.overwrote' }[i.kind] || 'issue.undeclared';
  return t(key, { file: i.file, owner: i.owner, who });
}
