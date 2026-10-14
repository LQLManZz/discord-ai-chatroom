// Discord layer: commands, approval buttons and the chat interface the job engine talks to.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, MessageFlags,
} from 'discord.js';
import { AGENTS, SYSTEM_PERSONA, workerKeys, isEnabled, setAgentModel } from './agents.js';
import { jobs, createJob, plan, approve, cancel, askDirect, config, setWorkspace, restoreJobs, resume } from './jobs.js';
import { getFullAutonomyDirs, getAutonomyForDir, addFullAutonomyDir, removeFullAutonomyDir } from './autonomy.js';
import { renderMermaid, buildPlanDiagram, detectLocalMedia, smartChunk, renderMermaidInText } from './media.js';
import {
  setupHub, hubIds, workspaceChannel, workspaceOf, listWorkspaces, isHubChannel, webhookTarget, inbox,
  scheduleDashboard, refreshQuota, quotaEmbed, healthEmbed, trackJob, logActivity,
} from './hub.js';
import { ensureOnwatch } from './quota.js';
import { t, statusLabel, modeLabel } from './i18n.js';

const execAsync = promisify(exec);

const { DISCORD_TOKEN, CHANNEL_ID } = process.env;
const ALLOWED = (process.env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!DISCORD_TOKEN || !CHANNEL_ID) {
  console.error('Missing DISCORD_TOKEN or CHANNEL_ID in .env — run `npm run setup`.');
  process.exit(1);
}

// Single-instance lock: a second bot on the same token would answer every command twice and create duplicate
// channels. Holding a local port is released by the OS even if the process crashes, unlike a pid file.
const LOCK_PORT = Number(process.env.BOT_LOCK_PORT || 47821);
await new Promise((resolve) => {
  net.createServer().once('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`⛔ The bot is already running (port ${LOCK_PORT} is held). Not starting a second copy.`);
    process.exit(0);
  }).listen(LOCK_PORT, '127.0.0.1', resolve);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

let channel; // lobby channel (CHANNEL_ID)

// ---------- Helpers ----------

const FILE_ICONS = {
  '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.webp': '🖼️', '.svg': '🎨', '.gif': '🎞️',
  '.mp3': '🎵', '.wav': '🎵', '.ogg': '🎵', '.m4a': '🎵', '.mp4': '🎬', '.webm': '🎬',
  '.js': '🟨', '.mjs': '🟨', '.ts': '🟦', '.py': '🐍', '.json': '📦',
  '.md': '📝', '.txt': '📄', '.html': '🌐', '.css': '🎨', '.pdf': '📕', '.csv': '📊', '.zip': '🗜️',
};
const fileIcon = (ext) => FILE_ICONS[ext.toLowerCase()] || '📄';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const i = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${['B', 'KB', 'MB', 'GB'][i]}`;
}

/** Discord rejects messages over 2000 chars. */
const fit = (s, n = 1990) => (s.length > n ? `${s.slice(0, n - 20)}\n${t('truncated')}` : s);
const reply = (msg, content) => msg.reply(typeof content === 'string' ? fit(content) : content);

/** Resolve a user-supplied path inside `root`; null if it escapes (e.g. `!cat ../../.env`). */
function inside(root, rel) {
  const full = path.resolve(root, rel || '.');
  const r = path.relative(root, full);
  return r.startsWith('..') || path.isAbsolute(r) ? null : full;
}

/** A user-supplied workspace folder must already exist (a typo must not create folders). */
const existingDir = (p) => {
  const full = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
  return fs.existsSync(full) && fs.statSync(full).isDirectory() ? full : null;
};

async function withHourglass(msg, fn) {
  await msg.react('⏳').catch(() => {});
  try { return await fn(); } finally { msg.reactions.cache.get('⏳')?.users.remove(client.user.id).catch(() => {}); }
}

// ---------- Posting under agent personas ----------

// `to` = channel or thread id (defaults to the lobby)
async function post(agentKey, rawText, { to = CHANNEL_ID, embeds = [], files = [], cwd = config.cwd } = {}) {
  const { webhook, threadId } = await webhookTarget(to);
  const p = agentKey ? AGENTS[agentKey] : SYSTEM_PERSONA;
  const base = { username: p.name, avatarURL: p.avatar, threadId, allowedMentions: { parse: [] } };

  let text = rawText || '';
  const allFiles = [...files];
  if (text) {
    if (text.includes('```mermaid')) { // render mermaid blocks to images
      const rendered = await renderMermaidInText(text);
      text = rendered.text;
      allFiles.push(...rendered.attachments);
    }
    for (const att of detectLocalMedia(text, cwd).attachments) { // attach workspace media the text mentions
      if (!allFiles.some((f) => f.name === att.name)) allFiles.push(att);
    }
  }

  const parts = text ? smartChunk(text) : [];
  if (parts.length > 3) {
    const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `${agentKey || 'agent'}-report.md` });
    return webhook.send({ ...base, content: `${parts[0]}\n\n${t('longReport')}`, files: [file, ...allFiles], embeds });
  }
  if (!parts.length) return webhook.send({ ...base, embeds, files: allFiles });
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    await webhook.send({ ...base, content: parts[i], embeds: last ? embeds : undefined, files: last ? allFiles : undefined });
  }
}

