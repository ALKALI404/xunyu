#!/usr/bin/env node
/**
 * scripts/routes/console.mjs —— 工作台（9340）上的「总控台 / 自检 / 日志尾巴」（WS-027 + WS-031）
 *
 * 为什么单独一个文件：工作台 server 已经 3200 行，再往里塞接口组会把
 * 「花钱的 dispatch」那条主线淹掉。所以整块交给本模块，server 里只留挂载。
 *
 *   GET  /api/console                         → 四栏一次给全（3–5 秒缓存，`cached` 标识）
 *   POST /api/console/restart { id }          → 直接转 WS-016 的 POST /api/supervisor/restart
 *   GET  /api/console/selftest                → 9 项自检（并行，单次 < 3 秒，带每项耗时）
 *   GET  /api/logs/tail?src=kernel|bridge|services&lines=500&onlyError=1&q=xxx
 *
 * 三条铁律（都踩过）：
 *   1. **判 `ok` 字段，不判 HTTP 状态码**——桥会回 200 + {ok:false} 的软失败；
 *   2. **尾部读，不整文件加载**——桥的日志动辄几十兆，全量读一次就把工作台拖死；
 *   3. **聚合只拧形状，不新造数据源**——四栏全部来自已有接口/已有文件。
 *
 * 自检项（WS-027 §四 的 8 条 + WS-031 §① 追加的「模型 Key」，共 9 条；
 * 两张票各自点名的检查项一条不少，多的那条是模型 Key）：
 *   1 services     8 个服务端口可连（不是看进程）
 *   2 qq-bridge    桥 /api/status：判 ok + SnowLuma 已连接且账号在线
 *   3 relay        /health 的 checks.bindings.ok
 *   4 study-engine /health 的 recheck.ok
 *   5 model-key    模型 Key 存在（**只回掩码**）
 *   6 index-jsonl  state\*.jsonl 逐行 JSON.parse 全通过，且无 BOM
 *   7 disk         剩余 > 5 GB
 *   8 persona      人设文件存在且非空（WS-027 §四 第 5 条）
 *   9 qq-file      文件通道：未接入前固定红（WS-027 明确要求「现在必须是红的」）
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  maskSecret, clipLine, LINE_MAX, parseClock, formatEntry, collapseRepeats, isErrorLogName,
} from '../ws031-core.mjs';
import {
  shapeQq, shapeRelay, shapeFiles, shapePersona, shapeMemory,
  shapeCost, shapeTickets, shapeServices, cacheDecision, degradedOf,
} from '../console-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..');
const STATE = path.join(WORKSPACE, 'state');
const REGISTRY = path.join(WORKSPACE, 'tools', 'services.json');
const WS_LOGS = path.join(WORKSPACE, 'logs');
const DSH_LOGS = 'C:\\Users\\Xuchi\\.dsh\\logs';
const DSH_CREDENTIALS = 'C:\\Users\\Xuchi\\.dsh\\.credentials.yaml';
const BRIDGE_DIR = process.env.XUNYU_BRIDGE_DIR ?? 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1';
const BRIDGE_HTTP = 'http://127.0.0.1:3100';
const RELAY_HEALTH = 'http://127.0.0.1:9334/health';
const ENGINE_HEALTH = 'http://127.1.1.3:9351/health';
const PERSONA_FILE = 'E:\\DeepFish\\Xunyu\\roles\\鲟鱼.md';
// 快照路径可覆盖：验收「supervisor 不可用 → 503」时指一份过期快照，不去真杀看门狗（它会被自动拉起，测不稳）
const SUPERVISOR_SNAPSHOT = process.env.XUNYU_SUPERVISOR_SNAPSHOT ?? path.join(STATE, 'supervisor.json');
const DISK_MIN_FREE = 5 * 1024 ** 3;
let lastSelftestAt = 0;          // 5 秒限频（进程内）

// ── 小工具 ───────────────────────────────────────────────────────────────────
function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; }
}
// 纯函数在 scripts\ws031-core.mjs（有单测）；这里只做 IO 薄壳。
export { maskSecret };
/** utf8 解不开就按 GBK 解：桥的 stdout 日志是 Windows 控制台码页写出来的。 */
function decodeSmart(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 不是 utf8 */ }
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}
function tcpProbe(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    const fin = (ok, error) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* */ }
      resolve({ ok, ms: Date.now() - t0, error: error ?? null });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false, 'timeout'));
    sock.once('error', (e) => fin(false, e?.code ?? String(e)));
    sock.connect(port, host);
  });
}
/**
 * 内部探活一律用 node:http + agent:false（每条请求新开连接）。
 * 为什么不用全局 fetch：undici 会复用 keep-alive 连接池，而桥在这台机器上一小时能重启好几次——
 * 池里那条连到「已经死掉的桥」的旧 socket 会让请求一直等到超时（自检因此连续误报「桥不可用」，
 * 但同一时刻 curl 只要 20ms）。新连接 + 短超时才是探活该有的样子。
 */
