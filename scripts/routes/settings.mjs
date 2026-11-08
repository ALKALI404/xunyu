#!/usr/bin/env node
/**
 * scripts/routes/settings.mjs —— 设置读写 / SnowLuma 编排 / 桥接控制台（WS-031）
 *
 * 三组接口，共用一条红线：**令牌与 Key 一律掩码，连错误信息里都不许出现明文**。
 *
 *   设置
 *     GET  /api/settings                → 读（model / sampling / bridge / persona），key/token 只有掩码
 *     POST /api/settings {model?,sampling?,bridge?} → 增量写；**空字符串 = 不改**
 *
 *   SnowLuma（扫码登录编排；只起停 + 读状态，不碰它自己的配置文件）
 *     GET  /api/snowluma/status         → {ok, running, loggedIn, online, qrWindowVisible, lastCheckAt}
 *     POST /api/snowluma/start          → 起进程 + 把登录窗调到前台
 *     POST /api/snowluma/reconnect      → 断线重连（只重连不换号，不模拟扫码）
 *
 *   桥接控制台
 *     GET  /api/bridge/status           → 桥的运行态（心跳/会话/队列/错误/窗口）
 *     GET  /api/bridge/logs?src=&after=&lines=  → 增量日志（after 序号，别每次全量）
 *     POST /api/bridge/toggle {key,value}       → **只许改白名单五个字段**，其它 403
 *     POST /api/bridge/restart          → **必须委托给 supervisor**，绝不自己 kill
 *     POST /api/bridge/start            → 同样走 supervisor（桥没起时拉起）
 *     POST /api/bridge/refresh-token    → 重读桥的令牌，**只回 ok，不回内容**
 *
 * 为什么要「委托 supervisor」：桥被自己的工作台 kill 掉时，supervisor 会以为它自己挂的，
 * 触发一次重复拉起——两条路径同时动手，桥会来回起两次。所以重启只有一条路：supervisor。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// httpJson 复用 console.mjs 的：内部探活用 node:http 新连接，
// 不用全局 fetch 的 keep-alive 池（桥一重启，池里的死连接会把请求拖到超时）
import { httpJson } from './console.mjs';
// 纯函数（判定/解析/归一化/校验）全在 ws031-core.mjs，有单测；这里只留 IO 薄壳
import {
  maskSecret, sanitizeLogText, seqOf, parseClock, numIn, clipLine, ERR_RE,
  validateToggle, validateSamplingPatch, validateModelPatch, validateBridgeToken, SAMPLING_KEYS,
} from '../ws031-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..');
const STATE = path.join(WORKSPACE, 'state');
const SETTINGS_FILE = path.join(STATE, 'settings.json');
const SUPERVISOR_EVENTS = path.join(WORKSPACE, 'logs', 'supervisor.jsonl');
const PERSONA_FILE = 'E:\\DeepFish\\Xunyu\\roles\\鲟鱼.md';
const DSH_CREDENTIALS = 'C:\\Users\\Xuchi\\.dsh\\.credentials.yaml';

const BRIDGE_DIR = process.env.XUNYU_BRIDGE_DIR ?? 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1';
const BRIDGE_CFG = path.join(BRIDGE_DIR, 'config.json');
const BRIDGE_STATE = path.join(BRIDGE_DIR, 'state');
// 端口可覆盖：验收时要在**不动线上桥**的前提下演「桥没起」，靠的正是这两个 env（见交付单）
const BRIDGE_PORT = Number(process.env.XUNYU_BRIDGE_PORT ?? 3100);
const BRIDGE_URL = process.env.XUNYU_BRIDGE_URL ?? `http://127.0.0.1:${BRIDGE_PORT}`;
const SNOW_HOME = process.env.XUNYU_SNOWLUMA_HOME ?? 'E:\\DeepFish\\SnowLuma-v2.1.1-win-x64';
// 端口也可覆盖：验收时要在不碰线上 SnowLuma 的前提下演「进程没起」（见交付单 ⑤）
const SNOW_HTTP_PORT = Number(process.env.XUNYU_SNOW_HTTP_PORT ?? 3000);
const SNOW_WS_PORT = Number(process.env.XUNYU_SNOW_WS_PORT ?? 3001);

// 桥配置里**只许改这五个**字段；其它一律 403（红线 1）
const TOGGLE_WHITELIST = ['sendDelayMs', 'ackMessage', 'questionTimeoutMs', 'allow', 'deny'];

// ── 小工具 ───────────────────────────────────────────────────────────────────
function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-ws031`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);      // 原子换，别让人读到半截 JSON
}
function backup(file, tag = 'ws031') {
  try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${tag}`); } catch { /* 备份失败不挡路 */ }
}
function decodeSmart(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 不是 utf8 */ }
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}
function tcpProbe(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const fin = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
    sock.connect(port, host);
  });
}
function ps(script, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', script], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout ?? ''));
    });
  });
}
function exec(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '') || (err ? String(err.message ?? err) : '') });
    });
  });
}

