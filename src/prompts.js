// Prompt templates for the Orchestrator (plan / review) and the workers.
// Static rules come first and per-job content last, so repeated calls share a cacheable prefix.
import { AGENTS, workerKeys } from './agents.js';
import { AGENT_LANGUAGE as LANG } from './i18n.js';
const MAX_HANDOFF_CHARS = 6000;

const roster = () =>
  workerKeys().map((k) => `- "${k}" (${AGENTS[k].name}): ${AGENTS[k].skills}`).join('\n');

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n...[truncated]` : s);
/** For logs/stderr the useful part (the error) is at the end. */
export const tail = (s, n) => (s.length > n ? `...[earlier output cut]\n${s.slice(-n)}` : s);

const TASK_SCHEMA = `{
      "id": "T1",
      "agent": "<one of the agent keys above>",
      "title": "Short title",
      "complexity": "low|medium|high",
      "files": ["relative/path/this/task/creates/or/edits.py"],
      "expected_output": "Concrete file or artifact this task produces",
      "instructions": "Detailed, self-contained instructions: goal, files involved, acceptance criteria",
      "depends_on": []
    }`;

const PLAN_SCHEMA = `\`\`\`json
{
  "summary": "Executive summary of the strategy and approach, written in ${LANG}",
  "deliverables": ["Key file or asset to produce (e.g. src/index.js, docs/api.md)"],
  "architecture": "Optional Mermaid diagram code (e.g. flowchart LR\\n  A --> B), or empty string",
  "shared_contract": "Everything two or more tasks must agree on: function signatures, data formats, file layout, naming, shared test vectors. Empty string if tasks are independent.",
  "tasks": [
    ${TASK_SCHEMA}
  ]
}
\`\`\``;

const COORDINATION_RULES = `Coordination rules (the engine enforces these):
- FILE OWNERSHIP: every task must list in "files" each file it will create or modify (paths relative to the workspace). A worker may only write its own files; it can read anything.
- Never give the same file to two tasks that can run at the same time. If you do, the engine forces them to run one after another (slower). Prefer splitting work by file.
- If a later task must change a file an earlier task wrote, give that file to the later task explicitly and tell it what to preserve.
- Put every interface/rule that several tasks depend on into "shared_contract", so parallel workers build compatible pieces without talking to each other.
- Workers talk to each other only through you: their reports carry notes, requests (changes needed outside their files), questions and blockers, which you resolve when reviewing.`;

const PLANNING_RULES = `Planning rules:
- Break the work into concrete tasks (usually 1-8). Each task must be self-contained: the worker ONLY sees its own task, the shared contract, and the handoffs of the tasks it depends_on.
- Pick the agent based on skills and cost: hand simple work to the cheaper/faster agents (haiku, deepseek-flash, gemini-flash), and save sonnet for hard work.
- Use depends_on when a task needs a teammate's results (handoff). Tasks with no dependency run IN PARALLEL.
- Do not add a separate "final review" task: you review every round yourself.
- Architecture: for multi-file work provide a clean Mermaid diagram in "architecture" (or empty string if simple).
- If the request is just a question that needs no code work: return "tasks": [] and put the answer in "summary".
${COORDINATION_RULES}
- Reply with ONLY a single JSON block in exactly this format:
${PLAN_SCHEMA}`;

export function planPrompt({ request, cwd, feedback, previousPlan }) {
  return `You are the ORCHESTRATOR (tech lead) of a team of AI agents working together in a Discord chatroom. You are the hub of the team: you plan, assign file ownership, relay information between workers, and resolve their conflicts.
You DO NOT write code. Your job is to understand the request, read the code in the workspace (read-only) when needed, then make a plan and assign the work.

Team (workers available):
${roster()}

${PLANNING_RULES}

=== THIS JOB ===
Workspace (the shared project folder): ${cwd}

USER REQUEST:
"""
${request}
"""
${previousPlan ? `\nYOUR PREVIOUS PLAN (rejected by the user):\n${JSON.stringify(previousPlan, null, 2)}\n` : ''}${feedback ? `\nUSER FEEDBACK ON THE PLAN:\n"""\n${feedback}\n"""\nRevise the plan to address this feedback.\n` : ''}`;
}

