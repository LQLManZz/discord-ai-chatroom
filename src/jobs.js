// Job engine: plan -> (user approves) -> run tasks per dependency graph -> Orchestrator reviews -> repeat.
// Has no Discord knowledge; it talks to the UI through the `chat` object passed in.
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, workerKeys } from './agents.js';
import { runAgent } from './runner.js';
import { planPrompt, workerPrompt, reviewPrompt, extractJson, extractHandoff, tail } from './prompts.js';
import { getAutonomyForDir } from './autonomy.js';
import { quotaBlock, quotaError } from './quota.js';
import { t } from './i18n.js';
import {
  fileKey, relFile, snapshot, changes, serializeSharedFiles, backupFiles, attribute, describeIssue,
} from './guard.js';

const cfg = {
  cwd: path.resolve(process.env.WORKSPACE_DIR || 'workspace'),
  maxParallel: Number(process.env.MAX_PARALLEL || 3),
  timeoutMs: Number(process.env.TASK_TIMEOUT_MIN || 30) * 60_000,
  maxRounds: Number(process.env.MAX_ROUNDS || 3),
};
export const config = cfg;
fs.mkdirSync(cfg.cwd, { recursive: true });

export function setWorkspace(dir) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  cfg.cwd = resolved;
  return resolved;
}

export const jobs = new Map();
const newId = () => Date.now().toString(36).slice(-5);

/**
 * chat interface (implemented by index.js):
 *   say(job, agentKey|null, text)       -> post a message as that agent
 *   showPlan(job)                         -> show the plan + Approve/Reject buttons
 *   showReview(job, data)                 -> final report (optional)
 *   showFailure(job, text)                -> job failed (optional)
 *   update(job)                           -> job/task state changed, refresh dashboards (optional)
 */
export function createJob({ request, userId, chat, cwd, meta = {} }) {
  const id = newId();
  const targetCwd = path.resolve(cwd || cfg.cwd);
  const autonomy = getAutonomyForDir(targetCwd);
  const job = {
    id, request, userId, meta, chat,
    cwd: targetCwd,
    autonomy,
    dir: path.join(targetCwd, '.chatroom', 'jobs', id),
    status: 'planning', round: 1,
    plan: null, results: {}, running: new Set(), history: [],
    taskState: {}, // taskId -> { status: queued|running|done|failed|skipped, startedAt, ms }
    createdAt: Date.now(), updatedAt: Date.now(),
    // Coordination state (see guard.js): who last wrote each file, what workers told the Orchestrator,
    // detected file conflicts, task run windows and the files each task actually changed.
    ledger: {}, board: [], issues: [], windows: {}, changedByTask: {}, reported: new Set(),
  };
  fs.mkdirSync(job.dir, { recursive: true });
  jobs.set(id, job);
  return job;
}

/** Everything needed to rebuild the job after a bot restart (live objects like `chat` and processes are left out). */
function persistJob(job) {
  const { chat, running, reported, history, meta, ...data } = job;
  const state = {
    ...data,
    history: history.map((h) => ({ round: h.round, plan: h.plan })),
    // full stderr is already in <task>.stderr.log; keep only the end (where the error is)
    results: Object.fromEntries(Object.entries(data.results).map(([k, r]) => [k, { ...r, stderr: (r.stderr || '').slice(-2000) }])),
    meta: { threadId: meta.threadId, channelId: meta.channelId, cardId: meta.cardId, approvalRefs: meta.approvalRefs },
  };
  try { fs.writeFileSync(path.join(job.dir, 'state.json'), JSON.stringify(state)); } catch (e) { console.error('persist job:', e.message); }
}

const touch = (job) => { job.updatedAt = Date.now(); persistJob(job); job.chat.update?.(job); };

/**
 * Reload jobs saved in <dir>/.chatroom/jobs/* (see persistJob). A job that was mid-flight when the bot died is put
 * back to "awaiting_approval": approving it again resumes from the tasks that hadn't succeeded yet.
 * Returns the jobs that were interrupted.
 */