// ── 令牌 / Key：只读、只掩码 ──────────────────────────────────────────────────
function bridgeConfig() { return readJson(BRIDGE_CFG, {}) ?? {}; }

function bridgeToken() {
  const cfg = bridgeConfig();
  const fromCfg = String(cfg.consoleToken ?? '').trim();
  if (fromCfg) return fromCfg;
  try { return fs.readFileSync(path.join(BRIDGE_STATE, 'console-token'), 'utf8').trim(); } catch { return ''; }
}

function findModelKey() {
  const fromBridge = String(bridgeConfig()?.dsh?.authToken ?? '').trim();
  if (fromBridge) return { value: fromBridge, source: '桥 config.dsh.authToken' };
  const env = String(process.env.JUFLOW_API_KEY ?? '').trim();
  if (env) return { value: env, source: '环境变量 JUFLOW_API_KEY' };
  try {
    const m = /^\s*JUFLOW_API_KEY\s*:\s*(\S+)\s*$/m.exec(fs.readFileSync(DSH_CREDENTIALS, 'utf8'));
    if (m?.[1]) return { value: m[1], source: '.dsh\\.credentials.yaml' };
  } catch { /* 没有就算了 */ }
  return { value: '', source: '' };
}

// ── ① 设置 ───────────────────────────────────────────────────────────────────
function readSettings() {
  const doc = readJson(SETTINGS_FILE, null) ?? {};
  const sampling = doc.sampling ?? {};
  const out = {};
  for (const k of SAMPLING_KEYS) out[k] = sampling[k] ?? null;   // 没设置就是 null，别编默认值
  return { sampling: out, updatedAt: doc.updatedAt ?? null, file: SETTINGS_FILE };
}

function settingsView() {
  const cfg = bridgeConfig();
  const key = findModelKey();
  const st = readSettings();
  let persona = { path: PERSONA_FILE, mtime: null, chars: null, ok: false };
  try {
    const s = fs.statSync(PERSONA_FILE);
    const text = fs.readFileSync(PERSONA_FILE, 'utf8');
    persona = { path: PERSONA_FILE, mtime: s.mtimeMs, chars: [...text].length, ok: true };
  } catch { /* 读不到就 null，不编 */ }
  return {
    ok: true,
    at: Date.now(),
    model: {
      provider: cfg?.dsh?.provider ?? null,
      baseUrl: cfg?.dsh?.baseUrl ?? null,
      name: cfg?.dsh?.model ?? null,
      keyMasked: maskSecret(key.value),
      keySource: key.source || null,
      hasKey: Boolean(key.value),
    },
    sampling: st.sampling,
    samplingFile: 'state\\settings.json',
    samplingUpdatedAt: st.updatedAt,
    bridge: {
      url: BRIDGE_URL,
      tokenMasked: maskSecret(bridgeToken()),
      tokenSource: String(cfg.consoleToken ?? '').trim() ? 'config.consoleToken' : 'state\\console-token',
    },
    persona,
  };
}

// ── 三个补丁：校验逻辑在 core（有单测），这里只负责读文件 / 备份 / 落盘 ──────────
function applyModelPatch(patch, applied, warnings) {
  if (!patch || typeof patch !== 'object') return false;
  const cfg = bridgeConfig();
  const r = validateModelPatch(cfg.dsh ?? {}, patch);
  applied.push(...r.applied);
  warnings.push(...r.warnings);
  if (!r.applied.length) return false;
  backup(BRIDGE_CFG);
  cfg.dsh = r.dsh;
  writeJsonAtomic(BRIDGE_CFG, cfg);
  return true;
}

