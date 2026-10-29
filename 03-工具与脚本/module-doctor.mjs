#!/usr/bin/env node
// scripts/module-doctor.mjs —— 一条命令看清全系统「模块状」。
//
//   活着吗（/health）· 会什么（/capabilities）· 刚才卡在哪（trace.jsonl 最近一条）
//
// 口径（唯一）：docs\模块契约-v0.md。本脚本**只读探测**，不做任何自动修复，也不改任何模块。
//
// 用法：
//   node scripts\module-doctor.mjs           # 表格 + 结论
//   node scripts\module-doctor.mjs --json    # 机读（stdout 只有 JSON）
//
// 退出码：
//   0 = 全 OK / 只有 ⚠（契约没跟上、capabilities 缺端点、trace 静默…都算 ⚠）
//   1 = 有模块 **transport 级失败**（端口不通且不在豁免表里）
//
// 判定规则（写死）：
//   · 端口用 TCP 直连判（不枚举全表，免得慢 + 要权限）
//   · /health 超时 2s；ok:false 时把 error.layer 打出来
//   · capabilities 里 cap 撞车（两个模块声明同一个）→ ⚠ 撞车 并列出来
//   · trace.jsonl 读最后 200 行，按模块算「最近一条距今多久」；超过 30 分钟标 ⚠ 静默
//   · 9733/9333 这类常态不开的，写在 EXEMPT 表里不算失败

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const TRACE_FILE = path.join(WORKSPACE, 'logs', 'trace.jsonl');

/** 探针超时：TCP 800ms、HTTP 2000ms（契约要求 /health ≤2s）。 */
const TCP_TIMEOUT_MS = 800;
const HTTP_TIMEOUT_MS = 2000;
/** trace 判「静默」的阈值。 */
const TRACE_SILENT_MS = 30 * 60 * 1000;
const TRACE_TAIL_LINES = 200;

/**
 * 豁免表：这些端口常态不开，不算 transport 失败。
 * 为什么写死在顶部常量里：doctor 是排障入口，规则必须一眼可见、可 review。
 */
const EXEMPT = new Map([
  [9333, '游戏 mod（9333，常态不开；只监测不拉起）']
]);

/**
 * 模块表。`probePort` 是可改的探针端口（负向测试就改这里）。
 * health/capabilities 的 probe 含义：
 *   true  = 按契约探
 *   false = 本版不探（bridge 要 console-token / dsh 只有端口）——照实写在表里，不假装 OK
 */
const MODULES = [
  { name: 'relay', probePort: 9334, probeHealth: true, probeCaps: true },
  { name: 'body', probePort: 9335, probeHealth: true, probeCaps: true },
  { name: 'wecom', probePort: 8788, probeHealth: true, probeCaps: true },
  // bridge 本体（3100）的 /api/status 要 console-token，所以探的是**外挂探针** 9337
  // （E:\DeepFish\avatar\probe-bridge.mjs，由它去问 3100 再翻译成契约形状）。
  { name: 'bridge', probePort: 9337, probeHealth: true, probeCaps: true },
  // D6-v2（2026-10-28）：疼痛总线，契约 /health + /capabilities 都有，按模块探。
  { name: 'pain-bus', probePort: 9339, probeHealth: true, probeCaps: true },
  { name: 'dsh', probePort: 60540, probeHealth: false, probeCaps: false, portOnly: true },
  { name: 'mod', probePort: 9333, probeHealth: false, probeCaps: false, portOnly: true }
];

// ── 小工具 ───────────────────────────────────────────────────────────────────

/** 终端显示宽度：CJK / 全角按 2 格算，否则表格会歪。 */
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

const nowMs = () => Date.now();

