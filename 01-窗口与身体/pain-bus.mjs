#!/usr/bin/env node
// pain-bus.mjs —— 疼痛总线（127.0.0.1:9339）。
//
// 2026-10-28 D6-v2：**不再定时轮询全系统**。谁出问题谁把疼报过来，控制器（self-heal）收到才动。
//
// 三个来源（都由别人打到本进程，本体不主动查）：
//   1) 监护者报丧  {pain:"crash", module, code:"exit-1"}
//   2) 调用方疼痛  {pain:"unreachable"|"timeout"|"contract", module:对端, by:自己}
//   3) 慢兜底      {pain:"silent", module}  ← 由 self-heal 每 5 分钟对"last-seen 超时"的模块补发
//
// 端点（契约状 /health + /capabilities，其余是总线自己的）：
//   POST /pain           收一条疼痛事件 → 追加 logs\pain.jsonl → 更新内存状态
//   POST /pain/touch     "我看过它，它还活着"：只刷新 last-seen，不产生新的疼（慢兜底用）
//   POST /pain/retract   缩回：模块标 degraded、能力表摘掉（self-heal 调）
//   POST /pain/restore   摘牌：模块标回 ok、能力表恢复（self-heal 调）
//   GET  /pain/status    给看板/控制器读：每模块状态、degraded 列表、最近事件、当前可用能力
//   GET  /health         契约 §一
//   GET  /capabilities   契约 §二（只声明本总线能做什么）
//
// 安全：只监听 127.0.0.1；只认回环 Host；只收 JSON；**不对外暴露任何业务数据**。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const VERSION = 'pain-2026-10-28';
const MODULE = 'pain-bus';
const PORT = Number(process.env.PAIN_PORT || 9339);
const WORKSPACE = '<工作区>';
const PAIN_FILE = path.join(WORKSPACE, 'logs', 'pain.jsonl');
const STARTED_AT = Date.now();
const RECENT_MAX = 50;

/** 能力表种子：只放契约 v0 里出现过的能力名，别替别人的模块发明能力。 */
const CAPS = {
  relay: ['relay.push'],
  body: ['body.say', 'body.state'],
  wecom: ['wecom.inbound'],
  bridge: ['bridge.status']
};

/** module -> { state, lastSeen, lastPain:{pain,at,by,code}, degradedSince, reason } */
const modules = new Map();
let seq = 0;
const recent = [];

function ensureModule(name) {
  let entry = modules.get(name);
  if (!entry) {
    entry = { module: name, state: 'ok', lastSeen: 0, lastPain: null, degradedSince: null, reason: '' };
    modules.set(name, entry);
  }
  return entry;
}