function applySamplingPatch(patch, applied, warnings) {
  if (!patch || typeof patch !== 'object') return false;
  const cur = readSettings();
  const r = validateSamplingPatch(cur.sampling, patch);
  applied.push(...r.applied);
  warnings.push(...r.warnings);
  if (!r.applied.length) return false;
  writeJsonAtomic(SETTINGS_FILE, { sampling: r.sampling, updatedAt: Date.now() });
  return true;
}

function applyBridgePatch(patch, applied, warnings) {
  if (!patch || typeof patch !== 'object') return false;
  const cfg = bridgeConfig();
  let touched = false;
  if ('url' in patch) {
    const url = String(patch.url ?? '').trim();
    if (!url) warnings.push('bridge.url 为空，未改');
    else if (!/^https?:\/\//.test(url)) warnings.push('bridge.url 要 http(s):// 开头，未改');
    else {
      const doc = readJson(SETTINGS_FILE, {}) ?? {};
      doc.bridge = { ...(doc.bridge ?? {}), url };
      doc.updatedAt = doc.updatedAt ?? Date.now();
      writeJsonAtomic(SETTINGS_FILE, doc);
      applied.push('bridge.url');
    }
  }
  if ('token' in patch) {
    const r = validateBridgeToken(patch.token);
    if (!r.ok) warnings.push(r.warning);
    else { cfg.consoleToken = r.value; touched = true; applied.push('bridge.token'); }
  }
  if (!touched) return false;
  backup(BRIDGE_CFG);
  writeJsonAtomic(BRIDGE_CFG, cfg);
  return true;
}

// ── ② SnowLuma ───────────────────────────────────────────────────────────────
function snowCfg() {
  const s = bridgeConfig()?.snowluma ?? {};
  return {
    httpUrl: String(process.env.XUNYU_SNOW_HTTP_URL ?? s.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    wsUrl: String(s.wsUrl ?? 'ws://127.0.0.1:3001'),
    token: String(s.accessToken ?? '').trim(),
    home: SNOW_HOME,
  };
}

// 窗口扫描要起一次 PowerShell（几百毫秒到几秒），**绝不能挡在 HTTP 请求里**：
// 缓存 15 秒，过期就后台刷一次，本次先返回上次看到的——宁可晚 15 秒，也不让页面等 3 秒。
let winCache = { at: 0, rows: [], refreshing: false };
function windows() {
  if (!winCache.refreshing && Date.now() - winCache.at > 15000) {
    winCache.refreshing = true;
    ps('Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress', 5000)
      .then((out) => {
        let rows = [];
        try { const j = JSON.parse(out.trim() || '[]'); rows = Array.isArray(j) ? j : [j]; } catch { rows = []; }
        winCache = { at: Date.now(), rows, refreshing: false };
      })
      .catch(() => { winCache = { ...winCache, at: Date.now(), refreshing: false }; });
  }
  return Promise.resolve(winCache.rows);
}
const SNOW_WIN_RE = /snowluma|扫码|二维码|登录|qr/i;
async function snowWindowVisible() {
  const rows = await windows();
  return rows.some((r) => SNOW_WIN_RE.test(String(r.MainWindowTitle ?? '')));
}
// 只有「启动/重连」这种一次性动作才允许现场扫窗口（要真值，不能拿缓存）
const WIN_SCAN_PS = 'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress';
async function scanWindowsNow() {
  const out = await ps(WIN_SCAN_PS, 5000);
  try { const j = JSON.parse(out.trim() || '[]'); return Array.isArray(j) ? j : [j]; } catch { return []; }
}
async function focusSnowWindow() {
  const rows = await scanWindowsNow();
  const hit = rows.find((r) => SNOW_WIN_RE.test(String(r.MainWindowTitle ?? '')));
  if (!hit) return { ok: false, detail: '没找到登录窗（可能是无窗口/后台模式，不需要前台）' };
  await ps(`$ws = New-Object -ComObject WScript.Shell; $ws.AppActivate(${Number(hit.Id)}) | Out-Null`, 4000);
  winCache = { at: 0, rows: [], refreshing: false };
  return { ok: true, detail: `已把「${String(hit.MainWindowTitle).slice(0, 30)}」调到前台` };
}

async function snowProbe() {
  const cfg = snowCfg();
  const [http, ws] = await Promise.all([tcpProbe('127.0.0.1', SNOW_HTTP_PORT, 800), tcpProbe('127.0.0.1', SNOW_WS_PORT, 800)]);
  const running = http || ws;
  let loggedIn = false, online = false, detail = '';
  let account = null;
  if (running) {
    const h = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' };
    const li = await httpJson(`${cfg.httpUrl}/get_login_info`, { method: 'POST', headers: h, body: {}, timeoutMs: 2500 });
    if (li.ok && li.body?.status === 'ok' && li.body?.data?.user_id) {
      loggedIn = true;
      account = { nickname: li.body.data.nickname ?? null, uin: String(li.body.data.user_id).slice(0, 3) + '***' };
    } else if (li.ok && li.body?.retcode) {
      detail = `登录态查询失败（retcode=${li.body.retcode}，多半是没登录/要扫码）`;
    } else {
      detail = `OneBot 接口不通：${li.error ?? `HTTP ${li.status}`}`;
    }
    if (loggedIn) {
      const gs = await httpJson(`${cfg.httpUrl}/get_status`, { method: 'POST', headers: h, body: {}, timeoutMs: 2000 });
      if (gs.ok && gs.body?.status === 'ok') online = Boolean(gs.body?.data?.online);
    }
  } else {
    detail = `SnowLuma 进程没起（${SNOW_HTTP_PORT}/${SNOW_WS_PORT} 都没在听）`;
  }
  const qrWindowVisible = running ? await snowWindowVisible() : false;
  return { running, loggedIn, online, qrWindowVisible, account, detail };
}

async function snowStart() {
  const before = await snowProbe();
  if (before.running) {
    const focus = before.loggedIn ? { ok: false, detail: '已登录，没有登录窗' } : await focusSnowWindow();
    return { ok: true, alreadyRunning: true, focus, status: await snowProbe() };
  }
  const exe = path.join(SNOW_HOME, 'node.exe');
  const entry = path.join(SNOW_HOME, 'index.mjs');
  if (!fs.existsSync(exe) || !fs.existsSync(entry)) {
    return { ok: false, error: `SnowLuma 装在哪？找不到 ${exe} 或 ${entry}` };
  }
  const child = spawn(exe, [entry], { cwd: SNOW_HOME, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  // 起进程 ≠ 起得来：回头看一眼（WS-016 踩过 4 次「拉起成功」其实没起）
  let up = false;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 700));
    if (await tcpProbe('127.0.0.1', SNOW_HTTP_PORT, 500)) { up = true; break; }
  }
  if (!up) return { ok: false, error: `拉起了进程但 20 秒内 ${SNOW_HTTP_PORT} 没在听——看 SnowLuma 自己的日志`, pid: child.pid ?? null };
  const focus = await focusSnowWindow();
  return { ok: true, started: true, pid: child.pid ?? null, focus, status: await snowProbe() };
}

async function snowPid() {
  const out = await ps(`(Get-NetTCPConnection -LocalPort ${SNOW_HTTP_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`, 4000);
  const pid = Number(String(out).trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function snowReconnect() {
  const st = await snowProbe();
  if (!st.running) {
    const started = await snowStart();
    return { ok: started.ok, action: 'started', detail: '本来就没起，这次直接启动（不算重连）', start: started };
  }
  if (st.loggedIn && st.online) {
    return { ok: true, action: 'already-online', detail: '本来就在线，没动进程' };
  }
  // 进程在但不登录/不在线：只重启进程，不碰它的配置文件
  const pid = await snowPid();
  if (!pid) return { ok: false, error: '拿不到 SnowLuma 的 pid（3000 没有监听进程）' };
  await exec('taskkill', ['/PID', String(pid), '/F'], 8000);
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    if (!(await tcpProbe('127.0.0.1', 3000, 300))) break;
  }
  const started = await snowStart();
  return { ok: started.ok, action: 'restarted', detail: `重连（进程 ${pid} → 重启）`, start: started };
}

/** 登录成功 → 自动把桥拉起来（走 supervisor；不自己 spawn） */
async function ensureBridgeUp(why) {
  const up = await tcpProbe('127.0.0.1', BRIDGE_PORT, 800);
  if (up) return { ok: true, action: 'already-up', why };
  try {
    const { restartOne } = await import('../supervisor.mjs');
    const r = await restartOne('qq-bridge');
    return { ok: Boolean(r.ok), action: r.action ?? 'restart', why, detail: r.error ?? null, code: r.code ?? null };
  } catch (e) {
    return { ok: false, action: 'failed', why, detail: String(e?.message ?? e) };
  }
}

// ── ③ 桥接控制台 ─────────────────────────────────────────────────────────────
function readBridgeLogRaw(file, maxBytes = 256 * 1024) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  return { buf, start, size: st.size, mtime: st.mtimeMs };
}

/** 把缓冲区按行切开，同时记住每行的**绝对字节偏移**——这就是 logs?after= 的序号 */
function splitLinesWithOffset({ buf, start }) {
  const out = [];
  let begin = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0x0a) continue;
    const slice = buf.subarray(begin, i);
    out.push({ offset: start + begin, text: decodeSmart(slice) });
    begin = i + 1;
  }
  if (begin < buf.length) out.push({ offset: start + begin, text: decodeSmart(buf.subarray(begin)) });
  return out;
}

