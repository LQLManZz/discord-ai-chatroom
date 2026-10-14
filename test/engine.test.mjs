// Engine coordination test with fake agents (no CLI / quota used). Run: npm test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.AGENTS_SKIP_SCAN = '1';
process.env.LANGUAGE = 'en';
import os from 'node:os';

const SRC = new URL('../src/', import.meta.url).href;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-test-'));
process.env.WORKSPACE_DIR = WS;
process.env.MAX_PARALLEL = '3';

const prompts = { review: null, workers: {} };
const PLAN = {
  summary: 'test plan', shared_contract: 'add(a, b) -> int in core.py',
  tasks: [
    { id: 'T1', agent: 'deepseek-flash', title: 'core', files: ['core.py'], instructions: 'x', depends_on: [] },
    { id: 'T2', agent: 'gemini-flash', title: 'ui', files: ['ui.html', 'shared.css'], instructions: 'x', depends_on: [] },
    { id: 'T3', agent: 'haiku', title: 'docs', files: [path.join(WS, 'shared.css'), 'README.md'], instructions: 'x', depends_on: [] },
    { id: 'T4', agent: 'sonnet', title: 'tests', files: ['test_core.py'], instructions: 'x', depends_on: ['T1'] },
  ],
};
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(WS, f)), { recursive: true }); fs.writeFileSync(path.join(WS, f), s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mock.module(new URL('runner.js', SRC).href, {
  exports: {
    runAgent(agent, prompt) {
      const p = (async () => {
        if (prompt.includes('You are the ORCHESTRATOR')) {
          if (prompt.includes('Review the results')) { prompts.review = prompt; return { ok: true, text: '```json\n{"status":"done","summary":"ok"}\n```', stderr: '', ms: 1 }; }
          return { ok: true, text: '```json\n' + JSON.stringify(PLAN) + '\n```', stderr: '', ms: 1 };
        }
        const id = prompt.match(/=== YOUR TASK \[(\w+)\]/)[1];
        prompts.workers[id] = prompt;
        await sleep(300);
        if (id === 'T1') write('core.py', 'def add(a, b):\n    return a + b\n');
        if (id === 'T2') { write('ui.html', '<h1>ui</h1>'); write('shared.css', 'a{}'); write('stray.txt', 'oops'); }
        if (id === 'T3') { write('shared.css', 'a{}\nb{}'); write('README.md', '# docs'); }
        if (id === 'T4') { write('test_core.py', 'import core'); write('core.py', 'def add(a, b):\n    return b + a\n'); } // rogue edit
        if (id === 'T4') return { ok: false, text: '', stderr: 'OpenAI Codex banner\n' + 'x'.repeat(9000) + '\nREAL ERROR: tests crashed', code: 1, ms: 5 };
        const handoff = { handoff: { summary: `${id} done`, files_changed: [], interfaces: id === 'T1' ? 'def add(a, b) -> int' : '',
          notes_for_team: id === 'T2' ? 'colors are in shared.css' : '', requests: id === 'T3' ? ['core.py needs a docstring'] : [], questions: [], blockers: [] } };
        return { ok: true, text: `Report ${id}\n\`\`\`python\nprint(1)\n\`\`\`\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\``, stderr: '', ms: 300 };
      })();
      p.cancel = () => {};
      return p;
    },
  },
});

// Keep the real onWatch quota out of this test: nobody is out of quota here
const realQuota = await import(new URL('quota.js?real', SRC).href);
mock.module(new URL('quota.js', SRC).href, { exports: { quotaBlock: () => null, quotaError: realQuota.quotaError } });

const jobsMod = await import(new URL('jobs.js', SRC).href);
const said = [];
const chat = { say: async (j, a, t) => said.push(`[${a || 'system'}] ${t}`), showPlan: async (j) => jobsMod.approve(j), showReview: async () => {}, showFailure: async (j, t) => said.push('FAIL ' + t) };

test('coordination end-to-end', async () => {
  const job = jobsMod.createJob({ request: 'build it', userId: 'u', chat, cwd: WS });
  await jobsMod.plan(job);
  while (!['done', 'failed'].includes(job.status)) await sleep(50);

  // 1. Same file in two parallel tasks -> serialized; absolute path normalised
  assert.deepEqual(job.plan.tasks.find((t) => t.id === 'T3').files, ['shared.css', 'README.md']);
  assert.deepEqual(job.plan.tasks.find((t) => t.id === 'T3').after, ['T2']);
  assert.ok(job.windows.T3.start >= job.windows.T2.end, 'T3 must start after T2 ends');
  assert.ok(job.windows.T2.start < job.windows.T1.end, 'T1 and T2 still run in parallel');

  // 2. Conflicts detected and attributed
  const issues = job.issues.map((i) => i.text);
  console.log('issues:\n ' + issues.join('\n '));
  assert.ok(issues.some((t) => t.includes('stray.txt') && t.includes('T2')), 'undeclared stray.txt by T2');
  assert.ok(issues.some((t) => t.includes('core.py') && t.includes('T1') && t.includes('T4')), 'T4 overwrote T1 core.py');
  assert.ok(fs.existsSync(path.join(job.dir, 'backup', 'T3', 'shared.css')), 'T3 backed up shared.css (written by T2) before running');

  // 3. Communication through the Orchestrator
  assert.match(prompts.workers.T4, /Interfaces:\ndef add\(a, b\) -> int/, 'T4 got T1 structured handoff');
  assert.match(prompts.workers.T4, /add\(a, b\) -> int in core.py/, 'shared contract delivered');
  assert.match(prompts.workers.T3, /colors are in shared.css/, 'team board note relayed');
  assert.match(prompts.workers.T3, /shared.css: written by T2/, 'file history given to next owner');
  assert.match(prompts.review, /T3 \(haiku\) \[request\]: core.py needs a docstring/, 'request reaches Orchestrator');
  assert.match(prompts.review, /core.py/); assert.match(prompts.review, /stray.txt/);
  assert.match(prompts.review, /REAL ERROR: tests crashed/, 'failed task shows the END of stderr');
  assert.doesNotMatch(prompts.review, /OpenAI Codex banner/);
  assert.ok(!said.some((s) => s.includes('```json')), 'handoff JSON not dumped into chat');

  // 4. Persistence + resume
  const state = JSON.parse(fs.readFileSync(path.join(job.dir, 'state.json'), 'utf8'));
  assert.equal(state.status, 'done');
  state.status = 'running'; state.id = 'zzzzz'; state.taskState.T4 = { status: 'running' }; delete state.results.T4;
  fs.mkdirSync(path.join(WS, '.chatroom/jobs/zzzzz'), { recursive: true });
  fs.writeFileSync(path.join(WS, '.chatroom/jobs/zzzzz/state.json'), JSON.stringify({ ...state, dir: path.join(WS, '.chatroom/jobs/zzzzz') }));
  const back = jobsMod.restoreJobs([WS], chat);
  assert.deepEqual(back.map((j) => [j.id, j.status, j.interruptedFrom]), [['zzzzz', 'awaiting_approval', 'running']]);
  const r = jobsMod.jobs.get('zzzzz');
  prompts.workers = {};
  await jobsMod.approve(r);
  while (!['done', 'failed'].includes(r.status)) await sleep(50);
  assert.deepEqual(Object.keys(prompts.workers), ['T4'], 'resume re-runs only the unfinished task');
});