export function restoreJobs(dirs, chat) {
  const interrupted = [];
  for (const d of dirs) {
    const root = path.join(d, '.chatroom', 'jobs');
    let ids = [];
    try { ids = fs.readdirSync(root); } catch { continue; }
    for (const id of ids) {
      let state;
      try { state = JSON.parse(fs.readFileSync(path.join(root, id, 'state.json'), 'utf8')); } catch { continue; }
      if (jobs.has(state.id)) continue;
      const job = { ...state, chat, running: new Set(), reported: new Set(), history: state.history.map((h) => ({ ...h, results: state.results })) };
      if (['planning', 'running', 'reviewing'].includes(job.status)) {
        for (const [tid, s] of Object.entries(job.taskState)) if (s.status === 'running') job.taskState[tid] = { status: 'failed' };
        job.interruptedFrom = job.status;
        job.status = job.plan?.tasks?.length ? 'awaiting_approval' : 'failed';
        interrupted.push(job);
      }
      jobs.set(job.id, job);
      if (job.status === 'paused') scheduleResume(job); // waiting for a quota reset: keep waiting, no approval needed
    }
  }
  return interrupted;
}
const setStatus = (job, status) => { job.status = status; job.statusAt = Date.now(); touch(job); };
const setTask = (job, id, patch) => { job.taskState[id] = { ...job.taskState[id], ...patch }; touch(job); };

// ---------- Quota pauses: an agent out of quota pauses the job instead of failing it ----------

const RECHECK_MS = 15 * 60_000; // when the reset time is unknown (e.g. a prepaid balance at 0)
const LEARNED_BLOCK_MS = 30 * 60_000; // a CLI said "limit reached" but neither it nor onWatch says until when
const MAX_TIMER_MS = 6 * 3600_000; // long waits are split, so a wrong reset time never strands a job
// Wait this long past the reset so the provider (and onWatch's next poll) have caught up
const RESUME_GRACE_MS = Number(process.env.QUOTA_RESUME_GRACE_MS ?? 60_000);

/** agentKey -> { until, reason } learned from quota errors; onWatch data is checked on top of this. */
export const agentBlocks = new Map();

class QuotaPause extends Error {
  constructor(agent, block) { super(`${agent} out of quota`); this.agent = agent; this.block = block; }
}

/** Why this agent can't take work right now ({ until, reason }), or null. */
export function agentBlock(agentKey) {
  const learned = agentBlocks.get(agentKey);
  if (learned && learned.until > Date.now()) return learned;
  agentBlocks.delete(agentKey);
  return quotaBlock(agentKey);
}

function learnBlock(agentKey, info) {
  const onwatch = quotaBlock(agentKey);
  const block = {
    until: info.until || onwatch?.until || Date.now() + LEARNED_BLOCK_MS,
    reason: onwatch?.reason || t('eng.cliQuota'),
  };
  agentBlocks.set(agentKey, block);
  return block;
}

const timers = new Map(); // jobId -> resume timer

async function pause(job, stage, blocks) {
  job.resumeStage = stage; // plan | execute | review
  const untils = blocks.map((b) => b.block.until).filter(Boolean);
  job.pausedUntil = untils.length ? Math.min(...untils) : null;
  job.pauseReason = blocks.map((b) => `${AGENTS[b.agent]?.name || b.agent}: ${b.block.reason}`).join(' · ');
  setStatus(job, 'paused');
  scheduleResume(job);
  if (job.chat.showPaused) await job.chat.showPaused(job);
  else await job.chat.say(job, null, t('eng.pausedShort', { reason: job.pauseReason }));
}

export function scheduleResume(job) {
  clearTimeout(timers.get(job.id));
  const wait = job.pausedUntil ? Math.max(job.pausedUntil - Date.now(), 0) + RESUME_GRACE_MS : RECHECK_MS;
  const timer = setTimeout(() => resume(job).catch((e) => fail(job, t('eng.resumeFailed', { msg: e.message }))), Math.min(wait, MAX_TIMER_MS));
  timer.unref?.();
  timers.set(job.id, timer);
}

