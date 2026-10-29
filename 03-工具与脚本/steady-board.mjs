#!/usr/bin/env node
// scripts/steady-board.mjs —— 稳态看板 v0：把「内稳态清单」里**现在就能取到数**的回路采下来。
//
// 依据：docs\内稳态清单-2026-10-28.md（七个回路）｜工单：state\tasks\D5-steady-board.md
//
// 本版采三条（其余留桩，别假装有数）：
//   回路 1 存活    —— 复用 module-doctor 的 collect()（端口 + /health）
//   回路 2 投递    —— bridge.out.log 最近 1 小时的 [投递] 行：已确认 / 未确认 / 重投
//   回路 7 一致性  —— logs\trace.jsonl 里各模块最近一条的时间差（静默 >30 分钟 = 越界）
//   回路 4/5/6     —— 未接入（上下文 / 成本 / 记忆：各有自己的采样器，不在本版）
//
// 只读：不写日志、不起服务、不发消息、不改任何文件。
//
// 用法：
//   node scripts\steady-board.mjs          # 表格 + 一行结论
//   node scripts\steady-board.mjs --json   # 机读
//
// 退出码：**恒 0**（看板是读数工具，不是闸门；判据看 JSON 里的 verdict）。只有自身崩了才 1。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect as collectDoctor } from './module-doctor.mjs';

const VERSION = '0.1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');

// ── 常量（要改就改这里，别散落）─────────────────────────────────────────────
const BRIDGE_LOG = 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\state\\bridge.out.log';
const TRACE_CANDIDATES = [
  path.join(WORKSPACE, 'logs', 'trace.jsonl'),   // 契约 §三 的路径
  path.join(WORKSPACE, 'state', 'trace.jsonl')   // 工单里写的路径（兼容）
];
const DELIVERY_WINDOW_MS = 60 * 60 * 1000;   // 回路 2：最近 1 小时
const DELIVERY_BAD_RATE = 0.05;              // 未确认率 > 5% → WARN
const TRACE_SILENT_MS = 30 * 60 * 1000;      // 回路 7：静默 > 30 分钟 → WARN
const LOG_TAIL_BYTES = 1024 * 1024;          // 只读日志尾部 1MB，别把 800KB 全拖进来
const TRACE_TAIL_LINES = 200;

// ── 小工具（与 module-doctor 同款：CJK 宽度对齐）────────────────────────────
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (
      cp <= 0x115f
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1f64f)
    )) ? 2 : 1;
  }
  return w;
}
function pad(s, width) {
  const text = String(s ?? '');
  const gap = width - dispWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}
function clip(s, max) {
  const text = String(s ?? '');
  return dispWidth(text) <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}
