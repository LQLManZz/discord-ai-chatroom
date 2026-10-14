// Agent registry: each agent = a persona on Discord + how to call its CLI.
// The Orchestrator reads `skills` to decide which task goes to whom. Agents whose CLI is not installed
// (see scan.js) or that are listed in AGENTS_DISABLED are left out automatically.
import 'dotenv/config';
import { scanMachine } from './scan.js';

const env = (k, d) => process.env[k] || d;
const avatar = (seed) => `https://api.dicebear.com/9.x/bottts-neutral/png?seed=${encodeURIComponent(seed)}`;
const codexArgs = (provider, model) => ['-c', `model_provider=${provider}`, '-c', `model=${model}`];

export const AGENTS = {
  orchestrator: {
    name: 'Opus · Orchestrator',
    runtime: 'claude',
    model: env('ORCHESTRATOR_MODEL', 'opus'),
    color: 0xd97757,
    avatar: avatar('opus-orchestrator'),
    skills: 'Plans the work, breaks it into tasks, assigns them, reviews the results. Does not write code itself.',
  },
  sonnet: {
    name: 'Sonnet · Workhorse',
    runtime: 'claude',
    model: env('SONNET_MODEL', 'sonnet'),
    color: 0xe8a87c,
    avatar: avatar('sonnet'),
    skills: 'Core coding: medium-to-hard features, refactoring, debugging, complex logic, writing tests.',
  },
  haiku: {
    name: 'Haiku · Workhorse',
    runtime: 'claude',
    model: env('HAIKU_MODEL', 'haiku'),
    color: 0xf3d2b3,
    avatar: avatar('haiku'),
    skills: 'Small, fast jobs: docs/README, simple scripts, renames, boilerplate, small config edits, quick lookups in code.',
  },
  'gemini-flash': {
    name: 'Gemini Flash · Workhorse',
    runtime: 'agy',
    model: env('GEMINI_MODEL', 'gemini-3.8-flash-high'),
    color: 0x4285f4,
    avatar: avatar('gemini-flash'),
    skills: 'Frontend/UI, long-context reading of large codebases, documentation research, multimodal analysis, fast prototypes.',
  },
  'deepseek-flash': {
    name: 'DeepSeek Flash · Workhorse',
    runtime: 'codex',
    provider: 'deepseek',
    model: env('DEEPSEEK_MODEL', 'deepseek-flash'),
    color: 0x4d6bfe,
    avatar: avatar('deepseek-flash'),
    skills: 'Cheap, fast coding: repetitive/batch tasks, algorithms, scripts, unit tests, porting code.',
  },
  codex: {
    name: 'Codex GPT · Workhorse',
    runtime: 'codex',
    provider: env('CODEX_GPT_PROVIDER', 'openai'),
    model: env('CODEX_GPT_MODEL', 'gpt-5.6-sol'),
    enabled: env('CODEX_GPT_ENABLED', '0') === '1', // needs an OpenAI login/API key for Codex, so opt-in
    color: 0x10a37f,
    avatar: avatar('codex-gpt'),
    skills: 'Coding and code review: reviewing diffs, finding bugs, hard implementation work.',
  },
};
for (const a of Object.values(AGENTS)) if (a.provider) a.codexArgs = codexArgs(a.provider, a.model);

// The bot itself (system messages) uses this persona
export const SYSTEM_PERSONA = { name: 'Chatroom', avatar: avatar('chatroom-system') };

const DISABLED = new Set(env('AGENTS_DISABLED', '').split(',').map((s) => s.trim()).filter(Boolean));
for (const k of DISABLED) if (AGENTS[k]) AGENTS[k].enabled = false;

/** Mark each agent available or not from what is installed. Returns the scan. */
export function applyScan(scan = scanMachine()) {
  for (const a of Object.values(AGENTS)) {
    const cli = scan.cli[a.runtime];
    if (!cli) a.missing = `\`${a.runtime}\` CLI not found`;
    else if (a.runtime === 'codex' && a.provider !== 'openai' && !scan.codexProviders.includes(a.provider)) {
      a.missing = `Codex provider "${a.provider}" not in ~/.codex/config.toml`;
    } else delete a.missing;
  }
  return scan;
}
// AGENTS_SKIP_SCAN=1 (tests) treats every agent as installed
export const lastScan = process.env.AGENTS_SKIP_SCAN === '1' ? null : applyScan();

export const isEnabled = (key) => !!AGENTS[key] && AGENTS[key].enabled !== false && !AGENTS[key].missing;
export const workerKeys = () => Object.keys(AGENTS).filter((k) => k !== 'orchestrator' && isEnabled(k));

export function setAgentModel(key, model) {
  const a = AGENTS[key];
  if (!a) return false;
  a.model = model;
  if (a.provider) a.codexArgs = codexArgs(a.provider, model);
  return true;
}
