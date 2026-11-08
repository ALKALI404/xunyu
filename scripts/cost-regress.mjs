#!/usr/bin/env node
// scripts/cost-regress.mjs —— 花费回归锁（D68）
//
// 干什么：拿**官方账单 CSV**当真值，跟本地 cost-core 算出来的数字逐项对，超阈值就 FAIL。
// 为什么要它：D44/D45 一天之内改过两次口径，交接后没人能保证"数字还是那套算法算的"。
// 这东西把三件事锁住：
//   ① 四项用量与金额的误差阈值（hit<2% / output<2% / 金额<3% / miss±30%）；
//   ② 口径版本号（cost-core 的 COST_RULE_VERSION）——数字对不上时先看这个号；
//   ③ 双公式检测（--lint）：scripts 里除了 cost-core 还有谁在拿 cacheHit 计价。
//
// 用法：
//   node scripts\cost-regress.mjs                        # 用最新一份官方数据、它覆盖的那天
//   node scripts\cost-regress.mjs --day 2026-10-28
//   node scripts\cost-regress.mjs --official assets\数据\official-20261028 --json
//   node scripts\cost-regress.mjs --lint                 # 只做双公式检测

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { collectCost, dayStart, beijingClock, COST_RULE_VERSION, LEDGER } from './cost-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const OFFICIAL_ROOT = path.join(WORKSPACE, 'assets', '数据');
const LOG_FILE = path.join(WORKSPACE, 'state', 'cost-regress.log');
const THRESHOLDS = { hit: 2, output: 2, cost: 3, miss: 30 };

/** 找最新一份官方数据目录（official-YYYYMMDD，按名字排序取最后）。 */
function latestOfficial() {
  let names = [];
  try { names = fs.readdirSync(OFFICIAL_ROOT).filter((n) => /^official-\d{8}$/.test(n)).sort(); } catch { names = []; }
  if (!names.length) return null;
  return path.join(OFFICIAL_ROOT, names[names.length - 1]);
}

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { head: [], rows: [] };
  const head = lines[0].split(',').map((s) => s.trim());
  const rows = lines.slice(1).map((l) => l.split(',').map((s) => s.trim()));
  return { head, rows };
}

/** 官方真值：金额 = cost-*.csv 求和；四类用量 = amount-*.csv 按 type 求和。 */
export function readOfficial(dir) {
  const files = fs.readdirSync(dir);
  const costFile = files.find((f) => /^cost-.*\.csv$/i.test(f));
  const amountFile = files.find((f) => /^amount-.*\.csv$/i.test(f));
  if (!costFile) throw new Error(`${dir} 里没有 cost-*.csv`);
  const cost = readCsv(path.join(dir, costFile));
  const ci = cost.head.indexOf('cost');
  const si = cost.head.indexOf('start_time_iso');
  const ei = cost.head.indexOf('end_time_iso');
  let money = 0;
  let lastStartMs = 0;
  const moneyByStart = new Map();
  for (const r of cost.rows) {
    const c = Number(r[ci] || 0);
    money += c;
    const ts = si >= 0 && r[si] ? Date.parse(r[si]) : (ei >= 0 && r[ei] ? Date.parse(r[ei]) : NaN);
    if (Number.isFinite(ts)) {
      lastStartMs = Math.max(lastStartMs, ts);
      moneyByStart.set(ts, (moneyByStart.get(ts) ?? 0) + c);
    }
  }
  // 官方导出的最后一行通常是"导出那一刻的半截小时"。它有多长没法直读，
  // 但可以用官方自己的 request_count 估：最后一桶请求数 / 前一桶 × 60 = 覆盖了多少分钟。
  // 这比"整点一刀切"准得多（实测整点切会差 2–3 个百分点，够把 PASS 判成 FAIL）。
  const usage = { hit: 0, miss: 0, output: 0, request: 0 };
  const reqByStart = new Map();
  if (amountFile) {
    const amount = readCsv(path.join(dir, amountFile));
    const ti = amount.head.indexOf('type');
    const ai = amount.head.indexOf('amount');
    const asi = amount.head.indexOf('start_time_iso');
    for (const r of amount.rows) {
      const t = String(r[ti] ?? '');
      const v = Number(r[ai] || 0);
      if (t === 'input_cache_hit_tokens') usage.hit += v;
      else if (t === 'input_cache_miss_tokens') usage.miss += v;
      else if (t === 'output_tokens') usage.output += v;
      else if (t === 'request_count') {
        usage.request += v;
        const ts = asi >= 0 && r[asi] ? Date.parse(r[asi]) : NaN;
        if (Number.isFinite(ts)) reqByStart.set(ts, (reqByStart.get(ts) ?? 0) + v);
      }
    }
  }
  const starts = [...reqByStart.keys()].sort((a, b) => a - b);
  let untilMs = lastStartMs;
  let partialMinutes = null;
  if (starts.length >= 2) {
    const last = starts[starts.length - 1];
    const prev = starts[starts.length - 2];
    const lastReq = reqByStart.get(last) ?? 0;
    const prevReq = reqByStart.get(prev) ?? 0;
    if (prevReq > 0 && lastReq > 0 && lastReq < prevReq) {
      partialMinutes = Math.max(1, Math.min(59, Math.round((lastReq / prevReq) * 60)));
      untilMs = last + partialMinutes * 60000;
    }
  }
  return { dir, money, moneyAll: money, usage, untilMs, partialMinutes, files: { costFile, amountFile } };
}