const BRIDGE_LOG_FILES = [
  { file: () => path.join(BRIDGE_STATE, 'bridge.log'), src: 'bridge' },
  { file: () => path.join(BRIDGE_STATE, 'bridge.err.log'), src: 'bridge-err' },
  { file: () => path.join(BRIDGE_STATE, 'bridge-crash.log'), src: 'bridge-crash' },
  { file: () => path.join(BRIDGE_STATE, 'logs', 'errors.jsonl'), src: 'bridge-err' },
];

/**
 * 序号（seq）＝ 该行时间戳 × 1000 + 行内序号，全局单调、跨文件可比。
 * 这样 `after=nextSeq` 的语义就是「比上一次最后一条更新的行」，不会因为多个文件各自
 * 从 0 开始编号而互相串台（第一版就是这么错的：after 拿主日志的号去问，结果把错误日志
 * 的历史行全倒出来了）。
 */
function bridgeLogLines({ src = 'all', after = 0, lines = 200 }) {
  const onlyErr = src === 'errors';
  const files = BRIDGE_LOG_FILES.filter((f) => {
    if (onlyErr && !/err|crash/.test(f.src)) return false;
    try { return fs.statSync(f.file()).isFile(); } catch { return false; }
  });
  const rows = [];
  let truncated = false;
  for (const f of files) {
    let raw;
    try { raw = readBridgeLogRaw(f.file()); } catch { continue; }
    // *.err.log / errors.jsonl 本身就是错误日志：整份都算 error，别指望每行都写 "error"
    const forcedErr = /err|crash/.test(f.src);
    const all = splitLinesWithOffset(raw);
    const last = all.slice(-1200);
    if (all.length > last.length) truncated = true;
    last.forEach((line, idx) => {
      const text = line.text;
      if (!text.trim()) return;
      const isErr = forcedErr || ERR_RE.test(text);
      if (onlyErr && !isErr) return;
      const at = Math.round(parseClock(text, raw.mtime));   // 纯函数：core
      const seq = seqOf(at, idx);                           // 纯函数：core
      if (seq <= after) return;
      const clipped = clipLine(text);                       // 纯函数：core
      if (text.length > 500) truncated = true;
      rows.push({ seq, at, level: isErr ? 'error' : 'info', text: sanitizeLogText(clipped), src: f.src });
    });
  }
  rows.sort((a, b) => a.seq - b.seq);
  const out = rows.slice(-Math.min(1000, Math.max(1, Number(lines) || 200)));
  return {
    ok: true, src, lines: out, count: out.length,
    nextSeq: out.length ? out[out.length - 1].seq : Number(after) || 0,
    truncated,
  };
}

