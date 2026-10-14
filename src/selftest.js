// Test the whole flow WITHOUT Discord: plan -> auto-approve -> run -> review, printed to the console.
// Usage: npm run check -- "request"
import { createJob, plan, approve, jobs } from './jobs.js';
import { AGENTS } from './agents.js';

const request = process.argv.slice(2).join(' ') || 'Create hello.txt in the workspace containing the line "hello from the agents", then create README.md describing that file.';

const chat = {
  say: async (job, agentKey, text) => console.log(`\n[${agentKey ? AGENTS[agentKey].name : 'system'}] ${text}`),
  showPlan: async (job) => {
    console.log(`\n=== PLAN round ${job.round}: ${job.plan.summary}`);
    for (const t of job.plan.tasks) console.log(`  [${t.id}] ${t.agent} ${t.depends_on.length ? `<- ${t.depends_on}` : ''} : ${t.title}`);
    console.log('  (auto-approve)');
    await approve(job);
  },
};

const job = createJob({ request, userId: 'selftest', chat });
await plan(job);
// Wait until the job finishes
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (['done', 'failed', 'cancelled'].includes(jobs.get(job.id).status)) { clearInterval(t); resolve(); }
  }, 1000);
});
console.log(`\nJob #${job.id} -> ${job.status}. Logs: ${job.dir}`);