function fmtAge(ms) {
  if (!Number.isFinite(ms)) return '无记录';
  if (ms < 1000) return '刚刚';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// ── 回路 1：存活（复用 module-doctor）──────────────────────────────────────
async function circuitLiveness() {
  let report = null;
  let error = null;
  try {
    report = await collectDoctor();
  } catch (err) {
    error = String(err?.message ?? err);
  }
  if (!report) {
    return {
      id: 1, name: '存活', metric: 'module-doctor transport',
      status: 'unknown', verdict: '⚠ 取不到数',
      reading: `module-doctor 抛错：${error}`,
      threshold: '任一模块 transport 红',
      findings: [{ level: 'A', what: `存活采集失败：${error}` }],
      detail: { error }
    };
  }
  const modules = report.modules ?? [];
  const fails = modules.filter((m) => m.verdict === '失败');
  const online = modules.filter((m) => m.tcp === 'open');
  // 回路 1 的越界判据严格按清单：**只认 transport 红**（端口不通且无豁免）。
  // 契约不符 / adapter 不在 只记 A 级发现（清单：契约不符只 A，不自动改代码），不把存活判成 WARN。
  const findings = [];
  let contractGaps = 0;
  for (const m of fails) findings.push({ level: 'B', what: `模块 ${m.name}:${m.port} transport 红` });
  for (const m of modules) {
    const issues = [];
    if (m.health?.status === 'ok-but-not-contract') issues.push('health 缺契约字段');
    if (m.health?.adapterOk === false) issues.push(`adapter=${m.health.adapter} 不通`);
    if (['no-endpoint', 'legacy-object', 'not-contract'].includes(m.capabilities?.status)) issues.push('capabilities 不合契约');
    if (m.capabilities?.status === 'ok' && (m.capabilities?.violations ?? []).length) issues.push('capabilities 命名违规');
    if (issues.length) {
      contractGaps += 1;
      findings.push({ level: 'A', what: `模块 ${m.name}：${issues.join('、')}（只记录，不自动改）` });
    }
  }
  const status = fails.length ? 'fail' : 'ok';
  return {
    id: 1, name: '存活', metric: 'module-doctor transport',
    status,
    verdict: fails.length ? '✗ FAIL' : 'OK',
    reading: `${online.length}/${modules.length} 在线，transport 红 ${fails.length}，契约不符 ${contractGaps}`,
    threshold: '任一模块 transport 红',
    findings,
    detail: {
      modules: modules.map((m) => ({ name: m.name, port: m.port, tcp: m.tcp, verdict: m.verdict, health: m.health?.status, caps: m.capabilities?.status })),
      exitCode: report.exitCode,
      doctorOverall: report.overall,
      contractGaps
    }
  };
}

// ── 回路 2：投递（bridge.out.log 最近 1 小时）───────────────────────────────
/** 把 `HH:MM:SS` 还原成绝对时间（跨零点时按"最近一次该时刻"算）。 */
function clockToTs(hh, mm, ss, nowMs) {
  const base = new Date(nowMs);
  const t = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(hh), Number(mm), Number(ss)).getTime();
  // 日志没有日期：算出来的时间比现在晚 2 分钟以上，说明是昨天的（跨零点）
  return t > nowMs + 120000 ? t - 24 * 60 * 60 * 1000 : t;
}

function circuitDelivery(nowMs) {
  if (!fs.existsSync(BRIDGE_LOG)) {
    return {
      id: 2, name: '投递', metric: 'bridge.out.log [投递] 行',
      status: 'unknown', verdict: '⚠ 无日志',
      reading: 'bridge.out.log 不存在（桥接没跑或路径变了）',
      threshold: '未确认率 >5%',
      findings: [{ level: 'A', what: '投递回路取不到日志' }],
      detail: { file: BRIDGE_LOG, exists: false }
    };
  }
  let raw = '';
  try {
    const stat = fs.statSync(BRIDGE_LOG);
    const size = Math.min(stat.size, LOG_TAIL_BYTES);
    const fd = fs.openSync(BRIDGE_LOG, 'r');
    try {
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, stat.size - size);
      raw = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return {
      id: 2, name: '投递', metric: 'bridge.out.log [投递] 行',
      status: 'unknown', verdict: '⚠ 读不到',
      reading: `读日志失败：${String(error?.message ?? error).slice(0, 60)}`,
      threshold: '未确认率 >5%',
      findings: [{ level: 'A', what: '投递回路读不到日志' }],
      detail: { file: BRIDGE_LOG, exists: true, error: String(error?.message ?? error) }
    };
  }

  const counts = { confirmed: 0, unconfirmed: 0, retried: 0, failed: 0 };
  const windowStart = nowMs - DELIVERY_WINDOW_MS;
  let scanned = 0;
  for (const line of raw.split('\n')) {
    const m = /^(\d{2}):(\d{2}):(\d{2})\s+\[bridge\]\s+\[投递\]\s+(\S+)/.exec(line);
    if (!m) continue;
    const at = clockToTs(m[1], m[2], m[3], nowMs);
    if (at < windowStart) continue;
    scanned += 1;
    const kind = m[4];
    if (kind === '已确认') counts.confirmed += 1;
    else if (kind === '未确认') counts.unconfirmed += 1;
    else if (kind === '重投') counts.retried += 1;
    else if (kind === '失败') counts.failed += 1;
  }
  const total = counts.confirmed + counts.unconfirmed;
  const rate = total > 0 ? counts.unconfirmed / total : 0;
  const findings = [];
  if (rate > DELIVERY_BAD_RATE) {
    findings.push({ level: 'B', what: `未确认率 ${(rate * 100).toFixed(1)}% > ${(DELIVERY_BAD_RATE * 100).toFixed(0)}%（幂等重投已上线，该重投的会重投）` });
  }
  if (counts.failed > 0) {
    findings.push({ level: 'A', what: `最近 1 小时有 ${counts.failed} 条投递被判失败（已上报 state\\投递失败.jsonl）` });
  }
  const status = findings.length ? 'warn' : 'ok';
  return {
    id: 2, name: '投递', metric: 'bridge.out.log [投递] 行（近 1h）',
    status,
    verdict: fundsVerdict(status),
    reading: `已确认 ${counts.confirmed} / 未确认 ${counts.unconfirmed} / 重投 ${counts.retried} / 失败 ${counts.failed}（共 ${total} 次判定，未确认率 ${(rate * 100).toFixed(1)}%）`,
    threshold: `未确认率 >${(DELIVERY_BAD_RATE * 100).toFixed(0)}%`,
    findings,
    detail: { file: BRIDGE_LOG, windowMs: DELIVERY_WINDOW_MS, scanned, ...counts, total, rate }
  };
}
const fundsVerdict = (status) => (status === 'ok' ? 'OK' : (status === 'fail' ? '✗ FAIL' : '⚠ WARN'));

