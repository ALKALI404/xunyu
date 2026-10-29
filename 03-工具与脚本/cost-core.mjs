#!/usr/bin/env node
// scripts/cost-core.mjs —— **唯一的计价函数**（D44 立）；token-report / /api/cost / 页面 / cost-report 四处共用。
//
// 为什么要有这个文件（2026-10-28 主人报「每日花费 ¥396，明显不对」）：
//   账本里有两类记录：
//     · k='turn' —— 单步真实增量（要计入金额）
//     · k='base' —— 会话**累计快照**（每个会话周期性重报一次总量，不是新增花费）
//   旧实现把 base 当 turn 累加，命中量被放大十几倍（实测 base 742 行贡献了 559 亿 hit，
//   而真正要算的 turn 行只有 47 亿）。所以：**base 永不进金额**，只留着判断「覆盖到哪」。
//
// 口径（继承 token-report，未改）：
//   1. 只算 k='turn'（老数据没有 k 字段的，按 turn 处理）；
//   2. 同一条 `(sid, turn, step, model, provider)` 重复行只取一次（重试/重报不叠加）；
//   3. 按 `(sid, turn)` 收敛：cacheHit 取该轮 **max**，cacheMiss/cacheWrite/output(+reasoning) 累加；
//   4. 计价走桥接的 model-prices.ratesAt（含峰谷价）。
//
// CLI（只读，零 token）：
//   node scripts\cost-core.mjs --stats            # k 分布 + base 若计入会多出多少钱（证明用）
//   node scripts\cost-core.mjs --day 2026-10-28   # 某天合计

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1';
export const LEDGER = `${BRIDGE}/state/token-usage.jsonl`;
const BEIJING_OFFSET_MINUTES = 480;
const { ratesAt, beijingParts } = await import(`file:///${BRIDGE}/src/model-prices.js`);

const pad2 = (n) => String(n).padStart(2, '0');

/** 北京时间三件套：完整文本 / 日期 / 钟点（不依赖本机时区）。 */
export function beijingClock(ms) {
  const d = new Date(Number(ms) + BEIJING_OFFSET_MINUTES * 60000);
  return {
    text: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
    day: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    clock: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  };
}

/** 解析时间：ISO 或 `YYYY-MM-DD[ HH:mm[:ss]]`，一律按北京时间理解。 */
export function parseAt(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return utc - BEIJING_OFFSET_MINUTES * 60000;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** 北京时间某天 00:00 的 ms。 */
export function dayStart(dayText) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayText ?? '').trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - BEIJING_OFFSET_MINUTES * 60000;
}

