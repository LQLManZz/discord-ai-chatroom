// Detects which agent CLIs are installed on this machine, so the Orchestrator is only offered agents that can run.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** First line of `<cmd> --version`, or null if the command is missing/broken. */
function version(cmd) {
  // shell: lets Windows resolve npm .cmd shims; the command string is a fixed name, never user input
  const r = spawnSync(`${cmd} --version`, { shell: true, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/)[0] || 'installed';
}

/** Model providers configured for Codex in ~/.codex/config.toml ([model_providers.<name>] tables). */
function codexProviders() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  let toml = '';
  try { toml = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const names = [...toml.matchAll(/^\s*\[model_providers\.("?)([\w-]+)\1\]/gm)].map((m) => m[2]);
  const active = toml.match(/^\s*model_provider\s*=\s*"([\w-]+)"/m)?.[1];
  return [...new Set([...names, ...(active ? [active] : [])])];
}

/** { cli: { claude, agy, codex }: version|null, codexProviders: [...] } */
export function scanMachine() {
  const cli = { claude: version('claude'), agy: version('agy'), codex: version('codex') };
  return { cli, codexProviders: cli.codex ? codexProviders() : [], at: Date.now() };
}