/** Continue a paused job from where it stopped. force = try now even if quota still looks empty. */
export async function resume(job, { force = false } = {}) {
  clearTimeout(timers.get(job.id));
  timers.delete(job.id);
  if (job.status !== 'paused') return false;
  const stage = job.resumeStage;
  const agents = stage === 'execute'
    ? [...new Set(job.plan.tasks.filter((t) => !job.results[t.id]?.ok).map((t) => t.agent))]
    : ['orchestrator'];
  const blocked = agents.map((a) => ({ agent: a, block: agentBlock(a) })).filter((b) => b.block);
  if (force) for (const a of agents) agentBlocks.delete(a);
  else if (blocked.length === agents.length) { // nothing can move yet: wait for the earliest reset
    const untils = blocked.map((b) => b.block.until).filter(Boolean);
    job.pausedUntil = untils.length ? Math.min(...untils) : null;
    touch(job);
    scheduleResume(job);
    return false;
  }
  job.pausedUntil = null;
  job.pauseReason = '';
  await job.chat.say(job, null, t('eng.resumed', { stage }));
  if (stage === 'plan') plan(job, { feedback: job.pendingFeedback });
  else if (stage === 'review') review(job);
  else {
    setStatus(job, 'running');
    execute(job).catch((e) => fail(job, t('eng.jobError', { msg: e.message })));
  }
  return true;
}

async function fail(job, text) {
  setStatus(job, 'failed');
  if (job.chat.showFailure) await job.chat.showFailure(job, text);
  else await job.chat.say(job, null, text);
}

const save = (job, name, text) => {
  const file = path.join(job.dir, name);
  fs.writeFileSync(file, text);
  return file;
};

/** Call the Orchestrator (read-only); retry once if the JSON is malformed. */
async function askOrchestrator(job, prompt) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const block = agentBlock('orchestrator');
    if (block) throw new QuotaPause('orchestrator', block);
    const p = attempt === 1 ? prompt : `${prompt}\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON (${lastErr}). Reply with ONLY one JSON block.`;
    const run = runAgent(AGENTS.orchestrator, p, { cwd: job.cwd, readOnly: true, timeoutMs: cfg.timeoutMs });
    job.running.add(run);
    const res = await run.finally(() => job.running.delete(run));
    if (job.status === 'cancelled') throw new Error('cancelled');
    if (!res.ok) {
      const q = quotaError(`${res.stderr}\n${res.text}`);
      if (q) throw new QuotaPause('orchestrator', learnBlock('orchestrator', q));
      lastErr = res.stderr || `exit ${res.code}`;
      continue;
    }
    try { return extractJson(res.text); } catch (e) { lastErr = e.message; }
  }
  throw new Error(`Orchestrator failed: ${String(lastErr).slice(0, 500)}`);
}

/** Validate & normalise tasks returned by the Orchestrator. */
function normaliseTasks(tasks, round, earlierIds = [], cwd = cfg.cwd) {
  const workers = workerKeys();
  const fallback = workers.includes('sonnet') ? 'sonnet' : workers[0] || 'sonnet'; // for an agent key that doesn't exist
  const earlier = new Set(earlierIds);
  const seen = new Set();
  const list = (Array.isArray(tasks) ? tasks : []).map((t, i) => {
    let id = String(t.id || `T${i + 1}`).replace(/\s+/g, '');
    if (round > 1 && !id.startsWith('R')) id = `R${round}-${id}`;
    while (seen.has(id) || earlier.has(id)) id += "'";
    seen.add(id);
    const agent = workers.includes(t.agent) ? t.agent : fallback;
    return {
      id, agent,
      title: String(t.title || id).slice(0, 200),
      complexity: ['low', 'medium', 'high'].includes(String(t.complexity).toLowerCase()) ? String(t.complexity).toLowerCase() : 'medium',
      expected_output: String(t.expected_output || ''),
      instructions: String(t.instructions || t.title || ''),
      depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(String) : [],
      files: [...new Set((Array.isArray(t.files) ? t.files : []).map((f) => relFile(cwd, f)).filter(Boolean))],
      after: [], // ordering-only edges added by serializeSharedFiles
      reassigned: agent !== t.agent ? t.agent : undefined,
    };
  });
  // Rewrite depends_on to the normalised ids; drop dependencies that don't exist (earlier-round ids are allowed)
  const idMap = new Map((Array.isArray(tasks) ? tasks : []).map((t, i) => [String(t.id || `T${i + 1}`).replace(/\s+/g, ''), list[i].id]));
  for (const t of list) {
    t.depends_on = t.depends_on.map((d) => idMap.get(d) || d).filter((d) => (seen.has(d) || earlier.has(d)) && d !== t.id);
  }
  return list;
}