/** 人类可读的「多久以前」。 */
function agoText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '刚刚';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s 前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h 前`;
  return `${Math.round(h / 24)}d 前`;
}

// ── 探针 ─────────────────────────────────────────────────────────────────────

/** TCP 直连判端口：不通就 closed（含 800ms 超时）。端口越界直接判 transport 失败，不去连。 */
function probeTcp(port, host = '127.0.0.1', timeoutMs = TCP_TIMEOUT_MS) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve({ open: false, ms: 0, error: `端口号非法（${port}，合法范围 1-65535）` });
  }
  return new Promise((resolve) => {
    const started = nowMs();
    const socket = new net.Socket();
    let settled = false;
    const done = (open, error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ open, ms: nowMs() - started, error: error ?? null });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (error) => done(false, error?.code ?? String(error?.message ?? error)));
    try {
      socket.connect(port, host);
    } catch (error) {
      done(false, error?.code ?? String(error?.message ?? error));
    }
  });
}

/** GET JSON，超时 2s。返回 {status, json, error, ms}。 */
async function getJson(port, urlPath, host = '127.0.0.1', timeoutMs = HTTP_TIMEOUT_MS) {
  const started = nowMs();
  try {
    const response = await fetch(`http://${host}:${port}${urlPath}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, ok: response.ok, json, text: text.slice(0, 400), error: null, ms: nowMs() - started };
  } catch (error) {
    const name = error?.name === 'TimeoutError' ? 'timeout' : (error?.cause?.code ?? error?.code ?? error?.name ?? 'fetch-failed');
    return { status: 0, ok: false, json: null, text: '', error: String(name), ms: nowMs() - started };
  }
}

// ── 契约校验 ─────────────────────────────────────────────────────────────────

const HEALTH_REQUIRED = ['ok', 'module', 'version', 'port', 'uptimeMs', 'ts', 'checks'];
const CAP_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/;

/** 校验 /health 是否合契约；返回 {compliant, missing, note}。 */
function checkHealthContract(json) {
  if (!json || typeof json !== 'object') return { compliant: false, missing: HEALTH_REQUIRED.slice(), note: '响应不是 JSON 对象' };
  const missing = HEALTH_REQUIRED.filter((field) => !(field in json));
  return { compliant: missing.length === 0, missing, note: missing.length ? `缺 ${missing.join(',')}` : '' };
}

/**
 * 校验 /capabilities 是否合契约（数组 + {cap,kind,note}），并对旧形状（对象 map）照实标注。
 * 返回 {status, count, items, violations, note}
 */
function checkCapabilitiesContract(json) {
  if (!json || typeof json !== 'object') {
    return { status: 'not-contract', count: 0, items: [], violations: ['响应不是 JSON 对象'], note: '' };
  }
  if ('module' in json === false) {
    // 不阻断：只作为契约偏差记一笔
  }
  const caps = json.capabilities;
  if (Array.isArray(caps)) {
    const items = caps.filter((entry) => entry && typeof entry.cap === 'string');
    const violations = [];
    if (items.length !== caps.length) violations.push('有 items 缺 cap 字符串');
    for (const entry of items) {
      if (!CAP_RE.test(entry.cap)) violations.push(`cap 命名不合契约：${entry.cap}`);
      if (!['action', 'query'].includes(String(entry.kind))) violations.push(`${entry.cap} 的 kind 不是 action/query`);
    }
    return {
      status: violations.length ? 'not-contract' : 'ok',
      count: items.length,
      items: items.map((entry) => ({ cap: entry.cap, kind: entry.kind ?? '', module: String(json.module ?? '') })),
      violations,
      note: violations.length ? violations.slice(0, 3).join('；') : ''
    };
  }
  if (caps && typeof caps === 'object') {
    // 旧形状：{ say:true, anim:true, ... } —— 契约要求数组，这里照实报「不合契约」，但项数仍然有信息量
    const keys = Object.keys(caps);
    return {
      status: 'legacy-object',
      count: keys.length,
      items: keys.map((key) => ({ cap: key, kind: '', module: String(json.module ?? '') })),
      violations: ['capabilities 是旧形状（对象 map），契约要求数组 [{cap,kind,note}]'],
      note: '旧形状（对象 map）'
    };
  }
  return { status: 'not-contract', count: 0, items: [], violations: ['capabilities 既不是数组也不是对象'], note: '' };
}

// ── trace ───────────────────────────────────────────────────────────────────

