// Setup wizard and health check.
//   npm run setup    interactive: language, Discord bot, channel, users, workspace -> writes .env, then runs the checks
//   npm run doctor   checks only: Node, .env, Discord token/intent/permissions/channel, agent CLIs, onWatch
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { scanMachine } from '../src/scan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');
const API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 1n << 3n;
const NEEDED = { // permission bit -> name (all included in Administrator)
  4: 'Manage Channels', 28: 'Manage Roles', 29: 'Manage Webhooks', 13: 'Manage Messages', 10: 'View Channels',
  11: 'Send Messages', 38: 'Send Messages in Threads', 35: 'Create Public Threads', 14: 'Embed Links',
  15: 'Attach Files', 16: 'Read Message History', 6: 'Add Reactions',
};
const MESSAGE_CONTENT_INTENT = (1 << 18) | (1 << 19); // GATEWAY_MESSAGE_CONTENT(_LIMITED) application flags

let lang = 'en';
const L = (en, vi) => (lang === 'vi' ? vi : en);
const ok = (s) => console.log(`  ✅ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const bad = (s) => { console.log(`  ❌ ${s}`); bad.count = (bad.count || 0) + 1; };

function readEnv() {
  if (!fs.existsSync(ENV)) return {};
  return Object.fromEntries(fs.readFileSync(ENV, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
}

/** Fill .env.example with `values` (keeping its comments), plus any extra keys already in .env. */
function writeEnv(values) {
  const template = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const used = new Set();
  let out = template.replace(/^([A-Z0-9_]+)=.*$/gm, (line, k) => {
    used.add(k);
    return k in values ? `${k}=${values[k]}` : line;
  });
  const extra = Object.entries(values).filter(([k]) => !used.has(k));
  if (extra.length) out += `\n# --- Other settings ---\n${extra.map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
  if (fs.existsSync(ENV)) fs.copyFileSync(ENV, `${ENV}.bak`);
  fs.writeFileSync(ENV, out);
}

const discord = (token, p) => fetch(API + p, { headers: { Authorization: `Bot ${token}` } })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const invite = (appId) => `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=8`;

// ---------- checks ----------

async function checkDiscord(env) {
  console.log('\nDiscord');
  if (!env.DISCORD_TOKEN) return bad(L('DISCORD_TOKEN is empty', 'DISCORD_TOKEN đang trống'));
  const me = await discord(env.DISCORD_TOKEN, '/users/@me');
  if (me.status !== 200) return bad(L(`token rejected (HTTP ${me.status}) — reset it in the Developer Portal`, `token bị từ chối (HTTP ${me.status}) — tạo lại trong Developer Portal`));
  ok(L(`logged in as ${me.body.username} (${me.body.id})`, `đăng nhập là ${me.body.username} (${me.body.id})`));

  const app = await discord(env.DISCORD_TOKEN, '/applications/@me');
  if (app.status === 200 && !(app.body.flags & MESSAGE_CONTENT_INTENT)) {
    bad(L('Message Content Intent is OFF — Developer Portal → Bot → Privileged Gateway Intents', 'Message Content Intent đang TẮT — Developer Portal → Bot → Privileged Gateway Intents'));
  } else if (app.status === 200) ok('Message Content Intent');

  if (!env.CHANNEL_ID) return bad(L('CHANNEL_ID is empty', 'CHANNEL_ID đang trống'));
  const ch = await discord(env.DISCORD_TOKEN, `/channels/${env.CHANNEL_ID}`);
  if (ch.status !== 200) {
    bad(L(`cannot see channel ${env.CHANNEL_ID} (HTTP ${ch.status}). Invite the bot: ${invite(me.body.id)}`, `không thấy kênh ${env.CHANNEL_ID} (HTTP ${ch.status}). Mời bot: ${invite(me.body.id)}`));
    return;
  }
  ok(L(`lobby channel #${ch.body.name}`, `kênh lobby #${ch.body.name}`));

  const [guild, member] = await Promise.all([
    discord(env.DISCORD_TOKEN, `/guilds/${ch.body.guild_id}`),
    discord(env.DISCORD_TOKEN, `/guilds/${ch.body.guild_id}/members/${me.body.id}`),
  ]);
  if (guild.status !== 200 || member.status !== 200) return warn(L('could not read the bot permissions', 'không đọc được quyền của bot'));
  const roles = new Map(guild.body.roles.map((r) => [r.id, BigInt(r.permissions)]));
  let perms = roles.get(guild.body.id) || 0n; // @everyone
  for (const id of member.body.roles) perms |= roles.get(id) || 0n;
  if (perms & ADMINISTRATOR) return ok(L(`server "${guild.body.name}": Administrator`, `server "${guild.body.name}": Administrator`));
  const missing = Object.entries(NEEDED).filter(([bit]) => !(perms & (1n << BigInt(bit)))).map(([, n]) => n);
  if (missing.length) bad(L(`missing permissions: ${missing.join(', ')} (simplest: give the bot role Administrator)`, `thiếu quyền: ${missing.join(', ')} (đơn giản nhất: cấp Administrator cho role của bot)`));
  else ok(L('permissions', 'quyền hạn'));
}