// ---------- Approval buttons & workspace job cards ----------

const approvalRow = (job) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`approve:${job.id}`).setLabel(t('btn.approve')).setStyle(ButtonStyle.Success).setEmoji('✅'),
  new ButtonBuilder().setCustomId(`reject:${job.id}`).setLabel(t('btn.cancel')).setStyle(ButtonStyle.Danger).setEmoji('🛑'),
);

/** Remove the Approve/Cancel buttons everywhere they were posted (thread + #reports). */
async function closeApproval(job, note) {
  // Refs (channel + message ids) rather than message objects, so this still works after a bot restart
  for (const { channelId, messageId } of job.meta.approvalRefs || []) {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    await ch?.messages.edit(messageId, { content: note, components: [] }).catch(() => {});
  }
  job.meta.approvalRefs = [];
}

const autoTag = (job) => (job.autonomy === 'full' ? '⚡' : '🛡️');
const cardContent = (job) => `${statusLabel(job.status)} · **Job #${job.id}** ${autoTag(job)} · <@${job.userId}>\n> ${job.request.slice(0, 300)}`;

// ---------- Chat interface for the job engine ----------

const chat = {
  // Any job/task state change: dashboard, activity/alert feeds, and the job card when the status changes
  update(job) {
    scheduleDashboard();
    trackJob(job);
    if (job.meta.cardId && job.meta.cardStatus !== job.status) {
      job.meta.cardStatus = job.status;
      client.channels.fetch(job.meta.channelId)
        .then((ch) => ch.messages.edit(job.meta.cardId, { content: cardContent(job), allowedMentions: { parse: [] } }))
        .catch(() => {});
    }
  },

  say: (job, agentKey, text) =>
    post(agentKey, text, { to: job.meta.threadId, cwd: job.cwd }).catch((e) => console.error('post error:', e.message)),

  async showPlan(job) {
    const mode = modeLabel(job.autonomy);
    // Discord rejects a message whose embeds total more than 6000 chars, so every part has a budget
    const embed = new EmbedBuilder()
      .setColor(AGENTS.orchestrator.color)
      .setTitle(t('plan.title', { id: job.id, round: job.round }))
      .setDescription(String(job.plan.summary || '—').slice(0, 1200))
      .setFooter({ text: `📁 ${job.cwd} • ${mode}` });
    if (job.plan.deliverables?.length) {
      embed.addFields({ name: t('plan.deliverables'), value: job.plan.deliverables.map((d) => `• \`${d}\``).join('\n').slice(0, 500) });
    }
    if (job.plan.shared_contract) embed.addFields({ name: t('plan.contract'), value: job.plan.shared_contract.slice(0, 600) });
    const coord = [
      ...job.plan.serialized.map((n) => `🔒 ${n}`),
      ...(job.plan.undeclared.length ? [t('plan.undeclared', { list: job.plan.undeclared.join(', ') })] : []),
      ...job.plan.tasks.filter((x) => x.reassigned).map((x) => t('plan.reassigned', { id: x.id, from: x.reassigned, to: x.agent })),
    ];
    if (coord.length) embed.addFields({ name: t('plan.coord'), value: coord.join('\n').slice(0, 500) });

    const files = [];
    const chartCode = job.plan.architecture?.trim() || buildPlanDiagram(job.plan.tasks);
    const chart = chartCode && (await renderMermaid(chartCode));
    if (chart) {
      files.push(new AttachmentBuilder(chart, { name: 'plan-architecture.png' }));
      embed.setImage('attachment://plan-architecture.png');
    }

    const shown = job.plan.tasks.slice(0, 20);
    const perTask = Math.max(60, Math.floor(2600 / shown.length) - 160); // instructions budget per card
    for (const x of shown) {
      const deps = x.depends_on.length ? ` *(${t('plan.needs')}: ${x.depends_on.join(', ')})*` : '';
      const after = x.after.length ? ` *(${t('plan.after')}: ${x.after.join(', ')})*` : '';
      const owned = x.files.length ? `\n📂 ${x.files.map((f) => `\`${f}\``).join(', ').slice(0, 200)}` : '';
      const instr = x.instructions.length > perTask ? `${x.instructions.slice(0, perTask)}…` : x.instructions;
      embed.addFields({
        name: `[${x.id}] ${AGENTS[x.agent]?.name || x.agent} • ${t(`cx.${x.complexity}`)}`.slice(0, 256),
        value: `**${x.title.slice(0, 120)}**${deps}${after}${owned}\n${instr}`.slice(0, 1024),
      });
    }
    if (job.plan.tasks.length > shown.length) embed.addFields({ name: '…', value: t('plan.more', { n: job.plan.tasks.length - shown.length, round: job.round }) });

    await post('orchestrator', null, { to: job.meta.threadId, embeds: [embed], files, cwd: job.cwd });
    const thread = await client.channels.fetch(job.meta.threadId);
    const inThread = await thread.send({ content: t('plan.ready'), components: [approvalRow(job)] });

    // Short version in #reports so you can approve from the inbox without opening the thread
    const brief = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(t('plan.inboxTitle', { id: job.id, round: job.round }))
      .setDescription(String(job.plan.summary || '').slice(0, 1500))
      .addFields({ name: `${job.plan.tasks.length} task(s)`, value: job.plan.tasks.map((x) => `\`${x.id}\` ${x.agent} — ${x.title}`).join('\n').slice(0, 1024) })
      .setFooter({ text: `📁 ${job.cwd} • ${mode} • ${t('plan.inboxFooter')}` });
    const inInbox = await inbox(job, { embed: brief, components: [approvalRow(job)] }).catch(() => null);
    job.meta.approvalRefs = [inThread, inInbox].filter(Boolean).map((m) => ({ channelId: m.channelId, messageId: m.id }));
  },

  async showReview(job, data) {
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(t('review.title', { id: job.id }))
      .setDescription(String(data.summary || '—').slice(0, 3000))
      .setFooter({ text: `📁 ${job.cwd} • ${modeLabel(job.autonomy)}` });
    if (Array.isArray(data.deliverables) && data.deliverables.length) {
      const list = data.deliverables.map((d) => (typeof d === 'string' ? `• \`${d}\`` : `• **\`${d.file}\`**: ${d.description || ''}`));
      embed.addFields({ name: t('review.deliverables'), value: list.join('\n').slice(0, 1024) });
    }
    if (data.verification) embed.addFields({ name: t('review.verify'), value: `\`\`\`bash\n${String(data.verification).slice(0, 900)}\n\`\`\`` });
    if (Array.isArray(data.next_steps) && data.next_steps.length) {
      embed.addFields({ name: t('review.next'), value: data.next_steps.map((s) => `• ${s}`).join('\n').slice(0, 1024) });
    }
    const media = detectLocalMedia(`${data.summary || ''} ${(data.media_files || []).join(' ')}`, job.cwd);
    const firstImg = media.filesFound.find((f) => ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(f.ext));
    if (firstImg) embed.setImage(`attachment://${firstImg.name}`);

    await post('orchestrator', null, { to: job.meta.threadId, embeds: [embed], files: media.attachments, cwd: job.cwd });
    // Same report in #reports (attachments stay in the thread)
    await inbox(job, { embed: EmbedBuilder.from(embed).setImage(null), dm: true }).catch((e) => console.error('inbox error:', e.message));
  },

  async showPaused(job) {
    const unix = job.pausedUntil && Math.floor(job.pausedUntil / 1000);
    const text = t('paused.text', {
      id: job.id,
      reason: job.pauseReason,
      done: job.plan?.tasks.filter((x) => job.results[x.id]?.ok).length || 0,
      total: job.plan?.tasks.length || 0,
      stage: job.resumeStage,
      when: unix ? `<t:${unix}:R> (<t:${unix}:t>)` : t('paused.unknown'),
    });
    await chat.say(job, null, text);
    const embed = new EmbedBuilder().setColor(0xf39c12).setTitle(t('paused.title', { id: job.id })).setDescription(text.slice(0, 1500)).setFooter({ text: `📁 ${job.cwd}` });
    await inbox(job, { embed, dm: true }).catch((e) => console.error('inbox error:', e.message));
  },

  async showFailure(job, text) {
    await chat.say(job, null, text);
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle(t('failure.title', { id: job.id }))
      .setDescription(`${text.slice(0, 1500)}\n\n${t('failure.hint')}`)
      .setFooter({ text: `📁 ${job.cwd}` });
    await inbox(job, { embed, dm: true }).catch((e) => console.error('inbox error:', e.message));
  },
};