/** 解析 trace 文件尾部 N 行 → 每模块最近一条。文件不存在/读不到都不抛。 */
function parseTraceFile(file, modules) {
  if (!fs.existsSync(file)) {
    return { exists: false, byModule: new Map(), badLines: 0, tailLines: 0, unknownModules: [] };
  }
  let raw = '';
  try {
    const stat = fs.statSync(file);
    const readBytes = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);
      raw = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { exists: true, byModule: new Map(), badLines: 0, tailLines: 0, unknownModules: [], error: String(error?.message ?? error) };
  }
  const lines = raw.split('\n').filter((line) => line.trim());
  const tail = lines.slice(-TRACE_TAIL_LINES);
  const byModule = new Map();
  let badLines = 0;
  for (const line of tail) {
    let rec = null;
    try { rec = JSON.parse(line); } catch { badLines += 1; continue; }
    if (!rec || typeof rec !== 'object') { badLines += 1; continue; }
    const module = String(rec.module ?? '');
    const at = Number(rec.t);
    if (!module || !Number.isFinite(at)) { badLines += 1; continue; }
    const prev = byModule.get(module);
    if (!prev || at > prev.at) {
      byModule.set(module, {
        at,
        cap: String(rec.cap ?? ''),
        ok: rec.ok !== false,
        layer: rec.layer ? String(rec.layer) : null,
        code: rec.code ? String(rec.code) : null,
        trace: rec.trace ? String(rec.trace) : null
      });
    }
  }
  const known = new Set((modules ?? []).map((mod) => (typeof mod === 'string' ? mod : mod.name)));
  return {
    exists: true,
    byModule,
    badLines,
    tailLines: tail.length,
    unknownModules: [...byModule.keys()].filter((name) => !known.has(name))
  };
}

/** 读现网 trace.jsonl（logs\trace.jsonl）。文件不存在 → 返回 exists:false + 说明。 */
function readTrace(modules) {
  const parsed = parseTraceFile(TRACE_FILE, modules);
  return {
    ...parsed,
    file: TRACE_FILE,
    note: parsed.exists ? (parsed.error ? `读不到：${parsed.error}` : '') : 'trace 文件还没落（契约§三未上线）'
  };
}

// ── cap 撞车 ─────────────────────────────────────────────────────────────────