// ── 回路 7：一致性（trace 各模块最近一条）──────────────────────────────────
function circuitConsistency(nowMs, livenessDetail) {
  const found = TRACE_CANDIDATES.find((file) => fs.existsSync(file)) ?? null;
  if (!found) {
    // 负向场景：trace 被挪走/改名 —— 必须 WARN，不能崩
    return {
      id: 7, name: '一致性', metric: 'trace 各模块最近一条',
      status: 'warn', verdict: '⚠ WARN',
      reading: 'trace 文件不在（被改名/还没落？）',
      threshold: `静默 >${TRACE_SILENT_MS / 60000} 分钟`,
      findings: [{ level: 'A', what: 'trace.jsonl 不存在：一致性无从判断（契约§三断档）' }],
      detail: { file: null, candidates: TRACE_CANDIDATES, exists: false }
    };
  }
  let raw = '';
  try {
    raw = fs.readFileSync(found, 'utf8');
  } catch (error) {
    return {
      id: 7, name: '一致性', metric: 'trace 各模块最近一条',
      status: 'warn', verdict: '⚠ WARN',
      reading: `trace 读不到：${String(error?.message ?? error).slice(0, 50)}`,
      threshold: `静默 >${TRACE_SILENT_MS / 60000} 分钟`,
      findings: [{ level: 'A', what: 'trace.jsonl 存在但读不到' }],
      detail: { file: found, exists: true, error: String(error?.message ?? error) }
    };
  }
  const lines = raw.split('\n').filter((line) => line.trim()).slice(-TRACE_TAIL_LINES);
  const byModule = new Map();
  let badLines = 0;
  for (const line of lines) {
    let rec = null;
    try { rec = JSON.parse(line); } catch { badLines += 1; continue; }
    const module = String(rec?.module ?? '');
    const at = Number(rec?.t);
    if (!module || !Number.isFinite(at)) { badLines += 1; continue; }
    const prev = byModule.get(module);
    if (!prev || at > prev.at) byModule.set(module, { at, ok: rec.ok !== false, cap: String(rec.cap ?? '') });
  }

  const ages = [...byModule.entries()]
    .map(([module, hit]) => ({ module, ageMs: nowMs - hit.at, ok: hit.ok, cap: hit.cap }))
    .sort((a, b) => a.module.localeCompare(b.module));
  const silent = ages.filter((item) => item.ageMs > TRACE_SILENT_MS);
  const findings = silent.map((item) => ({ level: 'B', what: `trace 静默 ${fmtAge(item.ageMs)}：${item.module}（>${TRACE_SILENT_MS / 60000} 分钟）` }));
  if (badLines > 0) findings.push({ level: 'A', what: `trace 有 ${badLines} 行坏行` });

  const contractGap = livenessDetail?.contractGaps ?? 0;
  if (contractGap > 0) findings.push({ level: 'A', what: `${contractGap} 个模块契约不符（只记录，不自动改）` });

  const status = silent.length ? 'warn' : 'ok';
  return {
    id: 7, name: '一致性', metric: 'trace 各模块最近一条',
    status,
    verdict: fundsVerdict(status),
    reading: ages.length
      ? ages.map((item) => `${item.module} ${fmtAge(item.ageMs)}`).join(' / ')
      : 'trace 里一条记录都没有',
    threshold: `静默 >${TRACE_SILENT_MS / 60000} 分钟`,
    findings,
    detail: {
      file: found,
      ages: ages.map((item) => ({ module: item.module, ageMs: item.ageMs, ok: item.ok, cap: item.cap })),
      silent: silent.map((item) => item.module),
      badLines,
      tailLines: lines.length
    }
  };
}