export function httpJson(url, { timeoutMs = 2000, method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { resolve({ ok: false, error: `URL 不合法：${e?.message ?? e}` }); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body === null ? null : JSON.stringify(body);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = mod.request({
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method,
      agent: false,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        done({ ok: true, status: res.statusCode, body: parsed, text });
      });
      res.on('error', (e) => done({ ok: false, error: String(e?.message ?? e) }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`超时（>${timeoutMs}ms）`)); });
    req.on('error', (e) => done({ ok: false, error: String(e?.message ?? e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 自检各项 ─────────────────────────────────────────────────────────────────
function tick(name, t0, ok, detail, extra = {}) {
  return { name, ok: Boolean(ok), detail, ms: Date.now() - t0, ...extra };
}

async function checkServices() {
  const t0 = Date.now();
  const reg = readJson(REGISTRY, { services: [] });
  const list = reg?.services ?? [];
  if (!list.length) return tick('services', t0, false, '读不到 tools\\services.json 的服务清单');
  const results = await Promise.all(list.map(async (s) => {
    const r = await tcpProbe(s.host ?? '127.0.0.1', Number(s.port));
    return { id: s.id, name: s.name, port: s.port, host: s.host ?? '127.0.0.1', ...r };
  }));
  const down = results.filter((r) => !r.ok);
  if (!down.length) return tick('services', t0, true, `${results.length} 个服务端口都可连`);
  // 连不上时再问一句「这个端口到底在不在听、听在哪个地址」——多半是注册表 host 和实际绑定的地址不一致
  const listeners = await listeningPorts();
  const why = down.map((d) => {
    const other = (listeners.get(d.port) ?? []).filter((a) => a !== d.host);
    if (other.length) return `${d.name}(${d.port}) 注册的是 ${d.host}，实际听在 ${other.join('/')}`;
    return `${d.name}(${d.port}) ${d.error ?? '连不上'}`;
  }).join('；');
  return tick('services', t0, false, `${down.length} 个服务没起：${why}`, { down: down.map((d) => d.id) });
}

// 端口 → 实际监听地址列表（5 秒缓存；只在有服务连不上时才查，平时不花这 70ms）
// 用 netstat 而不是 Get-NetTCPConnection：后者在这个盒子要 4.7 秒，自检总共才 3 秒预算。
let listenerCache = { at: 0, map: new Map() };
function listeningPorts() {
  if (Date.now() - listenerCache.at < 5000 && listenerCache.map.size) return Promise.resolve(listenerCache.map);
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { timeout: 2500, windowsHide: true }, (err, stdout) => {
      const map = new Map();
      if (!err && stdout) {
        // 形如： TCP    127.1.1.4:9342    0.0.0.0:0    LISTENING    49688
        // 不认状态词（各语言版本可能本地化），只认「对端端口是 0」= 在听
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = /^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+\S+\s+\d+\s*$/i.exec(line);
          if (!m) continue;
          if (m[4] !== '0') continue;
          const port = Number(m[2]);
          const addr = m[1];
          if (!Number.isFinite(port)) continue;
          const list = map.get(port) ?? [];
          if (addr && !list.includes(addr)) list.push(addr);
          map.set(port, list);
        }
      }
      listenerCache = { at: Date.now(), map };
      resolve(map);
    });
  });
}

function bridgeToken() {
  const cfg = readJson(path.join(BRIDGE_DIR, 'config.json'), {});
  const fromCfg = String(cfg?.consoleToken ?? '').trim();
  if (fromCfg) return fromCfg;
  try { return fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function checkBridge() {
  const t0 = Date.now();
  const token = bridgeToken();
  if (!token) return tick('qq-bridge', t0, false, '读不到桥的控制台令牌（state\\console-token 与 config.consoleToken 都空）');
  // 桥的 HTTP 偶尔会卡几秒（账本重写/DSH 事件突发）。自检有 3 秒预算，所以给 1.3 秒、
  // 失败再给一次——一次超时不能当「接口不可用」；两次都不行才是结论。
  const probeOnce = (ms) => httpJson(`${BRIDGE_HTTP}/api/status`, { timeoutMs: ms, headers: { 'x-console-token': token } });
  let r = await probeOnce(12000);
  let attempts = 1;
  if (!r.ok) { r = await probeOnce(15000); attempts = 2; }
  if (!r.ok) {
    const up = await tcpProbe('127.0.0.1', 3100, 800);
    if (!up.ok) return tick('qq-bridge', t0, false, `桥没起（3100 连不上：${up.error ?? 'refused'}）`);
    return tick('qq-bridge', t0, false, `桥的 HTTP 两次都没应答（12s / 15s；端口在听，接口不可用——事件循环被占住或状态接口太慢，看桥日志）`, { attempts });
  }
  // 软失败：桥会 200 + {ok:false}
  if (r.body === null) return tick('qq-bridge', t0, false, `桥回的不是 JSON（HTTP ${r.status}）：${String(r.text ?? '').slice(0, 80)}`);
  if (r.body.ok === false) return tick('qq-bridge', t0, false, `桥自报失败：${String(r.body.error ?? r.body.reason ?? 'ok=false')}`);
  if (r.status === 401 || r.status === 403) return tick('qq-bridge', t0, false, `桥拒绝了令牌（HTTP ${r.status}）：令牌可能已轮换，跑 POST /api/bridge/refresh-token`);
  const sl = r.body.snowluma ?? {};
  const connected = Boolean(sl.connected);
  const online = Boolean(sl.accountOnline);
  if (!connected) return tick('qq-bridge', t0, false, '桥起来了，但连不上 SnowLuma（snowluma.connected=false）');
  if (!online) return tick('qq-bridge', t0, false, 'SnowLuma 连上了，但 QQ 账号不在线（isOnline=false）——要扫码登录');
  return tick('qq-bridge', t0, true, `桥 ok，SnowLuma 已连、账号在线（${r.body.mode ?? '—'} 模式）`);
}

async function checkRelay() {
  const t0 = Date.now();
  const r = await httpJson(RELAY_HEALTH, { timeoutMs: 1500 });
  if (!r.ok) return tick('relay', t0, false, `中继 /health 不通：${r.error}`);
  if (!r.body || r.body.ok === false) return tick('relay', t0, false, `中继自报失败：${String(r.body?.error ?? 'ok=false')}`);
  const b = r.body.checks?.bindings ?? {};
  if (b.ok === true) return tick('relay', t0, true, `绑定正常${b.detail ? `（${b.detail}）` : ''}`);
  return tick('relay', t0, false, `绑定不全：${b.detail ?? 'bindings.ok!=true'}`);
}

async function checkEngine() {
  const t0 = Date.now();
  const r = await httpJson(ENGINE_HEALTH, { timeoutMs: 1500 });
  if (!r.ok) return tick('study-engine', t0, false, `评分引擎 /health 不通：${r.error}`);
  if (!r.body || r.body.ok === false) return tick('study-engine', t0, false, `引擎自报失败：${String(r.body?.error ?? 'ok=false')}`);
  const rc = r.body.recheck ?? {};
  if (rc.ok === true) return tick('study-engine', t0, true, `复核通道可用（超时 ${rc.timeoutMs ?? '—'}ms${rc.warm ? '，已预热' : ''}）`);
  return tick('study-engine', t0, false, `复核通道不可用（recheck.ok!=true，timeoutMs=${rc.timeoutMs ?? '—'}）`);
}

/** 模型 Key 只认三个地方，**只回掩码，永不回明文** */
function findModelKey() {
  const cfg = readJson(path.join(BRIDGE_DIR, 'config.json'), {});
  const fromBridge = String(cfg?.dsh?.authToken ?? '').trim();
  if (fromBridge) return { value: fromBridge, source: '桥 config.dsh.authToken' };
  const env = String(process.env.JUFLOW_API_KEY ?? '').trim();
  if (env) return { value: env, source: '环境变量 JUFLOW_API_KEY' };
  try {
    const yml = fs.readFileSync(DSH_CREDENTIALS, 'utf8');
    const m = /^\s*JUFLOW_API_KEY\s*:\s*(\S+)\s*$/m.exec(yml);
    if (m?.[1]) return { value: m[1], source: '.dsh\\.credentials.yaml' };
  } catch { /* 没这个文件就跳过 */ }
  return { value: '', source: '' };
}

function checkModelKey() {
  const t0 = Date.now();
  const k = findModelKey();
  if (!k.value) return tick('model-key', t0, false, '模型 Key 没找到（桥 config.dsh.authToken / JUFLOW_API_KEY / .credentials.yaml 都空）');
  return tick('model-key', t0, true, `已配置 ${maskSecret(k.value)}（来源：${k.source}）`);
}

// 索引 jsonl 的解析结果按 (size, mtime) 缓存：文件没变就不重复 parse，
// 但**不是**给整个自检加缓存——selftest 每次照跑，只是不做无用功。
const jsonlCache = new Map();
function checkIndexJsonl() {
  const t0 = Date.now();
  let files = [];
  try {
    files = fs.readdirSync(STATE).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    return tick('index-jsonl', t0, false, `读不到 state 目录：${e?.message ?? e}`);
  }
  const bad = [];
  let parsedFiles = 0;
  let parsedLines = 0;
  const MAX_BYTES = 20 * 1024 * 1024;   // 超大文件跳过（别让 selftest 变慢），并如实说明
  const skipped = [];
  for (const name of files) {
    const file = path.join(STATE, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.size > MAX_BYTES) { skipped.push(name); continue; }
    const key = `${name}|${st.size}|${st.mtimeMs}`;
    const cached = jsonlCache.get(key);
    if (cached) { parsedLines += cached.lines; parsedFiles += 1; if (cached.bad) bad.push(cached.bad); continue; }
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      bad.push({ name, line: 1, reason: '文件带 BOM（必须无 BOM）' });
      jsonlCache.set(key, { lines: 0, bad: bad[bad.length - 1] });
      continue;
    }
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    let lineNo = 0;
    let found = null;
    for (const line of lines) {
      lineNo += 1;
      if (!line.trim()) continue;
      try { JSON.parse(line); } catch { found = { name, line: lineNo, reason: '不是合法 JSON' }; break; }
    }
    jsonlCache.set(key, { lines: lineNo, bad: found });
    parsedFiles += 1;
    parsedLines += lineNo;
    if (found) bad.push(found);
  }
  // 缓存别无限长
  if (jsonlCache.size > 400) jsonlCache.clear();
  const note = skipped.length ? `；跳过超大文件 ${skipped.join('、')}` : '';
  if (bad.length) {
    const b = bad[0];
    return tick('index-jsonl', t0, false, `${b.name} 第 ${b.line} 行${b.reason}${bad.length > 1 ? `（还有 ${bad.length - 1} 个文件有问题）` : ''}`, { bad });
  }
  return tick('index-jsonl', t0, true, `${parsedFiles} 个 jsonl、${parsedLines} 行全部 parse 通过${note}`);
}

function checkDisk() {
  const t0 = Date.now();
  try {
    const st = fs.statfsSync('E:\\');
    const free = Number(st.bavail) * Number(st.bsize);
    const gb = free / 1024 ** 3;
    if (free > DISK_MIN_FREE) return tick('disk', t0, true, `E: 剩余 ${gb.toFixed(1)} GB（阈值 5 GB）`);
    return tick('disk', t0, false, `只剩 ${gb.toFixed(1)} GB（阈值 5 GB）`);
  } catch (e) {
    return tick('disk', t0, false, `读不到磁盘用量：${e?.message ?? e}`);
  }
}

function checkPersona() {
  const t0 = Date.now();
  try {
    const st = fs.statSync(PERSONA_FILE);
    if (!st.size) return tick('persona', t0, false, '人设文件是空的（roles\\鲟鱼.md 0 字节）');
    return tick('persona', t0, true, `roles\\鲟鱼.md ${(st.size / 1024).toFixed(1)} KB，改于 ${new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false })}`);
  } catch {
    return tick('persona', t0, false, `人设文件读不到：${PERSONA_FILE}`);
  }
}

/**
 * QQ 文件通道（WS-028 还没做）——**现在必须是红的**，这是设计不是故障。
 * 等 state\qq-files.json 里 implemented:true，这里才改判收件箱可写 + outbox 可读。
 */
function checkQqFile() {
  const t0 = Date.now();
  const doc = readJson(path.join(STATE, 'qq-files.json'), null);
  if (!doc || doc.implemented !== true) {
    return tick('qq-file', t0, false, '未接入（网关有能力 upload_private_file，本地零实现；待 WS-028）', { skipped: false });
  }
  const inbox = path.join(WORKSPACE, '收件箱');
  const outbox = path.join(WORKSPACE, '输出');
  try {
    fs.mkdirSync(inbox, { recursive: true });
    fs.accessSync(inbox, fs.constants.W_OK);
    fs.readdirSync(outbox);
    return tick('qq-file', t0, true, '收件箱可写、输出目录可读', { skipped: false });
  } catch (e) {
    return tick('qq-file', t0, false, `目录不可用：${e?.message ?? e}`, { skipped: false });
  }
}

/** 9 项并行跑；任何一项抛错都不许把整条自检带崩。 */
// WS-027 票面点名的 8 条；第 9 条 model-key 是 WS-031 §① 要求的，两条票合并 = 9。
export const WS027_CHECKS = ['services', 'qq-bridge', 'relay', 'study-engine', 'persona', 'index-jsonl', 'disk', 'qq-file'];

export async function runSelftest() {
  const t0 = Date.now();
  const jobs = [
    ['services', checkServices], ['qq-bridge', checkBridge], ['relay', checkRelay],
    ['study-engine', checkEngine], ['model-key', checkModelKey], ['index-jsonl', checkIndexJsonl],
    ['disk', checkDisk], ['persona', checkPersona], ['qq-file', checkQqFile],
  ];
  const raw = await Promise.all(jobs.map(async ([name, fn]) => {
    try { return await fn(); } catch (e) { return { name, ok: false, detail: `检查自己抛错：${e?.message ?? e}`, ms: null }; }
  }));
  // 票面契约是 `state:"pass|fail|skipped"` + 顶层 `summary`；WS-031 那边用的是 `ok` 布尔。
  // 两个都发：`ok` 留兼容，`state` 给新前端。
  const checks = raw.map((c) => ({
    name: c.name,
    state: c.skipped ? 'skipped' : (c.ok ? 'pass' : 'fail'),
    ok: Boolean(c.ok),
    detail: c.detail ?? '',
    ms: c.ms ?? null,
    ...(c.skipped ? { skipped: true } : {}),
  }));
  const tally = (list) => ({
    total: list.length,
    pass: list.filter((c) => c.state === 'pass').length,
    fail: list.filter((c) => c.state === 'fail').length,
    skipped: list.filter((c) => c.state === 'skipped').length,
  });
  return {
    ok: checks.every((c) => c.state !== 'fail'),
    at: Date.now(),
    atText: new Date().toLocaleString('zh-CN', { hour12: false }),
    ms: Date.now() - t0,
    summary: { ...tally(checks), ws027: tally(checks.filter((c) => WS027_CHECKS.includes(c.name))) },
    checks,
  };
}

// ── 日志尾巴（纯函数在 ws031-core：parseClock / formatEntry / collapseRepeats）────
const TAIL_BYTES = 256 * 1024;     // 一次最多从尾部读 256 KB

/** 从文件尾部读一段，返回**已解码**的行数组（丢掉第一行半截）。 */
function readTail(file, { maxBytes = TAIL_BYTES } = {}) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const text = decodeSmart(buf);
  const lines = text.split(/\r?\n/);
  if (start > 0 && lines.length) lines.shift();   // 第一行可能是半截
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, bytes: st.size, sliced: start > 0, mtime: st.mtimeMs };
}