function lastErrorOf() {
  const cands = [
    { f: path.join(BRIDGE_STATE, 'bridge.err.log'), tag: 'bridge.err.log' },
    { f: path.join(BRIDGE_STATE, 'bridge-crash.log'), tag: 'bridge-crash.log' },
    { f: path.join(BRIDGE_STATE, 'logs', 'errors.jsonl'), tag: 'errors.jsonl' },
  ];
  let best = null;
  for (const c of cands) {
    let raw;
    try { raw = readBridgeLogRaw(c.f, 64 * 1024); } catch { continue; }
    const lines = splitLinesWithOffset(raw).reverse();
    for (const l of lines) {
      if (!l.text.trim() || !ERR_RE.test(l.text)) continue;
      const at = raw.mtime;
      if (!best || at > best.at) {
        best = { at, text: sanitizeLogText(clipLine(l.text.trim().slice(0, 300), 300)), src: c.tag };
      }
      break;
    }
  }
  return best;
}

function countErrorsToday() {
  let n = 0;
  for (const f of [path.join(BRIDGE_STATE, 'bridge.err.log'), path.join(BRIDGE_STATE, 'logs', 'errors.jsonl')]) {
    try {
      const raw = readBridgeLogRaw(f, 128 * 1024);
      for (const l of splitLinesWithOffset(raw)) if (l.text.trim()) n += 1;   // 整份都是错误日志
    } catch { /* 没这个文件就跳过 */ }
  }
  return n;
}