// ---------- Commands ----------

function allowed(userId, guild) {
  if (ALLOWED.length) return ALLOWED.includes(userId);
  return guild?.ownerId === userId;
}

const jobOfThread = (threadId) => [...jobs.values()].find((j) => j.meta.threadId === threadId);
const findJob = (msg, idArg) => (idArg && jobs.get(idArg)) || jobOfThread(msg.channel.id);
const agentList = () => ['orchestrator', ...workerKeys()].join(', ');
const ACTIVE = ['planning', 'awaiting_approval', 'running', 'reviewing', 'paused'];

function helpMessage() {
  const ids = hubIds();
  const ch = (id) => (id ? `<#${id}>` : '');
  return t('help', {
    lobby: ch(ids.lobby), reports: ch(ids.reports), dashboard: ch(ids.dashboard), quota: ch(ids.quota),
    health: ch(ids.health), activity: ch(ids.activity), alerts: ch(ids.alerts),
  });
}

const commands = {
  help: (msg) => reply(msg, helpMessage()),

  async quota(msg) {
    await refreshQuota();
    return reply(msg, { embeds: [quotaEmbed(await ensureOnwatch())] });
  },

  async status(msg) {
    return withHourglass(msg, async () => reply(msg, { embeds: [await healthEmbed()] }));
  },

  async hub(msg) {
    await setupHub(client, channel);
    const ids = hubIds();
    const list = [ids.reports, ids.dashboard, ids.quota, ids.health, ids.activity, ids.alerts, ...listWorkspaces().map((w) => w.channelId)]
      .filter(Boolean).map((id) => `<#${id}>`).join(' ');
    return reply(msg, t('hub.ready', { list }));
  },

  agents(msg) {
    const lines = Object.entries(AGENTS).map(([k, a]) => `${isEnabled(k) ? '🟢' : a.missing ? '🔴' : '⚪'} **${a.name}** \`${k}\` — ${a.runtime}/${a.model}${a.missing ? ` (${a.missing})` : ''}\n   ${a.skills}`);
    return reply(msg, `${t('agents.title')}\n${lines.join('\n')}`);
  },

  jobs(msg) {
    const list = [...jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10).map((j) =>
      `#${j.id} ${autoTag(j)} · **${statusLabel(j.status)}** · ${j.meta.threadId ? `<#${j.meta.threadId}>` : ''} ${j.request.slice(0, 60)}`);
    return reply(msg, list.length ? `${t('jobs.title')}\n${list.join('\n')}` : t('jobs.none'));
  },

  async workspace(msg, rest) {
    const icon = (dir) => (getAutonomyForDir(dir) === 'full' ? '⚡' : '🛡️');
    if (!rest) {
      const list = listWorkspaces().map((w) => `${icon(w.path)} <#${w.channelId}> — \`${w.path}\``).join('\n');
      return reply(msg, t('ws.default', { path: config.cwd, list }));
    }
    const dir = existingDir(rest);
    if (!dir) return reply(msg, t('err.noDir', { dir: rest }));
    const newPath = setWorkspace(dir);
    const wsCh = await workspaceChannel(newPath);
    scheduleDashboard();
    return reply(msg, t('ws.set', { path: newPath, mode: icon(newPath), channel: `${wsCh}` }));
  },

  autonomy(msg, rest) {
    const [sub, ...dirParts] = rest.split(/\s+/);
    const dirArg = dirParts.join(' ').trim();
    if (sub?.toLowerCase() === 'add') {
      if (!dirArg) return reply(msg, t('usage', { usage: '`!autonomy add <path>`' }));
      return reply(msg, t('auto.added', { path: addFullAutonomyDir(dirArg) }));
    }
    if (sub?.toLowerCase() === 'remove') {
      if (!dirArg) return reply(msg, t('usage', { usage: '`!autonomy remove <path>`' }));
      return reply(msg, removeFullAutonomyDir(dirArg) ? t('auto.removed', { path: dirArg }) : t('auto.notFound'));
    }
    const dirs = getFullAutonomyDirs();
    return reply(msg, t('auto.status', {
      path: config.cwd,
      mode: modeLabel(getAutonomyForDir(config.cwd)),
      fallback: process.env.AGENT_AUTONOMY || 'safe',
      list: dirs.length ? dirs.map((d) => `• \`${d}\``).join('\n') : t('auto.none'),
    }));
  },

  model(msg, rest) {
    const [key, newModel] = rest.split(/\s+/);
    if (!key) {
      const list = Object.entries(AGENTS).filter(([k]) => isEnabled(k)).map(([k, a]) => `• **${a.name}** (\`${k}\`): \`${a.model}\``).join('\n');
      return reply(msg, t('model.list', { list }));
    }
    const agentKey = key.toLowerCase();
    if (!AGENTS[agentKey]) return reply(msg, t('err.badAgent', { list: agentList() }));
    if (!newModel) return reply(msg, t('model.current', { name: AGENTS[agentKey].name, model: AGENTS[agentKey].model, key: agentKey }));
    setAgentModel(agentKey, newModel);
    return reply(msg, t('model.set', { name: AGENTS[agentKey].name, model: newModel }));
  },

  files(msg, rest, cwd) {
    const dir = inside(cwd, rest);
    if (!dir) return reply(msg, t('err.outside', { path: rest }));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return reply(msg, t('err.noDir', { dir }));
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const items = entries.slice(0, 30).map((e) => {
      if (e.isDirectory()) return `📁 \`${e.name}/\``;
      let size = '';
      try { size = ` *(${formatBytes(fs.statSync(path.join(dir, e.name)).size)})*`; } catch { /* vanished */ }
      return `${fileIcon(path.extname(e.name))} \`${e.name}\`${size}`;
    });
    const more = entries.length > 30 ? `\n${t('files.more', { n: entries.length - 30 })}` : '';
    return reply(msg, `${t('files.title', { dir })}\n${items.join('\n')}${more}`);
  },

  cat(msg, rest, cwd) {
    if (!rest) return reply(msg, t('usage', { usage: '`!cat <file>`' }));
    const file = inside(cwd, rest);
    if (!file) return reply(msg, t('err.outside', { path: rest }));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return reply(msg, t('err.noFile', { file: rest }));
    const name = path.basename(file);
    const ext = path.extname(file).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      return reply(msg, { embeds: [new EmbedBuilder().setTitle(`🖼️ ${name}`).setImage(`attachment://${name}`)], files: [new AttachmentBuilder(file, { name })] });
    }
    if (['.mp3', '.wav', '.ogg', '.m4a', '.pdf', '.zip'].includes(ext)) return reply(msg, { content: `${fileIcon(ext)} \`${name}\``, files: [new AttachmentBuilder(file, { name })] });
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.length > 1800) {
        return reply(msg, { content: t('cat.big', { name, size: formatBytes(fs.statSync(file).size) }), files: [new AttachmentBuilder(Buffer.from(content, 'utf8'), { name })] });
      }
      return reply(msg, `📄 **\`${name}\`**:\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\``);
    } catch (e) {
      return reply(msg, t('cat.binary', { msg: e.message }));
    }
  },

  diff(msg, rest, cwd) {
    return withHourglass(msg, async () => {
      try {
        const { stdout: status } = await execAsync('git status -s', { cwd, timeout: 5000 });
        if (!status.trim()) return reply(msg, t('diff.clean'));
        const { stdout: diff } = await execAsync('git diff', { cwd, timeout: 5000, maxBuffer: 20 * 1024 * 1024 });
        const body = diff.trim() || status;
        if (body.length > 1800) {
          return reply(msg, { content: `📊 **git status**\n\`\`\`\n${status.slice(0, 1500)}\n\`\`\`\n${t('diff.attached')}`, files: [new AttachmentBuilder(Buffer.from(body, 'utf8'), { name: 'git-diff.patch' })] });
        }
        return reply(msg, `📊 **git diff**\n\`\`\`diff\n${body}\n\`\`\``);
      } catch (e) {
        return reply(msg, t('diff.noGit', { msg: e.message.slice(0, 300) }));
      }
    });
  },

  run(msg, rest, cwd) {
    if (!rest) return reply(msg, t('usage', { usage: '`!run <command>`' }));
    if (getAutonomyForDir(cwd) !== 'full') return reply(msg, t('run.safe', { path: cwd }));
    return withHourglass(msg, async () => {
      const started = Date.now();
      try {
        const { stdout, stderr } = await execAsync(rest, { cwd, timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const out = (stdout || stderr || t('run.noOutput')).trim();
        if (out.length > 1800) return reply(msg, { content: `💻 **[${secs}s]** ${t('run.long')}`, files: [new AttachmentBuilder(Buffer.from(out, 'utf8'), { name: 'output.log' })] });
        return reply(msg, `💻 **[${secs}s]**\n\`\`\`\n${out}\n\`\`\``);
      } catch (err) {
        return reply(msg, `${t('run.error', { code: err.code })}\n\`\`\`\n${(err.stderr || err.message).slice(-1700)}\n\`\`\``);
      }
    });
  },

  export(msg, rest) {
    const job = findJob(msg, rest);
    if (!job) return reply(msg, t('err.noJob'));
    const lines = [
      t('export.title', { id: job.id }),
      `${t('export.request')} ${job.request}`,
      `${t('export.status')} ${job.status} (round ${job.round})`,
      `${t('export.workspace')} ${job.cwd}`,
      `${t('export.time')} ${new Date().toLocaleString()}`,
      '', t('export.plan'), job.plan?.summary || t('export.none'), '', t('export.tasks'),
    ];
    for (const [id, r] of Object.entries(job.results)) {
      lines.push(`### [${id}] — ${r.ok ? t('export.ok') : t('export.fail')}`, r.text || (r.stderr || '').slice(-4000) || t('export.none'), '');
    }
    return reply(msg, { content: t('export.done', { id: job.id }), files: [new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: `job-${job.id}.md` })] });
  },

  async clean(msg) {
    const active = [...jobs.values()].filter((j) => ACTIVE.includes(j.status));
    for (const j of active) {
      await cancel(j);
      await closeApproval(j, t('cancel.done', { id: j.id }));
    }
    return reply(msg, t('clean.done', { n: active.length }));
  },

  broadcast(msg, rest) {
    if (!rest) return reply(msg, t('usage', { usage: '`!broadcast <text>`' }));
    return post(null, t('broadcast', { text: rest }));
  },

  async task(msg, rest, cwd) {
    if (!rest) return reply(msg, t('usage', { usage: '`!task <request>` / `!task in <folder>: <request>`' }));
    if (msg.channel.isThread()) return reply(msg, t('task.inThread'));
    if (!isEnabled('orchestrator')) return reply(msg, t('err.noOrchestrator'));
    let request = rest;
    let target = cwd;
    // "in <dir>: <request>" — the separator is ": " so Windows drive letters (C:\...) survive
    const mDir = rest.match(/^in\s+(.+?):\s+([\s\S]+)$/i);
    if (mDir) {
      target = existingDir(mDir[1].trim());
      if (!target) return reply(msg, t('err.noDir', { dir: mDir[1].trim() }));
      request = mDir[2].trim();
    }
    // Every job lives as a thread under its workspace channel, opened from a status card
    const wsCh = await workspaceChannel(target);
    const job = createJob({ request, userId: msg.author.id, chat, cwd: target });
    const card = await wsCh.send({ content: cardContent(job), allowedMentions: { parse: [] } });
    const thread = await card.startThread({ name: `#${job.id} ${autoTag(job)} ${request.replace(/\s+/g, ' ').slice(0, 80)}`, autoArchiveDuration: 1440 });
    await thread.members.add(msg.author.id).catch(() => {}); // so you get thread notifications
    Object.assign(job.meta, { threadId: thread.id, channelId: wsCh.id, cardId: card.id, cardStatus: job.status });
    if (wsCh.id !== msg.channel.id) await reply(msg, t('task.opened', { id: job.id, thread: `${thread}`, ws: `${wsCh}` }));
    return plan(job);
  },

  async revise(msg, rest) {
    const job = findJob(msg);
    if (!job || job.status !== 'awaiting_approval') return reply(msg, t('revise.none'));
    if (!rest) return reply(msg, t('usage', { usage: '`!revise <feedback>`' }));
    await closeApproval(job, t('revise.closed'));
    return plan(job, { feedback: rest });
  },

  async resume(msg, rest) {
    const job = findJob(msg, rest);
    if (!job || job.status !== 'paused') return reply(msg, t('resume.none'));
    await resume(job, { force: true });
    return msg.react('▶️');
  },

  async approve(msg, rest) {
    const job = findJob(msg, rest);
    if (!job || !(await approve(job))) return reply(msg, t('approve.none'));
    await closeApproval(job, t('approve.done', { user: msg.author.id, round: job.round }));
    return chat.say(job, null, t('approve.say', { user: msg.author.id }));
  },

  async cancel(msg, rest) {
    const job = findJob(msg, rest);
    if (!job) return reply(msg, t('err.noJob'));
    await cancel(job);
    await closeApproval(job, t('cancel.done', { id: job.id }));
    return chat.say(job, null, t('cancel.done', { id: job.id }));
  },

  async ask(msg, rest, cwd) {
    const [agentKey, ...q] = rest.split(/\s+/);
    if (!isEnabled(agentKey)) return reply(msg, t('err.badAgent', { list: agentList() }));
    if (!q.length) return reply(msg, t('usage', { usage: '`!ask <agent> <question>`' }));
    return withHourglass(msg, async () => {
      const res = await askDirect(agentKey, q.join(' '), cwd);
      await post(agentKey, res.text || `❌ ${(res.stderr || t('ask.noReply')).slice(-1500)}`, { to: msg.channel.id, cwd });
    });
  },
};
const ALIASES = { stats: 'status', ls: 'files', read: 'cat', exec: 'run', reject: 'cancel' };

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || msg.webhookId || !isHubChannel(msg.channel)) return;
  const m = msg.content.match(/^!(\w+)\s*([\s\S]*)$/);
  if (!m) return;
  const name = ALIASES[m[1].toLowerCase()] || m[1].toLowerCase();
  const handler = Object.hasOwn(commands, name) && commands[name];
  if (!handler) return;
  if (!allowed(msg.author.id, msg.guild)) return reply(msg, t('err.permission'));
  const cwd = workspaceOf(msg.channel) || config.cwd; // a workspace channel (or its threads) works in its own folder
  try {
    await handler(msg, m[2].trim(), cwd);
  } catch (e) {
    console.error(e);
    await reply(msg, t('err.system', { msg: e.message })).catch(() => {});
  }
});