// 账本按 (mtime,size) 缓存 10 秒：页面每 5 秒拉一次，不能每次都解析 4MB
let ledgerCache = { key: '', at: 0, rows: null, stats: null, lines: 0, bytes: 0, mtime: 0 };
function loadLedger(file = LEDGER) {
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}|${st.size}`;
  if (ledgerCache.rows && ledgerCache.key === key && Date.now() - ledgerCache.at < 10000) return ledgerCache;
  const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const rows = [];
  const stats = { total: raw.length, base: 0, turn: 0, other: 0, bad: 0 };
  for (const line of raw) {
    let r;
    try { r = JSON.parse(line); } catch { stats.bad += 1; continue; }
    let b = r.b;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { stats.bad += 1; continue; } }
    if (!b || typeof b !== 'object') { stats.bad += 1; continue; }
    const at = Number(r.t) || 0;
    if (!at) { stats.bad += 1; continue; }
    const kind = r.k === 'base' ? 'base' : (r.k === undefined || r.k === 'turn' ? 'turn' : 'other');
    stats[kind] += 1;
    rows.push({
      kind, at,
      sid: String(r.sid ?? '?'),
      turn: Number(r.turn ?? 0),
      step: r.step == null ? null : Number(r.step),
      model: String(r.model ?? ''),
      provider: String(r.provider ?? ''),
      miss: Number(b.cacheMiss) || 0,
      hit: Number(b.cacheHit) || 0,
      write: Number(b.cacheWrite) || 0,
      out: (Number(b.output) || 0) + (Number(b.reasoning) || 0)
    });
  }
  ledgerCache = { key, at: Date.now(), rows, stats, lines: raw.length, bytes: st.size, mtime: st.mtimeMs };
  return ledgerCache;
}

function money0(t) {
  const rates = ratesAt(String(t.model || ''), t.at);
  return (t.miss * rates.cacheMiss + t.hit * rates.cacheHit + t.write * rates.cacheWrite + t.out * rates.output) / rates.unit;
}

/**
 * 区间花费（唯一入口）。
 * @param {{file?:string, from?:number, to?:number, by?:'session'|'day'}} opts
 */
export function collectCost({ file = LEDGER, from, to, by = 'session' } = {}) {
  const now = Date.now();
  const rangeTo = Number.isFinite(to) ? Number(to) : now;
  const rangeFrom = Number.isFinite(from) ? Number(from) : (dayStart(beijingClock(rangeTo).day) ?? rangeTo - 86400000);
  const ledger = loadLedger(file);

  // ① 只留 turn 行（base 是会话累计快照，永不进金额）；**不去重**：重复行就是重试，钱真花了
  const rows = [];
  for (const row of ledger.rows) {
    if (row.kind !== 'turn') continue;
    if (row.at < rangeFrom || row.at > rangeTo) continue;
    rows.push(row);
  }

  // ② 逐行计价与累加（D45 定死：hit/miss/output 四类全部按 step 相加，不取 max）
  const days = new Map();
  const sessions = new Map();
  const turnKeys = new Map();          // (sid,turn) → 首末时间，仅用于「几轮」和起止展示
  const dayTurnKeys = new Map();       // day → Set(turnKey)
  const totals = { turns: 0, steps: 0, miss: 0, hit: 0, write: 0, out: 0, cost: 0 };

  for (const row of rows) {
    const cost = money0({ ...row, at: row.at });        // 计价用该行自己的时间（峰谷按行判断）
    const day = beijingParts(row.at).date;
    const key = `${row.sid}|${row.turn}`;

    turnKeys.set(key, {
      firstAt: Math.min(turnKeys.get(key)?.firstAt ?? row.at, row.at),
      lastAt: Math.max(turnKeys.get(key)?.lastAt ?? row.at, row.at)
    });
    if (!dayTurnKeys.has(day)) dayTurnKeys.set(day, new Set());
    dayTurnKeys.get(day).add(key);

    const d = days.get(day) ?? { day, turns: 0, steps: 0, miss: 0, hit: 0, out: 0, cost: 0 };
    d.steps += 1; d.miss += row.miss; d.hit += row.hit; d.out += row.out; d.cost += cost;
    days.set(day, d);

    const s = sessions.get(row.sid) ?? { sid: row.sid, short: row.sid.replace(/^session-/, '').slice(0, 8), turns: 0, steps: 0, miss: 0, hit: 0, write: 0, out: 0, cost: 0, firstAt: row.at, lastAt: row.at, turnSet: new Set() };
    s.steps += 1; s.miss += row.miss; s.hit += row.hit; s.write += row.write; s.out += row.out; s.cost += cost;
    s.firstAt = Math.min(s.firstAt, row.at);
    s.lastAt = Math.max(s.lastAt, row.at);
    s.turnSet.add(key);
    sessions.set(row.sid, s);

    totals.steps += 1; totals.miss += row.miss; totals.hit += row.hit; totals.write += row.write; totals.out += row.out; totals.cost += cost;
  }
  for (const [day, set] of dayTurnKeys) { const d = days.get(day); if (d) d.turns = set.size; }
  for (const s of sessions.values()) { s.turns = s.turnSet.size; delete s.turnSet; }
  totals.turns = turnKeys.size;
  const dupInRange = 0;   // 不去重（重试也是真花钱）

  // ③ 汇总展示
  const sessionRows = [...sessions.values()].map((s) => {
    const a = beijingClock(s.firstAt);
    const b = beijingClock(s.lastAt);
    return {
      ...s,
      firstText: a.clock,
      lastText: b.clock,
      spanText: a.day === b.day ? `${a.clock}–${b.clock}` : `${a.day.slice(5)} ${a.clock}–${b.day.slice(5)} ${b.clock}`,
      hitRate: s.hit + s.miss ? Number(((s.hit / (s.hit + s.miss)) * 100).toFixed(1)) : null
    };
  }).sort((a, b) => b.cost - a.cost);

  return {
    ok: true,
    currency: 'CNY',
    range: {
      from: rangeFrom, to: rangeTo,
      fromText: beijingClock(rangeFrom).text, toText: beijingClock(rangeTo).text,
      label: (() => {
        const a = beijingClock(rangeFrom);
        const b = beijingClock(rangeTo);
        return a.day === b.day ? `${a.day.slice(5)} ${a.clock} → ${b.clock}` : `${a.day.slice(5)} ${a.clock} → ${b.day.slice(5)} ${b.clock}`;
      })(),
      by
    },
    totals,
    sessions: sessionRows,
    days: [...days.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))),
    ledger: { file, bytes: ledger.bytes, lines: ledger.lines, mtime: ledger.mtime, turnsInRange: rows.length, dupInRange, k: ledger.stats }
  };
}

/** 证明用：k 分布 + 「base 若被计入会多出多少」。 */
export function ledgerStats({ file = LEDGER } = {}) {
  const ledger = loadLedger(file);
  const acc = { turn: { rows: 0, hit: 0, miss: 0, out: 0, cost: 0 }, base: { rows: 0, hit: 0, miss: 0, out: 0, cost: 0 } };
  for (const row of ledger.rows) {
    const k = row.kind === 'base' ? 'base' : 'turn';
    acc[k].rows += 1;
    acc[k].hit += row.hit;
    acc[k].miss += row.miss;
    acc[k].out += row.out;
    acc[k].cost += money0(row);
  }
  return { file, lines: ledger.lines, bytes: ledger.bytes, k: ledger.stats, turn: acc.turn, base: acc.base };
}

// ── CLI（只在直接执行时跑）─────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  if (argv.includes('--stats')) {
    const s = ledgerStats();
    const fmt = (n) => Number(n).toLocaleString('en-US');
    console.log(`账本 ${s.file}`);
    console.log(`共 ${fmt(s.lines)} 行（${(s.bytes / 1048576).toFixed(1)} MB）｜k 分布：turn=${s.k.turn} base=${s.k.base} 其它=${s.k.other} 坏行=${s.k.bad}`);
    console.log('');
    console.log(`turn 行：${fmt(s.turn.rows)} 行｜hit ${fmt(s.turn.hit)}｜miss ${fmt(s.turn.miss)}｜out ${fmt(s.turn.out)}｜若全按行计价 ¥${s.turn.cost.toFixed(2)}`);
    console.log(`base 行：${fmt(s.base.rows)} 行｜hit ${fmt(s.base.hit)}｜miss ${fmt(s.base.miss)}｜out ${fmt(s.base.out)}｜若被误计入 ¥${s.base.cost.toFixed(2)}（← 这就是虚高来源）`);
    console.log('');
    console.log(`结论：base 是会话累计快照，**不计入金额**；按 (sid,turn) 收敛后才是真实花费（见 --day）。`);
    return;
  }
  const day = opt('day', beijingClock(Date.now()).day);
  const start = dayStart(day);
  const rep = collectCost({ from: start, to: start + 86400000 - 1, by: 'day' });
  console.log(`${day} 合计 ¥${rep.totals.cost.toFixed(2)}（${rep.totals.turns} 轮 / ${rep.totals.steps} 步 / 命中 ${rep.totals.hit.toLocaleString('en-US')}）`);
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