function newestLog(dir, { max = 1 } = {}) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ file: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, max);
  } catch { return []; }
}

function bridgeLogFiles() {
  return [
    { file: path.join(BRIDGE_DIR, 'state', 'bridge.log'), src: 'bridge' },
    { file: path.join(BRIDGE_DIR, 'state', 'bridge.err.log'), src: 'bridge-err' },
    { file: path.join(BRIDGE_DIR, 'state', 'bridge-crash.log'), src: 'bridge-crash' },
    { file: path.join(BRIDGE_DIR, 'state', 'logs', 'errors.jsonl'), src: 'bridge-err' },
  ].filter((f) => { try { return fs.statSync(f.file).isFile(); } catch { return false; } });
}

function serviceLogFiles() {
  const reg = readJson(REGISTRY, { services: [] });
  const out = [{ file: path.join(WS_LOGS, 'supervisor.jsonl'), src: 'supervisor' }];
  for (const s of reg?.services ?? []) {
    if (!s.log) continue;
    const f = path.resolve(WORKSPACE, s.log);
    try { if (fs.statSync(f).isFile()) out.push({ file: f, src: String(s.id) }); } catch { /* 没日志就算了 */ }
  }
  // 各服务的 err 日志（注册表只登记了 out）
  try {
    for (const f of fs.readdirSync(WS_LOGS).filter((n) => n.endsWith('.err.log'))) {
      out.push({ file: path.join(WS_LOGS, f), src: f.replace('.err.log', '') });
    }
  } catch { /* */ }
  return out;
}