const pct = (local, official) => (official > 0 ? (Math.abs(local - official) / official) * 100 : (local === official ? 0 : 100));

/** 对一天做回归。 */
export function regress({ officialDir = null, day = null, until = null } = {}) {
  const dir = officialDir ?? latestOfficial();
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: `找不到官方数据目录（默认 ${OFFICIAL_ROOT}\\official-YYYYMMDD）` };
  const off = readOfficial(dir);
  const useDay = day ?? (() => {
    const m = /official-(\d{4})(\d{2})(\d{2})/.exec(path.basename(dir));
    return m ? `${m[1]}-${m[2]}-${m[3]}` : beijingClock(Date.now()).day;
  })();
  const start = dayStart(useDay);
  const dayEnd = start + 86400000 - 1;
  // 关键：官方快照只覆盖到它最后一行的小时末，本地必须用同一窗口，
  // 否则越晚跑越"超阈"（第一次跑就因为拿了整天比 19:00 的快照，四项全 FAIL）。
  // until 可选：人工钉住官方快照的导出时刻（HH:mm），不给就按 request_count 估算
  let localTo = off.untilMs ? Math.min(dayEnd, off.untilMs) : dayEnd;
  if (until) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(until));
    if (m) localTo = start + (Number(m[1]) * 60 + Number(m[2])) * 60000;
  }
  const local = collectCost({ from: start, to: localTo, by: 'day' });
  const l = local.totals;

  const checks = [
    { key: 'hit', label: 'cacheHit', local: l.hit, official: off.usage.hit, limit: THRESHOLDS.hit },
    { key: 'output', label: 'output', local: l.out, official: off.usage.output, limit: THRESHOLDS.output },
    { key: 'cost', label: '金额', local: l.cost, official: off.money, limit: THRESHOLDS.cost, money: true },
    { key: 'miss', label: 'cacheMiss', local: l.miss, official: off.usage.miss, limit: THRESHOLDS.miss }
  ].map((c) => {
    const err = pct(c.local, c.official);
    return { ...c, errPct: Number(err.toFixed(2)), pass: err <= c.limit };
  });

  const fail = checks.filter((c) => !c.pass);
  return {
    ok: fail.length === 0,
    verdict: fail.length ? 'FAIL' : 'PASS',
    day: useDay,
    ruleVersion: COST_RULE_VERSION,
    officialDir: dir,
    window: { from: beijingClock(start).text, to: beijingClock(localTo).text },
    checks,
    local: { hit: l.hit, miss: l.miss, out: l.out, cost: l.cost, turns: l.turns, steps: l.steps },
    official: { hit: off.usage.hit, miss: off.usage.miss, out: off.usage.output, cost: off.money, request: off.usage.request },
    at: Date.now()
  };
}