function bridgeSessionsBound() {
  const s = readJson(path.join(BRIDGE_STATE, 'sessions.json'), null);
  if (!s) return null;
  if (Array.isArray(s.sessions)) return s.sessions.length;
  if (s.sessions && typeof s.sessions === 'object') return Object.keys(s.sessions).length;
  if (Array.isArray(s)) return s.length;
  return Object.keys(s).length ? 1 : 0;
}

async function bridgeStatus() {
  const t0 = Date.now();
  const token = bridgeToken();
  const up = await tcpProbe('127.0.0.1', BRIDGE_PORT, 900);
  let api = null;
  let pend = null;
  if (up) {
    const headers = { 'x-console-token': token };
    // 两个探针并发；桥偶尔会卡 6 秒，所以各给 2.2 秒——宁可报「接口超时」也不让页面等 5 秒
    const [s1, s2] = await Promise.all([
      httpJson(`${BRIDGE_URL}/api/status`, { timeoutMs: 1800, headers }),
      httpJson(`${BRIDGE_URL}/api/pending`, { timeoutMs: 1800, headers }),
    ]);
    api = s1.ok ? { status: s1.status, body: s1.body } : { error: s1.error };
    pend = s2;
  }
  let logAgeMs = null;
  try { logAgeMs = Date.now() - fs.statSync(path.join(BRIDGE_STATE, 'bridge.log')).mtimeMs; } catch { /* */ }
  const rows = await windows().catch(() => []);
  const visible = rows.some((r) => /qq.?桥|bridge|snowluma|扫码/i.test(String(r.MainWindowTitle ?? '')));
  return {
    ok: true,
    at: Date.now(),
    atText: new Date().toLocaleString('zh-CN', { hour12: false }),
    ms: Date.now() - t0,
    up,
    // 心跳 = 桥的 HTTP 能答；答不上来就是 null（别拿日志 mtime 冒充心跳，那只是「最后活动」）
    lastHeartbeatAgoMs: api?.body ? 0 : null,
    lastLogAgoMs: logAgeMs,
    sessionBound: bridgeSessionsBound(),
    queueDepth: pend?.ok && Array.isArray(pend.body?.pending) ? pend.body.pending.length : null,
    errorCount: countErrorsToday(),
    errorCountNote: '最近 128 KB 错误日志的行数（不是全天计数）',
    mode: api?.body?.mode ?? null,
    dshReady: api?.body?.dshReady ?? null,
    snowluma: api?.body?.snowluma
      ? { connected: Boolean(api.body.snowluma.connected), accountOnline: Boolean(api.body.snowluma.accountOnline), silent: Boolean(api.body.snowluma.silent) }
      : null,
    window: { visible },
    lastError: lastErrorOf(),
    api: up ? (api?.body ? 'ok' : { error: api?.error ?? '没有响应' }) : null,
    detail: up
      ? (api?.body ? null : `桥端口在听，但 /api/status 没应答：${api?.error ?? '没有响应'}（事件循环被占住？）`)
      : `桥没起（${BRIDGE_PORT} 连不上）；最后一次日志活动 ${logAgeMs == null ? '未知' : `${Math.round(logAgeMs / 1000)} 秒前`}`,
  };
}