/** Turn the Orchestrator's JSON into the round's plan: normalised tasks, file ownership, conflict-free ordering. */
function buildPlan(job, data) {
  const tasks = normaliseTasks(data.tasks, job.round, Object.keys(job.results), job.cwd);
  job.plan = {
    summary: String(data.summary || ''),
    deliverables: Array.isArray(data.deliverables) ? data.deliverables.map(String) : [],
    architecture: String(data.architecture || ''),
    // A follow-up round keeps the previous contract unless the Orchestrator rewrites it
    shared_contract: String(data.shared_contract || job.plan?.shared_contract || ''),
    tasks,
    serialized: serializeSharedFiles(tasks),
    undeclared: tasks.filter((t) => !t.files.length).map((t) => t.id),
  };
  save(job, `plan-r${job.round}.json`, JSON.stringify(job.plan, null, 2));
  if (job.plan.shared_contract) save(job, 'CONTRACT.md', job.plan.shared_contract);
  for (const t of tasks) job.taskState[t.id] = { status: 'queued' };
}

export async function plan(job, { feedback } = {}) {
  setStatus(job, 'planning');
  await job.chat.say(job, 'orchestrator', t(feedback ? 'eng.revising' : 'eng.planning'));
  try {
    const previousPlan = feedback ? job.plan : null;
    const data = await askOrchestrator(job, planPrompt({ request: job.request, cwd: job.cwd, feedback, previousPlan }));
    buildPlan(job, data);
    if (job.plan.tasks.length === 0) {
      // A plain question: the summary is the answer, deliver it like a final report
      setStatus(job, 'done');
      const answer = job.plan.summary || t('eng.noWork');
      if (job.chat.showReview) await job.chat.showReview(job, { status: 'done', summary: answer });
      else await job.chat.say(job, 'orchestrator', answer);
      return;
    }
    setStatus(job, 'awaiting_approval');
    await job.chat.showPlan(job);
  } catch (e) {
    if (job.status === 'cancelled') return;
    if (e instanceof QuotaPause) {
      job.pendingFeedback = feedback;
      return pause(job, 'plan', [{ agent: e.agent, block: e.block }]);
    }
    await fail(job, t('eng.planFailed', { msg: e.message }));
  }
}

export async function approve(job) {
  if (job.status !== 'awaiting_approval') return false;
  setStatus(job, 'running');
  execute(job).catch((e) => fail(job, t('eng.jobError', { msg: e.message })));
  return true;
}

export async function cancel(job) {
  clearTimeout(timers.get(job.id));
  setStatus(job, 'cancelled');
  for (const r of job.running) r.cancel?.();
  job.running.clear();
}

