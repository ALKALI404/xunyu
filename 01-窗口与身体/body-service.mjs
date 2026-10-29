#!/usr/bin/env node
// 鲟鱼工作组 · 身体服务（本机 127.0.0.1:9335）
//
// 为什么要有这一层：现在的「身体」是游戏《The NOexistenceN of Lilith》里的莉莉丝，
// 靠游戏内 mod（9333）驱动。但身体以后是要换的——所以所有「动身体」的请求都先到
// 这里，再由这里选一个**适配器**去执行。换身体只要写一个新适配器，上层（本体、
// 窗口、中继、子实体）一行都不用改。
//
// 适配器：
//   lilith  真实身体：转发到 mod 9333（/say /anim /emotion /dialogue /chatpanel /timer）
//   noop    哑身体：只记录不执行，用来在没有游戏/没有身体时跑通全链路、做测试
//
// 队列：mod 的所有操作最终都要抢 Unity 主线程（mod 内部 RunOnMain），并发打过去会把
// 游戏卡住。所以这里做**单飞**（一次只跑一个动作）+ FIFO 排队；队列满时优先丢「不是
// 说话」的低价值动作，再丢最旧的。每句话是原子的，不会被动作插到中间。
//
// 权限矩阵（谁能调、配额多少）在 P0-4 做，这里先把 `source` 记下来备用。
//
// 环境变量：
//   AVATAR_BODY_PORT   默认 9335
//   AVATAR_BODY        默认 lilith（可选 noop；认不出的名字按 noop 处理，宁可不驱动也不驱动错）
//   AVATAR_MOD         默认 http://127.0.0.1:9333
//   AVATAR_BODY_QUEUE  队列上限，默认 20

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.AVATAR_BODY_PORT || 9335);
const MOD = String(process.env.AVATAR_MOD || 'http://127.0.0.1:9333').replace(/\/+$/, '');
const ADAPTER_NAME = String(process.env.AVATAR_BODY || 'lilith').toLowerCase();
const QUEUE_MAX = Math.max(1, Number(process.env.AVATAR_BODY_QUEUE_MAX || 20));
const VER = '0.1.0';

const bootAt = Date.now();
// ── 观测层（D1 2026-10-28，契约 docs/模块契约-v0.md §三）──────────────────
// 只加：老字段/老端点一个没动。trace 一次调用一行，写 <工作区>\logs\trace.jsonl
const D1_VERSION = '2026-10-28';
const D1_TRACE_FILE = '<工作区>\\logs\\trace.jsonl';
function d1TraceId() { return 'tr-' + Math.random().toString(16).slice(2, 6); }
const D1_MAX_BYTES = Number(process.env.DSH_TRACE_MAX_BYTES || 0) || 50 * 1024 * 1024;
function d1RotateIfNeeded() {
  // 契约 §三：trace.jsonl 超 50MB 轮转成 trace-YYYYMMDD.jsonl。
  // 三个进程（relay/body/wecom）同时 append，轮转必须「谁都不会崩、谁都不会丢行」：
  //   · rename 失败一律吞掉（别人刚轮转完 → ENOENT；被杀毒/索引占用 → EPERM/EBUSY），继续 append；
  //   · 目标名已存在就加 .2/.3 …，绝不覆盖同日已有文件；
  //   · append 永远在轮转之后执行，且 appendFileSync 在文件不存在时会新建 —— 行不会丢。
  try {
    if (fs.statSync(D1_TRACE_FILE).size < D1_MAX_BYTES) return false;
    const dir = path.dirname(D1_TRACE_FILE);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let target = path.join(dir, 'trace-' + day + '.jsonl');
    for (let i = 2; fs.existsSync(target); i += 1) target = path.join(dir, 'trace-' + day + '.' + i + '.jsonl');
    fs.renameSync(D1_TRACE_FILE, target);
    return true;
  } catch { return false; }
}
function d1Trace(rec) {
  try {
    fs.mkdirSync(path.dirname(D1_TRACE_FILE), { recursive: true });
    d1RotateIfNeeded();
    fs.appendFileSync(D1_TRACE_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch { }
}

const log = (...a) => console.log(`[body] ${new Date().toISOString()}`, ...a);

// ── 令牌与角色（P0-4）──────────────────────────────────────────────────────
// 三个角色各一个 48 位十六进制令牌，落在 state/body-tokens.json（只写一次，重启复用——
// 客户端不用跟着重启；想换就直接删文件重启，旧令牌立刻失效）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(HERE, 'state', 'body-tokens.json');
const ROLES = ['owner', 'window', 'dev'];

function loadTokens() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const roles = raw?.roles ?? {};
    if (ROLES.every((r) => /^[0-9a-f]{32,64}$/i.test(String(roles[r] ?? '')))) return roles;
    log('⚠️ 令牌文件不完整，重新生成（旧令牌立即失效）');
  } catch {}
  const roles = {};
  for (const r of ROLES) roles[r] = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ver: 1, issuedAt: new Date().toISOString(), roles }, null, 2), 'utf8');
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
  log(`已生成身体令牌：${TOKEN_FILE}（角色 ${ROLES.join('/')}）`);
  return roles;
}