/** 跨模块找撞车：契约命名的 cap 只允许一个模块声明。 */
export function detectCollisions(rows) {
  const owners = new Map();
  for (const row of rows) {
    for (const item of row.capabilities?.items ?? []) {
      if (!CAP_RE.test(String(item.cap))) continue; // 非契约命名不参与撞车判定（已在 violations 里报过）
      const list = owners.get(item.cap) ?? [];
      if (!list.includes(row.name)) list.push(row.name);
      owners.set(item.cap, list);
    }
  }
  return [...owners.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([cap, list]) => ({ cap, modules: list }));
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function collect() {
  const stamp = nowMs();
  const trace = readTrace(MODULES);
  const rows = [];

  for (const mod of MODULES) {
    const reasons = [];
    const exemptReason = EXEMPT.get(mod.probePort) ?? null;
    const tcp = await probeTcp(mod.probePort);
    const row = {
      name: mod.name,
      port: mod.probePort,
      tcp: tcp.open ? 'open' : 'closed',
      tcpMs: tcp.ms,
      tcpError: tcp.error,
      exempt: Boolean(exemptReason),
      exemptReason,
      health: { status: 'not-probed', http: 0, ok: null, missing: [], note: mod.noProbeNote ?? '', error: null, ms: 0 },
      capabilities: { status: 'not-probed', count: 0, violations: [], note: '', items: [] },
      trace: { status: trace.exists ? 'none' : 'missing', lastAt: null, agoMs: null, silent: null, cap: '', ok: null },
      verdict: 'OK',
      reasons
    };

    // ① 端口
    if (!tcp.open) {
      if (exemptReason) {
        row.verdict = 'OK(豁免)';
        reasons.push(`豁免：${exemptReason}`);
      } else {
        row.verdict = '失败';
        reasons.push(`transport：端口 ${mod.probePort} 不通（${tcp.error ?? 'closed'}）`);
      }
    }

    // ② /health（只对 probeHealth 的模块探；端口不通就不探，免得叠噪音）
    if (tcp.open && mod.probeHealth) {
      const res = await getJson(mod.probePort, '/health');
      row.health.http = res.status;
      row.health.ms = res.ms;
      if (res.status === 0) {
        row.health.status = 'unreachable';
        reasons.push(`/health 请求失败：${res.error}`);
      } else if (res.status === 404) {
        row.health.status = 'no-endpoint';
        reasons.push('/health 端点不存在（不符合契约：缺 /health）');
      } else if (res.status === 401 || res.status === 403) {
        row.health.status = 'auth-required';
        reasons.push(`/health 需要鉴权（HTTP ${res.status}），本版不做鉴权探测`);
      } else if (!res.json) {
        row.health.status = 'bad-json';
        reasons.push('/health 返回的不是 JSON');
      } else {
        const contract = checkHealthContract(res.json);
        const healthOk = res.json.ok !== false;
        row.health.ok = healthOk;
        row.health.missing = contract.missing;
        if (!healthOk) {
          const err = res.json.error ?? {};
          const layer = String(err.layer ?? 'unknown');
          row.health.status = 'fail';
          row.health.error = { layer, code: String(err.code ?? ''), detail: String(err.detail ?? '') };
          row.health.note = `ok:false layer=${layer}${err.code ? ` code=${err.code}` : ''}`;
          reasons.push(`/health ok:false（layer=${layer}${err.code ? `，code=${err.code}` : ''}）`);
          if (layer === 'transport') row.verdict = '失败';
        } else {
          row.health.status = contract.compliant ? 'ok' : 'ok-but-not-contract';
          if (res.json.adapter) {
            const adapterOk = res.json.adapterOk !== false;
            row.health.adapter = String(res.json.adapter);
            row.health.adapterOk = adapterOk;
            if (!adapterOk) reasons.push(`adapter=${res.json.adapter} 不通（模块内部依赖，属 layer=module）`);
          }
          if (!contract.compliant) reasons.push(`不符合契约：缺 ${contract.missing.join(',')}`);
        }
      }
    } else if (tcp.open && !mod.probeHealth) {
      row.health.status = 'not-probed';
      row.health.note = mod.portOnly ? '只看端口' : (mod.noProbeNote ?? '本版不探');
    }

    // ③ /capabilities
    if (tcp.open && mod.probeCaps) {
      const res = await getJson(mod.probePort, '/capabilities');
      if (res.status === 0) {
        row.capabilities.status = 'unreachable';
        reasons.push(`/capabilities 请求失败：${res.error}`);
      } else if (res.status === 404) {
        row.capabilities.status = 'no-endpoint';
        reasons.push('/capabilities 端点不存在（不符合契约：缺 /capabilities）');
      } else if (res.status === 401 || res.status === 403) {
        row.capabilities.status = 'auth-required';
        reasons.push(`/capabilities 需要鉴权（HTTP ${res.status}）`);
      } else {
        const caps = checkCapabilitiesContract(res.json);
        row.capabilities.status = caps.status;
        row.capabilities.count = caps.count;
        row.capabilities.violations = caps.violations;
        row.capabilities.note = caps.note;
        row.capabilities.items = caps.items;
        if (caps.status !== 'ok') reasons.push(...caps.violations.slice(0, 2));
      }
    } else if (tcp.open && !mod.probeCaps) {
      row.capabilities.status = 'not-probed';
    }

    // ④ trace
    if (trace.exists) {
      const hit = trace.byModule.get(mod.name);
      if (hit) {
        const ago = stamp - hit.at;
        row.trace = {
          status: ago > TRACE_SILENT_MS ? 'silent' : 'ok',
          lastAt: hit.at,
          agoMs: ago,
          silent: ago > TRACE_SILENT_MS,
          cap: hit.cap,
          ok: hit.ok,
          layer: hit.layer,
          code: hit.code
        };
        if (ago > TRACE_SILENT_MS) reasons.push(`trace 静默 ${agoText(ago)}（>30 分钟）`);
        if (!hit.ok) reasons.push(`trace 最近一条是失败（${hit.layer ?? '?'}/${hit.code ?? '?'}）`);
      } else {
        row.trace.status = 'none';
        reasons.push('trace 里没有该模块的记录');
      }
    }

    // ⑤ 结论（transport 失败优先级最高）
    if (row.verdict !== '失败') {
      const contractGap = reasons.some((reason) => reason.startsWith('不符合契约') || reason.includes('端点不存在') || reason.includes('旧形状') || reason.includes('命名不合契约') || reason.includes('需要鉴权'));
      const traceGap = reasons.some((reason) => reason.includes('trace'));
      const moduleLevel = reasons.some((reason) => reason.includes('adapter=') || reason.includes('ok:false'));
      if (contractGap) row.verdict = '⚠ 待补';
      else if (traceGap || moduleLevel) row.verdict = '⚠ 注意';
      else row.verdict = row.verdict === 'OK(豁免)' ? 'OK(豁免)' : 'OK';
    }
    rows.push(row);
  }

  // cap 撞车（跨模块）
  const collisions = detectCollisions(rows);

  const transportFails = rows.filter((row) => row.verdict === '失败');
  const warns = rows.filter((row) => String(row.verdict).startsWith('⚠'));
  const exitCode = transportFails.length ? 1 : 0;
  const overall = exitCode ? 'fail' : (warns.length ? 'warn' : 'ok');

  return {
    tool: 'module-doctor',
    version: VERSION,
    contract: 'docs/模块契约-v0.md',
    at: new Date(stamp).toISOString(),
    ts: stamp,
    host: os.hostname(),
    overall,
    exitCode,
    modules: rows,
    collisions,
    exempt: [...EXEMPT.entries()].map(([port, reason]) => ({ port, reason })),
    trace: { exists: trace.exists, file: trace.file, tailLines: trace.tailLines ?? 0, badLines: trace.badLines ?? 0, note: trace.note ?? '', unknownModules: trace.unknownModules ?? [] },
    notes: [
      trace.exists ? null : `trace.jsonl 还没落（${TRACE_FILE}）—— 契约§三 未上线，本列显示 —`,
      'bridge 行探的是外挂探针 9337（avatar\\probe-bridge.mjs）；本体 3100 的 /api/status 要 console-token，doctor 不碰凭据',
      '只读探针，不做任何自动修复'
    ].filter(Boolean)
  };
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

function renderTable(report) {
  const cols = [
    { key: 'name', title: '模块', width: 8 },
    { key: 'port', title: '端口', width: 6 },
    { key: 'tcp', title: '连通', width: 6 },
    { key: 'health', title: 'health', width: 40 },
    { key: 'caps', title: 'capabilities', width: 24 },
    { key: 'trace', title: 'trace 最近', width: 16 },
    { key: 'verdict', title: '结论', width: 12 }
  ];
  const line = (cells) => cols.map((col, i) => pad(clip(cells[i] ?? '', col.width), col.width)).join('  ');
  const out = [];

  out.push(`module-doctor ${VERSION} · 契约 ${report.contract} · ${report.at}`);
  out.push('');
  out.push(line(cols.map((col) => col.title)));
  out.push(cols.map((col) => '─'.repeat(col.width)).join('  '));

  for (const row of report.modules) {
    const healthText = (() => {
      if (row.health.status === 'not-probed') return row.health.note || '—';
      if (row.health.status === 'no-endpoint') return '缺 /health';
      if (row.health.status === 'auth-required') return `要鉴权（HTTP ${row.health.http}）`;
      if (row.health.status === 'unreachable') return `连不上（${row.health.http || 'ERR'}）`;
      if (row.health.status === 'bad-json') return '非 JSON';
      if (row.health.status === 'fail') return `ok:false ${row.health.note}`;
      const adapter = row.health.adapter ? `, adapter=${row.health.adapter}${row.health.adapterOk === false ? '(不通)' : ''}` : '';
      return row.health.status === 'ok' ? `ok${adapter}` : `ok 但不合契约${adapter}`;
    })();
    const capText = (() => {
      if (row.capabilities.status === 'not-probed') return '—';
      if (row.capabilities.status === 'no-endpoint') return '缺 /capabilities';
      if (row.capabilities.status === 'auth-required') return '要鉴权';
      if (row.capabilities.status === 'unreachable') return '连不上';
      if (row.capabilities.status === 'legacy-object') return `${row.capabilities.count} 项（旧形状）`;
      return `${row.capabilities.count} 项`;
    })();
    const traceText = (() => {
      if (row.trace.status === 'missing') return '—';
      if (row.trace.status === 'none') return '无记录';
      const when = row.trace.agoMs != null ? agoText(row.trace.agoMs) : '—';
      return row.trace.silent ? `${when} ⚠静默` : when;
    })();
    out.push(line([row.name, String(row.port), row.tcp, healthText, capText, traceText, row.verdict]));
  }

  out.push('');
  if (report.collisions.length) {
    out.push('⚠ capabilities 撞车：');
    for (const hit of report.collisions) out.push(`   · ${hit.cap} —— 被 ${hit.modules.join(' / ')} 同时声明`);
  } else {
    out.push('capabilities 撞车：无（按契约命名的 cap 里没有重复）');
  }

  const fails = report.modules.filter((row) => row.verdict === '失败');
  const warns = report.modules.filter((row) => String(row.verdict).startsWith('⚠'));
  const onlines = report.modules.filter((row) => row.tcp === 'open');
  out.push(`模块在线：${onlines.length}/${report.modules.length}　失败：${fails.length}　待补/注意：${warns.length}`);
  for (const row of fails) out.push(`  ✗ ${row.name}:${row.port} —— ${row.reasons.join('；')}`);
  for (const row of warns) out.push(`  ⚠ ${row.name}:${row.port} —— ${row.reasons.join('；')}`);
  for (const note of report.notes) out.push(`  · ${note}`);
  out.push('');
  out.push(`结论: ${report.overall.toUpperCase()}　exit=${report.exitCode}${report.exitCode ? '（有 transport 级失败）' : ''}`);
  return `${out.join('\n')}\n`;
}

// ── 自检（不碰任何模块，纯内存 fixture）──────────────────────────────────────

/**
 * `--selftest`：把「契约校验 / 撞车 / trace 静默 / 豁免」四条判定喂已知 fixture 跑一遍。
 * 为什么要有：撞车和静默在现网**暂时造不出来**（只有 body 有 capabilities，trace 还没落），
 * 不给验收人一条能跑的负向路径，等于这两段逻辑没人验过。
 */
function runSelftest() {
  const results = [];
  const ok = (name, cond, detail) => {
    results.push({ name, ok: Boolean(cond), detail });
    process.stdout.write(`  ${cond ? '[ ok ]' : '[FAIL]'} ${name}${cond ? '' : ` — ${detail ?? ''}`}\n`);
  };

  process.stdout.write('\n=== module-doctor 自检（内存 fixture，不探网）===\n');

  // ① 契约完整的 /health
  const goodHealth = { ok: true, module: 'x', version: '1', port: 1, uptimeMs: 1, ts: 1, checks: {} };
  ok('① 合契约的 /health 判 compliant', checkHealthContract(goodHealth).compliant === true, JSON.stringify(checkHealthContract(goodHealth)));
  ok('① 缺字段能点出来', checkHealthContract({ ok: true, module: 'x' }).missing.join(',') === 'version,port,uptimeMs,ts,checks', JSON.stringify(checkHealthContract({ ok: true, module: 'x' })));

  // ② capabilities：契约数组 / 旧对象 / 命名违规
  const arrayShape = checkCapabilitiesContract({
    ok: true, module: 'body',
    capabilities: [{ cap: 'body.say', kind: 'action', note: '' }, { cap: 'body.state', kind: 'query', note: '' }]
  });
  ok('② 契约数组形状判 ok 且计数 2', arrayShape.status === 'ok' && arrayShape.count === 2, JSON.stringify(arrayShape));
  const legacyShape = checkCapabilitiesContract({ ok: true, module: 'body', capabilities: { say: true, anim: true, emotion: true } });
  ok('② 旧对象形状判 legacy-object 且计数 3', legacyShape.status === 'legacy-object' && legacyShape.count === 3, JSON.stringify(legacyShape));
  const badName = checkCapabilitiesContract({ ok: true, module: 'body', capabilities: [{ cap: 'BodySay', kind: 'action' }] });
  ok('② 命名违规能点出来', badName.status === 'not-contract' && badName.violations.some((v) => v.includes('命名不合契约')), JSON.stringify(badName));

  // ③ 撞车
  const rows = [
    { name: 'relay', capabilities: { items: [{ cap: 'relay.push', kind: 'action' }] } },
    { name: 'body', capabilities: { items: [{ cap: 'relay.push', kind: 'action' }, { cap: 'body.say', kind: 'action' }] } },
    { name: 'wecom', capabilities: { items: [{ cap: 'say', kind: 'action' }] } }
  ];
  const collisions = detectCollisions(rows);
  ok('③ 撞车能抓到（relay.push 被两模块声明）', collisions.length === 1 && collisions[0].cap === 'relay.push' && collisions[0].modules.length === 2, JSON.stringify(collisions));
  ok('③ 非契约命名的 cap 不参与撞车判定', !collisions.some((hit) => hit.cap === 'say'), JSON.stringify(collisions));

  // ④ trace 静默判定（用文件读写真跑一遍，但不碰现网 trace 文件）
  const tmpTrace = path.join(os.tmpdir(), `module-doctor-trace-${process.pid}.jsonl`);
  const oldTs = Date.now() - 31 * 60 * 1000;
  const freshTs = Date.now() - 5000;
  fs.writeFileSync(tmpTrace, [
    JSON.stringify({ t: oldTs, trace: 'tr-1', module: 'ghost', cap: 'relay.push', ms: 1, ok: true }),
    JSON.stringify({ t: freshTs, trace: 'tr-2', module: 'relay', cap: 'relay.push', ms: 2, ok: true }),
    '{bad json'
  ].join('\n'), 'utf8');
  const parsed = parseTraceFile(tmpTrace, ['relay']);
  ok('④ 能按模块取最近一条', parsed.byModule.get('relay')?.at === freshTs, JSON.stringify([...parsed.byModule.keys()]));
  ok('④ 坏行被计入 badLines', parsed.badLines === 1, `badLines=${parsed.badLines}`);
  const silent = (Date.now() - (parsed.byModule.get('ghost')?.at ?? Date.now())) > TRACE_SILENT_MS;
  ok('④ 超 30 分钟判静默', silent === true, 'ghost 应判静默');
  fs.rmSync(tmpTrace, { force: true });

  // ⑤ 豁免表
  ok('⑤ 9333 在豁免表里', EXEMPT.has(9333), JSON.stringify([...EXEMPT.keys()]));

  const failed = results.filter((row) => !row.ok);
  process.stdout.write(`\n=== 自检结果：${results.length - failed.length}/${results.length} 通过 ===\n`);
  return failed.length ? 1 : 0;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法: node scripts/module-doctor.mjs [--json | --selftest]\n');
    return 0;
  }
  if (argv.includes('--selftest')) return runSelftest();
  const asJson = argv.includes('--json');
  const unknown = argv.filter((arg) => arg !== '--json');
  if (unknown.length) {
    process.stderr.write(`未知参数: ${unknown.join(' ')}（只支持 --json / --selftest）\n`);
    return 2;
  }
  const report = await collect();
  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderTable(report));
  return report.exitCode;
}

// 只在自己被直接执行时跑 CLI；被 steady-board.mjs import 时只导出 collect()，不能顺手探一遍网。
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`module-doctor 崩溃：${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}

export { collect };
