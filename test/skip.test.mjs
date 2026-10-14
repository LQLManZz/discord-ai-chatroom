// A failed task skips the tasks that depend on it, and the job still reaches the Orchestrator's review.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AGENTS_SKIP_SCAN = '1';
const SRC = new URL('../src/', import.meta.url).href;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-skip-'));
process.env.WORKSPACE_DIR = WS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const realQuota = await import(new URL('quota.js?real', SRC).href);
mock.module(new URL('quota.js', SRC).href, { exports: { quotaBlock: () => null, quotaError: realQuota.quotaError } });
const calls = [];
mock.module(new URL('runner.js', SRC).href, {
  exports: {
    runAgent(agent, prompt) {
      const p = (async () => {
        const who = prompt.includes('You are the ORCHESTRATOR') ? (prompt.includes('Review the results') ? 'review' : 'plan') : prompt.match(/=== YOUR TASK \[(\w+)\]/)[1];
        calls.push(who);
        if (who === 'plan') {
          return { ok: true, stderr: '', text: '```json\n' + JSON.stringify({ summary: 's', tasks: [
            { id: 'T1', agent: 'haiku', title: 'a', files: ['a'], instructions: 'x' },
            { id: 'T2', agent: 'haiku', title: 'b', files: ['b'], instructions: 'x', depends_on: ['T1'] },
          ] }) + '\n```' };
        }
        if (who === 'review') return { ok: true, stderr: '', text: '```json\n{"status":"done","summary":"ok"}\n```' };
        return { ok: false, text: '', stderr: 'Traceback: ZeroDivisionError', code: 1 }; // T1 fails (not a quota error)
      })();
      p.cancel = () => {};
      return p;
    },
  },
});

const jobsMod = await import(new URL('jobs.js', SRC).href);

test('failed dependency: dependents are skipped, review still runs', async () => {
  const chat = { say: async () => {}, showPlan: async (j) => jobsMod.approve(j), showReview: async () => {}, showFailure: async () => {} };
  const job = jobsMod.createJob({ request: 'r', userId: 'u', chat, cwd: WS });
  await jobsMod.plan(job);
  const end = Date.now() + 5000;
  while (!['done', 'failed'].includes(job.status) && Date.now() < end) await sleep(20);
  assert.equal(job.status, 'done');
  assert.equal(job.taskState.T1.status, 'failed');
  assert.equal(job.taskState.T2.status, 'skipped');
  assert.deepEqual(calls, ['plan', 'T1', 'review']);
});
