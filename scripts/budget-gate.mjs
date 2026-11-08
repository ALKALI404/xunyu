#!/usr/bin/env node
// scripts/budget-gate.mjs —— 日预算闸（UG-026）：到阈值自动降级
//
// 背景（审计 #11）：预算一直"有报无闸"，主人今晚只剩 ¥30 才知道要省。
//
// ═══ 接口契约（改实现前先改这里）═══════════════════════════════════════════
// 状态：budgetGate({ now, spentOverride, file, lockFile, alertsFile, enforce, noAct }) -> {
//   locked:boolean, level:'ok'|'soft'|'hard', spent, soft, hard, currency, day,
//   lock:{day,at,spent,hard,reason}|null, enforced:boolean, cached:boolean,
//   expiredLock:boolean, reason:string
// }
//   · 花费口径**只认 cost-core.mjs**（本文件不算钱）
//   · 锁 = 文件 state\budget-lock **存在且属于今天**；隔天自动失效（不让人第二天被昨天的锁卡住）
//   · BUDGET_ENFORCE=0 → 永远 locked:false（回滚开关，闸门整体关）
// 动作：budgetAct({...}) -> { actions:[{type,...}] }
//   soft  → 写 state\budget-alerts.jsonl（一天一条）+ 邮件通知本体
//   hard  → 同上 + 写 state\budget-lock（存在即锁）
//   人工放行：node scripts\budget-unlock.mjs --reason "…"（删锁 + 记审计）
// 命令：node scripts\budget-gate.mjs [--simulate <金额>] [--json] [--check]
//   退出码：0 未锁 ｜ 1 已锁（便于外部脚本判）｜ 2 用法
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectCost } from './cost-core.mjs';   // 花费口径只有这一个（D68 cost-core）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');

export const BUDGET_FILE = path.join(WORKSPACE, 'state', 'budget.json');
export const LOCK_FILE = path.join(WORKSPACE, 'state', 'budget-lock');
export const ALERTS_FILE = path.join(WORKSPACE, 'state', 'budget-alerts.jsonl');
const DEFAULT_SOFT = 25;
const DEFAULT_HARD = 40;
const CACHE_MS = Number(process.env.BUDGET_CACHE_MS ?? 60000);

/** 北京时间的今天（YYYY-MM-DD）——和 cost-core 的日切口径一致 */
export function todayText(ms = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(ms));
}

function readJson(p, dflt = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; }
}

function readConfig() {
  const j = readJson(BUDGET_FILE, null) ?? {};
  return {
    soft: Number(process.env.BUDGET_SOFT ?? j.soft ?? DEFAULT_SOFT),
    hard: Number(process.env.BUDGET_HARD ?? j.hard ?? DEFAULT_HARD),
    currency: String(j.currency ?? 'CNY'),
    enforce: String(process.env.BUDGET_ENFORCE ?? j.enforce ?? '1') !== '0'
  };
}

function readLock() {
  const j = readJson(LOCK_FILE, null);
  if (!j) return null;
  try { fs.accessSync(LOCK_FILE); } catch { return null; }
  return j;
}

// 花费缓存：cost-core 一次约 290ms，dispatch 不该每次都付这个钱
let cache = { at: 0, day: null, spent: null };

function spentTodayCached({ now = Date.now() } = {}) {
  const day = todayText(now);
  if (cache.day === day && now - cache.at < CACHE_MS && cache.spent != null) return { spent: cache.spent, cached: true };
  let spent = null;
  try {
    const r = collectCost({ by: 'day' });
    const row = (r?.days ?? []).find((d) => String(d.day) === day);
    spent = row ? Number(row.cost) : 0;
  } catch { spent = null; }
  cache = { at: now, day, spent };
  return { spent, cached: false };
}


/** 只读判定（不写任何文件） */
export function budgetGate({ now = Date.now(), spentOverride = null, enforceOverride = null } = {}) {
  const cfg = readConfig();
  const day = todayText(now);
  const lock = readLock();
  const lockToday = Boolean(lock && String(lock.day ?? '') === day);
  const expiredLock = Boolean(lock && !lockToday);
  let spent = 0;
  let cached = false;
  if (lockToday) {
    // 快路径：已经锁着就不必再算钱（省 290ms），锁里的 spent 就是当时的数
    spent = Number(lock.spent ?? 0);
  } else if (spentOverride != null) {
    spent = Number(spentOverride);
  } else {
    const r = spentTodayCached({ now });
    spent = r.spent == null ? 0 : r.spent;
    cached = r.cached;
  }
  const enforced = enforceOverride == null ? cfg.enforce : Boolean(enforceOverride);
  const hard = cfg.hard;
  const soft = cfg.soft;
  const level = spent >= hard ? 'hard' : (spent >= soft ? 'soft' : 'ok');
  const locked = enforced && (lockToday || (spentOverride != null && spent >= hard));
  return {
    locked, level, spent, soft, hard, currency: cfg.currency, day,
    lock: lockToday ? lock : null, lockDay: lock?.day ?? null, expiredLock,
    enforced, cached,
    reason: !enforced ? 'BUDGET_ENFORCE=0（闸门关着）'
      : locked ? (lockToday ? String(lock.reason ?? '桶到阈值自动锁') : `模拟花费 ¥${spent.toFixed(2)} ≥ hard ¥${hard}`)
        : expiredLock ? `昨天的锁（${lock.day}）已自动失效`
          : level === 'soft' ? `已过 soft ¥${soft}（当前 ¥${spent.toFixed(2)}），只告警` : `今日 ¥${spent.toFixed(2)}，未到 soft ¥${soft}`
  };
}