/** 重启只走 supervisor。**绝不**在这里 kill 进程。 */
async function bridgeRestart() {
  try {
    const { restartOne } = await import('../supervisor.mjs');
    const r = await restartOne('qq-bridge');
    const delegated = 'POST /api/supervisor/restart {id:"qq-bridge"}';
    if (r.code === 429) {
      return { status: 429, body: { ok: false, delegated, error: r.error, used: r.used, max: r.max } };
    }
    if (!r.ok) return { status: 500, body: { ok: false, delegated, error: r.error, action: r.action ?? 'failed' } };
    // supervisor 的 restartOne 契约是「探活失败才拉起」，不 kill。桥在跑时它回 already-up 且**不写事件**，
    // 那样「重启」在日志里什么痕迹都没有。所以这里补一条 supervisor 口径的 skip 事件（只在 already-up 时补），
    // 让事后能查到「谁在什么时候请求过重启」。不写 'start'，免得吃掉 supervisor 的一小时配额。
    if (r.action === 'already-up') {
      try {
        fs.appendFileSync(SUPERVISOR_EVENTS, `${JSON.stringify({
          at: Date.now(), id: 'qq-bridge', action: 'skip', ok: true,
          detail: '工作台请求重启（/api/bridge/restart）：桥在跑，按 WS-016 契约不动进程',
        })}\n`, 'utf8');
      } catch { /* 日志写不进去不影响返回 */ }
    }
    return {
      status: 200,
      body: {
        ok: true, delegated, action: r.action, ms: r.ms ?? null,
        note: r.action === 'already-up'
          ? '桥本来就在跑：supervisor 的 restartOnce 只「拉起」不「杀掉」，这是 WS-016 的设计；已在 supervisor 事件流记一条 skip'
          : 'supervisor 已拉起桥并写入事件流',
      },
    };
  } catch (e) {
    return { status: 500, body: { ok: false, error: `委托 supervisor 失败：${e?.message ?? e}` } };
  }
}

function toggleBridge(key, value) {
  // 白名单与取值校验全在 core（有单测）：403 = 不在白名单，400 = 取值不对
  const v = validateToggle(key, value);
  if (!v.ok) return { status: v.status, body: { ok: false, error: v.error, ...(v.denied ? { denied: v.denied } : {}) } };
  const cfg = bridgeConfig();
  const next = v.value;
  const before = JSON.stringify(cfg[key] ?? null);
  if (before === JSON.stringify(next)) {
    return { status: 200, body: { ok: true, applied: key, unchanged: true, restartNeeded: false } };
  }
  backup(BRIDGE_CFG);
  cfg[key] = next;
  writeJsonAtomic(BRIDGE_CFG, cfg);
  return { status: 200, body: { ok: true, applied: key, restartNeeded: true, note: '桥读的是启动时的配置，要重启才生效（/api/bridge/restart）' } };
}

async function refreshToken() {
  const cfg = bridgeConfig();
  const fromCfg = String(cfg.consoleToken ?? '').trim();
  let fromFile = '';
  try { fromFile = fs.readFileSync(path.join(BRIDGE_STATE, 'console-token'), 'utf8').trim(); } catch { /* */ }
  const candidates = [
    { src: 'config.consoleToken', token: fromCfg },
    { src: 'state\\console-token', token: fromFile },
  ].filter((c) => c.token);
  if (!candidates.length) return { status: 409, body: { ok: false, error: '两处都读不到令牌（桥可能没启动过）——先把桥起来' } };
  let timeout = null;
  for (const c of candidates) {
    const r = await httpJson(`${BRIDGE_URL}/api/status`, { timeoutMs: 2500, headers: { 'x-console-token': c.token } });
    if (r.ok && r.status === 200 && r.body) {
      return { status: 200, body: { ok: true, source: c.src, len: c.token.length, masked: maskSecret(c.token), note: '令牌可用（只回掩码，不回内容）' } };
    }
    if (!r.ok) { timeout = r.error; break; }   // 超时 ≠ 令牌错，别冤枉令牌
  }
  // 失败必须显式：超时（桥没答）和 401/403（令牌被拒）是两种事，状态码也要分开
  if (timeout) {
    return { status: 503, body: { ok: false, unknown: true, error: `桥没应答（${timeout}），无法验证令牌；令牌本身没动过`, masked: maskSecret(candidates[0].token) } };
  }
  return { status: 401, body: { ok: false, error: '两处令牌都被桥拒了（401/403，可能已轮换）——重启桥后重新读', masked: maskSecret(candidates[0].token) } };
}

