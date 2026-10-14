// Run one agent CLI headlessly (claude / agy / codex) and return its final answer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const IS_WIN = process.platform === 'win32';
const AGY_MAX_ARG = 20000; // Windows command line limit is ~32k chars

const quote = (s) => (/[\s"&|<>^]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

/**
 * Build the command for an agent.
 * readOnly = true -> used by the Orchestrator (reads code only, never edits).
 */
function buildCommand(agent, prompt, { cwd, readOnly, autonomy, outFile }) {
  const full = autonomy === 'full' && !readOnly;
  switch (agent.runtime) {
    case 'claude': {
      const args = ['-p', '--model', agent.model, '--output-format', 'text'];
      if (readOnly) args.push('--disallowedTools', 'Edit,Write,NotebookEdit,Bash');
      else if (full) args.push('--dangerously-skip-permissions');
      else args.push('--permission-mode', 'acceptEdits');
      return { cmd: 'claude', args, stdin: prompt };
    }
    case 'agy': {
      const args = ['--model', agent.model, '--output-format', 'text'];
      if (readOnly) args.push('--mode', 'plan');
      else if (full) args.push('--dangerously-skip-permissions');
      else args.push('--mode', 'accept-edits');
      let p = prompt;
      if (p.length > AGY_MAX_ARG) {
        // Prompt too long to fit on the command line -> write it to a brief file and ask the agent to read it
        const brief = path.join(cwd, '.chatroom', `brief-${Date.now()}.md`);
        fs.mkdirSync(path.dirname(brief), { recursive: true });
        fs.writeFileSync(brief, prompt);
        p = `Read your full task brief in this file and carry it out: ${brief}`;
      }
      args.push('-p', p); // prompt must come right after -p
      return { cmd: 'agy', args };
    }
    case 'codex': {
      const sandbox = readOnly ? ['-s', 'read-only'] : full ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-s', 'workspace-write'];
      const args = ['exec', '--skip-git-repo-check', '-C', cwd, '-o', outFile, ...sandbox, ...(agent.codexArgs || []), '-'];
      // codex on Windows is an npm shim (.cmd) -> needs a shell
      return IS_WIN
        ? { cmd: ['codex.cmd', ...args.map(quote)].join(' '), args: [], shell: true, stdin: prompt }
        : { cmd: 'codex', args, stdin: prompt };
    }
    default:
      throw new Error(`Unknown runtime: ${agent.runtime}`);
  }
}

/**
 * @returns {Promise<{ok:boolean, text:string, stderr:string, code:number|null, ms:number}>}
 * `handle.cancel()` is attached to the returned promise so the job can be cancelled.
 */
export function runAgent(agent, prompt, { cwd, readOnly = false, autonomy = 'safe', timeoutMs = 30 * 60_000 } = {}) {
  const outFile = path.join(os.tmpdir(), `chatroom-codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  const { cmd, args, stdin, shell } = buildCommand(agent, prompt, { cwd, readOnly, autonomy, outFile });
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  delete env.CLAUDECODE; // allow launching claude even when the bot itself was started from Claude Code

  const started = Date.now();
  let child;
  const promise = new Promise((resolve) => {
    const opts = { cwd, env, windowsHide: true };
    child = shell ? spawn(cmd, { ...opts, shell: true }) : spawn(cmd, args, opts);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { err += `\n${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = out;
      if (agent.runtime === 'codex' && fs.existsSync(outFile)) {
        text = fs.readFileSync(outFile, 'utf8');
        fs.rmSync(outFile, { force: true });
      }
      text = stripAnsi(text).trim();
      err = stripAnsi(err).trim();
      if (timedOut) err = `Timed out after ${Math.round(timeoutMs / 60000)} minutes.\n${err}`;
      resolve({ ok: code === 0 && !timedOut && text.length > 0, text, stderr: err, code, ms: Date.now() - started });
    });

    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
  promise.cancel = () => child && killTree(child);
  return promise;
}