async function runTask(job, task) {
  const handoffs = task.depends_on.map((d) => {
    const t = [job.plan, ...job.history.map((h) => h.plan)].flatMap((p) => p.tasks).find((x) => x.id === d);
    const r = job.results[d];
    return { id: d, title: t?.title, agent: t?.agent, ok: r?.ok, text: r?.text || r?.stderr || '', file: r?.file, handoff: r?.handoff };
  });
  // What this worker is told about the rest of the team (all relayed by the engine on the Orchestrator's plan)
  const running = job.plan.tasks.filter((t) => t.id !== task.id && job.taskState[t.id]?.status === 'running');
  const ctx = {
    files: task.files,
    history: task.files.map((f) => job.ledger[fileKey(f)]).filter((h) => h && h.taskId !== task.id),
    parallel: running.map((t) => ({ id: t.id, agent: t.agent, title: t.title, files: t.files })),
    board: job.board.filter((b) => b.kind === 'note').slice(-15),
  };

  backupFiles(job.cwd, job.dir, task);
  const before = snapshot(job.cwd);
  job.windows[task.id] = { start: Date.now() };
  setTask(job, task.id, { status: 'running', startedAt: Date.now() });
  await job.chat.say(job, task.agent, `${t('eng.pickup', { id: task.id, title: task.title })}${handoffs.length ? t('eng.handoffFrom', { list: task.depends_on.join(', ') }) : ''}${task.files.length ? `\n📂 ${task.files.map((f) => `\`${f}\``).join(', ')}` : ''}`);

  const run = runAgent(AGENTS[task.agent], workerPrompt({ agentKey: task.agent, task, job, handoffs, ctx }), {
    cwd: job.cwd, autonomy: job.autonomy, timeoutMs: cfg.timeoutMs,
  });
  job.running.add(run);
  const res = await run.finally(() => job.running.delete(run));
  job.windows[task.id].end = Date.now();
  if (job.status === 'cancelled') return;

  // Who really changed what: flag edits outside the task's files and overwrites of teammates' work
  const owners = new Map();
  for (const t of job.plan.tasks) for (const f of t.files) owners.set(fileKey(f), (owners.get(fileKey(f)) || new Set()).add(t.id));
  const { mine, issues } = attribute({
    task, changed: changes(before, snapshot(job.cwd)), owners, ledger: job.ledger, windows: job.windows, round: job.round, reported: job.reported,
  });
  job.changedByTask[task.id] = mine;
  for (const i of issues) job.issues.push({ round: job.round, taskId: task.id, ...i, text: describeIssue(i) });
  save(job, 'ledger.json', JSON.stringify(job.ledger, null, 2));

  // Out of quota is not a failure: keep the task queued and let execute() pause the job until the reset
  const quota = !res.ok && quotaError(`${res.stderr}\n${res.text}`);
  if (quota) {
    const block = learnBlock(task.agent, quota);
    setTask(job, task.id, { status: 'waiting', until: block.until });
    if (res.stderr) save(job, `${task.id}-${task.agent}.quota.log`, res.stderr);
    await job.chat.say(job, task.agent, t('eng.quotaTask', { id: task.id, title: task.title, agent: AGENTS[task.agent].name, reason: block.reason, when: block.until ? `<t:${Math.floor(block.until / 1000)}:R>` : t('eng.quotaWhenBack') }));
    return 'quota';
  }

  const { handoff, report } = extractHandoff(res.text);
  for (const [kind, items] of Object.entries({
    note: handoff?.notes_for_team ? [handoff.notes_for_team] : [],
    request: handoff?.requests || [], question: handoff?.questions || [], blocker: handoff?.blockers || [],
  })) {
    for (const text of items) job.board.push({ round: job.round, from: `${task.id} (${task.agent})`, kind, text });
  }

  // stderr goes to its own file: codex prints its whole transcript there (100KB+) and the error is at the end
  const reportFile = save(job, `${task.id}-${task.agent}.md`, `# [${task.id}] ${task.title}\nAgent: ${task.agent}\nStatus: ${res.ok ? 'done' : 'FAILED'}\n\n${res.text || tail(res.stderr, 8000) || '(no output)'}`);
  if (res.stderr) save(job, `${task.id}-${task.agent}.stderr.log`, res.stderr);
  job.results[task.id] = { ok: res.ok, text: res.text, stderr: res.stderr, file: reportFile, handoff };
  setTask(job, task.id, { status: res.ok ? 'done' : 'failed', ms: res.ms });

  const secs = Math.round(res.ms / 1000);
  const shown = res.ok ? report : (report || tail(res.stderr, 1500) || '(no output)');
  const asks = [...(handoff?.requests || []).map((r) => `📨 ${r}`), ...(handoff?.questions || []).map((q) => `❓ ${q}`), ...(handoff?.blockers || []).map((b) => `⛔ ${b}`)];
  await job.chat.say(job, task.agent, `${res.ok ? '✅' : '❌'} **[${task.id}] ${task.title}** — ${secs}s\n\n${shown}${asks.length ? `\n\n${t('eng.toOrchestrator')}\n${asks.join('\n')}` : ''}`);
  if (issues.length) {
    await job.chat.say(job, null, t('eng.conflicts', { id: task.id, job: job.id, list: issues.map((i) => `• ${describeIssue(i)}`).join('\n') }));
  }
}