/**
 * 三源尾巴。`src=kernel|bridge|services`。
 * 返回 { lines:[{at,level,text,src}], truncated, source }
 */
export function collectTail({ src = 'kernel', lines = 500, onlyError = false, q = '' }) {
  const want = Math.min(2000, Math.max(1, Number(lines) || 500));
  const key = String(src || 'kernel');
  let files;
  let source;
  if (key === 'bridge') {
    files = bridgeLogFiles();
    source = '桥：state\\bridge.log + bridge.err.log + bridge-crash.log（+ state\\logs\\errors.jsonl）';
  } else if (key === 'services') {
    files = serviceLogFiles();
    source = 'services：logs\\supervisor.jsonl + 各服务 out/err';
  } else if (key === 'kernel') {
    const cands = [...newestLog(DSH_LOGS, { max: 1 }), ...newestLog(WS_LOGS, { max: 1 })];
    cands.sort((a, b) => b.at - a.at);
    files = cands.slice(0, 1).map((c) => ({ file: c.file, src: path.basename(c.file) }));
    source = 'kernel：DSH 侧最近写的 *.log（没有就用 logs\\*.log）';
  } else {
    return { ok: false, error: `未知 src=${key}（只支持 kernel|bridge|services）` };
  }
  if (!files.length) return { ok: false, error: `${key} 没有可读的日志文件` };

  const collected = [];
  let truncated = false;
  for (const f of files) {
    let tail;
    try { tail = readTail(f.file); } catch { continue; }
    if (tail.sliced) truncated = true;
    const mtime = tail.mtime;
    // 先全都收进来再过滤——只留最后 want 行再筛，等于「筛完就空」（踩过：桌面日志 141 条 error，筛出 0 条）
    const forceLevel = isErrorLogName(path.basename(f.file)) ? 'error' : null;
    for (const line of tail.lines) {
      if (!line.trim()) continue;
      if (line.length > LINE_MAX) truncated = true;
      collected.push(formatEntry(line, { atMs: mtime, src: f.src, forceLevel }));
    }
  }
  let rows = collected;
  if (onlyError) rows = rows.filter((r) => r.level === 'error');
  if (q) { const needle = String(q).toLowerCase(); rows = rows.filter((r) => r.text.toLowerCase().includes(needle)); }
  rows.sort((a, b) => a.at - b.at);
  // 相邻同文折叠（桥能把同一行刷两万次）：纯函数在 core，带 repeat 计数，不丢行
  const { rows: collapsedRows, deduped } = collapseRepeats(rows);
  if (deduped > 0) truncated = true;
  const out = collapsedRows.slice(-want);
  if (collapsedRows.length > out.length) truncated = true;
  return { ok: true, src: key, source, lines: out, count: out.length, rawCount: rows.length, deduped, truncated };
}