function checkAgents() {
  console.log(L('\nAgent CLIs (auto-detected)', '\nCLI của agent (tự dò)'));
  const scan = scanMachine();
  const rows = [
    ['claude', 'Claude Code → orchestrator, sonnet, haiku', 'npm i -g @anthropic-ai/claude-code && claude'],
    ['agy', 'Antigravity → gemini-flash', 'https://antigravity.google'],
    ['codex', `Codex → deepseek-flash${scan.codexProviders.length ? ` (providers: ${scan.codexProviders.join(', ')})` : ''}`, 'npm i -g @openai/codex'],
  ];
  for (const [cmd, label, how] of rows) {
    if (scan.cli[cmd]) ok(`${label} — ${scan.cli[cmd]}`);
    else if (cmd === 'claude') bad(`${label} — ${L('not found (required for the Orchestrator)', 'không tìm thấy (bắt buộc cho Orchestrator)')}: ${how}`);
    else warn(`${label} — ${L('not found (optional)', 'không tìm thấy (tùy chọn)')}: ${how}`);
  }
  if (scan.cli.codex && !scan.codexProviders.includes('deepseek')) {
    warn(L('deepseek-flash needs a [model_providers.deepseek] entry in ~/.codex/config.toml', 'deepseek-flash cần mục [model_providers.deepseek] trong ~/.codex/config.toml'));
  }
  return scan;
}

async function doctor() {
  const env = readEnv();
  console.log(L('\nAI Chatroom — health check', '\nAI Chatroom — kiểm tra'));
  console.log('\nSystem');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.version}`);
  else bad(L(`Node ${process.version} — need 22.13+ (node:sqlite)`, `Node ${process.version} — cần 22.13+ (node:sqlite)`));
  if (!fs.existsSync(ENV)) bad(L('.env missing — run `npm run setup`', 'thiếu .env — chạy `npm run setup`'));
  else ok('.env');
  const ws = path.resolve(ROOT, env.WORKSPACE_DIR || 'workspace');
  ok(L(`workspace ${ws}${fs.existsSync(ws) ? '' : ' (will be created)'}`, `workspace ${ws}${fs.existsSync(ws) ? '' : ' (sẽ được tạo)'}`));
  if (!env.ALLOWED_USER_IDS) warn(L('ALLOWED_USER_IDS empty: only the server owner can command the bot', 'ALLOWED_USER_IDS trống: chỉ chủ server ra lệnh được'));
  await checkDiscord(env);
  checkAgents();

  console.log('\nonWatch');
  if (fs.existsSync(path.join(os.homedir(), '.onwatch'))) ok(L('installed — quota panel and auto-pause enabled', 'đã cài — bật bảng quota và tự tạm dừng khi hết quota'));
  else warn(L('not installed (optional): quota panel and quota-aware pausing are off', 'chưa cài (tùy chọn): tắt bảng quota và tạm dừng theo quota'));
  const running = await new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(true)).listen(Number(env.BOT_LOCK_PORT || 47821), '127.0.0.1', () => s.close(() => resolve(false)));
  });
  console.log(`\n${L('Bot', 'Bot')}: ${running ? L('🟢 running', '🟢 đang chạy') : L('⚪ not running — `npm start`', '⚪ chưa chạy — `npm start`')}`);
  console.log(bad.count ? L(`\n${bad.count} problem(s) to fix.`, `\n${bad.count} vấn đề cần sửa.`) : L('\nAll good.', '\nỔn cả.'));
  return !bad.count;
}

// ---------- wizard ----------

async function wizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator](); // line queue: also works when answers are piped in
  const env = readEnv();
  const ask = async (q, def = '', secret = false) => {
    const shown = def && (secret ? `…${def.slice(-4)}` : def); // never echo a stored token
    process.stdout.write(`${q}${shown ? ` [${shown}]` : ''}: `);
    const { value, done } = await lines.next();
    if (!process.stdin.isTTY) process.stdout.write('\n');
    return (done ? '' : value).trim() || def;
  };

  lang = (await ask('Language / Ngôn ngữ (en/vi)', env.LANGUAGE || 'en')).toLowerCase().startsWith('vi') ? 'vi' : 'en';
  console.log(L(`
