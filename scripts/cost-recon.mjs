#!/usr/bin/env node
// scripts\cost-recon.mjs —— 花费三方同区间对账（WS-007 / W-221，03·维护 2026-10-29）
//
// 为什么要它：口径（cost-v1）已定、回归锁（cost-regress）只看「台账 vs 官方」两家；
// 但主人看到的是**面板**，面板对了不等于台账对了。这个脚本把三方拉到**同一个窗口**：
//   ① 面板  http://127.0.0.1:9340/api/cost?from=..&to=..
//   ② 台账  state\token-usage.jsonl（桥接写的真账本）→ collectCost()
//   ③ 官方  assets\数据\official-YYYYMMDD\ 或 state\baseline\official-YYYYMMDD\ 的 CSV
//
// 关键：官方 CSV 是一份**快照**（只覆盖导出那一刻以前）。三方必须裁到官方覆盖窗口，
// 否则「官方缺半小时、本地是整天」会把 PASS 判成 FAIL（cost-regress 第一次就栽在这）。
//
// 用法：
//   node scripts\cost-recon.mjs                                  # 昨天全天（12:00 定时用这个）
//   node scripts\cost-recon.mjs --from 2026-10-28T00:00 --to 2026-10-29T00:00
//   node scripts\cost-recon.mjs --day 2026-10-28 --json
//   node scripts\cost-recon.mjs --official state\baseline\official-20261028 --json
//   node scripts\cost-recon.mjs --ledger <副本路径>              # 演练：拿账本副本对账，不碰真账本
//   node scripts\cost-recon.mjs --notify                         # FAIL 时邮件报本体
//
// 出口码：0 PASS / 1 FAIL / 3 无基准（官方 CSV 缺失或不覆盖该区间）/ 4 面板取不到
// 只读：不改账本、不改口径、不写 cost-regress.log；只写 state\cost-recon.json（给看板）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectCost, parseAt, dayStart, beijingClock, COST_RULE_VERSION, LEDGER } from './cost-core.mjs';
import { readOfficial } from './cost-regress.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const STATE = path.join(WORKSPACE, 'state', 'cost-recon.json');
const OFFICIAL_ROOTS = [path.join(WORKSPACE, 'assets', '数据'), path.join(WORKSPACE, 'state', 'baseline')];
const PANEL_URL = process.env.COST_PANEL_URL || 'http://127.0.0.1:9340/api/cost';

// 判定阈值：金额是主人关心的那个数，按工单「差异 ≤3%」；token 只做诊断列（沿用 cost-regress 的松紧）
const THRESHOLD = { cost: 3, hit: 2, output: 2, miss: 30 };

const pct = (a, b) => (Number(b) > 0 ? (Math.abs(Number(a) - Number(b)) / Number(b)) * 100 : (Number(a) === Number(b) ? 0 : 100));
const pctText = (v) => `${Number(v).toFixed(2)}%`;
const num = (v) => Number(v).toLocaleString('en-US');
const money = (v) => `¥${Number(v).toFixed(2)}`;

/** 找所有官方快照目录（两个根目录都看）。 */
function listOfficial() {
  const out = [];
  for (const root of OFFICIAL_ROOTS) {
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => /^official-\d{8}$/.test(n)).sort(); } catch { continue; }
    for (const name of names) out.push({ dir: path.join(root, name), day: name.replace('official-', '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') });
  }
  return out;
}