// ── WS-027：总控台四栏聚合 ────────────────────────────────────────────────────
// 缓存 4 秒（票面要求 3–5 秒）：每栏数据来自已有接口，连打两次第二次必须快且标 cached。
const CONSOLE_TTL_MS = 4000;
let consoleCache = { at: 0, body: null };

/** 记忆目录只数行数与字节，60 秒扫一次（别每次请求都扫盘） */
const MEMORY_DIR = 'E:\\DeepFish\\Xunyu\\memory';
let memCache = { at: 0, value: null };
function memoryIndex() {
  const now = Date.now();
  if (memCache.value && now - memCache.at < 60000) return memCache.value;
  const entries = [];
  const walk = (dir) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(md|jsonl)$/i.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
        const text = fs.readFileSync(p, 'utf8');
        entries.push({ path: p, bytes: st.size, lines: text.split(/\r?\n/).length });
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(MEMORY_DIR);
  const value = shapeMemory(entries);
  memCache = { at: now, value };
  return value;
}

/**
 * 汇总四栏。deps 由工作台注入（cost / summary / agents）——那些计算在工作台里已经有，
 * 不在这里重写一份（「只聚合，不新造数据源」）。
 */
async function buildConsole(deps = {}) {
  const t0 = Date.now();
  const snapshot = readJson(SUPERVISOR_SNAPSHOT, null);
  const registry = readJson(REGISTRY, { services: [] });
  const token = bridgeToken();

  // 四栏各自独立，**并发拿**：串行时冷启动要 4.6 秒（桥 1.8 + relay 1.2 + 会话 2.5 相加），
  // 并发后是「最慢的那一项」。缓存钩子只挡住 4 秒内的第二次，第一次必须够快。
  const servicesP = Promise.all((registry.services ?? []).map(async (s) => ({
    id: s.id,
    ok: (await tcpProbe(s.host ?? '127.0.0.1', Number(s.port), 900)).ok,
  })));

  const qqP = (async () => {
    if (!token) return shapeQq({ error: '读不到桥的控制台令牌' });
    // 2.5 秒：桥忙起来一次要 1~6 秒；总控台有 4 秒缓存兜着，宁可多等一点也别把「忙」写成「读不到」
    const br = await httpJson(`${BRIDGE_HTTP}/api/status`, { timeoutMs: 2500, headers: { 'x-console-token': token } });
    if (!br.ok) return shapeQq({ error: br.error });
    if (br.body === null) return shapeQq({ error: `桥回了 HTTP ${br.status}，不是 JSON` });
    return shapeQq({ statusBody: br.body, activity: br.body.activity ?? null, nowMs: Date.now() });
  })();

  const relayP = httpJson(RELAY_HEALTH, { timeoutMs: 1200 }).then((rl) => shapeRelay(rl.ok ? rl.body : null, rl.ok ? null : rl.error));

  const personaP = (() => {
    try {
      const st = fs.statSync(PERSONA_FILE);
      return shapePersona({ file: PERSONA_FILE, mtime: st.mtimeMs, text: fs.readFileSync(PERSONA_FILE, 'utf8') });
    } catch (e) {
      return shapePersona({ file: PERSONA_FILE, error: `读不到：${e?.code ?? e?.message ?? e}` });
    }
  })();

  // deps 里的成本/台账是同步计算；agents 可能是异步（要等会话 RPC）
  const costP = Promise.resolve().then(() => {
    try { return shapeCost(deps.cost ? deps.cost() : null); } catch (e) { const c = shapeCost(null); c.error = String(e?.message ?? e); return c; }
  });
  const ticketsP = Promise.resolve().then(() => {
    try { return shapeTickets(deps.summary ? deps.summary() : null); } catch { return shapeTickets(null); }
  });
  const agentsP = (async () => {
    try {
      const raw = deps.agents ? await deps.agents() : [];
      const list = Array.isArray(raw) ? raw : (raw?.rows ?? []);
      const note = (!Array.isArray(raw) && raw?.error && list.length === 0) ? `会话读不到：${raw.error}` : null;
      return {
        agents: list.map((a) => ({
          no: a.no ?? null, title: a.title ?? '', running: Boolean(a.running), queued: Number(a.queued) || 0,
          doing: Number(a.doing) || 0, active: Boolean(a.active), idleText: a.idleText ?? null,
        })),
        agentsError: note,
      };
    } catch (e) { return { agents: [], agentsError: String(e?.message ?? e) }; }
  })();

  const [probes, qq, relay, persona, cost, tickets, agentsOut] = await Promise.all([
    servicesP, qqP, relayP, personaP, costP, ticketsP, agentsP,
  ]);
  const upOverride = Object.fromEntries(probes.map((p) => [p.id, p.ok]));
  const channels = {
    qq,
    relay,
    files: shapeFiles(readJson(path.join(STATE, 'qq-files.json'), null)),
  };
  // supervisor 不可用 = ① 栏根本画不出来，这不是「某一栏挂了」，按 503 处理（其余单源挂都仍是 200）。
  // 判据两条：快照不存在，或**90 秒没更新**（supervisor 15 秒一拍；超过 6 拍没动就是它没在跑）。
  // 只看「文件在不在」是不够的——supervisor 死了文件会一直在，那样会拿一份冻住的快照骗人。
  const snapAgeMs = snapshot?.at ? Date.now() - Number(snapshot.at) : null;
  const snapStale = snapAgeMs == null ? true : snapAgeMs > 90_000;
  if (!snapshot || snapStale) {
    return {
      ok: false, at: Date.now(), degraded: true, services: [], channels,
      code: 'supervisor-unreachable', error: 'supervisor-unreachable',
      detail: !snapshot
        ? 'supervisor 快照读不到（state\\supervisor.json 不存在）——先跑 node scripts\\supervisor.mjs --once'
        : `supervisor 快照 ${Math.round(snapAgeMs / 1000)} 秒没更新（>90 秒）——它可能没在跑，先看 state\\supervisor.lock`,
    };
  }

  return {
    ok: true,
    at: Date.now(),
    atText: new Date().toLocaleString('zh-CN', { hour12: false }),
    ms: Date.now() - t0,
    cached: false,
    degraded: degradedOf(channels),
    services: shapeServices(snapshot, upOverride),
    channels,
    brain: { persona, memory: memoryIndex(), model: { available: false, note: '经 DSH，无本地读数' } },
    cost,
    tickets,
    agents: agentsOut.agents,
    agentsError: agentsOut.agentsError,
  };
}