// ── 疼痛链路（D6-v2 新增一行，不是七回路之一）───────────────────────────────
/**
 * 读 pain-bus 的 GET /pain/status：显示「最近疼痛 / degraded 模块」，没有就写 `无`。
 * 只读、2s 超时；总线没起也不许崩（这是看板，不是控制器）。
 */
async function circuitPain() {
  const busUrl = String(process.env.PAIN_BUS_URL || 'http://127.0.0.1:9339').replace(/\/+$/, '');
  let payload = null;
  try {
    const response = await fetch(`${busUrl}/pain/status`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2000)
    });
    payload = JSON.parse((await response.text()).replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      id: 8, name: '疼痛', metric: 'pain-bus /pain/status',
      status: 'ok', verdict: 'OK',
      reading: '无（pain-bus 未启动）',
      threshold: '有 degraded / 有未处理疼',
      findings: [],
      detail: { bus: busUrl, reachable: false, error: String(error?.message ?? error).slice(0, 100) }
    };
  }
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  const degraded = Array.isArray(payload?.degraded) ? payload.degraded : [];
  const recent = Array.isArray(payload?.recent) ? payload.recent.slice(-3) : [];
  const pains = recent.filter((r) => !['retract', 'restore'].includes(String(r.pain)));
  const findings = [];
  for (const item of degraded) findings.push({ level: 'B', what: `${item.module} 处于 degraded${item.reason ? `（${item.reason}）` : ''}` });
  const lastPainText = pains.length
    ? pains.map((p) => `${p.module}/${p.pain} ${fmtAge(Date.now() - Number(p.t ?? Date.now()))}前`).join('、')
    : '无';
  const statusText = degraded.length ? 'warn' : 'ok';
  return {
    id: 8, name: '疼痛', metric: 'pain-bus /pain/status',
    status: statusText,
    verdict: fundsVerdict(statusText),
    reading: `degraded ${degraded.length}｜最近疼痛 ${lastPainText}`,
    threshold: '有 degraded / 有未处理疼',
    findings,
    detail: {
      bus: busUrl,
      reachable: true,
      seq: payload?.seq ?? null,
      degraded: degraded.map((d) => d.module),
      recent: recent.map((r) => ({ pain: r.pain, module: r.module, t: r.t, by: r.by })),
      capsRemoved: Array.isArray(payload?.caps?.removed) ? payload.caps.removed : [],
      modules: modules.map((m) => ({ module: m.module, state: m.state, ageMs: m.ageMs, lastPain: m.lastPain?.pain ?? null }))
    }
  };
}

// ── 回路 4/5/6：留桩 ────────────────────────────────────────────────────────
const STUBS = [
  { id: 4, name: '上下文', metric: 'pressureTokens', why: '采样器在 DSH 侧（check-context-budget），本版不接' },
  { id: 5, name: '成本', metric: '¥/小时、¥/轮、日累计', why: '采样器在 token-usage/账本，本版不接' },
  { id: 6, name: '记忆', metric: '蒸馏产物 / daily / engram 写入', why: '采样器在 00 的日结与蒸馏脚本，本版不接' }
].map((item) => ({
  id: item.id,
  name: item.name,
  metric: item.metric,
  status: 'stub',
  verdict: '未接入',
  reading: '未接入',
  threshold: '—',
  findings: [],
  detail: { why: item.why }
}));

// ── 汇总 ────────────────────────────────────────────────────────────────────
function decide(circuits) {
  const live = circuits.find((c) => c.id === 1);
  if (live?.status === 'fail') {
    return { verdict: 'FAIL', conclusion: 'FAIL（有 transport 级故障，先修再谈别的）' };
  }
  const troubled = circuits.filter((c) => c.status === 'warn' || c.status === 'unknown');
  if (troubled.length) {
    return { verdict: 'WARN', conclusion: `WARN（${troubled.length} 条回路越界，见上表）` };
  }
  return { verdict: 'STEADY', conclusion: 'STEADY（今日无需干预）' };
}