function appendAlert(rec) {
  try {
    fs.mkdirSync(path.dirname(ALERTS_FILE), { recursive: true });
    fs.appendFileSync(ALERTS_FILE, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch { /* ignore */ }
}

function readAlerts() {
  try {
    return fs.readFileSync(ALERTS_FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function postMail(to, body, level = '通知') {
  try {
    execFileSync(process.execPath, [path.join(WORKSPACE, 'scripts', 'mail.mjs'), 'post', '--to', to, '--from', '本体', '--level', level, '--body', body], { stdio: 'pipe' });
    const lines = fs.readFileSync(path.join('E:/DeepFish/Xunyu/memory/mail', 'mailbox.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.length ? Number(JSON.parse(lines[lines.length - 1]).seq) || null : null;
  } catch { return null; }
}

/** 执行动作：soft 告警 / hard 锁 + 告警；同一级别一天只发一次 */
export function budgetAct({ now = Date.now(), spentOverride = null, dry = false, mailFn = null, quiet = false } = {}) {
  const g = budgetGate({ now, spentOverride });
  const actions = [];
  const alerts = readAlerts();
  const already = (lv) => alerts.some((a) => a.day === g.day && a.level === lv);
  if (g.expiredLock && !dry) {
    try { fs.rmSync(LOCK_FILE, { force: true }); } catch { /* ignore */ }
    appendAlert({ at: now, day: g.day, level: 'expired', lockDay: g.lockDay, note: '跨天的锁自动失效' });
    actions.push({ type: 'expired', lockDay: g.lockDay });
  }
  const mail = (to, body, lv) => (dry ? null : (mailFn ?? postMail)(to, body, lv));

  if (g.level === 'soft' && !already('soft')) {
    const seq = mail('本体', `【预算告警·soft】今日已花 ¥${g.spent.toFixed(2)}（soft ¥${g.soft} / hard ¥${g.hard}）\n还没锁，只是提醒：再花 ¥${(g.hard - g.spent).toFixed(2)} 就会自动停派。`, '通知');
    if (!dry) appendAlert({ at: now, day: g.day, level: 'soft', spent: g.spent, soft: g.soft, hard: g.hard, mailSeq: seq });
    actions.push({ type: 'soft-alert', spent: g.spent, mailSeq: seq });
  }
  if (g.level === 'hard') {
    if (!g.lock && !dry) {
      const rec = { day: g.day, at: now, spent: g.spent, soft: g.soft, hard: g.hard, reason: `今日花费 ¥${g.spent.toFixed(2)} ≥ hard ¥${g.hard}` };
      try { fs.writeFileSync(LOCK_FILE, `${JSON.stringify(rec, null, 2)}\n`, 'utf8'); } catch { /* ignore */ }
      actions.push({ type: 'hard-lock', spent: g.spent });
    }
    if (!already('hard')) {
      const seq = mail('本体', `【预算闸·已锁】今日已花 ¥${g.spent.toFixed(2)} ≥ hard ¥${g.hard}：**已自动停派**（看图类动作也受影响）。\n恢复：node scripts\\budget-unlock.mjs --reason "…"｜别删锁了事，先说清为什么继续花。`, '告警');
      if (!dry) appendAlert({ at: now, day: g.day, level: 'hard', spent: g.spent, soft: g.soft, hard: g.hard, mailSeq: seq });
      actions.push({ type: 'hard-alert', spent: g.spent, mailSeq: seq });
    }
  }
  return { gate: budgetGate({ now, spentOverride }), actions, dry };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const check = argv.includes('--check');
  const si = argv.indexOf('--simulate');
  const sim = si >= 0 ? Number(argv[si + 1]) : null;
  if (si >= 0 && (sim == null || Number.isNaN(sim))) { process.stderr.write('用法：budget-gate --simulate <金额>\n'); process.exitCode = 2; return; }
  const r = check ? { gate: budgetGate({ spentOverride: sim }), actions: [], dry: true } : budgetAct({ spentOverride: sim });
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    const g = r.gate;
    process.stdout.write(`日预算：今日 ¥${g.spent.toFixed(2)}（soft ¥${g.soft} / hard ¥${g.hard}）｜级别 ${g.level}｜${g.locked ? '已锁' : '未锁'}${g.cached ? '（花费缓存）' : ''}${sim != null ? `（模拟 ¥${sim}）` : ''}\n`);
    process.stdout.write(`  ${g.reason}\n`);
    for (const a of r.actions) {
      if (a.type === 'soft-alert') process.stdout.write(`  → soft 告警（邮件 #${a.mailSeq ?? 'dry'}）\n`);
      if (a.type === 'hard-lock') process.stdout.write(`  → 写锁 state\\budget-lock\n`);
      if (a.type === 'hard-alert') process.stdout.write(`  → hard 告警 + 停派（邮件 #${a.mailSeq ?? 'dry'}）\n`);
      if (a.type === 'expired') process.stdout.write(`  → 昨天的锁（${a.lockDay}）已自动失效\n`);
    }
  }
  process.exitCode = r.gate.locked ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