/** Run tasks by dependency graph, at most maxParallel at a time. */
async function execute(job) {
  // Tasks that already succeeded (e.g. before a bot restart) are not run again
  const pending = new Map(job.plan.tasks.filter((t) => !job.results[t.id]?.ok).map((t) => [t.id, t]));
  for (const t of pending.values()) delete job.results[t.id]; // forget failed/skipped attempts being re-run
  const active = new Map();

  while ((pending.size || active.size) && job.status === 'running') {
    // Skip tasks whose dependency failed
    for (const task of [...pending.values()]) {
      const failedDep = task.depends_on.find((d) => job.results[d] && !job.results[d].ok);
      if (failedDep) {
        pending.delete(task.id);
        job.results[task.id] = { ok: false, skipped: true, text: '', stderr: `Skipped because ${failedDep} failed` };
        setTask(job, task.id, { status: 'skipped' });
        await job.chat.say(job, null, t('eng.skip', { id: task.id, dep: failedDep }));
      }
    }
    // Start tasks that are ready
    for (const t of [...pending.values()]) {
      if (active.size >= cfg.maxParallel) break;
      // depends_on: needs the result; after: only waits (shared files), whatever the outcome
      if (t.depends_on.every((d) => job.results[d]?.ok) && t.after.every((d) => job.results[d])) {
        const block = agentBlock(t.agent);
        if (block) { // its agent is out of quota: leave it queued, other agents keep working
          if (job.taskState[t.id]?.status !== 'waiting') setTask(job, t.id, { status: 'waiting', until: block.until });
          continue;
        }
        pending.delete(t.id);
        active.set(t.id, runTask(job, t).then((out) => { if (out === 'quota') pending.set(t.id, t); }).catch((e) => {
          job.results[t.id] = { ok: false, text: '', stderr: e.message };
          setTask(job, t.id, { status: 'failed' });
        }).finally(() => active.delete(t.id)));
      }
    }
    if (!active.size) {
      if (pending.size) {
        // Everything left is waiting (directly or through a dependency) on an agent without quota: pause, resume later
        const blocked = [...new Set([...pending.values()].map((t) => t.agent))]
          .map((agent) => ({ agent, block: agentBlock(agent) }))
          .filter((b) => b.block);
        if (blocked.length) return pause(job, 'execute', blocked);
        await job.chat.say(job, null, t('eng.cycle', { list: [...pending.keys()].join(', ') }));
        pending.clear();
      }
      break;
    }
    await Promise.race(active.values());
  }
  if (job.status !== 'running') return;
  await review(job);
}

async function review(job) {
  setStatus(job, 'reviewing');
  await job.chat.say(job, 'orchestrator', t('eng.reviewing', { round: job.round }));
  try {
    const extra = {
      changedByTask: job.changedByTask,
      issues: job.issues.filter((i) => i.round === job.round).map((i) => i.text),
      board: job.board.filter((b) => b.round === job.round),
    };
    const data = await askOrchestrator(job, reviewPrompt({ job, round: job.round, maxRounds: cfg.maxRounds, extra }));
    job.history.push({ round: job.round, plan: job.plan, results: job.results });
    if (data.status === 'continue' && job.round < cfg.maxRounds && Array.isArray(data.tasks) && data.tasks.length) {
      job.round += 1;
      buildPlan(job, data); // earlier results stay in job.results so new tasks can depend on them
      setStatus(job, 'awaiting_approval');
      await job.chat.showPlan(job);
    } else {
      setStatus(job, 'done');
      save(job, 'summary.md', String(data.summary || ''));
      save(job, 'review.json', JSON.stringify(data, null, 2));
      if (job.chat.showReview) {
        await job.chat.showReview(job, data);
      } else {
        await job.chat.say(job, 'orchestrator', t('eng.finished', { id: job.id, summary: data.summary || '' }));
      }
    }
  } catch (e) {
    if (job.status === 'cancelled') return;
    if (e instanceof QuotaPause) return pause(job, 'review', [{ agent: e.agent, block: e.block }]);
    await fail(job, t('eng.reviewFailed', { msg: e.message }));
  }
}

/** Ask one agent directly (outside the plan flow). */
export function askDirect(agentKey, prompt, customCwd) {
  const targetCwd = path.resolve(customCwd || cfg.cwd);
  const autonomy = getAutonomyForDir(targetCwd);
  return runAgent(AGENTS[agentKey], prompt, { cwd: targetCwd, autonomy, timeoutMs: cfg.timeoutMs });
}