function appendFileLine(rec) {
  try {
    fs.mkdirSync(path.dirname(PAIN_FILE), { recursive: true });
    fs.appendFileSync(PAIN_FILE, `${JSON.stringify(rec)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, code, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function readBody(req, limit = 20000) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; if (raw.length > limit) req.destroy(); });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
  });
}

function applyPain(event) {
  const entry = ensureModule(event.module);
  const at = Number.isFinite(Number(event.at)) ? Number(event.at) : Date.now();
  entry.lastSeen = Math.max(entry.lastSeen, at);
  // restart-ok 是"恢复"事实，不是待处理的疼：只刷新 lastSeen，**不许覆盖**还没被处理的 crash。
  // （supervisor 3 秒就能把进程拉回来，覆盖了 controller 就永远看不到那条 crash。）
  if (event.pain !== 'restart-ok') {
    entry.lastPain = { pain: event.pain, at, by: event.by ?? '', code: event.code ?? '' };
  }
  seq += 1;
  const rec = {
    seq,
    t: at,
    pain: event.pain,
    module: event.module,
    by: event.by ?? '',
    code: event.code ?? '',
    detail: String(event.detail ?? '').slice(0, 200),
    receivedAt: Date.now()
  };
  recent.push(rec);
  while (recent.length > RECENT_MAX) recent.shift();
  appendFileLine(rec);
  return { rec, state: entry.state };
}

const CAPABILITIES = [
  { cap: 'pain.report', kind: 'action', note: '上报一条疼痛（crash/unreachable/timeout/contract/silent）' },
  { cap: 'pain.retract', kind: 'action', note: '缩回：标 degraded、能力表摘掉' },
  { cap: 'pain.restore', kind: 'action', note: '摘牌：模块标回 ok、能力表恢复' },
  { cap: 'pain.status', kind: 'query', note: '读各模块最近状态、degraded 列表与可用能力' }
];

// ── trace（契约 §三）：只记「状态被改变」的那几次调用，别拿它当日志 ──────────────
// 为什么不记 /pain/status：控制器每秒轮询一次，记了就是每秒一行，纯噪音。
const TRACE_FILE = path.join(WORKSPACE, 'logs', 'trace.jsonl');
const TRACE_MAX_BYTES = 50 * 1024 * 1024;
function trace(cap, ok, code = '') {
  try {
    const st = fs.statSync(TRACE_FILE, { throwIfNoEntry: false });
    if (st && st.size >= TRACE_MAX_BYTES) return; // 轮转由写方（relay）负责，总线只保证别撑爆
    const rec = { t: Date.now(), trace: `tr-${Math.random().toString(16).slice(2, 6)}`, module: MODULE, cap, ms: 0, ok };
    if (!ok && code) { rec.layer = 'module'; rec.code = code; }
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch { /* 观测失败绝不拖垮总线 */ }
}

function healthBody() {
  const degraded = [...modules.values()].filter((m) => m.state === 'degraded');
  return {
    ok: true,
    module: MODULE,
    version: VERSION,
    port: PORT,
    uptimeMs: Date.now() - STARTED_AT,
    ts: Date.now(),
    checks: {
      bus: { ok: true },
      modules: { ok: true, detail: `${modules.size} 个已知，${degraded.length} 个 degraded` }
    }
  };
}

function statusBody() {
  const now = Date.now();
  const list = [...modules.values()].map((m) => ({
    module: m.module,
    state: m.state,
    lastSeen: m.lastSeen || null,
    ageMs: m.lastSeen ? now - m.lastSeen : null,
    lastPain: m.lastPain,
    degradedSince: m.degradedSince,
    reason: m.reason
  }));
  const degraded = list.filter((m) => m.state === 'degraded');
  const capsAvailable = Object.entries(CAPS)
    .filter(([name]) => (modules.get(name)?.state ?? 'ok') !== 'degraded')
    .flatMap(([name, caps]) => caps.map((cap) => ({ cap, module: name, available: true })));
  const capsDegraded = Object.entries(CAPS)
    .filter(([name]) => modules.get(name)?.state === 'degraded')
    .flatMap(([name, caps]) => caps.map((cap) => ({ cap, module: name, available: false })));
  return {
    ok: true,
    module: MODULE,
    version: VERSION,
    ts: now,
    seq,
    modules: list,
    degraded: degraded.map((m) => ({ module: m.module, since: m.degradedSince, reason: m.reason })),
    recent: recent.slice(-10),
    caps: { available: capsAvailable, removed: capsDegraded },
    lastSeenAt: list.reduce((max, m) => Math.max(max, m.lastSeen ?? 0), 0) || null
  };
}

async function handle(req, res) {
  const host = String(req.headers.host ?? '');
  if (host && !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
    sendJson(res, 403, { ok: false, module: MODULE, error: { layer: 'contract', code: 'host-not-allowed', detail: '只接受本机回环访问' } });
    return;
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/pain') {
    const raw = await readBody(req);
    let event = null;
    try { event = JSON.parse(raw); } catch { event = null; }
    if (!event || typeof event !== 'object' || !event.module || !event.pain) {
      sendJson(res, 400, { ok: false, module: MODULE, error: { layer: 'contract', code: 'bad-pain', detail: '需要 {pain, module}' } });
      return;
    }
    const applied = applyPain({
      pain: String(event.pain).slice(0, 40),
      module: String(event.module).slice(0, 60),
      by: event.by ? String(event.by).slice(0, 60) : '',
      code: event.code ? String(event.code).slice(0, 60) : '',
      detail: event.detail ? String(event.detail).slice(0, 200) : '',
      at: event.at
    });
    sendJson(res, 202, { ok: true, accepted: true, seq: applied.rec.seq, module: applied.rec.module, pain: applied.rec.pain, state: applied.state });
    trace('pain.report', true);
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/pain/retract' || url.pathname === '/pain/restore')) {
    const raw = await readBody(req);
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const name = String(payload?.module ?? '').trim();
    if (!name) {
      sendJson(res, 400, { ok: false, module: MODULE, error: { layer: 'contract', code: 'bad-request', detail: '需要 {module}' } });
      return;
    }
    const entry = ensureModule(name);
    const retract = url.pathname === '/pain/retract';
    entry.state = retract ? 'degraded' : 'ok';
    entry.degradedSince = retract ? Date.now() : null;
    entry.reason = retract ? String(payload?.reason ?? '').slice(0, 160) : '';
    // 摘牌后把 lastPain 清掉：这条疼已经被处理完了，别让控制器下一轮又捞出来重做。
    // （lastSeen 保留 —— 慢兜底还要靠它判断"多久没消息"）
    if (!retract) entry.lastPain = null;
    entry.lastSeen = Date.now();
    // 缩回/摘牌本身也是一条事实，进同一条 append-only 流（pain 字段标明类型）
    seq += 1;
    const rec = {
      seq,
      t: Date.now(),
      pain: retract ? 'retract' : 'restore',
      module: name,
      by: String(payload?.by ?? 'self-heal').slice(0, 60),
      code: '',
      detail: retract ? entry.reason : '',
      receivedAt: Date.now()
    };
    recent.push(rec);
    while (recent.length > RECENT_MAX) recent.shift();
    appendFileLine(rec);
    sendJson(res, 200, { ok: true, module: name, state: entry.state, seq });
    trace(retract ? 'pain.retract' : 'pain.restore', true);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pain/touch') {
    const raw = await readBody(req);
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const name = String(payload?.module ?? '').trim();
    if (!name) {
      sendJson(res, 400, { ok: false, module: MODULE, error: { layer: 'contract', code: 'bad-request', detail: '需要 {module}' } });
      return;
    }
    const entry = ensureModule(name);
    entry.lastSeen = Date.now();
    if (entry.state !== 'degraded') entry.lastPain = null; // 看过且可达 = 这条疼不成立了
    sendJson(res, 200, { ok: true, module: name, lastSeen: entry.lastSeen, state: entry.state });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/pain/status') {
    sendJson(res, 200, statusBody());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, healthBody());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/capabilities') {
    sendJson(res, 200, { ok: true, module: MODULE, version: VERSION, port: PORT, ts: Date.now(), capabilities: CAPABILITIES });
    return;
  }

  sendJson(res, 404, { ok: false, module: MODULE, error: { layer: 'contract', code: 'unknown-path', detail: '只提供 /pain、/pain/touch、/pain/retract、/pain/restore、/pain/status、/health、/capabilities' } });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    sendJson(res, 500, { ok: false, module: MODULE, version: VERSION, ts: Date.now(), error: { layer: 'module', code: 'bus-internal', detail: String(error?.message ?? error).slice(0, 160) } });
  });
});

server.on('error', (error) => {
  process.stderr.write(error?.code === 'EADDRINUSE'
    ? `pain-bus: ${PORT} 已被占用（可能已有总线在跑）\n`
    : `pain-bus: 监听失败 ${error?.code ?? error?.message ?? error}\n`);
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`pain-bus ${VERSION} 监听 127.0.0.1:${PORT} → ${PAIN_FILE}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1200).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