/** 重启单个服务：**不另写实现**，直接转 WS-016 的 restartOne */
async function consoleRestart(readBody) {
  const body = await readBody();
  if (body === null || typeof body !== 'object') return { status: 400, body: { ok: false, error: '请求体不是合法 JSON' } };
  const id = String(body?.id ?? '').trim();
  if (!id) return { status: 400, body: { ok: false, error: '缺 id（要重启哪个服务）' } };
  try {
    const { restartOne } = await import('../supervisor.mjs');
    const r = await restartOne(id);
    if (r.code === 404) return { status: 404, body: { ok: false, id, error: r.error } };
    if (r.code === 429) return { status: 429, body: { ok: false, id, error: r.error, used: r.used, max: r.max } };
    if (!r.ok) return { status: 500, body: { ok: false, id, action: 'failed', error: r.error, ms: r.ms } };
    return { status: 200, body: { ok: true, id, action: r.action, ms: r.ms, delegated: 'supervisor.restartOne' } };
  } catch (e) {
    return { status: 500, body: { ok: false, id, error: `委托 supervisor 失败：${e?.message ?? e}` } };
  }
}

// ── 路由入口（server 挂载时调用）──────────────────────────────────────────────
/**
 * 返回 { status, body } 表示已处理；返回 null 表示"不是我的路由"，交回 server。
 * deps 由工作台注入（cost/summary/agents），聚合时不重算已有逻辑。
 */