const HANDOFF_FORMAT = `\`\`\`json
{"handoff": {
  "summary": "one or two sentences: what you delivered",
  "files_changed": ["every file you created/modified/deleted"],
  "interfaces": "signatures, CLI usage, formats teammates must rely on (empty if none)",
  "notes_for_team": "anything teammates should know (empty if none)",
  "requests": ["a change needed in a file you do NOT own — describe it; the Orchestrator will assign it"],
  "questions": ["anything you had to assume or need the Orchestrator to decide"],
  "blockers": ["anything that stopped you from finishing"]
}}
\`\`\``;

const WORKER_RULES = `Rules:
- Do ONLY your task. Teammates work in the same folder, possibly at the same time.
- FILE OWNERSHIP: create or modify ONLY the files listed under "YOUR FILES". You may read any file. Never rewrite, reformat, delete or "fix" a file you do not own — even if it looks wrong. Put the needed change in "requests" instead; the Orchestrator will assign it.
- If a file you own was written earlier by a teammate (see FILE HISTORY), edit it in place and preserve its existing behaviour unless your instructions say otherwise. Do not regenerate it from scratch.
- Follow the SHARED CONTRACT exactly. If it is wrong or incomplete, follow it anyway where possible and raise it in "questions".
- If you generate any files (code, scripts, images, audio, data), state their paths.
- When done, reply with a short report in ${LANG} (at most ~250 words): what you did, how to verify it. Then END your reply with this JSON block (keys in English, values in ${LANG}):
${HANDOFF_FORMAT}`;

const handoffBlock = (h) => {
  const ho = h.handoff;
  if (!ho) return clip(h.ok ? h.text : tail(h.text, MAX_HANDOFF_CHARS), MAX_HANDOFF_CHARS);
  return [
    ho.summary && `Summary: ${ho.summary}`,
    ho.files_changed?.length && `Files: ${ho.files_changed.join(', ')}`,
    ho.interfaces && `Interfaces:\n${ho.interfaces}`,
    ho.notes_for_team && `Notes: ${ho.notes_for_team}`,
  ].filter(Boolean).join('\n');
};

/**
 * ctx: { files, history: [{path, taskId, agent}], parallel: [{id, agent, title, files}], board: [{from, kind, text}] }
 */
export function workerPrompt({ agentKey, task, job, handoffs, ctx }) {
  const a = AGENTS[agentKey];
  const handoffText = handoffs.length
    ? handoffs.map((h) => `--- [${h.id}] "${h.title}" — by ${h.agent} (${h.ok ? 'done' : 'FAILED'}) ---\n${handoffBlock(h)}\n(Full report: ${h.file})`).join('\n\n')
    : '(none — this task has no dependencies)';
  const files = ctx.files.length
    ? ctx.files.map((f) => `- ${f}`).join('\n')
    : '(none declared — keep edits minimal and list every file you touch in files_changed)';
  const history = ctx.history.length
    ? ctx.history.map((h) => `- ${h.path}: written by ${h.taskId} (${h.agent})`).join('\n')
    : '(all your files are new)';
  const parallel = ctx.parallel.length
    ? ctx.parallel.map((p) => `- [${p.id}] ${p.agent}: ${p.title} — owns: ${p.files.join(', ') || '(undeclared)'}`).join('\n')
    : '(nobody else is working right now)';
  const board = ctx.board.length
    ? ctx.board.map((b) => `- ${b.from} [${b.kind}]: ${b.text}`).join('\n')
    : '(empty)';

  return `You are ${a.name}, a worker agent on a multi-agent team. The Orchestrator (Claude Opus) is the hub of the team: it assigned you this task, decides who owns which file, and relays information between workers.

${WORKER_RULES}

=== JOB ===
Working directory (shared with the team): ${job.cwd}
Overall project goal (from the user): ${job.request}
Orchestrator's approach: ${job.plan.summary}

=== SHARED CONTRACT (all tasks follow this) ===
${job.plan.shared_contract || '(none)'}

=== YOUR TASK [${task.id}] ${task.title} ===
Expected output: ${task.expected_output || 'Implementation'}
${task.instructions}

=== YOUR FILES (only you may write these) ===
${files}

=== FILE HISTORY (your files that already exist) ===
${history}

=== TEAMMATES WORKING IN PARALLEL (do not touch their files) ===
${parallel}

=== HANDOFF FROM TEAMMATES YOU DEPEND ON ===
${handoffText}

=== TEAM BOARD (notes relayed by the Orchestrator) ===
${board}`;
}