const TOKENS = loadTokens();
const ROLE_BY_TOKEN = new Map(Object.entries(TOKENS).map(([r, t]) => [String(t), r]));

// 权限矩阵：角色 → 允许的动作。读接口另算（/health /capabilities 开放，/state 需令牌）。
const ROLE_ACTIONS = {
  owner: new Set(['say', 'anim', 'emotion', 'dialogue', 'chatpanel', 'timer', 'cancelalarm', 'memo', 'notice']),
  window: new Set(['say', 'anim', 'emotion', 'dialogue', 'chatpanel', 'timer', 'cancelalarm', 'memo', 'notice']),
  dev: new Set(['say'])
};

const tokenOf = (req, url) => String(req.headers['x-body-token'] ?? url.searchParams.get('token') ?? '').trim();
const roleOf = (req, url) => {
  const t = tokenOf(req, url);
  return t ? (ROLE_BY_TOKEN.get(t) ?? null) : null;
};

// ── 适配器 ───────────────────────────────────────────────────────────────
async function modJson(path, payload, timeoutMs = 8000) {
  const res = await fetch(`${MOD}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const lilith = {
  name: 'lilith',
  label: '莉莉丝（游戏内 mod）',
  // 能力表：上层先查这里，缺什么就跳过什么，别报错
  capabilities: {
    say: true, anim: true, emotion: true, dialogue: true,
    chatpanel: true, timer: true, cancelalarm: true, memo: true,
    nativeBubble: true, mood: false
  },
  async health() {
    try {
      const r = await fetch(`${MOD}/ping`, { signal: AbortSignal.timeout(2500) });
      const j = await r.json();
      return { ok: j?.ok === true, detail: j };
    } catch (error) {
      return { ok: false, detail: { error: String(error?.message ?? error) } };
    }
  },
  async say(p) { return (await modJson('/say', p)).data; },
  async anim(p) { return (await modJson('/anim', p)).data; },
  async emotion(p) { return (await modJson('/emotion', p)).data; },
  async dialogue(p) { return (await modJson('/dialogue', p)).data; },
  async chatpanel() { return (await modJson('/chatpanel', {})).data; },
  async timer(p) { return (await modJson('/timer', p)).data; },
  async cancelalarm() { return (await modJson('/cancelalarm', {})).data; },
  async memo(p) { return (await modJson('/memo', p)).data; }
};

const noop = {
  name: 'noop',
  label: '哑身体（只记录，不动任何东西）',
  capabilities: {
    say: 'logged', anim: 'logged', emotion: 'logged', dialogue: 'logged',
    chatpanel: 'logged', timer: 'logged', cancelalarm: 'logged', memo: 'logged',
    nativeBubble: false, mood: false
  },
  async health() { return { ok: true, detail: { note: '哑身体永远在线' } }; },
  async say(p) { return { ok: true, native: false, how: `noop say: ${String(p?.text ?? '').slice(0, 40)}` }; },
  async anim(p) { return { ok: true, how: `noop anim: ${p?.name ?? ''}` }; },
  async emotion(p) { return { ok: true, how: `noop emotion: ${p?.name ?? ''}` }; },
  async dialogue(p) { return { ok: true, how: `noop dialogue: ${String(p?.text ?? '').slice(0, 40)}` }; },
  async chatpanel() { return { ok: true, how: 'noop chatpanel' }; },
  async timer(p) { return { ok: true, how: `noop timer: ${p?.minutes ?? 10}` }; },
  async cancelalarm() { return { ok: true, how: 'noop cancelalarm' }; },
  async memo(p) { return { ok: true, how: `noop memo: ${p?.mode ?? ''}` }; }
};

const ADAPTERS = { lilith, noop };
let adapter = ADAPTERS[ADAPTER_NAME];
if (!adapter) {
  log(`⚠️ 认不出的身体适配器 "${ADAPTER_NAME}"，按 noop 处理（宁可不动，也不驱动错的身体）`);
  adapter = noop;
}

// ── 队列（单飞 + 仲裁 B：配额 / 优先级 / 合并）────────────────────────────
// 口径（2026-10-25）：本体 3 > 窗口 2 > 工作组 1；本体 1句/3s、4句/10s、15句/60s、动作 1/2s。
// 超额**不拒绝**，改成算出「最早可发时刻」再排；3 秒内同角色 spam 合并成一句；
// 队列满 20 按 dev→window→owner 丢最旧；manual（窗口里人亲自说的）不合并/不丢弃/不排队；
// 等超 30 秒的 job 提级（饥饿保护）。AVATAR_BODY_ARB=off 整体退回 FIFO。
const ARB_ON = String(process.env.AVATAR_BODY_ARB || 'on').toLowerCase() !== 'off';
const QUEUE_LIMIT = Math.max(1, Number(process.env.AVATAR_BODY_ARB_MAX || QUEUE_MAX));
const PRIORITY = { owner: 3, window: 2, dev: 1 };
const QUOTAS = {
  owner: { say: [[3000, 1], [10000, 4], [60000, 15]], action: [[2000, 1]] },
  window: { say: [[2000, 1], [10000, 6], [60000, 20]], action: [[2000, 1]] },
  dev: { say: [[5000, 1], [60000, 6]], action: [[5000, 1]] }
};
const STARVE_MS = 30000;
const MERGE_GAP_MS = 3000;
const MERGE_MAX_CHARS = 200;
const SEAM = '　';

const queue = [];
const history = [];             // 最近 50 条动作，供 /state 看
let busy = false;
let seq = 0;
let wakeTimer = null;
let wakeAt = 0;

const jobRoleOf = (job) => (PRIORITY[job.role] ? job.role : 'dev');
const planTimes = { say: { owner: [], window: [], dev: [] }, action: { owner: [], window: [], dev: [] } };

function historyPush(rec) {
  history.push(rec);
  while (history.length > 50) history.shift();
}

function settle(job, err, value) {
  const waiters = job.waiters;
  job.waiters = [];
  for (const w of waiters) {
    try { if (err) w.reject(err); else w.resolve(value); } catch {}
  }
}

/** 该角色这一类动作的最早可发时刻；顺手把这次占位写进计划表（避免两条同时算到同一时刻）。 */
function planSlot(role, kind, now) {
  const arr = planTimes[kind][role] ?? (planTimes[kind][role] = []);
  let at = now;
  if (ARB_ON) {
    for (const [windowMs, max] of (QUOTAS[role]?.[kind] ?? [])) {
      while (arr.length && now - arr[0] > windowMs) arr.shift();
      const idx = arr.length - max;
      if (idx >= 0) at = Math.max(at, arr[idx] + windowMs + 1);
    }
  }
  arr.push(at);
  arr.sort((a, b) => a - b);
  return at;
}

const betterKey = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]);

/**
 * 选出下一个该跑的 job：只挑**已经到点**的（饥饿提级 > 优先级 > 先来先跑）。
 * 没到点的只回报最早 fireAt —— 让 drain 挂定时器等，而不是让身体空转；
 * 否则一条被配额压到 60 秒后的 say 会把已经到点的闹钟/动作一起堵住。
 */
function pickNext(now) {
  let bestIdx = -1;
  let bestKey = null;
  let minFire = Infinity;
  for (let i = 0; i < queue.length; i += 1) {
    const j = queue[i];
    const boosted = now - j.queuedAt >= STARVE_MS;
    if (boosted && !j.boosted) {
      j.boosted = true;
      log(`[仲裁] 饥饿保护：${j.action}@${jobRoleOf(j)} 等了 ${((now - j.queuedAt) / 1000).toFixed(1)}s，提到最前`);
    }
    if (j.fireAt > now) {
      if (j.fireAt < minFire) minFire = j.fireAt;
      continue;
    }
    const key = [j.boosted ? 1 : 0, PRIORITY[jobRoleOf(j)] ?? 1, -j.id];
    if (!bestKey || betterKey(key, bestKey)) { bestIdx = i; bestKey = key; }
  }
  return { idx: bestIdx, minFire };
}

/** 队列满时丢一个：dev 最旧 → window 非 manual 最旧 → owner 最旧；manual 永不丢。 */
function dropOne() {
  if (queue.length < QUEUE_LIMIT) return null;
  let idx = -1;
  for (const role of ['dev', 'window', 'owner']) {
    idx = queue.findIndex((j) => jobRoleOf(j) === role && !j.manual);
    if (idx >= 0) break;
  }
  if (idx < 0) {
    log(`[仲裁] ⚠️ 队列 ${queue.length} 条全是 manual，临时超限（上限 ${QUEUE_LIMIT}）`);
    return null;
  }
  const [dropped] = queue.splice(idx, 1);
  log(`[仲裁] 队列满(${QUEUE_LIMIT})，丢弃 ${dropped.action}@${jobRoleOf(dropped)}（id=${dropped.id}，manual=${!!dropped.manual}）`);
  settle(dropped, Object.assign(new Error(`身体队列已满，${dropped.action} 被丢弃`), { code: 'QUEUE_FULL' }));
  return dropped;
}

function queueCountByRole() {
  const out = { owner: 0, window: 0, dev: 0 };
  for (const j of queue) out[jobRoleOf(j)] = (out[jobRoleOf(j)] ?? 0) + 1;
  return out;
}

const queueItem = (j) => ({
  id: j.id, action: j.action, role: jobRoleOf(j), source: j.source, priority: PRIORITY[jobRoleOf(j)] ?? 1,
  queuedAt: j.queuedAt, fireAt: j.fireAt, waitMs: Date.now() - j.queuedAt, boosted: !!j.boosted,
  manual: !!j.manual, mergedCount: j.mergedCount, droppedChars: j.droppedChars
});

/**
 * 入队。payload 会被合并逻辑改写（say 合并时改 payload.text，adapter 执行时读的就是它）。
 * opts.manual = 窗口里人亲自说的话：不合并、不丢弃、不排队。
 */
function enqueue(action, source, role, payload, run, opts = {}) {
  const now = Date.now();
  const kind = action === 'say' ? 'say' : 'action';
  const manual = opts.manual === true;
  const jobRole = PRIORITY[role] ? role : 'dev';

  if (ARB_ON && kind === 'say' && !manual) {
    // 合并：同角色、同一波（3 秒内入队）、还没开跑的那条 say
    const target = queue.find((j) => j.action === 'say' && jobRoleOf(j) === jobRole && !j.manual && !j.started && now - j.createdAt <= MERGE_GAP_MS);
    if (target) {
      const add = String(payload?.text ?? '').trim();
      const merged = `${String(target.payload.text ?? '').trim()}${SEAM}${add}`.trim();
      const cut = merged.length > MERGE_MAX_CHARS ? merged.slice(0, MERGE_MAX_CHARS) : merged;
      target.droppedChars += Math.max(0, merged.length - cut.length);
      target.payload.text = cut;
      target.mergedCount += 1;
      log(`[仲裁] 合并 say@${jobRole} → id=${target.id}（累计 ${target.mergedCount} 次，截断 ${target.droppedChars} 字）`);
      return new Promise((resolve, reject) => { target.waiters.push({ resolve, reject }); });
    }
  }

  dropOne();
  return new Promise((resolve, reject) => {
    const job = {
      id: ++seq, action, source, role: jobRole, kind, payload: payload ?? {}, run,
      waiters: [{ resolve, reject }], queuedAt: now, createdAt: now, started: false,
      manual, mergedCount: 0, droppedChars: 0,
      fireAt: manual ? now : planSlot(jobRole, kind, now),
      boosted: false
    };
    queue.push(job);
    if (wakeTimer && job.fireAt < wakeAt) { clearTimeout(wakeTimer); wakeTimer = null; }
    drain();
  });
}

async function drain() {
  if (busy) return;
  const now = Date.now();
  const pick = pickNext(now);
  if (pick.idx < 0) {
    // 一条到点的都没有：按最早 fireAt 挂定时器（别空转）
    if (pick.minFire !== Infinity && !wakeTimer) {
      wakeAt = pick.minFire;
      wakeTimer = setTimeout(() => { wakeTimer = null; drain(); }, Math.min(60000, Math.max(50, pick.minFire - Date.now())));
    }
    return;
  }
  const job = queue[pick.idx];
  queue.splice(pick.idx, 1);
  if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
  job.started = true;
  busy = true;
  const startedAt = Date.now();
  const base = {
    id: job.id, action: job.action, role: jobRoleOf(job), source: job.source,
    priority: PRIORITY[jobRoleOf(job)] ?? 1, manual: !!job.manual,
    mergedCount: job.mergedCount, droppedChars: job.droppedChars,
    text: typeof job.payload?.text === 'string' ? job.payload.text.slice(0, 80) : undefined,
    waitedMs: startedAt - job.queuedAt, at: new Date().toISOString()
  };
  try {
    const result = await job.run();
    const rec = { ...base, ok: result?.ok !== false, tookMs: Date.now() - startedAt };
    historyPush(rec);
    if (!rec.ok) log(`动作失败 ${job.action}@${rec.role}（source=${job.source}）：${JSON.stringify(result).slice(0, 300)}`);
    settle(job, null, { ...result, bodyJob: rec });
  } catch (error) {
    const rec = { ...base, ok: false, tookMs: Date.now() - startedAt, error: String(error?.message ?? error) };
    historyPush(rec);
    log(`动作异常 ${job.action}@${rec.role}（source=${job.source}）：${rec.error}`);
    settle(job, error);
  } finally {
    busy = false;
    setImmediate(drain);
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

// ── D9 零 token 气泡/提示（2026-10-28，03·维护）──────────────────────────────
// 两个落点，任一成功就算成：
//   ① 身体 /say（mod 在时是真的游戏内气泡；mod 不在就失败，不影响 ②）
//   ② relay /notice → 对话窗的气泡（窗口每 ~1s 轮询 /lines，唯一稳定可见的显示面）
// 全程不碰 DSH：不调用任何“唤起 agent”的接口、不写会话、不产生任何回合。
const RELAY_NOTICE_URL = 'http://127.0.0.1:9334/notice';
async function runNotice(input, role, source) {
  const text = String(input?.text ?? '').replace(/\s*\n+\s*/g, ' ').trim().slice(0, 500);
  const target = input?.target === 'dsh' ? 'dsh' : 'xunyu';
  const level = String(input?.level ?? 'info');
  const record = input?.record === true || input?.record === '1' || input?.record === 1;
  const out = { ok: false, text, target, level, recorded: record, body: null, window: null };
  if (text && adapter.capabilities.say !== false) {
    try {
      const r = await enqueue('say', source, role, { text }, () => adapter.say({ text }), { manual: true });
      out.body = { ok: r?.ok !== false, adapter: adapter.name, result: r };
    } catch (e) { out.body = { ok: false, error: String(e?.message ?? e) }; }
  }
  try {
    const res = await fetch(RELAY_NOTICE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, target, record }),
      signal: AbortSignal.timeout(2500)
    });
    const data = await res.json().catch(() => ({}));
    out.window = { ok: res.ok && data?.ok !== false, http: res.status, relay: data };
  } catch (e) { out.window = { ok: false, error: String(e?.message ?? e) }; }
  out.ok = !!(out.body?.ok || out.window?.ok);
  return out;
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const d1ReqT0 = Date.now(); // D1：本次请求起手时刻（degraded 短路也要记 trace）

  if (req.method === 'GET' && path === '/health') {
    const ah = await adapter.health();
    return send(200, {
      ok: true,
      module: 'body',
      version: VER,
      port: PORT,
      ts: Date.now(),
      checks: {
        adapter: { ok: ah.ok, detail: typeof ah.detail === 'string' ? ah.detail : JSON.stringify(ah.detail ?? '') },
        queue: { ok: queue.length < QUEUE_LIMIT, detail: queue.length + '/' + QUEUE_LIMIT },
        capabilities: { ok: !!adapter.capabilities, detail: Object.keys(adapter.capabilities || {}).length + ' 项' }
      },
      service: 'body-service',
      ver: VER,
      adapter: adapter.name,
      adapterLabel: adapter.label,
      adapterOk: ah.ok,
      adapterDetail: ah.detail,
      queue: { depth: queue.length, busy, max: QUEUE_LIMIT, arb: ARB_ON, byRole: queueCountByRole() },
      uptimeMs: Date.now() - bootAt
    });
  }

  if (req.method === 'GET' && path === '/capabilities') {
    return send(200, {
      ok: true,
      module: 'body',
      version: VER,
      port: PORT,
      ts: Date.now(),
      // 契约 §二要求的数组形状；旧的适配器 map 一个键都没丢，改挂 adapterCapabilities
      capabilities: [
        { cap: 'body.say', kind: 'action', note: '说一句话，可指定情绪/动作' },
        { cap: 'body.anim', kind: 'action', note: '播一个动画（按名字）' },
        { cap: 'body.emotion', kind: 'action', note: '切表情' },
        { cap: 'body.dialogue', kind: 'action', note: '走一轮对话' },
        { cap: 'body.notice', kind: 'action', note: '零 token 气泡：身体 + 对话窗（可选入历史）' },
        { cap: 'body.state', kind: 'query', note: '当前动画/情绪/队列状态（需令牌）' },
        { cap: 'body.health', kind: 'query', note: '活着吗（契约字段）' }
      ],
      adapterCapabilities: adapter.capabilities,
      adapter: adapter.name,
      adapterLabel: adapter.label,
      unsupported: Object.entries(adapter.capabilities).filter(([, v]) => v === false).map(([k]) => k)
    });
  }

  // /state 里历史含对话原文：只有三个已知角色能看；/health 与 /capabilities 保持开放。
  if (req.method === 'GET' && path === '/state' && !roleOf(req, url)) {
    log(`[403] 无有效令牌读取 /state`);
    return send(403, { ok: false, error: '读取 /state 需要有效令牌（x-body-token）' });
  }

  if (req.method === 'GET' && path === '/state') {
    const ah = await adapter.health();
    return send(200, {
      ok: true,
      adapter: adapter.name,
      adapterOk: ah.ok,
      queue: { depth: queue.length, busy, arb: ARB_ON, byRole: queueCountByRole(), items: queue.map(queueItem) },
      history
    });
  }

  // D9：GET /notice?text=…&target=…（workdesk 也可以只发一条 URL）
  if (req.method === 'GET' && path === '/notice') {
    const roleG = roleOf(req, url);
    if (!roleG || !(ROLE_ACTIONS[roleG] ?? new Set()).has('notice')) {
      log(`[403] 角色 ${roleG ?? '无'} 无权 notice`);
      return send(403, { ok: false, role: roleG ?? null, error: '缺少令牌或无权（/notice 需要 owner/window 令牌）' });
    }
    const r = await runNotice({
      text: url.searchParams.get('text'),
      target: url.searchParams.get('target'),
      level: url.searchParams.get('level'),
      record: url.searchParams.get('record')
    }, roleG, String(url.searchParams.get('source') ?? 'workdesk'));
    log(`[气泡] GET notice → body=${r.body?.ok ? 'ok' : 'fail'} window=${r.window?.ok ? 'ok' : 'fail'}`);
    return send(r.ok ? 200 : 502, r);
  }

  if (req.method !== 'POST') return send(405, { ok: false, error: '只支持 GET /health /capabilities /state /notice 和 POST 动作' });

  const body = await readBody(req);
  const source = String(body.source ?? url.searchParams.get('source') ?? 'unknown');
  const caps = adapter.capabilities;

  // ── 鉴权（P0-4）：没有有效令牌就一个动作都别想动 ──────────────────────
  const role = roleOf(req, url);
  if (!role) {
    log(`[403] 无有效令牌：${path}（${tokenOf(req, url) ? '令牌无效' : '缺令牌'}）`);
    return send(403, {
      ok: false,
      error: '缺少或无效的身体令牌：请求头带 x-body-token（角色令牌见 avatar/state/body-tokens.json）'
    });
  }
  const actionName = String(path).replace(/^\//, '');
  const allowedActions = ROLE_ACTIONS[role] ?? new Set();
  if (!allowedActions.has(actionName)) {
    log(`[403] 角色 ${role} 无权 ${actionName}（来源 ${source}）`);
    return send(403, {
      ok: false,
      role,
      error: `角色 ${role} 无权执行 ${actionName}（可做：${[...allowedActions].join(', ') || '无'}）`
    });
  }
  log(`动作 ${actionName} ← ${role}（${source}）`);

  const need = (name, value) => {
    if (value == null || String(value).trim() === '') {
      send(400, { ok: false, error: `${name} 不能为空` });
      return false;
    }
    return true;
  };

  try {
    switch (path) {
      case '/say': {
        const _d1t0 = Date.now();
        const _d1tr = d1TraceId();
        const _d1done = (oks, extra = {}) => d1Trace({ t: Date.now(), trace: _d1tr, module: 'body', cap: 'body.say', ms: Date.now() - _d1t0, ok: oks, ...extra });
        if (!need('text', body.text)) { _d1done(false, { layer: 'contract', code: 'text-empty', detail: 'text 不能为空' }); return; }
        if (caps.say === false) { _d1done(false, { layer: 'module', code: 'unsupported', detail: 'adapter 不支持 say' }); return send(501, { ok: false, error: '当前身体不支持说话' }); }
        const payload = { text: String(body.text).trim() };
        if (body.emotion && caps.emotion !== false) payload.emotion = String(body.emotion);
        if (body.action && caps.anim !== false) payload.action = String(body.action);
        if (body.ttlMs) payload.ttlMs = Number(body.ttlMs);
        const r = await enqueue('say', source, role, payload, () => adapter.say(payload), { manual: body.manual === true });
        _d1done(r?.ok !== false, r?.ok === false ? { layer: 'module', code: 'say-failed', detail: String(r?.error ?? 'enqueue 返回失败').slice(0, 120) } : {});
        return send(200, { ok: r?.ok !== false, adapter: adapter.name, result: r });
      }
      case '/anim': {
        const _d1t0 = Date.now();
        const _d1tr = d1TraceId();
        if (!need('name', body.name)) { d1Trace({ t: Date.now(), trace: _d1tr, module: 'body', cap: 'body.anim', ms: Date.now() - _d1t0, ok: false, layer: 'contract', code: 'name-empty', detail: 'name 不能为空' }); return; }
        if (caps.anim === false) { d1Trace({ t: Date.now(), trace: _d1tr, module: 'body', cap: 'body.anim', ms: Date.now() - _d1t0, ok: false, layer: 'module', code: 'unsupported', detail: 'adapter 不支持 anim' }); return send(501, { ok: false, error: '当前身体不支持动作' }); }
        const r = await enqueue('anim', source, role, null, () => adapter.anim({ name: String(body.name).trim() }));
        d1Trace({ t: Date.now(), trace: _d1tr, module: 'body', cap: 'body.anim', ms: Date.now() - _d1t0, ok: r?.ok !== false, ...(r?.ok === false ? { layer: 'module', code: 'anim-failed', detail: String(r?.error ?? 'enqueue 返回失败').slice(0, 120) } : {}) });
        return send(200, { ok: r?.ok !== false, adapter: adapter.name, result: r });
      }
      case '/emotion': {
        if (!need('name', body.name)) return;
        if (caps.emotion === false) return send(501, { ok: false, error: '当前身体不支持表情' });
        const r = await enqueue('emotion', source, role, null, () => adapter.emotion({ name: String(body.name).trim() }));
        return send(200, { ok: r?.ok !== false, adapter: adapter.name, result: r });
      }
      case '/dialogue': {
        if (!need('text', body.text)) return;
        if (caps.dialogue === false) return send(501, { ok: false, error: '当前身体不支持对话文本' });
        const r = await enqueue('dialogue', source, role, null, () => adapter.dialogue({ text: String(body.text).trim() }));
        return send(200, { ok: r?.ok !== false, adapter: adapter.name, result: r });
      }
      case '/notice': {
        const _d1t0 = Date.now();
        if (!need('text', body.text)) return;
        const r = await runNotice({ text: body.text, target: body.target, level: body.level, record: body.record }, role, source);
        d1Trace({
          t: Date.now(), trace: d1TraceId(), module: 'body', cap: 'body.notice', ms: Date.now() - _d1t0, ok: r.ok,
          ...(r.ok ? {} : { layer: 'module', code: 'notice-failed', detail: JSON.stringify({ body: r.body, window: r.window }).slice(0, 160) })
        });
        return send(r.ok ? 200 : 502, r);
      }
      case '/chatpanel': {
        if (caps.chatpanel === false) return send(501, { ok: false, error: '当前身体没有菜单面板' });
        const r = await enqueue('chatpanel', source, role, null, () => adapter.chatpanel());
        return send(200, { ok: r?.ok !== false, adapter: adapter.name, result: r });
      }
      case '/timer': {
        if (caps.timer === false) return send(501, { ok: false, error: '当前身体不支持闹钟' });
        const minutes = Number(body.minutes ?? 10);
        const r = await enqueue('timer', source, role, null, () => adapter.timer({ minutes }));
        return send(200, { ok: r?.ok !== false, adapter: adapter.name, result: r });
      }
      case '/cancelalarm': {
        if (caps.cancelalarm === false) return send(501, { ok: false, error: '当前身体不支持取消闹钟' });
        const r = await enqueue('cancelalarm', source, role, null, () => adapter.cancelalarm());
        return send(200, { ok: r?.ok !== false, adapter: adapter.name, result: r });
      }
      default:
        return send(404, { ok: false, error: `没有这个动作：${path}` });
    }
  } catch (error) {
    if (error?.code === 'QUEUE_FULL') return send(429, { ok: false, error: String(error.message) });
    // 2026-10-27 主人定的优先级：**窗口是一等公民，莉莉丝只是窗口连的可选身体模块箱**。
    // 外设没开（或挂着）不该让对话报错 —— 先探一次 adapter 健康，确认它本来就不可用，
    // 就把这次动作降级成「收到但不出声」，返回 200，别吐 502 让窗口和本体以为链路断了。
    let adapterDown = false;
    try { const h = await adapter.health(); adapterDown = !h?.ok; } catch { adapterDown = true; }
    if (adapterDown && adapter.name !== 'noop') {
      log(`身体外设不可用（${adapter.name}），${path} 降级为静默，不报错`);
      // D1：降级也属「一次调用」，照样落 trace（layer=module / code=adapter-down）
      const _d1capMap = { '/say': 'body.say', '/anim': 'body.anim', '/emotion': 'body.emotion', '/dialogue': 'body.dialogue' };
      if (_d1capMap[path]) {
        d1Trace({ t: Date.now(), trace: d1TraceId(), module: 'body', cap: _d1capMap[path], ms: Date.now() - d1ReqT0, ok: false, layer: 'module', code: 'adapter-down', detail: String(error?.message ?? error).slice(0, 120) });
      }
      return send(200, {
        ok: true, degraded: true, spoke: false, adapter: adapter.name,
        reason: String(error?.message ?? error)
      });
    }
    return send(502, { ok: false, adapter: adapter.name, error: `身体动作失败：${String(error?.message ?? error)}` });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`身体服务已启动 http://127.0.0.1:${PORT}  适配器=${adapter.name}（${adapter.label}）  上游=${MOD}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(`${sig} 退出`); server.close(() => process.exit(0)); });
}