export async function handle({ route, method, url, readBody, deps }) {
  if (route === '/api/console') {
    if (method !== 'GET') return { status: 405, body: { ok: false, error: '只支持 GET' } };
    const now = Date.now();
    const d = cacheDecision(now, consoleCache.at, CONSOLE_TTL_MS);
    if (d.hit && consoleCache.body) {
      return { status: 200, body: { ...consoleCache.body, cached: true, cacheAgeMs: d.ageMs } };
    }
    const body = await buildConsole(deps ?? {});
    if (!body.ok) return { status: 503, body };
    consoleCache = { at: body.at, body };
    return { status: 200, body };
  }

  if (route === '/api/console/restart') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '只支持 POST' } };
    return consoleRestart(readBody);
  }

  if (route === '/api/console/selftest') {
    if (method !== 'GET') return { status: 405, body: { ok: false, error: '只支持 GET' } };
    const now = Date.now();
    // 不吃缓存（要当下的真话），但 5 秒限频：连打时不重复扫盘、不重复打后端
    if (now - lastSelftestAt < 5000) {
      return { status: 429, body: { ok: false, error: `自检 5 秒内只跑一次（${Math.ceil((5000 - (now - lastSelftestAt)) / 1000)} 秒后可再跑）`, at: now, lastAt: lastSelftestAt } };
    }
    lastSelftestAt = now;
    try {
      const r = await runSelftest();
      return { status: 200, body: r };
    } catch (e) {
      lastSelftestAt = 0;   // 自己崩了不占着限频
      throw e;
    }
  }

  if (route === '/api/logs/tail') {
    if (method !== 'GET') return { status: 405, body: { ok: false, error: '只支持 GET' } };
    const pick = (k) => url.searchParams.get(k);
    const r = collectTail({
      src: pick('src') ?? 'kernel',
      lines: Number(pick('lines') ?? 500),
      onlyError: pick('onlyError') === '1' || pick('onlyError') === 'true',
      q: pick('q') ?? '',
    });
    return { status: r.ok ? 200 : 400, body: r };
  }

  return null;
}