1) https://discord.com/developers/applications → New Application → Bot → Reset Token (copy it)
2) Same page: turn ON "Message Content Intent"`, `
1) https://discord.com/developers/applications → New Application → Bot → Reset Token (sao chép)
2) Cùng trang: bật "Message Content Intent"`));
  const token = await ask('DISCORD_TOKEN', env.DISCORD_TOKEN, true);
  const me = await discord(token, '/users/@me');
  if (me.status !== 200) {
    console.log(L(`❌ token rejected (HTTP ${me.status})`, `❌ token bị từ chối (HTTP ${me.status})`));
    rl.close();
    process.exit(1);
  }
  console.log(L(`✅ ${me.body.username}. Invite it to your server (Administrator):\n   ${invite(me.body.id)}`, `✅ ${me.body.username}. Mời bot vào server (Administrator):\n   ${invite(me.body.id)}`));
  console.log(L('\nDiscord → Settings → Advanced → Developer Mode ON, then right-click to "Copy ID".', '\nDiscord → Settings → Advanced → bật Developer Mode, rồi chuột phải → "Copy ID".'));
  const channelId = await ask(L('Lobby channel ID (the bot builds the rest of the hub around it)', 'ID kênh lobby (bot dựng phần còn lại của hub quanh kênh này)'), env.CHANNEL_ID);
  const users = await ask(L('Your Discord user ID(s), comma separated', 'User ID Discord của bạn (cách nhau bằng dấu phẩy)'), env.ALLOWED_USER_IDS);
  const workspace = await ask(L('Default workspace folder', 'Thư mục workspace mặc định'), env.WORKSPACE_DIR || './workspace');
  const autonomy = await ask(L('Let agents run shell commands in the workspace without asking? (y/n)', 'Cho agent chạy lệnh terminal trong workspace không cần hỏi? (y/n)'), env.FULL_AUTONOMY_DIRS ? 'y' : 'n');
  rl.close();

  checkAgents();
  writeEnv({
    ...env,
    LANGUAGE: lang,
    CHAT_LANGUAGE: '', // agents report in the UI language
    DISCORD_TOKEN: token,
    CHANNEL_ID: channelId,
    ALLOWED_USER_IDS: users,
    WORKSPACE_DIR: workspace,
    FULL_AUTONOMY_DIRS: autonomy.toLowerCase().startsWith('y') ? workspace : '',
  });
  console.log(L(`\n.env written${fs.existsSync(`${ENV}.bak`) ? ' (previous one saved as .env.bak)' : ''}.`, `\nĐã ghi .env${fs.existsSync(`${ENV}.bak`) ? ' (bản cũ lưu ở .env.bak)' : ''}.`));
  const good = await doctor();
  if (good) console.log(L('\nStart it with: npm start', '\nChạy bot: npm start'));
}

lang = (readEnv().LANGUAGE || 'en').startsWith('vi') ? 'vi' : 'en';
if (process.argv.includes('--check')) process.exit((await doctor()) ? 0 : 1);
else await wizard();