// ── 路由入口 ─────────────────────────────────────────────────────────────────
export async function handle({ route, method, url, readBody }) {
  // ① 设置
  if (route === '/api/settings') {
    if (method === 'GET') return { status: 200, body: settingsView() };
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '只支持 GET / POST' } };
    const body = await readBody();
    if (body === null || typeof body !== 'object') return { status: 400, body: { ok: false, error: '请求体不是合法 JSON' } };
    const applied = [];
    const warnings = [];
    let needsRestart = false;
    if (body.model) needsRestart = Boolean(applyModelPatch(body.model, applied, warnings)) || needsRestart;
    if (body.sampling) applySamplingPatch(body.sampling, applied, warnings);
    if (body.bridge) needsRestart = Boolean(applyBridgePatch(body.bridge, applied, warnings)) || needsRestart;
    // 失败必须显式：一个字段都没改成、还有警告 → 400（不是 200+ok:false）。
    // 部分成功才回 200，并把没改成的理由放在 warnings 里。
    const status = (!applied.length && warnings.length) ? 400 : 200;
    return {
      status,
      body: {
        ok: status === 200, applied, warnings, restartNeeded: needsRestart,
        at: Date.now(),
        view: settingsView(),
        note: needsRestart ? '模型/令牌写进了桥的 config.json，要重启桥才生效' : undefined,
      },
    };
  }

  // ② SnowLuma
  if (route === '/api/snowluma/status') {
    if (method !== 'GET') return { status: 405, body: { ok: false, error: '只支持 GET' } };
    const s = await snowProbe();
    return {
      status: 200,
      body: {
        ok: true, ...s,
        lastCheckAt: Date.now(),
        lastCheckAtText: new Date().toLocaleString('zh-CN', { hour12: false }),
        qr: s.qrWindowVisible ? '登录窗可见（要扫码）' : (s.loggedIn ? '已登录' : '未登录且没找到登录窗'),
      },
    };
  }
  if (route === '/api/snowluma/start' || route === '/api/snowluma/reconnect') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '只支持 POST' } };
    const wasLoggedIn = (await snowProbe()).loggedIn;
    const r = route === '/api/snowluma/start' ? await snowStart() : await snowReconnect();
    const after = await snowProbe();
    let bridge = null;
    if (after.loggedIn && !wasLoggedIn) {
      // 登录成功 → 自动把桥拉起来
      bridge = await ensureBridgeUp('SnowLuma 登录成功');
      try {
        writeJsonAtomic(path.join(STATE, 'snowluma-status.json'), {
          at: Date.now(), loggedIn: true, bridgeAutoStartedAt: bridge?.ok ? Date.now() : null, bridgeResult: bridge?.action ?? null,
        });
      } catch { /* 记不上不影响 */ }
    }
    return { status: r.ok ? 200 : 500, body: { ...r, status: after, bridgeAutoStart: bridge } };
  }

  // ③ 桥接控制台
  if (route === '/api/bridge/status') {
    if (method !== 'GET') return { status: 405, body: { ok: false, error: '只支持 GET' } };
    return { status: 200, body: await bridgeStatus() };
  }
  if (route === '/api/bridge/logs') {
    if (method !== 'GET') return { status: 405, body: { ok: false, error: '只支持 GET' } };
    return {
      status: 200,
      body: bridgeLogLines({
        src: url.searchParams.get('src') ?? 'all',
        after: Number(url.searchParams.get('after') ?? 0) || 0,
        lines: Number(url.searchParams.get('lines') ?? 200),
      }),
    };
  }
  if (route === '/api/bridge/toggle') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '只支持 POST' } };
    const body = await readBody();
    if (!body || typeof body !== 'object') return { status: 400, body: { ok: false, error: '请求体不是合法 JSON' } };
    const key = String(body.key ?? '').trim();
    if (!key) return { status: 400, body: { ok: false, error: '缺 key（白名单：sendDelayMs/ackMessage/questionTimeoutMs/allow/deny）' } };
    return toggleBridge(key, body.value);
  }
  if (route === '/api/bridge/restart') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '只支持 POST' } };
    return bridgeRestart();
  }
  if (route === '/api/bridge/start') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '只支持 POST' } };
    const r = await ensureBridgeUp('手动请求拉起');
    return { status: r.ok ? 200 : 500, body: r };
  }
  if (route === '/api/bridge/refresh-token') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '只支持 POST' } };
    return refreshToken();
  }

  return null;
}

