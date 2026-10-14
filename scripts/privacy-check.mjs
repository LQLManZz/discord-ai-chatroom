// Blocks commits/pushes that would publish secrets or personal data.
//   node scripts/privacy-check.mjs --staged   lines added in the staged diff (pre-commit hook)
//   node scripts/privacy-check.mjs --all      every tracked file (pre-push hook, `npm run privacy`)
//   node scripts/privacy-check.mjs --install  point git at .githooks/ (run by `npm install`)
// What counts as personal is learned from this machine, never stored in the repo: values in .env, your home
// folder, your git email, the workspace folders in .chatroom/hub.json, and any extra terms in .privacy-blocklist.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (process.argv.includes('--install')) {
  try { git('rev-parse', '--git-dir'); } catch { process.exit(0); } // not a git checkout (e.g. a tarball): nothing to do
  git('config', 'core.hooksPath', '.githooks');
  console.log('privacy hooks installed (.githooks)');
  process.exit(0);
}

// Files that must never be committed, whatever they contain
const FORBIDDEN_PATHS = [
  [/(^|\/)\.env(?!\.example$)(\..*)?$/, 'local .env (secrets and personal settings)'],
  [/(^|\/)\.chatroom\//, 'bot state (.chatroom: channel ids, job logs)'],
  [/^workspace\//, 'agent workspace'],
  [/(^|\/)\.privacy-blocklist$/, 'your private blocklist'],
  [/\.(log|pem|key|p12|pfx|sqlite|db)$/i, 'log / key / database file'],
  [/(^|\/)\.claude\/settings\.local\.json$/, 'local Claude Code settings'],
];

const SECRET_PATTERNS = [
  [/[MN][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/, 'Discord bot token'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key (OpenAI/DeepSeek style)'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/, 'Discord webhook URL'],
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Personal terms of the person running this check. */
function personalTerms() {
  const terms = new Map(); // term -> reason
  const add = (v, why) => { if (v && String(v).trim().length >= 4) terms.set(String(v).trim(), why); };

  const parseEnv = (file) => (fs.existsSync(file) ? Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')])) : {});
  const env = parseEnv(path.join(ROOT, '.env'));
  const defaults = new Set(Object.values(parseEnv(path.join(ROOT, '.env.example'))));
  for (const [k, v] of Object.entries(env)) {
    if (!v || defaults.has(v)) continue; // a value identical to the shipped default is not personal
    if (/^\d{17,20}(,\s*\d{17,20})*$/.test(v)) v.split(',').forEach((id) => add(id, `${k} (Discord id) from .env`));
    else if (v.length >= 6 && !/^(true|false|safe|full|en|vi|English|Vietnamese|\d+)$/i.test(v)) add(v, `${k} from .env`);
  }

  const home = os.homedir();
  add(home, 'your home folder path');
  add(home.replace(/\\/g, '/'), 'your home folder path');
  add(home.replace(/\\/g, '\\\\'), 'your home folder path (escaped)');
  try { add(git('config', '--global', 'user.email').trim(), 'your git email'); } catch { /* none */ }

  // Workspace folders you registered in Discord are personal project names/paths
  try {
    const hub = JSON.parse(fs.readFileSync(path.join(ROOT, '.chatroom', 'hub.json'), 'utf8'));
    for (const w of Object.values(hub.workspaces || {})) {
      const same = (x, y) => path.relative(x, y) === '' || (process.platform === 'win32' && x.toLowerCase() === y.toLowerCase());
      if (same(path.resolve(w.path), path.resolve(ROOT, 'workspace'))) continue; // the shipped default, not personal
      add(w.path, 'one of your workspace folders');
      const base = path.basename(w.path).replace(/^\./, '');
      if (base.length >= 4) add(base, 'one of your workspace folder names');
    }
    for (const id of [hub.hqId, hub.monCatId, hub.wsCatId, hub.reportsId, hub.dashboardId]) add(id, 'a channel id of your server');
  } catch { /* bot never ran here */ }

  const extra = path.join(ROOT, '.privacy-blocklist');
  if (fs.existsSync(extra)) {
    for (const l of fs.readFileSync(extra, 'utf8').split(/\r?\n/)) if (l.trim() && !l.startsWith('#')) add(l, '.privacy-blocklist');
  }
  // whole-word match, so a short folder name like "arin" doesn't fire inside "sharing"
  return [...terms].map(([term, why]) => [new RegExp(`(?<![A-Za-z0-9])${escape(term)}(?![A-Za-z0-9])`, 'i'), why]);
}

/** [{ file, line, text }] to inspect */
function targets(mode) {
  const out = [];
  if (mode === 'all') {
    for (const file of git('ls-files', '-z').split('\0').filter(Boolean)) {
      out.push({ file, line: 0, text: null });
      let content = '';
      try { content = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue; // binary
      content.split(/\r?\n/).forEach((text, i) => out.push({ file, line: i + 1, text }));
    }
    return out;
  }
  for (const file of git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean)) {
    out.push({ file, line: 0, text: null });
  }
  let file = null;
  let line = 0;
  for (const l of git('diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR').split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(6); continue; }
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (l.startsWith('+')) out.push({ file, line: line++, text: l.slice(1) });
  }
  return out;
}

const SELF = 'scripts/privacy-check.mjs'; // contains the patterns themselves
const mode = process.argv.includes('--all') ? 'all' : 'staged';
const personal = personalTerms();
const problems = [];
const mask = (s) => (s.length <= 8 ? '****' : `${s.slice(0, 3)}…${s.slice(-3)}`);

for (const { file, line, text } of targets(mode)) {
  if (text === null) {
    for (const [re, why] of FORBIDDEN_PATHS) if (re.test(file)) problems.push(`${file}: ${why}`);
    continue;
  }
  if (file === SELF) continue;
  for (const [re, why] of [...SECRET_PATTERNS, ...personal]) {
    const m = text.match(re);
    if (m) problems.push(`${file}:${line}: ${why} ("${mask(m[0])}")`);
  }
}

if (problems.length) {
  console.error(`\n✋ privacy check (${mode}): ${problems.length} problem(s) — nothing personal or secret may reach the public repo.\n`);
  for (const p of [...new Set(problems)].slice(0, 50)) console.error(`  • ${p}`);
  console.error('\nMove the value to .env (git-ignored) or remove it, then try again.');
  console.error('A term that is not actually personal? Change it so it no longer matches, or drop it from .privacy-blocklist.\n');
  process.exit(1);
}
console.log(`privacy check (${mode}): clean (${personal.length} personal terms checked)`);
