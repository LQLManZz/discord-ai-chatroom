// Quota exhaustion: a job pauses instead of failing, saves its progress and resumes by itself after the reset.
// Fake agents and a fake onWatch, no CLI / quota used. Run: npm test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AGENTS_SKIP_SCAN = '1';
process.env.LANGUAGE = 'en';

process.env.QUOTA_RESUME_GRACE_MS = '0';
const SRC = new URL('../src/', import.meta.url).href;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-quota-'));
process.env.WORKSPACE_DIR = WS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (cond, ms = 8000) => (async () => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await sleep(25); } })();

// Fake onWatch: agentKey -> { until, reason } while "out of quota"
const onwatch = new Map();
const realQuota = await import(new URL('quota.js?real', SRC).href);
mock.module(new URL('quota.js', SRC).href, {
  exports: {
    quotaBlock: (k) => { const b = onwatch.get(k); return b && b.until > Date.now() ? b : null; },
    quotaError: realQuota.quotaError,
  },
});

const calls = [];
let haikuLimitedUntil = 0; // haiku's CLI answers "usage limit reached" until this time
const PLAN = { summary: 'p', tasks: [
  { id: 'T1', agent: 'deepseek-flash', title: 'a', files: ['a.py'], instructions: 'x' },
  { id: 'T2', agent: 'haiku', title: 'b', files: ['b.md'], instructions: 'x' },
  { id: 'T3', agent: 'deepseek-flash', title: 'c', files: ['c.py'], instructions: 'x', depends_on: ['T2'] },
] };
mock.module(new URL('runner.js', SRC).href, {
  exports: {
    runAgent(agent, prompt) {
      const p = (async () => {
        const who = prompt.includes('You are the ORCHESTRATOR') ? (prompt.includes('Review the results') ? 'review' : 'plan') : prompt.match(/=== YOUR TASK \[(\w+)\]/)[1];
        calls.push(who);
        await sleep(30);
        if (who === 'plan') return { ok: true, text: '```json\n' + JSON.stringify(PLAN) + '\n```', stderr: '' };
        if (who === 'review') return { ok: true, text: '```json\n{"status":"done","summary":"ok"}\n```', stderr: '' };
        if (who === 'T2' && Date.now() < haikuLimitedUntil) {
          return { ok: false, text: '', stderr: `Claude AI usage limit reached|${Math.floor(haikuLimitedUntil / 1000)}`, code: 1 };
        }
        fs.writeFileSync(path.join(WS, PLAN.tasks.find((t) => t.id === who).files[0]), who);
        return { ok: true, text: `done ${who}`, stderr: '' };
      })();
      p.cancel = () => {};
      return p;
    },
  },
});

const jobsMod = await import(new URL('jobs.js', SRC).href);
const said = [];
const chat = { say: async (j, a, t) => said.push(t), showPlan: async (j) => jobsMod.approve(j), showReview: async () => {} };

test('worker runs out of quota mid-job: pause, keep progress, auto-resume after reset', async () => {
  haikuLimitedUntil = Math.ceil((Date.now() + 1500) / 1000) * 1000; // CLI error carries a whole-second epoch
  const job = jobsMod.createJob({ request: 'r', userId: 'u', chat, cwd: WS });
  await jobsMod.plan(job);
  await until(() => job.status === 'paused');

  assert.equal(job.resumeStage, 'execute');
  assert.equal(job.pausedUntil, haikuLimitedUntil, 'reset time parsed from the CLI error');
  assert.equal(job.taskState.T1.status, 'done', 'other agents kept working');
  assert.equal(job.taskState.T2.status, 'waiting', 'quota failure is not a failure');
  assert.notEqual(job.taskState.T3.status, 'skipped', 'dependent task not skipped');
  assert.ok(!job.results.T2, 'T2 has no failed result recorded');
  const saved = JSON.parse(fs.readFileSync(path.join(job.dir, 'state.json'), 'utf8'));
  assert.equal(saved.status, 'paused');
  assert.ok(saved.results.T1.ok, 'progress saved to disk');

  await until(() => job.status === 'done');
  assert.deepEqual(calls, ['plan', 'T1', 'T2', 'T2', 'T3', 'review'], 'T1 not re-run; T2 retried after reset; then T3 and review');
  assert.ok(said.some((t) => t.includes('Quota is back')));
});

test('orchestrator out of quota before planning: wait for onWatch reset, then plan by itself', async () => {
  calls.length = 0;
  onwatch.set('orchestrator', { until: Date.now() + 800, reason: 'Claude 5 giờ còn 0%' });
  const job = jobsMod.createJob({ request: 'r2', userId: 'u', chat, cwd: WS });
  await jobsMod.plan(job);
  assert.equal(job.status, 'paused');
  assert.equal(job.resumeStage, 'plan');
  assert.equal(calls.length, 0, 'no call wasted on an exhausted agent');
  await until(() => job.status === 'done');
  assert.equal(calls[0], 'plan');
});

test('a paused job survives a bot restart and resumes on schedule', async () => {
  calls.length = 0;
  const job = jobsMod.createJob({ request: 'r3', userId: 'u', chat, cwd: WS });
  onwatch.set('orchestrator', { until: Date.now() + 60_000, reason: 'x' });
  await jobsMod.plan(job);
  assert.equal(job.status, 'paused');
  jobsMod.cancel(job); // stop this instance's timer...
  const state = JSON.parse(fs.readFileSync(path.join(job.dir, 'state.json'), 'utf8'));
  // ...and pretend the bot restarted with the job still paused, its reset now due
  Object.assign(state, { id: 'rstrt', status: 'paused', pausedUntil: Date.now() + 300, dir: path.join(WS, '.chatroom/jobs/rstrt') });
  fs.mkdirSync(state.dir, { recursive: true });
  fs.writeFileSync(path.join(state.dir, 'state.json'), JSON.stringify(state));
  onwatch.delete('orchestrator');
  jobsMod.restoreJobs([WS], chat);
  const back = jobsMod.jobs.get('rstrt');
  assert.equal(back.status, 'paused');
  await until(() => back.status === 'done');
  assert.equal(calls[0], 'plan');
});

test('quotaError recognises common CLI messages and ignores ordinary failures', () => {
  const q = realQuota.quotaError;
  assert.ok(q('Error: 429 Too Many Requests'));
  assert.ok(q('insufficient_balance: please top up'));
  assert.ok(q('RESOURCE_EXHAUSTED: quota exceeded for model'));
  const r = q('You have hit your usage limit. Try again in 2 hours.');
  assert.ok(r.until > Date.now() + 7000e3 && r.until < Date.now() + 7300e3);
  assert.equal(q('Traceback: ZeroDivisionError'), null);
  assert.equal(q('npm ERR! missing script: test'), null);
});
