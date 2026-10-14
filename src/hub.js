// Discord work hub: server layout, live panels and feeds.
//   🏢 AI HUB       lobby (CHANNEL_ID) · 📥-reports (your inbox)
//   📡 MONITORING   📊-dashboard · 📈-quota · 🩺-health (live panels) · 🧾-activity · 🚨-alerts (feeds)
//   📁 WORKSPACES   one channel per workspace folder, one thread per job
// Channel/message ids are persisted in .chatroom/hub.json so restarts reuse the same channels and panels.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { AGENTS, workerKeys, isEnabled, applyScan, lastScan } from './agents.js';
import { jobs, config, agentBlock } from './jobs.js';
import { onwatchInstalled, ensureOnwatch, readQuotas, ONWATCH_URL } from './quota.js';
import { t, statusLabel } from './i18n.js';

const STORE = path.resolve('.chatroom', 'hub.json');
const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

function load() {
  try { return { workspaces: {}, ...JSON.parse(fs.readFileSync(STORE, 'utf8')) }; } catch { return { workspaces: {} }; }
}
function persist() {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(state, null, 2));
}

const state = load();
let client;
let guild;
let lobbyId;
let scan = lastScan;
const startedAt = Date.now();
const webhooks = new Map(); // parent channel id -> webhook

const TASK_ICON = { queued: '⏳', running: '🔵', done: '✅', failed: '❌', skipped: '⏭️', waiting: '⏸️' };
const ACTIVE = ['planning', 'awaiting_approval', 'running', 'reviewing', 'paused'];

