// onWatch integration: keep the onWatch daemon alive and read its latest quotas straight from its SQLite db (read-only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AGENTS } from './agents.js';
import { t } from './i18n.js';

const HOME = process.env.ONWATCH_HOME || path.join(os.homedir(), '.onwatch');
const EXE = path.join(HOME, 'bin', process.platform === 'win32' ? 'onwatch.exe' : 'onwatch');
const DB = path.join(HOME, 'data', 'onwatch.db');
export const ONWATCH_URL = `http://127.0.0.1:${process.env.ONWATCH_PORT || 9211}`;
export const onwatchInstalled = () => fs.existsSync(EXE);

const isUp = () => fetch(ONWATCH_URL, { redirect: 'manual', signal: AbortSignal.timeout(3000) }).then(() => true, () => false);

/** Start onWatch if its dashboard isn't answering. Returns 'up' | 'started' | 'missing'. */
export async function ensureOnwatch() {
  if (!onwatchInstalled()) return 'missing';
  if (await isUp()) return 'up';
  // cwd = ~/.onwatch so it picks up its own .env, exactly like onwatch.cmd does
  spawn(EXE, [], { cwd: HOME, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return 'started';
}


/**
 * Latest snapshot per provider.
 * rows: { provider, name, left (% remaining), resetsAt, at }   balances: { provider, name, value, ok, at }
 */
export function readQuotas() {
  if (!fs.existsSync(DB)) return null;
  const db = new DatabaseSync(DB, { readOnly: true });
  const all = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } }; // table may not exist in older onWatch versions
  try {
    const rows = [];
    // Providers that report "utilization %" per quota
    for (const [table, provider] of [['anthropic', 'Claude'], ['codex', 'Codex']]) {
      for (const r of all(`select v.quota_name n, v.utilization u, v.resets_at r, s.captured_at c
        from ${table}_quota_values v join ${table}_snapshots s on s.id = v.snapshot_id
        where s.id = (select max(id) from ${table}_snapshots)`)) {
        rows.push({ provider, name: t(`q.${r.n}`) === `q.${r.n}` ? r.n : t(`q.${r.n}`), left: 100 - r.u, resetsAt: r.r, at: r.c });
      }
    }
    for (const r of all(`select v.label n, v.remaining_percent p, v.is_exhausted x, v.reset_time r, s.captured_at c
      from antigravity_model_values v join antigravity_snapshots s on s.id = v.snapshot_id
      where s.id = (select max(id) from antigravity_snapshots)`)) {
      rows.push({ provider: 'Antigravity', name: r.n, left: r.x ? 0 : r.p, resetsAt: r.r, at: r.c });
    }
    const balances = all('select captured_at c, is_available a, currency cur, total_balance b from deepseek_snapshots order by id desc limit 1')
      .map((d) => ({ provider: 'DeepSeek', name: t('quota.balance'), value: `${d.b} ${d.cur}`, ok: !!d.a, at: d.c }));
    return { rows, balances };
  } finally {
    db.close();
  }
}

// ---------- Quota gate for the job engine ----------


const STOP_PCT = Number(process.env.QUOTA_STOP_PCT || 2); // don't start work on a quota with less left than this

/** onWatch rows that limit an agent (by the CLI/provider it runs on). */
function rowsFor(agentKey, data) {
  const a = AGENTS[agentKey];
  if (!a || !data) return { rows: [], balance: null };
  if (a.runtime === 'claude') return { rows: data.rows.filter((r) => r.provider === 'Claude'), balance: null };
  if (a.runtime === 'agy') return { rows: data.rows.filter((r) => r.provider === 'Antigravity' && /gemini/i.test(r.name)), balance: null };
  const provider = (a.codexArgs || []).find((x) => x.startsWith('model_provider='))?.split('=')[1];
  if (provider === 'deepseek') return { rows: [], balance: data.balances.find((b) => b.provider === 'DeepSeek') || null };
  return { rows: data.rows.filter((r) => r.provider === 'Codex'), balance: null };
}

/**
 * Is this agent out of quota according to onWatch? Returns null when it may work, otherwise
 * { until: epoch ms of the reset, or null when unknown (e.g. a prepaid balance at 0), reason }.
 */
export function quotaBlock(agentKey) {
  let data = null;
  try { data = readQuotas(); } catch { return null; } // no onWatch -> rely on error detection only
  const { rows, balance } = rowsFor(agentKey, data);
  const now = Date.now();
  const out = rows.filter((r) => r.left <= STOP_PCT && !(r.resetsAt && Date.parse(r.resetsAt) <= now)); // a passed reset = refilled
  if (out.length) {
    const until = Math.max(...out.map((r) => Date.parse(r.resetsAt) || 0)) || null;
    return { until, reason: out.map((r) => t('q.leftReason', { provider: r.provider, name: r.name, pct: Math.round(r.left) })).join(', ') };
  }
  if (balance && (!balance.ok || parseFloat(balance.value) <= 0)) return { until: null, reason: t('q.balanceReason', { value: balance.value }) };
  return null;
}

const QUOTA_ERROR = /usage limit|rate[ _-]?limit|quota|limit reached|limit exceeded|too many requests|\b429\b|insufficient[_ ](balance|credits|quota)|credit balance|out of credits|resource[_ ]exhausted|RESOURCE_EXHAUSTED|try again (later|in)|resets? (at|in)/i;

/**
 * Does a FAILED run look like it hit a quota? Only call this on failures: a successful report may well talk about
 * quotas. Returns null or { until: epoch ms if the message says when it resets, else null }.
 */
export function quotaError(text) {
  const msg = String(text || '').slice(-6000);
  if (!QUOTA_ERROR.test(msg)) return null;
  const epoch = msg.match(/limit reached\|(\d{10})/i); // Claude Code: "Claude AI usage limit reached|1760000000"
  if (epoch) return { until: Number(epoch[1]) * 1000 };
  const secs = msg.match(/(?:try again|retry|resets?) in (\d+)\s*(s|sec|seconds|m|min|minutes|h|hours?)\b/i);
  if (secs) {
    const unit = secs[2][0].toLowerCase();
    return { until: Date.now() + Number(secs[1]) * (unit === 'h' ? 3600e3 : unit === 'm' ? 60e3 : 1e3) };
  }
  const iso = msg.match(/(?:resets?|until|after)\s*(?:at)?\s*(\d{4}-\d\d-\d\dT[\d:.]+Z?)/i);
  if (iso && Date.parse(iso[1]) > Date.now()) return { until: Date.parse(iso[1]) };
  return { until: null };
}