// ---------- Approve / Cancel buttons ----------

client.on('interactionCreate', async (i) => {
  if (!i.isButton()) return;
  const [action, id] = i.customId.split(':');
  if (!allowed(i.user.id, i.guild)) return i.reply({ content: t('err.permission'), flags: MessageFlags.Ephemeral });
  const job = jobs.get(id);
  if (!job) return i.reply({ content: t('button.gone'), flags: MessageFlags.Ephemeral });

  // The same buttons sit in the job thread and in #reports: clear both, whichever was clicked
  if (action === 'approve') {
    if (!(await approve(job))) return i.reply({ content: t('approve.badState', { status: statusLabel(job.status) }), flags: MessageFlags.Ephemeral });
    await i.deferUpdate();
    await closeApproval(job, t('approve.done', { user: i.user.id, round: job.round }));
  } else {
    await cancel(job);
    await i.deferUpdate();
    await closeApproval(job, t('cancel.by', { id: job.id, user: i.user.id }));
  }
});

// ---------- Startup ----------

client.once('clientReady', async () => {
  channel = await client.channels.fetch(CHANNEL_ID);
  await setupHub(client, channel);

  // Bring back jobs from before the restart; ones that were mid-flight wait for a fresh approval to resume
  const interrupted = restoreJobs([...new Set([config.cwd, ...listWorkspaces().map((w) => w.path)])], chat);
  for (const job of interrupted) {
    if (job.status === 'awaiting_approval') {
      await chat.say(job, null, t('restart.resume', { stage: job.interruptedFrom }));
      await chat.showPlan(job).catch((e) => console.error('resume plan:', e.message));
    } else {
      await chat.showFailure(job, t('restart.failed', { id: job.id })).catch(() => {});
    }
  }
  scheduleDashboard();

  const mode = modeLabel(getAutonomyForDir(config.cwd));
  console.log(`✅ Logged in as ${client.user.tag} · #${channel.name} · workspace ${config.cwd} · ${mode}`);
  if (!ALLOWED.length) console.warn('⚠️  ALLOWED_USER_IDS is not set -> only the server owner can run commands.');
  if (!isEnabled('orchestrator')) console.warn('⚠️  Claude Code CLI not found: the Orchestrator cannot plan. Run `npm run doctor`.');
  logActivity(t('act.botUp', { n: workerKeys().length + (isEnabled('orchestrator') ? 1 : 0) }));
  const ids = hubIds();
  await post(null, t('online', {
    orchestrator: AGENTS.orchestrator.model,
    workers: workerKeys().map((k) => `\`${k}\``).join(', ') || '—',
    path: config.cwd, mode, dashboard: `<#${ids.dashboard}>`, reports: `<#${ids.reports}>`,
  }));
});

client.login(DISCORD_TOKEN);