function countActions(circuits) {
  const actions = { A: 0, B: 0, C: 0 };
  for (const circuit of circuits) {
    for (const finding of circuit.findings ?? []) {
      if (actions[finding.level] !== undefined) actions[finding.level] += 1;
    }
  }
  return actions;
}

function oneLine(report) {
  const live = report.circuits.find((c) => c.id === 1);
  const delivery = report.circuits.find((c) => c.id === 2);
  const consistency = report.circuits.find((c) => c.id === 7);
  const liveTag = live?.status === 'fail' ? 'FAIL' : (live?.status === 'warn' ? 'WARN' : (live?.status === 'unknown' ? '无数据' : 'OK'));
  const confirmed = delivery?.detail?.confirmed ?? 0;
  const unconfirmed = delivery?.detail?.unconfirmed ?? 0;
  const traceText = (consistency?.detail?.ages ?? []).map((item) => `${item.module} ${fmtAge(item.ageMs)}`).join(' / ') || '无记录';
  return `A=${report.actions.A}  B=${report.actions.B}  C=${report.actions.C} ｜ 存活 ${liveTag} ｜ 投递 未确认 ${unconfirmed}/${confirmed + unconfirmed} ｜ trace ${traceText}`;
}

function renderTable(report) {
  const cols = [
    { title: '回路', width: 12 },
    { title: '指标', width: 24 },
    { title: '读数', width: 64 },
    { title: '阈值', width: 18 },
    { title: '判定', width: 8 }
  ];
  const line = (cells) => cols.map((col, i) => pad(clip(cells[i] ?? '', col.width), col.width)).join('  ');
  const out = [];
  out.push(`steady-board ${VERSION} · 依据 docs\\内稳态清单-2026-10-28.md · ${report.at}`);
  out.push('');
  out.push(line(cols.map((col) => col.title)));
  out.push(cols.map((col) => '─'.repeat(col.width)).join('  '));
  for (const circuit of report.circuits) {
    out.push(line([
      `${circuit.id} ${circuit.name}`,
      circuit.metric,
      circuit.reading,
      circuit.threshold,
      circuit.verdict
    ]));
  }
  out.push('');
  for (const circuit of report.circuits) {
    for (const finding of circuit.findings ?? []) {
      out.push(`  [${finding.level}] 回路${circuit.id} ${circuit.name}：${finding.what}`);
    }
  }
  return `${out.join('\n')}\n`;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法: node scripts\\steady-board.mjs [--json]\n');
    return;
  }
  const unknown = argv.filter((arg) => arg !== '--json');
  if (unknown.length) {
    process.stderr.write(`未知参数: ${unknown.join(' ')}（只支持 --json）\n`);
    process.exitCode = 2;
    return;
  }
  const asJson = argv.includes('--json');
  const now = Date.now();

  const liveness = await circuitLiveness();
  const delivery = circuitDelivery(now);
  const consistency = circuitConsistency(now, liveness.detail);
  const pain = await circuitPain();
  const circuits = [liveness, delivery, consistency, pain, ...STUBS];
  const { verdict, conclusion } = decide(circuits);
  const actions = countActions(circuits);

  const report = {
    tool: 'steady-board',
    version: VERSION,
    basis: 'docs/内稳态清单-2026-10-28.md',
    at: new Date(now).toISOString(),
    ts: now,
    verdict,
    conclusion,
    actions,
    oneLine: '',
    circuits,
    notes: [
      '回路 4/5/6 未接入（各自采样器在 DSH / 账本 / 00 的日结里）',
      '只读看板：不写日志、不起服务、不发消息',
      '退出码恒 0（读数工具，不是闸门）；判据看 verdict/--json'
    ]
  };
  report.oneLine = oneLine(report);

  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(renderTable(report));
    process.stdout.write(`${'-'.repeat(40)}\n${report.oneLine}\n`);
    process.stdout.write(`结论: ${report.conclusion}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`steady-board 崩溃：${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