const REVIEW_SCHEMA = `\`\`\`json
{
  "status": "done",
  "summary": "Executive summary of the completed project, written in ${LANG}",
  "deliverables": [
    { "file": "path/to/file", "description": "Short explanation of what it does" }
  ],
  "verification": "Shell command or steps to run/test the deliverables (e.g. npm test or python app.py)",
  "media_files": ["any generated images, charts, audio, or output artifacts"],
  "next_steps": ["Suggestions or next phase ideas"]
}
\`\`\`
Or if work is incomplete/broken, or a conflict/request below needs work:
\`\`\`json
{
  "status": "continue",
  "summary": "Why another round is needed and how each conflict/request is resolved, in ${LANG}",
  "shared_contract": "Updated contract for the next round (repeat the current one if unchanged)",
  "tasks": [
    ${TASK_SCHEMA}
  ]
}
\`\`\``;

/** extra: { changedByTask: {id: [paths]}, issues: [string], board: [{from, kind, text}] } */
export function reviewPrompt({ job, round, maxRounds, extra }) {
  const results = job.plan.tasks
    .map((t) => {
      const r = job.results[t.id];
      const body = !r ? '(not run because a dependency failed)' : r.ok ? clip(r.text, 4000) : tail(r.text || r.stderr, 4000);
      const actual = extra.changedByTask[t.id];
      return `--- [${t.id}] ${t.title} — ${t.agent} — ${r ? (r.ok ? 'DONE' : r.skipped ? 'SKIPPED' : 'FAILED') : 'SKIPPED'} ---
Owned files: ${t.files.join(', ') || '(undeclared)'}
Files it actually changed (measured by the engine): ${actual?.length ? actual.join(', ') : '(none)'}
${body}${r?.file ? `\n(Full report: ${r.file})` : ''}`;
    })
    .join('\n\n');
  const comms = extra.board.filter((b) => b.kind !== 'note');

  return `You are the ORCHESTRATOR, the hub of the team. Review the results of the round below (you may read the code in the workspace to verify, but must NOT edit).

Team:
${roster()}

${COORDINATION_RULES}

Your review duties:
1. Check the work against the request and the shared contract.
2. Resolve EVERY file conflict and EVERY worker request / question / blocker listed below: either assign a follow-up task (giving the file to exactly one owner) or explain in the summary why no action is needed.
3. If a file was overwritten by mistake, the pre-task backup is in ${job.dir}/backup/<taskId>/ — a follow-up task can restore or merge from it.

Decide whether the goal is completed or needs another round:
${REVIEW_SCHEMA}
${round >= maxRounds ? 'NOTE: This is the last round, so you should return "status": "done" and list any remaining limitations (including unresolved conflicts) in the summary.' : ''}

=== THIS JOB (round ${round}/${maxRounds}) ===
Workspace: ${job.cwd}
USER REQUEST: ${job.request}
PLAN FOR THIS ROUND: ${job.plan.summary}
SHARED CONTRACT: ${job.plan.shared_contract || '(none)'}

FILE CONFLICTS DETECTED BY THE ENGINE:
${extra.issues.length ? extra.issues.map((i) => `- ${i}`).join('\n') : '(none)'}

WORKER REQUESTS / QUESTIONS / BLOCKERS:
${comms.length ? comms.map((b) => `- ${b.from} [${b.kind}]: ${b.text}`).join('\n') : '(none)'}

RESULTS:
${results}

Reply with ONLY a single JSON block.`;
}

/** Pull the JSON object out of an LLM reply (it may be wrapped in ```json or surrounded by prose). */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of candidates) {
    try { return JSON.parse(c.trim()); } catch { /* try the next one */ }
  }
  throw new Error('Could not find valid JSON in the Orchestrator reply');
}

/** The worker's trailing {"handoff": {...}} block, or null. Also returns the report text without it. */
export function extractHandoff(text) {
  const blocks = [...String(text).matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi)];
  for (const m of blocks.reverse()) {
    try {
      const h = JSON.parse(m[1]).handoff;
      if (!h || typeof h !== 'object') continue;
      const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []);
      return {
        handoff: {
          summary: String(h.summary || ''),
          files_changed: list(h.files_changed),
          interfaces: String(h.interfaces || ''),
          notes_for_team: String(h.notes_for_team || ''),
          requests: list(h.requests),
          questions: list(h.questions),
          blockers: list(h.blockers),
        },
        report: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(),
      };
    } catch { /* not the handoff block */ }
  }
  return { handoff: null, report: String(text) };
}