const ts = (ms, f = 'R') => `<t:${Math.floor(ms / 1000)}:${f}>`; // Discord renders (and ticks) these client-side
const where = (j) => (j.meta.threadId ? `<#${j.meta.threadId}>` : `#${j.id}`);
const bar = (done, total) => {
  const n = total ? Math.max(0, Math.min(10, Math.round((done / total) * 10))) : 0;
  return '▰'.repeat(n) + '▱'.repeat(10 - n);
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const users = () => (process.env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- Server layout ----------

/** Fetch the channel saved under `key`, (re)create it if gone, and keep it under the intended category. */
async function ensure(key, opts) {
  const existing = state[key] && (await guild.channels.fetch(state[key]).catch(() => null));
  if (existing) {
    if (opts.parent && existing.parentId !== opts.parent) await existing.setParent(opts.parent, { lockPermissions: false }).catch(() => {});
    return existing;
  }
  const ch = await guild.channels.create(opts).catch((e) => {
    if (!opts.permissionOverwrites) throw e;
    const { permissionOverwrites, ...rest } = opts; // bot lacks Manage Roles: create it without the read-only lock
    return guild.channels.create(rest);
  });
  state[key] = ch.id;
  persist();
  return ch;
}

const readOnly = () => [
  { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads] },
  { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
];
const textChannel = (name, parent, topicKey) => ({
  name, type: ChannelType.GuildText, parent, topic: t(topicKey), permissionOverwrites: readOnly(),
});

/** Build (or repair) the hub layout around the lobby channel. Safe to call repeatedly. */
export async function setupHub(c, lobby) {
  client = c;
  lobbyId = lobby.id;
  guild = lobby.guild;
  const hq = await ensure('hqId', { name: '🏢 AI HUB', type: ChannelType.GuildCategory });
  const mon = await ensure('monCatId', { name: '📡 MONITORING', type: ChannelType.GuildCategory });
  await ensure('wsCatId', { name: '📁 WORKSPACES', type: ChannelType.GuildCategory });
  if (lobby.parentId !== hq.id) await lobby.setParent(hq.id, { lockPermissions: false }).catch(() => {});
  await ensure('reportsId', textChannel('📥-reports', hq.id, 'topic.reports'));
  await ensure('dashboardId', textChannel('📊-dashboard', mon.id, 'topic.dashboard'));
  if (onwatchInstalled()) await ensure('quotaId', textChannel('📈-quota', mon.id, 'topic.quota'));
  await ensure('healthId', textChannel('🩺-health', mon.id, 'topic.health'));
  await ensure('activityId', textChannel('🧾-activity', mon.id, 'topic.activity'));
  await ensure('alertsId', textChannel('🚨-alerts', mon.id, 'topic.alerts'));
  await workspaceChannel(config.cwd);

  await refreshDashboard();
  await refreshHealth();
  if (onwatchInstalled()) await refreshQuota();
  if (!setupHub.started) {
    setupHub.started = true;
    setInterval(refreshDashboard, 60_000);
    setInterval(refreshHealth, 5 * 60_000);
    setInterval(() => { scan = applyScan(); }, 30 * 60_000); // a CLI installed/removed later is picked up
    if (onwatchInstalled()) setInterval(refreshQuota, 120_000); // = onWatch's poll interval
  }
}

export const hubIds = () => ({
  lobby: lobbyId, reports: state.reportsId, dashboard: state.dashboardId, quota: state.quotaId,
  health: state.healthId, activity: state.activityId, alerts: state.alertsId,
});

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'workspace';

/** The channel for a workspace folder; created on first use. */
export async function workspaceChannel(cwd) {
  const full = path.resolve(cwd);
  const entry = state.workspaces[norm(full)];
  const existing = entry && (await guild.channels.fetch(entry.channelId).catch(() => null));
  if (existing) return existing;

  const base = `ws-${slug(path.basename(full))}`;
  const taken = new Set(guild.channels.cache.map((ch) => ch.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  const ch = await guild.channels.create({
    name, type: ChannelType.GuildText, parent: state.wsCatId, topic: t('topic.workspace', { path: full }),
  });
  state.workspaces[norm(full)] = { channelId: ch.id, path: full };
  persist();
  await ch.send(t('ws.welcome', { path: full })).catch(() => {});
  scheduleDashboard();
  return ch;
}

const parentId = (ch) => (ch.isThread?.() ? ch.parentId : ch.id);

/** Workspace folder bound to a channel (or to the parent of a thread), else undefined. */
export const workspaceOf = (ch) => Object.values(state.workspaces).find((w) => w.channelId === parentId(ch))?.path;
export const listWorkspaces = () => Object.values(state.workspaces);
export const isHubChannel = (ch) => parentId(ch) === lobbyId || !!workspaceOf(ch);

/** Webhook to post under agent personas into a channel or thread id. */
export async function webhookTarget(id) {
  const ch = await client.channels.fetch(id);
  const parent = ch.isThread() ? ch.parent : ch;
  let hook = webhooks.get(parent.id);
  if (!hook) {
    const hooks = await parent.fetchWebhooks();
    hook = hooks.find((h) => h.owner?.id === client.user.id && h.name === 'AI Chatroom')
      || (await parent.createWebhook({ name: 'AI Chatroom', reason: 'Personas for AI agents' }));
    webhooks.set(parent.id, hook);
  }
  return { webhook: hook, threadId: ch.isThread() ? ch.id : undefined };
}

// ---------- Reports inbox ----------

/** Post to #reports and ping the job owner. REPORT_DM=1 also sends it as a DM. */
export async function inbox(job, { embed, components = [], dm = false }) {
  const ch = state.reportsId && (await client.channels.fetch(state.reportsId).catch(() => null));
  if (dm && process.env.REPORT_DM === '1') {
    client.users.send(job.userId, { content: `Job #${job.id} · ${where(job)}`, embeds: [embed] }).catch(() => {});
  }
  if (!ch) return null;
  return ch.send({ content: `<@${job.userId}> · ${where(job)}`, embeds: [embed], components, allowedMentions: { users: [job.userId] } });
}

// ---------- Activity & alerts feeds ----------

const feeds = { activityId: [], alertsId: [] };
let flushTimer = null;

/** Queue a line for a feed channel; bursts are sent as one message every few seconds. */
function feed(key, line) {
  if (!state[key]) return;
  feeds[key].push(line);
  if (!flushTimer) flushTimer = setTimeout(flushFeeds, 3000);
}

async function flushFeeds() {
  flushTimer = null;
  for (const key of Object.keys(feeds)) {
    const lines = feeds[key].splice(0);
    if (!lines.length) continue;
    const ch = await client.channels.fetch(state[key]).catch(() => null);
    let chunk = '';
    for (const l of lines.map((x) => `${ts(Date.now(), 'T')} ${clip(x, 400)}`)) {
      if (chunk.length + l.length > 1900) { await ch?.send({ content: chunk, allowedMentions: { parse: [] } }).catch(() => {}); chunk = ''; }
      chunk += `${chunk ? '\n' : ''}${l}`;
    }
    if (chunk) await ch?.send({ content: chunk, allowedMentions: { parse: [] } }).catch(() => {});
  }
}

export const logActivity = (line) => feed('activityId', line);

const seen = new Map(); // jobId -> { status, tasks: { id: status }, issues }

/** Called on every job change: turn state differences into activity/alert lines. */
export function trackJob(job) {
  const prev = seen.get(job.id);
  const now = {
    status: job.status,
    tasks: Object.fromEntries((job.plan?.tasks || []).map((x) => [x.id, job.taskState[x.id]?.status])),
    issues: job.issues?.length || 0,
  };
  seen.set(job.id, now);
  if (!prev) { // first sighting: a new job is announced, a restored one is only recorded
    if (job.status === 'planning') logActivity(t('act.jobNew', { id: job.id, where: where(job), request: clip(job.request.replace(/\s+/g, ' '), 120) }));
    return;
  }
  if (prev.status !== now.status) {
    logActivity(t('act.jobStatus', { status: statusLabel(now.status), id: job.id, where: where(job) }));
    if (now.status === 'failed') feed('alertsId', t('alert.jobFailed', { job: job.id, where: where(job) }));
    if (now.status === 'paused') feed('alertsId', t('alert.paused', { job: job.id, reason: job.pauseReason }));
  }
  for (const task of job.plan?.tasks || []) {
    const s = now.tasks[task.id];
    if (!s || s === prev.tasks[task.id] || s === 'queued') continue;
    const st = job.taskState[task.id];
    const extra = s === 'done' || s === 'failed' ? (st.ms ? ` · ${Math.round(st.ms / 1000)}s` : '') : s === 'waiting' ? ` · ${t('dash.waitQuota')}` : '';
    logActivity(t('act.task', { icon: TASK_ICON[s] || '•', job: job.id, task: task.id, agent: task.agent, title: clip(task.title, 60), extra }));
    if (s === 'failed') feed('alertsId', t('alert.taskFailed', { job: job.id, task: task.id, agent: task.agent, where: where(job) }));
  }
  for (const issue of (job.issues || []).slice(prev.issues)) feed('alertsId', t('alert.conflict', { job: job.id, text: issue.text }));
}

// ---------- Live dashboard ----------

function agentPanel() {
  const busy = new Map();
  const add = (k, s) => busy.set(k, [...(busy.get(k) || []), s]);
  for (const j of jobs.values()) {
    if (j.status === 'planning') add('orchestrator', `${t('dash.planningJob', { where: where(j) })} · ${ts(j.statusAt || j.createdAt)}`);
    if (j.status === 'reviewing') add('orchestrator', `${t('dash.reviewingJob', { where: where(j) })} · ${ts(j.statusAt)}`);
    if (j.status !== 'running' || !j.plan) continue;
    for (const task of j.plan.tasks) {
      const s = j.taskState[task.id];
      if (s?.status === 'running') add(task.agent, `**[${task.id}]** ${clip(task.title, 50)} · ${where(j)} · ${ts(s.startedAt)}`);
    }
  }
  return ['orchestrator', ...workerKeys()].map((k) => {
    const work = busy.get(k);
    if (work) return `🔵 **${AGENTS[k].name}** — ${work.join('\n　↳ ')}`;
    const block = agentBlock(k);
    if (block) return `⏸️ **${AGENTS[k].name}** — ${t('dash.outOfQuota', { reason: block.reason, when: block.until ? ts(block.until) : t('dash.whenRefilled') })}`;
    return `🟢 **${AGENTS[k].name}** — ${t('dash.idle')}`;
  }).join('\n');
}

function jobBlock(j) {
  const tasks = j.plan?.tasks || [];
  const head = `**Job #${j.id}** · ${statusLabel(j.status)} · ${t('dash.round', { n: j.round })} · ${where(j)}\n> ${clip(j.request.replace(/\s+/g, ' '), 90)}`;
  const paused = j.status === 'paused'
    ? `\n${t('dash.pausedLine', { reason: j.pauseReason, when: j.pausedUntil ? ts(j.pausedUntil) : t('paused.unknown') })}`
    : '';
  if (!tasks.length) return head + paused;
  const fin = tasks.filter((x) => ['done', 'failed', 'skipped'].includes(j.taskState[x.id]?.status)).length;
  const lines = tasks.map((x) => {
    const s = j.taskState[x.id] || {};
    const extra = s.status === 'running' ? ` · ${ts(s.startedAt)}`
      : s.status === 'waiting' ? ` · ${t('dash.waitQuota')}${s.until ? ` ${ts(s.until)}` : ''}`
        : s.ms ? ` · ${Math.round(s.ms / 1000)}s` : '';
    return `${TASK_ICON[s.status] || '⏳'} \`${x.id}\` ${x.agent} — ${clip(x.title, 50)}${extra}`;
  });
  return `${head}${paused}\n\`${bar(fin, tasks.length)}\` ${fin}/${tasks.length}\n${lines.join('\n')}`;
}

function dashboardEmbeds() {
  const all = [...jobs.values()];
  const active = all.filter((j) => ACTIVE.includes(j.status));
  const recent = all.filter((j) => !ACTIVE.includes(j.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const waiting = active.filter((j) => j.status === 'awaiting_approval').length;

  // Discord caps a message's embeds at 6000 chars in total: team ≤1500, jobs ≤3000, recent ≤1000 (+ titles)
  const team = new EmbedBuilder().setColor(0x5865f2).setTitle(t('dash.team')).setDescription(clip(agentPanel(), 1500));
  const work = new EmbedBuilder()
    .setColor(waiting ? 0xf1c40f : 0x3498db)
    .setTitle(t('dash.active', { n: active.length }) + (waiting ? t('dash.waiting', { n: waiting }) : ''))
    .setDescription(clip(active.map(jobBlock).join('\n\n') || t('dash.noActive'), 3000));
  const wsLines = listWorkspaces().map((w) => {
    const n = active.filter((j) => norm(j.cwd) === norm(w.path)).length;
    return `<#${w.channelId}>${n ? ` · ${t('dash.wsRunning', { n })}` : ''}`;
  });
  const history = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(t('dash.recent'))
    .setDescription(clip(recent.map((j) => `${statusLabel(j.status)} · **#${j.id}** ${where(j)} · ${clip(j.request.replace(/\s+/g, ' '), 60)} · ${ts(j.updatedAt)}`).join('\n') || t('dash.none'), 1000))
    .addFields({ name: t('dash.workspaces'), value: clip(wsLines.join('\n') || t('dash.none'), 400) })
    .setFooter({ text: t('dash.footer') })
    .setTimestamp();
  return [team, work, history];
}

let pending = null;
/** Coalesce bursts of job events into one dashboard edit. */
export function scheduleDashboard() {
  if (!pending) pending = setTimeout(() => { pending = null; refreshDashboard(); }, 2000);
}

/** Edit the panel message kept in state[msgKey] inside channel state[chKey]; post and pin it if it's gone. */
async function upsertPinned(chKey, msgKey, payload) {
  if (!client || !state[chKey]) return;
  try {
    const ch = await client.channels.fetch(state[chKey]);
    const msg = state[msgKey] && (await ch.messages.fetch(state[msgKey]).catch(() => null));
    if (msg) return void (await msg.edit(payload));
    const m = await ch.send(payload);
    state[msgKey] = m.id;
    persist();
    await m.pin().catch(() => {});
  } catch (e) {
    console.error(`${chKey}:`, e.message);
  }
}

export const refreshDashboard = () => upsertPinned('dashboardId', 'dashboardMsgId', { content: '', embeds: dashboardEmbeds() });

// ---------- Health panel ----------

const dur = (ms) => {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

async function healthEmbed() {
  const gb = (b) => (b / 1024 ** 3).toFixed(1);
  const all = [...jobs.values()];
  const cli = scan?.cli || {};
  const cliLines = ['claude', 'agy', 'codex'].map((c) => `${cli[c] ? '🟢' : '🔴'} \`${c}\` ${cli[c] || t('health.missing')}`);
  if (scan?.codexProviders?.length) cliLines.push(`　codex providers: ${scan.codexProviders.join(', ')}`);
  const agentLines = Object.entries(AGENTS).map(([k, a]) => `${isEnabled(k) ? '🟢' : a.missing ? '🔴' : '⚪'} ${a.name}${a.missing ? ` — ${a.missing}` : ''}`);
  const onwatch = onwatchInstalled() ? (await ensureOnwatch()) : null;
  return new EmbedBuilder()
    .setColor(cli.claude ? 0x2ecc71 : 0xe74c3c)
    .setTitle(t('health.title'))
    .addFields(
      { name: t('health.bot'), value: t('health.botValue', { uptime: dur(Date.now() - startedAt), since: ts(startedAt, 'f'), pid: process.pid, node: process.version, ping: client.ws.ping >= 0 ? client.ws.ping : '—' }) },
      { name: t('health.host'), value: t('health.hostValue', { os: `${os.type()} ${os.release()} (${os.arch()})`, free: gb(os.freemem()), total: gb(os.totalmem()), load: os.loadavg()[0].toFixed(2) }) },
      { name: t('health.clis'), value: clip(cliLines.join('\n'), 1024) },
      { name: t('health.agents'), value: clip(agentLines.join('\n'), 1024) },
      { name: t('health.jobs'), value: t('health.jobsValue', {
        active: all.filter((j) => ['planning', 'running', 'reviewing'].includes(j.status)).length,
        paused: all.filter((j) => j.status === 'paused').length,
        waiting: all.filter((j) => j.status === 'awaiting_approval').length,
        total: all.length,
      }) },
      { name: t('health.onwatch'), value: onwatch ? `${onwatch === 'up' ? '🟢' : '🟡'} ${onwatch} · ${ONWATCH_URL}` : t('health.onwatchMissing') },
    )
    .setTimestamp();
}

export async function refreshHealth() {
  if (!client || !state.healthId) return;
  await upsertPinned('healthId', 'healthMsgId', { content: '', embeds: [await healthEmbed()] });
}
export { healthEmbed };

// ---------- Quota panel (onWatch) ----------

const ALERT_PCT = Number(process.env.QUOTA_ALERT_PCT || 10);
const USES = { Claude: 'orchestrator · sonnet · haiku', Antigravity: 'gemini-flash', DeepSeek: 'deepseek-flash', Codex: 'codex' };
// Which of our agents a quota row actually limits (agy's Claude/GPT pool isn't used by the team)
const usesOf = (r) => (r.provider === 'Antigravity' && !/gemini/i.test(r.name) ? t('quota.noAgent') : USES[r.provider] || '?');
const level = (left) => (left < ALERT_PCT ? '🔴' : left < 30 ? '🟡' : '🟢');
const tsOf = (iso) => (iso ? ts(Date.parse(iso)) : '?');

export function quotaEmbed(onwatchState) {
  const data = onwatchState === 'missing' ? null : readQuotas();
  const embed = new EmbedBuilder().setTitle(t('quota.title')).setURL(ONWATCH_URL).setTimestamp();
  if (!data) return embed.setColor(0xe74c3c).setDescription(t('quota.unreadable', { state: onwatchState }));

  const groups = new Map();
  for (const r of data.rows) {
    const line = `${level(r.left)} ${r.name} — ${t('quota.left')} **${Math.round(r.left)}%** \`${bar(r.left, 100)}\` · ${t('quota.reset')} ${tsOf(r.resetsAt)}`;
    groups.set(r.provider, [...(groups.get(r.provider) || []), line]);
  }
  for (const b of data.balances) groups.set(b.provider, [...(groups.get(b.provider) || []), `${b.ok ? '🟢' : '🔴'} ${b.name}: **${b.value}**`]);
  for (const [provider, lines] of groups) {
    embed.addFields({ name: `${provider}${USES[provider] ? ` → ${USES[provider]}` : ''}`, value: clip(lines.join('\n'), 1024) });
  }
  const latest = Math.max(0, ...[...data.rows, ...data.balances].map((r) => Date.parse(r.at) || 0));
  const low = data.rows.some((r) => r.left < ALERT_PCT);
  return embed
    .setColor(low ? 0xe74c3c : 0x2ecc71)
    .setDescription(t('quota.status', {
      state: onwatchState === 'started' ? t('quota.restarted') : t('quota.running'),
      when: latest ? ts(latest) : '?',
      url: ONWATCH_URL,
    }));
}

/** Keep onWatch alive, refresh #quota, and ping you in #alerts once per reset cycle when a quota runs low. */
export async function refreshQuota() {
  const onwatchState = await ensureOnwatch();
  await upsertPinned('quotaId', 'quotaMsgId', { content: '', embeds: [quotaEmbed(onwatchState)] });

  const data = onwatchState === 'missing' ? null : readQuotas();
  const sent = new Set(state.quotaAlerts || []);
  // providers report the same reset with a few µs of jitter per poll: bucket it to the hour, or it re-alerts every poll
  const key = (r) => `${r.provider}:${r.name}:${Math.round(Date.parse(r.resetsAt) / 3600e3) || r.resetsAt}`;
  const fresh = (data?.rows || []).filter((r) => r.left < ALERT_PCT && !sent.has(key(r)));
  if (!fresh.length || !state.alertsId) return;
  for (const r of fresh) sent.add(key(r));
  state.quotaAlerts = [...sent].slice(-50);
  persist();

  const ch = await client.channels.fetch(state.alertsId).catch(() => null);
  await ch?.send({
    content: `${users().map((u) => `<@${u}>`).join(' ')} ${t('quota.lowTitle')}`,
    embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription(fresh.map((r) =>
      `🔴 **${r.provider}** ${r.name} — ${t('quota.left')} **${Math.round(r.left)}%** · ${t('quota.reset')} ${tsOf(r.resetsAt)}\n　${t('quota.affects')}: ${usesOf(r)}`).join('\n'))],
    allowedMentions: { users: users() },
  }).catch((e) => console.error('quota alert:', e.message));
}