/** 面板读数：同一个窗口、同一套口径（面板内部调的就是 collectCost）。 */
async function readPanel(from, to) {
  const url = `${PANEL_URL}?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, url };
    const body = JSON.parse((await res.text()).replace(/^\uFEFF/, ''));
    if (!body?.totals) return { ok: false, error: '响应里没有 totals', url };
    return { ok: true, url, totals: body.totals, ruleVersion: body.ruleVersion, range: body.range, raw: body };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 160), url };
  }
}

/** 区间里有多少 base 行（只用于 FAIL 时说清「可能虚高」）。 */
function countBaseRows(file, from, to) {
  try {
    const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    let base = 0;
    for (const line of raw) {
      if (!line.includes('"k":"base"')) continue;
      let r = null;
      try { r = JSON.parse(line); } catch { continue; }
      const at = Number(r?.t) || 0;
      if (r?.k === 'base' && at >= from && at <= to) base += 1;
    }
    return base;
  } catch { return null; }
}

/** 差异超阈时给「可能原因」：只写能拿证据支持的，不猜。 */
function explain(ctx) {
  const out = [];
  const { off, local, panel, window, baseRows } = ctx;
  if (baseRows > 0) {
    out.push(`区间内有 ${baseRows} 行 k='base'（会话累计快照）：它不进金额，但若被任何一处计入会让 hit 虚高十几倍`);
  }
  if (Number.isFinite(off.partialMinutes) && off.partialMinutes !== null) {
    out.push(`官方最后一行是半截小时（约 ${off.partialMinutes} 分钟），本地窗口已裁到 ${beijingClock(window.to).clock}`);
  }
  const dCost = pct(local.cost, off.money);
  if (dCost > THRESHOLD.cost) {
    out.push(`台账 vs 官方金额差 ${pctText(dCost)}（>${THRESHOLD.cost}%）：先看 COST_RULE_VERSION 是不是 ${COST_RULE_VERSION}，再查账本有没有 base 行被算进去`);
  }
  const dOut = pct(local.out, off.usage.output);
  if (dOut > THRESHOLD.output) {
    out.push(`output 差 ${pctText(dOut)}（>${THRESHOLD.output}%）：本地 out = output + reasoning（cost-v1 口径）；官方按整小时归集，边界那几分钟会挪桶`);
  }
  const dMiss = pct(local.miss, off.usage.miss);
  if (dMiss > THRESHOLD.miss) {
    out.push(`miss 差 ${pctText(dMiss)}（>${THRESHOLD.miss}%）：miss 是波动项，常见于区间边界那几分钟或重试行`);
  }
  if (panel?.ok) {
    const dPanel = pct(local.cost, panel.totals.cost);
    if (dPanel > 0.5) out.push(`面板 vs 台账金额差 ${pctText(dPanel)}：面板有 10s 缓存，或两次请求之间账本又长了`);
  } else {
    out.push(`面板没取到（${panel?.error ?? '未知'}）：三方对账退化为两方，结论只覆盖 台账 vs 官方`);
  }
  if (Math.abs(window.to - off.untilMs) <= 60000) out.push('区间右边界贴着官方导出时刻（差 ≤1 分钟）：那几分钟的花费天然对不齐');
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法: node scripts\\cost-recon.mjs [--from ISO] [--to ISO] [--day YYYY-MM-DD|yesterday|today] [--official <dir>] [--ledger <file>] [--json] [--notify]\n');
    return;
  }
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const asJson = argv.includes('--json');
  const notify = argv.includes('--notify');
  const ledgerFile = opt('ledger', LEDGER);
  const officialArg = opt('official', null);

  // ── 区间 ────────────────────────────────────────────────────────────────
  let from = opt('from', null) ? parseAt(opt('from')) : null;
  let to = opt('to', null) ? parseAt(opt('to')) : null;
  const dayArg = opt('day', null);
  if ((from == null || to == null) && !dayArg) { from = null; to = null; }
  let day = null;
  if (from == null || to == null) {
    let pick = dayArg;
    if (!pick || pick === 'yesterday' || pick === 'today') {
      const base = pick === 'today' ? Date.now() : Date.now() - 86400000;
      pick = beijingClock(base).day;
    }
    day = pick;
    from = dayStart(day);
    to = from + 86400000 - 1;
  }
  if (from == null || to == null || !(from < to)) {
    process.stderr.write('区间不对：--from 必须早于 --to（ISO 或 YYYY-MM-DD[ HH:mm]，按北京时间）\n');
    process.exitCode = 2;
    return;
  }

  // ── 官方基准 ────────────────────────────────────────────────────────────
  const officialAll = listOfficial();
  let offDir = officialArg ? { dir: path.resolve(officialArg), day: null } : null;
  if (!offDir) {
    // 默认挑「和这个区间重叠最多」的那份快照；同等重叠取最新
    let best = null;
    for (const item of officialAll) {
      try {
        const o = readOfficial(item.dir);
        const start = dayStart(item.day);
        const overlap = Math.min(to, o.untilMs) - Math.max(from, start);
        if (overlap > 0 && (!best || overlap >= best.overlap)) best = { ...item, overlap, off: o };
      } catch { /* 目录不全就跳过 */ }
    }
    if (best) offDir = best;
  }

  let off = null;
  if (offDir) {
    try {
      off = readOfficial(offDir.dir);
      if (!offDir.day) {
        const m = /official-(\d{4})(\d{2})(\d{2})/.exec(path.basename(offDir.dir));
        offDir.day = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
      }
    } catch (error) {
      off = null;
      offDir = { ...offDir, error: String(error?.message ?? error) };
    }
  }

  // ── 裁剪到官方覆盖窗口 ──────────────────────────────────────────────────
  const base = { tool: 'cost-recon', version: '1.0.0', ruleVersion: COST_RULE_VERSION, at: new Date().toISOString(), requested: { from, to } };
  if (!off || !offDir?.day) {
    const why = offDir?.error
      ? `官方 CSV 读不了：${offDir.error}`
      : (officialAll.length
        ? `官方快照只有 ${officialAll.map((x) => `${x.day}（${path.relative(WORKSPACE, x.dir)}）`).join('、')}，与请求区间 ${beijingClock(from).text} → ${beijingClock(to).text} 不重叠`
        : '没有官方 CSV 快照（assets\\数据\\official-* 或 state\\baseline\\official-* 都没有）');
    const report = {
      ...base, ok: false, verdict: 'NO-BASELINE', exitCode: 3,
      reasons: [why],
      note: '没有基准就不下结论：这不是 PASS，也不是 FAIL'
    };
    writeState(report);
    if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`花费三方对账 · 区间 ${beijingClock(from).text} → ${beijingClock(to).text} · 口径 ${COST_RULE_VERSION}\n`);
      process.stdout.write(`⚠ 无基准：${report.reasons[0]}\n`);
      process.stdout.write('结论: 无基准（不下 PASS）\n');
    }
    process.exitCode = 3;
    return;
  }

  const offStart = dayStart(offDir.day);
  const offEnd = off.untilMs ?? (offStart + 86400000 - 1);
  const windowFrom = Math.max(from, offStart);
  const windowTo = Math.min(to, offEnd);
  if (!(windowFrom < windowTo)) {
    const report = {
      ...base, ok: false, verdict: 'NO-BASELINE', exitCode: 3,
      official: { dir: offDir.dir, day: offDir.day, window: `${beijingClock(offStart).text} → ${beijingClock(offEnd).text}` },
      reasons: [`官方快照 ${offDir.day} 只覆盖 ${beijingClock(offStart).clock} → ${beijingClock(offEnd).clock}，与请求区间 ${beijingClock(from).clock} → ${beijingClock(to).clock} 不重叠`],
      note: '没有重叠窗口就不下结论：这不是 PASS'
    };
    writeState(report);
    if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`花费三方对账 · 请求区间 ${beijingClock(from).text} → ${beijingClock(to).text}\n`);
      process.stdout.write(`⚠ 无基准：${report.reasons[0]}\n结论: 无基准（不下 PASS）\n`);
    }
    process.exitCode = 3;
    return;
  }

  // ── 三方读数 ────────────────────────────────────────────────────────────
  const local = collectCost({ file: ledgerFile, from: windowFrom, to: windowTo, by: 'day' }).totals;
  const panel = await readPanel(windowFrom, windowTo);

  const offMoney = off.money;
  const diffs = {
    ledger: { cost: pct(local.cost, offMoney), hit: pct(local.hit, off.usage.hit), miss: pct(local.miss, off.usage.miss), output: pct(local.out, off.usage.output) },
    panel: panel.ok
      ? { cost: pct(panel.totals.cost, offMoney), hit: pct(panel.totals.hit, off.usage.hit), miss: pct(panel.totals.miss, off.usage.miss), output: pct(panel.totals.out, off.usage.output) }
      : null,
    ledgerVsPanel: panel.ok ? { cost: pct(local.cost, panel.totals.cost), hit: pct(local.hit, panel.totals.hit) } : null
  };

  const moneySides = [
    { side: '台账 vs 官方', value: diffs.ledger.cost },
    { side: '面板 vs 官方', value: diffs.panel ? diffs.panel.cost : null },
    { side: '台账 vs 面板', value: diffs.ledgerVsPanel ? diffs.ledgerVsPanel.cost : null }
  ].filter((x) => x.value !== null);
  const worstMoney = Math.max(...moneySides.map((x) => x.value));
  const passMoney = worstMoney <= THRESHOLD.cost;
  const verdict = !passMoney ? 'FAIL' : 'PASS';
  const reasons = passMoney ? [] : explain({ off, local, panel, window: { to: windowTo }, baseRows: countBaseRows(ledgerFile, windowFrom, windowTo) ?? 0 });

  const report = {
    ...base,
    ok: verdict === 'PASS',
    verdict,
    exitCode: panel.ok ? (verdict === 'PASS' ? 0 : 1) : 4,
    degraded: !panel.ok,   // 面板取不到：只有两方（台账 vs 官方），结论要打折扣
    window: { from: windowFrom, to: windowTo, fromText: beijingClock(windowFrom).text, toText: beijingClock(windowTo).text, clipped: windowFrom !== from || windowTo !== to },
    official: { dir: offDir.dir, day: offDir.day, cost: offMoney, hit: off.usage.hit, miss: off.usage.miss, output: off.usage.output, request: off.usage.request, untilMs: offEnd, partialMinutes: off.partialMinutes ?? null },
    ledger: { file: ledgerFile, cost: local.cost, hit: local.hit, miss: local.miss, output: local.out, write: local.write, turns: local.turns, steps: local.steps },
    panel: panel.ok
      ? { url: panel.url, cost: panel.totals.cost, hit: panel.totals.hit, miss: panel.totals.miss, output: panel.totals.out, turns: panel.totals.turns, range: panel.range ?? null }
      : { ok: false, url: panel.url, error: panel.error },
    diffs: {
      ledger: round4(diffs.ledger),
      panel: diffs.panel ? round4(diffs.panel) : null,
      ledgerVsPanel: diffs.ledgerVsPanel ? round4(diffs.ledgerVsPanel) : null
    },
    threshold: THRESHOLD,
    worstMoneyPct: Number(worstMoney.toFixed(2)),
    reasons
  };
  writeState(report);

  if (notify && verdict === 'FAIL') {
    try {
      execFileSync(process.execPath, [path.join(WORKSPACE, 'scripts', 'mail.mjs'), 'post', '--to', '本体', '--from', '03', '--level', '活',
        '--body', `【花费对账 FAIL】${report.window.fromText} → ${report.window.toText}：最差金额差 ${pctText(worstMoney)}（阈值 ${THRESHOLD.cost}%）。\n`
          + `台账 ${money(report.ledger.cost)}｜面板 ${report.panel.cost != null ? money(report.panel.cost) : '取不到'}｜官方 ${money(report.official.cost)}。\n`
          + `可能原因：${reasons.length ? reasons.slice(0, 3).join('；') : '见 state\\cost-recon.json'}`], { stdio: 'ignore' });
    } catch { /* 发信失败不影响结论 */ }
  }

  if (asJson) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); }
  else printTable(report);

  process.exitCode = report.exitCode;
}

function round4(obj) { return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Number(Number(v).toFixed(2))])); }

function writeState(report) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, `${JSON.stringify(report)}\n`, 'utf8');
  } catch { /* 写不了状态不影响对账 */ }
}

function printTable(r) {
  const out = [];
  out.push(`花费三方对账 · ${r.window.fromText} → ${r.window.toText} · 口径 ${r.ruleVersion}${r.window.clipped ? '（已裁到官方快照覆盖范围）' : ''}`);
  out.push(`官方 ${path.relative(WORKSPACE, r.official.dir)}${r.official.partialMinutes ? `（末行半截 ${r.official.partialMinutes} 分钟）` : ''}`);
  out.push('');
  const cols = [
    { t: '来源', w: 14 }, { t: '金额(¥)', w: 11 }, { t: 'hit', w: 16 }, { t: 'miss', w: 12 }, { t: 'out', w: 11 }, { t: '轮/步', w: 10 }
  ];
  const line = (cells) => cols.map((c, i) => pad(cells[i] ?? '', c.w)).join('  ');
  out.push(line(cols.map((c) => c.t)));
  out.push(cols.map((c) => '─'.repeat(c.w)).join('  '));
  out.push(line(['台账', money(r.ledger.cost), num(r.ledger.hit), num(r.ledger.miss), num(r.ledger.output), `${r.ledger.turns}/${r.ledger.steps}`]));
  out.push(line(['面板', r.panel.cost != null ? money(r.panel.cost) : '取不到', r.panel.hit != null ? num(r.panel.hit) : '—', r.panel.miss != null ? num(r.panel.miss) : '—', r.panel.output != null ? num(r.panel.output) : '—', r.panel.turns != null ? String(r.panel.turns) : '—']));
  out.push(line(['官方', money(r.official.cost), num(r.official.hit), num(r.official.miss), num(r.official.output), `${r.official.request}`]));
  out.push('');
  out.push('差异（对官方）      金额      hit       miss      out');
  for (const [label, d] of [['台账', r.diffs.ledger], ['面板', r.diffs.panel]]) {
    if (!d) continue;
    out.push(`${pad(label, 18)}${pad(pctText(d.cost), 10)}${pad(pctText(d.hit), 10)}${pad(pctText(d.miss), 10)}${pctText(d.output)}`);
  }
  if (r.diffs.ledgerVsPanel) out.push(`${pad('台账 vs 面板', 18)}${pctText(r.diffs.ledgerVsPanel.cost)}（金额）`);
  out.push('');
  if (r.degraded) {
    out.push(`⚠ 面板取不到（${r.panel?.error ?? '未知'}）：本次只对了两方（台账 vs 官方），不是完整三方 —— 不算完整 PASS`);
  }
  if (r.verdict === 'PASS') {
    out.push(`✓ PASS（三方金额两两差异 ≤${r.threshold.cost}%；最差 ${pctText(r.worstMoneyPct)}）`);
    const tok = r.diffs.ledger;
    if (tok.output > r.threshold.output || tok.hit > r.threshold.hit || tok.miss > r.threshold.miss) {
      out.push(`  ⚠ token 诊断列超 cost-regress 阈值：hit ${pctText(tok.hit)} / output ${pctText(tok.output)} / miss ${pctText(tok.miss)}（金额仍 PASS，但这几项是 04 的回头账）`);
    }
  } else {
    out.push(`✗ FAIL（最差金额差 ${pctText(r.worstMoneyPct)} > ${r.threshold.cost}%）`);
    for (const reason of r.reasons) out.push(`  · ${reason}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

function pad(s, width) {
  const text = String(s ?? '');
  let w = 0;
  for (const ch of text) { const cp = ch.codePointAt(0); w += (cp >= 0x2e80 && cp <= 0xa4cf) ? 2 : 1; }
  return w >= width ? text : text + ' '.repeat(width - w);
}

main().catch((error) => {
  process.stderr.write(`cost-recon 崩了：${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