/** 双公式检测：scripts\*.mjs 里除 cost-core 外，还有谁"拿 cacheHit 参与计价"。 */
export function lintPricingPoints() {
  const dir = path.join(WORKSPACE, 'scripts');
  const hits = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    if (name === 'cost-core.mjs' || name === 'cost-regress.mjs') continue;   // 计价内核 + 本检测器自己
    const file = path.join(dir, name);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const text = line.trim();
      if (text.startsWith('//') || text.startsWith('*')) return;             // 注释不算
      // 只认「真的拿 cacheHit 乘了价」：调 ratesAt、或 cacheHit * rate、或 rate.cacheHit。
      // 单纯的累加（unit.cost += u.cost）不算第二套公式。
      const prices = /ratesAt\s*\(|cacheHit\s*\*|rate\.cacheHit|rates\.cacheHit|cacheHit\s*\/\s*rate/.test(text);
      const sumsHit = /cacheHit|\bhit\b/.test(text);
      if (prices && sumsHit) hits.push({ file: `scripts\\${name}`, line: i + 1, code: text.slice(0, 120) });
    });
  }
  return { ok: hits.length === 0, hits };
}

function appendLog(result) {
  const line = [
    new Date(result.at).toISOString(),
    result.day,
    result.ruleVersion,
    result.verdict,
    ...result.checks.map((c) => `${c.key}=${c.errPct}%`),
    `cost=${result.local.cost.toFixed(2)}`,
    `official=${result.official.cost.toFixed(2)}`
  ].join('\t');
  try { fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8'); } catch { /* 日志写不了不影响结论 */ }
  return line;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const json = argv.includes('--json');

  if (argv.includes('--lint')) {
    const l = lintPricingPoints();
    if (json) { process.stdout.write(`${JSON.stringify(l, null, 2)}\n`); }
    else if (l.ok) console.log('✓ 计价点唯一：只有 scripts\\cost-core.mjs 在算钱');
    else { console.log(`✗ 发现 ${l.hits.length} 处额外计价点（口径可能又分裂了）：`); for (const h of l.hits) console.log(`  ${h.file}:${h.line}  ${h.code}`); }
    process.exitCode = l.ok ? 0 : 1;
    return;
  }

  const result = regress({ officialDir: opt('official', null), day: opt('day', null), until: opt('until', null) });
  if (!result.ok && result.error) {
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`); else console.error(`✗ ${result.error}`);
    process.exitCode = 2;
    return;
  }
  appendLog(result);
  // --notify：FAIL 时给 00 和 01 各发一封（日结里挂这个开关）
  if (argv.includes('--notify') && result.verdict === 'FAIL') {
    try {
      const bad = result.checks.filter((x) => !x.pass).map((x) => `${x.label} ${x.errPct}%>${x.limit}%`).join('，');
      const body = `花费回归 FAIL（${result.day}，口径 ${result.ruleVersion}，官方 ${result.officialDir}）：${bad}。先查 COST_RULE_VERSION 有没有变，再跑 --lint 看有没有第二套公式。`;
      for (const to of ['00', '01']) {
        execFileSync(process.execPath, [path.join(WORKSPACE, 'scripts', 'mail.mjs'), 'post', '--to', to, '--from', '04', '--body', body], { stdio: 'ignore' });
      }
    } catch { /* 发信失败不影响结论 */ }
  }
  if (json) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }
  else {
    console.log(`花费回归 · ${result.day} · 口径 ${result.ruleVersion}`);
    console.log(`官方目录 ${path.relative(WORKSPACE, result.officialDir)}　对账窗口 ${result.window ? result.window.from + " → " + result.window.to : ""}`);
    console.log('');
    console.log('项目          本地            官方            误差     阈值   结果');
    for (const c of result.checks) {
      const fmt = (v) => (c.money ? `¥${v.toFixed(2)}` : Number(v).toLocaleString('en-US'));
      console.log(`${c.label.padEnd(12)}${String(fmt(c.local)).padEnd(16)}${String(fmt(c.official)).padEnd(16)}${(c.errPct + '%').padEnd(9)}${('±' + c.limit + '%').padEnd(7)}${c.pass ? 'OK' : 'FAIL'}`);
    }
    console.log('');
    console.log(`${result.verdict === 'PASS' ? '✓ PASS' : '✗ FAIL'}（写日志 ${path.relative(WORKSPACE, LOG_FILE)}）`);
    if (result.verdict === 'FAIL') {
      const bad = result.checks.filter((c) => !c.pass).map((c) => `${c.label} ${c.errPct}%>${c.limit}%`).join('，');
      console.log(`  超阈项：${bad}`);
      console.log('  先查口径：cost-core 的 COST_RULE_VERSION 有没有变；再跑 --lint 看有没有第二套公式。');
    }
  }
  process.exitCode = result.verdict === 'PASS' ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
