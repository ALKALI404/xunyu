// 桌宠 ←→ 两个联系人 的中继（本机 127.0.0.1:9334）。
//
// 两个目标：
//   xunyu —— QQ 侧的鲟鱼（她在 state/agents 那个工作区里的会话）
//   dsh   —— 直接找 DSH 侧的会话（桥接 defaultTarget=auto 解析到哪个就发哪个）
// 两条线各自维护 sessionId 和游标，回复不会串。
//
// 桥接的 agent 接口要求同时带 x-agent-token 和 控制台令牌（?token=）。
//
// 用法：node avatar/relay.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const BRIDGE = 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1';
const PORT = Number(process.env.AVATAR_RELAY_PORT || 9334);
const MOD = String(process.env.AVATAR_MOD || 'http://127.0.0.1:9333').replace(/\/+$/, '');
// 身体服务（9335）：所有「动身体」的请求都应该走它，再由它的适配器去驱动具体身体。
// MOD 只作兜底——服务没起时至少还能说话，不至于因为抽象层挂了就变成哑巴。
const BODY_SERVICE = String(process.env.AVATAR_BODY_SERVICE || 'http://127.0.0.1:9335').replace(/\/+$/, '');
const relayBootAt = Date.now();
let relayBodyOk = true;

// ── 疼痛上报（D6-v2 埋点，最小改动）────────────────────────────────────────
// 规矩：只往 127.0.0.1:9339/pain 发一条 JSON，fire-and-forget；总线没起就当没发生。
// 用**动态 import + 全链 catch**：pain-client 哪天被挪走，也绝不能把 relay 拖崩。
let painClientPromise = null;
function reportPainSafe(event) {
  try {
    if (!painClientPromise) {
      painClientPromise = import('./pain-client.mjs').catch(() => null);
    }
    painClientPromise
      .then((mod) => (mod && typeof mod.reportPain === 'function' ? mod.reportPain(event) : false))
      .catch(() => {});
  } catch { /* 永不抛 */ }
}
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

const BRIDGE_HTTP = 'http://127.0.0.1:3100';

// 读 JSON 一律剥 BOM：PowerShell 的 Set-Content -Encoding UTF8 / 记事本都会带 BOM，
// 裸 JSON.parse 抛错后被 catch 成 fallback，症状是「配置静默变空」，很难查。
function stripBom(s) { return String(s).replace(/^\uFEFF/, ''); }

function readJson(p, fallback = null) {
  try { return JSON.parse(stripBom(fs.readFileSync(p, 'utf8'))); } catch { return fallback; }
}

const cfg = readJson(path.join(BRIDGE, 'config.json'), {}) ?? {};
const ownerQQ = String(cfg.ownerQQ ?? '');
const key = String(process.env.AVATAR_KEY || `private:${ownerQQ}`);

// 令牌会随桥接重启重新生成（agentToken 和 console-token 都会变），
// 所以不能只在启动时读一次；请求被拒时重读一次再试。
function readTokens() {
  const st = readJson(path.join(BRIDGE, 'state', 'social-v2.json'), {}) ?? {};
  const conv = st.conversations?.[key] ?? {};
  let ct = '';
  try { ct = fs.readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim(); } catch {}
  return { token: String(conv.agentToken ?? conv.token ?? ''), consoleToken: ct };
}
let { token, consoleToken } = readTokens();

// 身体服务的角色令牌（P0-4）：按「谁的话」选角色，每次现读，删文件换令牌后立即跟上。
function readBodyTokens() {
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('./state/body-tokens.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
    return raw?.roles ?? {};
  } catch { return {}; }
}
const withConsole = (p, ct = consoleToken) => p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(ct);

// 目标表：两条独立的会话线与游标
// skipHistory：启动/重绑后的第一次轮询只「读掉」历史、不转发。
// 2026-10-25 实测：重启时把 cursor 归零，会把会话里已有的回复整段重投一遍，
// 同一句话连发两三次就会被 QQ 判刷屏限流。宁可漏一小段，不重放。
const targets = {
  xunyu: { label: '鲟鱼', sessionId: null, cursor: 0, error: '', skipHistory: true },
  dsh: { label: 'DSH', sessionId: null, cursor: 0, error: '', skipHistory: true }
};

// 本体会话登记（create-body-session.mjs 写入）。有它就优先用这个 id，
// 不再靠「cwd 在 state/agents 里、最近活跃」去猜。
const OWNER_FILE = 'E:\\DeepFish\\avatar\\state\\owner-session.json';
const ownerReg = readJson(OWNER_FILE, null);
if (ownerReg?.sessionId) {
  targets.xunyu.sessionId = String(ownerReg.sessionId);
  console.log(`[relay] 本体已登记：${ownerReg.sessionId}（cwd=${ownerReg.cwd ?? '?'}，preset=${ownerReg.preset ?? '?'}）`);
}

const GONE_RE = /找不到会话|会话不存在|session[-_ ]?not[-_ ]?found|invalid session|已失效|已归档/i;
const isGoneText = (s) => GONE_RE.test(String(s ?? ''));

const lines = [];
// D9（2026-10-28）：行号必须跨重启只增不减。原来每次启动 lineSeq=0，窗口还攥着旧游标
// （after 比新序号大）→ 收不到任何新消息，只有切页签才恢复；而「游标超大就回全量」会让
// 窗口把同一条气泡重画 N 遍（实测 5 遍）。所以落一个 state\relay-lines.json 续号。
const LINE_SEQ_FILE = 'E:\\DeepFish\\avatar\\state\\relay-lines.json';
function loadLineSeq() {
  try {
    const j = JSON.parse(fs.readFileSync(LINE_SEQ_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const n = Number(j?.seq);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch {}
  return 0;
}
let lineSeq = loadLineSeq();
function saveLineSeq() {
  try {
    fs.mkdirSync(path.dirname(LINE_SEQ_FILE), { recursive: true });
    fs.writeFileSync(LINE_SEQ_FILE, JSON.stringify({ seq: lineSeq, at: new Date().toISOString() }) + '\n', 'utf8');
  } catch {}
}

// ── 窗口聊天记事本（2026-10-25，主人改口径）──────────────────────────────
// 按天一个文件、**一句一行**、标清谁说的（主人 / 鲟鱼），每天换新；
// 蒸馏直接读它 —— 不再另搞一份 JSONL。
const WINDOW_LOG_DIR = 'E:\\DeepFish\\History\\chats';
let windowLogDay = '';
let windowLogStream = null;
// ── D9（2026-10-28，03·维护）按来源分目录 ──────────────────────────────────
// 旧 `chats\window_*.md` 继续写（双写期），同时按 target 写：
//   E:\DeepFish\History\window\鲟鱼\YYYY-MM-DD.jsonl
//   E:\DeepFish\History\window\dsh\YYYY-MM-DD.jsonl
// 一行一条：{t, from:"主人"|"agent", target:"鲟鱼"|"dsh", text}
// 两边各写各的 try：任何一边失败都不拦另一边；先写旧路径，新目录挂了消息也已经在旧路径上。
const WINDOW_SPLIT_DIR = 'E:\\DeepFish\\History\\window';
const WINDOW_SPLIT_NAME = { xunyu: '鲟鱼', dsh: 'dsh' };
const WINDOW_SPLIT_KEEP = 8;            // 最多同时开 8 个句柄（跨天/换来源时关最旧）
const windowSplitStreams = new Map();   // `${来源}|${日期}` -> WriteStream
function windowSplitStream(label, day) {
  const key = label + '|' + day;
  const hit = windowSplitStreams.get(key);
  if (hit) return hit;
  const dir = path.join(WINDOW_SPLIT_DIR, label);
  fs.mkdirSync(dir, { recursive: true });
  const stream = fs.createWriteStream(path.join(dir, day + '.jsonl'), { flags: 'a' });
  // 流出错只记日志：调用方已经落在旧路径上了，这里不能把进程/对话带崩
  stream.on('error', (e) => log('[relay] 分目录流出错（旧路径仍在写）：' + String(e?.message ?? e)));
  windowSplitStreams.set(key, stream);
  if (windowSplitStreams.size > WINDOW_SPLIT_KEEP) {
    for (const [k, s] of windowSplitStreams) {
      if (k === key) continue;
      try { s.end(); } catch {}
      windowSplitStreams.delete(k);
      if (windowSplitStreams.size <= WINDOW_SPLIT_KEEP) break;
    }
  }
  return stream;
}
// 记事本去重（2026-10-27）：xunyu / dsh 两个 target 常指同一会话，同一句回复会被写两遍。
// 用「会话 + 回复时间戳」当键，Set 到上限就裁最旧 —— 不做无限增长的内存 map。
const windowSeen = new Set();
const WINDOW_SEEN_MAX = 2000;
function persistWindowLine(rec) {
  const day = new Date(rec.ts).toLocaleDateString('sv-SE'); // 本地时区 YYYY-MM-DD
  const text = String(rec.text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
  if (!text) return;
  if (rec.dedupeKey) {
    if (windowSeen.has(rec.dedupeKey)) return;
    windowSeen.add(rec.dedupeKey);
    if (windowSeen.size > WINDOW_SEEN_MAX) {
      const first = windowSeen.values().next().value;
      if (first !== undefined) windowSeen.delete(first);
    }
  }
  // ① 旧路径（双写期继续写，别断）
  try {
    if (day !== windowLogDay) {
      if (windowLogStream) { try { windowLogStream.end(); } catch {} }
      fs.mkdirSync(WINDOW_LOG_DIR, { recursive: true });
      windowLogStream = fs.createWriteStream(WINDOW_LOG_DIR + '\\window_' + day + '.md', { flags: 'a' });
      windowLogDay = day;
    }
    const hhmmss = new Date(rec.ts).toLocaleTimeString('zh-CN', { hour12: false });
    const who = rec.from === 'user' ? '主人' : '鲟鱼';
    windowLogStream.write('[' + hhmmss + '] ' + who + '：' + text + '\n');
  } catch (error) {
    log('[relay] 旧窗口记事本写入失败（新分目录仍在写）：' + String(error?.message ?? error));
  }
  // ② 新分目录（按来源）
  try {
    const label = WINDOW_SPLIT_NAME[rec.t];
    if (label) {
      const row = { t: rec.ts, from: rec.from === 'user' ? '主人' : 'agent', target: label, text };
      windowSplitStream(label, day).write(JSON.stringify(row) + '\n');
    }
  } catch (error) {
    log('[relay] 分目录写入失败（旧路径已写，不丢消息）：' + String(error?.message ?? error));
  }
}
// 对话窗在线信号：窗口每次轮询都带 client=window，15 秒内算在线。
// 用途：审批/提问优先落在窗口上，窗口开着就别再拿 QQ 打扰主人。
let windowSeenAt = 0;
const WINDOW_ALIVE_MS = 60000;
const windowAlive = () => Date.now() - windowSeenAt < WINDOW_ALIVE_MS;
function addLine(target, from, text, dedupeKey = null, opts = {}) {
  lineSeq += 1;
  saveLineSeq();   // D9：行号续写落盘，重启后窗口游标不会错位
  const rec = { n: lineSeq, t: target, from, text: String(text ?? ''), ts: Date.now(), ...(dedupeKey ? { dedupeKey } : {}) };
  lines.push(rec);
  if (lines.length > 500) lines.splice(0, lines.length - 500);
  // D9：气泡提示（opts.noHistory）只显示、不进历史；正常对话照旧双写
  if (!opts.noHistory) persistWindowLine(rec);
  return rec;
}

// 固定目标（可选）：targets.json 里写死会话 id，避免 auto 跟随跑偏。
// 例子：{ "dsh": "session-b8901502-...", "xunyu": null }
// 2026-10-25 踩到：这份文件被 PowerShell 写成带 UTF-8 BOM，裸 JSON.parse 直接抛错、
// catch 成 {} ——于是「重启自恢复」认为没有固定目标，dsh 永远绑不上（静默失效）。
// 所以读任何 JSON 都先剥 BOM（stripBom 在文件顶部）。
function readPins() {
  try {
    return JSON.parse(stripBom(fs.readFileSync(new URL('./targets.json', import.meta.url), 'utf8')));
  } catch { return {}; }
}
/** 记住某个目标的会话 id（写回 targets.json，无 BOM），重启后照它自恢复。 */
function writePins(patch) {
  try {
    const next = { ...readPins(), ...patch };
    fs.writeFileSync(new URL('./targets.json', import.meta.url), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) {
    log('写 targets.json 失败:', String(e?.message ?? e));
    return false;
  }
}

const RELAY_LOG = path.join('E:\\DeepFish\\avatar', 'state', 'relay.log');
let relayLogFd = null;
let relayLogWrites = 0;
// 日志轮转（2026-10-25 主人要求）：超过 2 MB 就换新文件，保留 3 份（.1 .2 .3）。
// 必须**在本进程内**做：relay.log 是我们自己持有的句柄，外部脚本改名会被「文件正在使用」挡住
// （实测：另一个进程 rename 直接 EBUSY）。
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP = 3;
function rotateRelayLogIfNeeded() {
  try {
    if (relayLogFd != null) return;
    const st = fs.statSync(RELAY_LOG, { throwIfNoEntry: false });
    if (!st || st.size < LOG_MAX_BYTES) return;
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const from = `${RELAY_LOG}.${i}`;
      const to = `${RELAY_LOG}.${i + 1}`;
      if (fs.existsSync(from)) { try { fs.rmSync(to, { force: true }); } catch {} try { fs.renameSync(from, to); } catch {} }
    }
    try { fs.rmSync(`${RELAY_LOG}.1`, { force: true }); } catch {}
    try { fs.renameSync(RELAY_LOG, `${RELAY_LOG}.1`); } catch {}
  } catch {}
}
function writeRelayLog(line) {
  try {
    if (relayLogFd == null) {
      fs.mkdirSync(path.dirname(RELAY_LOG), { recursive: true });
      rotateRelayLogIfNeeded();
      relayLogFd = fs.openSync(RELAY_LOG, 'a');
    }
    fs.writeSync(relayLogFd, line + '\n');
    // 每 200 行查一次大小，避免每行都 stat
    if (++relayLogWrites % 200 === 0) {
      try {
        const st = fs.statSync(RELAY_LOG, { throwIfNoEntry: false });
        if (st && st.size >= LOG_MAX_BYTES) { fs.closeSync(relayLogFd); relayLogFd = null; }
      } catch { fs.closeSync(relayLogFd); relayLogFd = null; }
    }
  } catch {
    try { if (relayLogFd != null) fs.closeSync(relayLogFd); } catch {}
    relayLogFd = null; // 下次写自动重新打开（文件被删 / 句柄失效时自愈）
  }
}
// 重启后自恢复①：不再依赖「守护启动时的 stdout 重定向」，自己写文件。
const log = (...a) => {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' +
    a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
  try { console.log(line); } catch {}
  writeRelayLog(line);
};

// ── 来源令牌（2026-10-26）──────────────────────────────────────────────────
// 〔来源：主人亲发〕现在只认这个令牌，不看请求体里的 origin/source 字段。
// 桥接启动时生成/轮换 `state/relay-origin.token`，中继每个请求读一次（桥接重启会换新，
// 读文件比缓存更稳；失败就当没令牌——最坏退化成「本体代传」，不会打错标签）。
const RELAY_ORIGIN_FILE = 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\state\\relay-origin.token';
function readRelayOriginToken() {
  try { return fs.readFileSync(RELAY_ORIGIN_FILE, 'utf8').trim(); } catch { return ''; }
}

async function bridge(pathname, { method = 'GET', body } = {}) {
  const doFetch = async () => {
    const originToken = readRelayOriginToken();
    const r = await fetch(`${BRIDGE_HTTP}${withConsole(pathname)}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-agent-token': token,
        ...(originToken ? { 'x-origin-token': originToken } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: r.status, data, text };
  };
  let res = await doFetch();
  if (res.status === 401 || res.status === 403) {
    // 桥接重启过：令牌已轮换，重读后再试一次（只重试一次，避免掩盖真权限问题）
    ({ token, consoleToken } = readTokens());
    res = await doFetch();
  }
  return res;
}

let bodyServiceWarned = false;
// D1：推窗 = relay 的核心副作用，包一层记 trace（原函数体一字未改，改名成 Impl）
async function pushToBody(text, role = 'owner') {
  const _t0 = Date.now();
  const _tr = d1TraceId();
  let _ok = false;
  let _err = null;
  try {
    _ok = await pushToBodyImpl(text, role);
  } catch (e) {
    _err = e;
    throw e;
  } finally {
    relayBodyOk = _ok === true && !_err;
    if (!relayBodyOk) {
      const _isTimeout = /timeout|timed out|ETIMEDOUT/i.test(String(_err?.name ?? '') + String(_err?.message ?? ''));
      reportPainSafe({
        pain: _isTimeout ? 'timeout' : 'unreachable',
        module: 'body',
        by: 'relay',
        code: _err ? 'push-throw' : 'push-failed',
        detail: String(_err?.message ?? 'body 拒收/不可达').slice(0, 120)
      });
    }
    d1Trace({
      t: Date.now(), trace: _tr, module: 'relay', cap: 'relay.push',
      ms: Date.now() - _t0, ok: relayBodyOk,
      ...(relayBodyOk ? {} : { layer: 'module', code: _err ? 'push-throw' : 'push-failed', detail: String(_err?.message ?? _err ?? 'body 拒收/不可达').slice(0, 120) })
    });
  }
  return _ok;
}
async function pushToBodyImpl(text, role = 'owner') {
  // P0-4：身体服务要令牌。角色按「谁的话」选：鲟鱼 tab 的回复=owner，DSH tab 的=dev。
  const bodyToken = String(readBodyTokens()[role] ?? '');
  try {
    const r = await fetch(`${BODY_SERVICE}/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bodyToken ? { 'x-body-token': bodyToken } : {}) },
      body: JSON.stringify({ text, source: 'relay', role }),
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) return true;
    // 401/403 是鉴权问题：**绝不能**回落直连 mod —— 那等于把刚装上的闸门绕过去。
    if (r.status === 401 || r.status === 403) {
      log(`身体服务拒绝（HTTP ${r.status}，角色 ${role}）：查 state/body-tokens.json 与角色权限，不回落直连`);
      return false;
    }
    log(`身体服务拒绝说话（HTTP ${r.status}），转直连 mod`);
  } catch (error) {
    if (!bodyServiceWarned) {
      bodyServiceWarned = true;
      log(`身体服务 ${BODY_SERVICE} 不通（${String(error?.message ?? error)}），暂时直连 mod`);
    }
  }
  try {
    await fetch(`${MOD}/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000)
    });
    return true;
  } catch { return false; }
}

/** 找鲟鱼自己的会话：cwd 在 state/agents 下的那个（取最近活跃）。 */
async function resolveXunyuSession() {
  const { data } = await bridge('/api/dsh/sessions?key=' + encodeURIComponent(key));
  const rows = Array.isArray(data?.sessions) ? data.sessions : [];
  // 优先认「本体之家」（<Xunyu根>），旧路径 avatar\body 与 state\agents 只作后备。
  const sortRecent = (a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0);
  const bodyCwd = rows.filter((r) => /avatar[\\/]body|DeepFish[\\/](Xunyu|鲟鱼)/i.test(String(r.cwd ?? ''))).sort(sortRecent);
  if (bodyCwd[0]?.sessionId) return bodyCwd[0].sessionId;
  const candidates = rows
    .filter((r) => /state[\\/]agents/i.test(String(r.cwd ?? '')))
    .sort(sortRecent);
  return candidates[0]?.sessionId ?? null;
}

// ── 每个目标一条轮询 ──────────────────────────────────────────────────────
async function pollTarget(name) {
  const t = targets[name];
  for (;;) {
    if (!token) { t.error = '没有 agent token'; await new Promise((r) => setTimeout(r, 5000)); continue; }
    if (!t.sessionId) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    try {
      const qs = new URLSearchParams({ key, sessionId: t.sessionId, waitMs: '12000' });
      if (t.cursor) qs.set('after', String(t.cursor));
      const { status, data } = await bridge(`/api/dsh/wait?${qs}`);
      // 「没有活跃的中继绑定」是暂时状态（桥接刚重启/还没喊过话），不能当成会话失效，
      // 否则登记好的本体 id 会被立刻清掉，窗口第一条消息就找不到人。
      // 2026-10-26：光"等"不够——桥接每次重启都会清空内存里的 relayBindings，
      // 没人重绑就一直停在「等待绑定」，表现是**窗口里看得到自己发的话、看不到鲟鱼回的话**
      // （主人 18:29 报的正是这个）。这里用已知的 sessionId 自动重绑，15 秒最多一次。
      if (status === 404 && /没有活跃的中继绑定/.test(String(data?.error ?? ''))) {
        const nowMs = Date.now();
        if (!t.rebindAt || nowMs - t.rebindAt > 15000) {
          t.rebindAt = nowMs;
          try {
            const rb = await bridge('/api/dsh/bind', {
              method: 'POST',
              body: { key, sessionId: t.sessionId, title: name }
            });
            if (rb.data?.ok) {
              log(`[${name}] 自动重绑成功（桥接重启后 relayBindings 为空）`);
              t.error = '';
              t.skipHistory = true; // 只把游标推到最新，不重放历史回复
              continue;
            }
            t.error = `等待绑定（自动重绑被拒：${rb.data?.error ?? rb.status}）`;
          } catch (error) {
            t.error = '等待绑定（自动重绑异常）';
          }
        } else {
          t.error = '等待绑定（稍后自动重试）';
        }
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (status === 404 || (data && data.ok === false && isGoneText(data.error))) {
        log(`[${name}] 会话失效，等待重新绑定`);
        t.sessionId = null;
        t.cursor = 0;
        t.error = '会话已失效，重新等待绑定';
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (!data?.ok) { t.error = data?.error ?? `HTTP ${status}`; await new Promise((r) => setTimeout(r, 3000)); continue; }
      t.error = '';
      const nextCursor = Number(data.cursor ?? t.cursor) || t.cursor;
      if (t.skipHistory) {
        // 启动/重绑后的第一次轮询：只把游标推到最新，不把历史回复重投一遍
        t.cursor = nextCursor;
        t.skipHistory = false;
        log(`[${name}] 跳过历史：游标直接推到 ${t.cursor}，不重投旧回复`);
        continue;
      }
      t.cursor = nextCursor;
      for (const reply of data.replies ?? []) {
        const text = String(reply.text ?? reply.content ?? '').trim();
        if (!text) continue;
        log(`[${name}] ←`, text.slice(0, 50).replace(/\n/g, ' '));
        addLine(name, 'agent', text, reply.ts != null ? `${t.sessionId ?? name}:${reply.ts}` : null);
        await pushToBody(text, name === 'xunyu' ? 'owner' : 'dev');
      }
    } catch (error) {
      t.error = String(error?.message ?? error);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  // 窗口心跳：带 client=window 的任何请求都算「窗口在线」
  if (url.searchParams.get('client') === 'window') windowSeenAt = Date.now();

  if (req.method === 'GET' && url.pathname === '/window-presence') {
    return send(200, { ok: true, alive: windowAlive(), ageMs: windowSeenAt ? Date.now() - windowSeenAt : null });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const _d1Total = Object.keys(targets).length;
    const _d1Bound = Object.values(targets).filter((v) => v && v.sessionId && !v.error).length;
    return send(200, {
      ok: true,
      module: 'relay',
      version: D1_VERSION,
      port: PORT,
      uptimeMs: Date.now() - relayBootAt,
      ts: Date.now(),
      checks: {
        bindings: { ok: _d1Bound > 0, detail: _d1Bound + '/' + _d1Total + ' 已绑定' },
        window: { ok: windowAlive(), detail: 'ageMs=' + (windowSeenAt ? Date.now() - windowSeenAt : 'null') },
        body: { ok: relayBodyOk, detail: relayBodyOk ? 'ok' : '上次推窗失败' }
      },
      key,
      hasToken: !!token,
      targets: Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, { sessionId: v.sessionId, error: v.error, cursor: v.cursor }])),
      mod: MOD,
      lines: lineSeq,
      window: { alive: windowAlive(), ageMs: windowSeenAt ? Date.now() - windowSeenAt : null }
    });
  }

  // D6-v2 埋点自测口（**只在 AVATAR_PAIN_SELFTEST=1 时挂载**，生产不挂）：
  // 走一遍真实的 pushToBody 包装层，用来演练「relay 调 body 失败 → unreachable pain」。
  // 生产不设这个环境变量时，这个分支根本不存在（下面 if 直接跳过）。
  if (process.env.AVATAR_PAIN_SELFTEST === '1' && req.method === 'POST' && url.pathname === '/pain/selftest') {
    // 这个路由处理器不是 async（老代码风格），所以用 promise 链，别用 await
    pushToBody('pain selftest', 'dev')
      .then((okPush) => send(200, { ok: true, pushed: okPush === true, bodyService: BODY_SERVICE, relayBodyOk }))
      .catch((error) => send(500, { ok: false, error: String(error?.message ?? error) }));
    return;
  }

  // 契约 §二：/capabilities（D1 新增；老端点一个没动）
  if (req.method === 'GET' && url.pathname === '/capabilities') {
    return send(200, {
      ok: true, module: 'relay', version: D1_VERSION, port: PORT, ts: Date.now(),
      capabilities: [
        { cap: 'relay.push', kind: 'action', note: '把一句话推给窗口/身体（走 body /say）' },
        { cap: 'relay.chat', kind: 'action', note: '把一句话投给绑定会话并等回复' },
        { cap: 'relay.rebind', kind: 'action', note: '切换 xunyu/dsh 目标绑定' },
        { cap: 'relay.lines', kind: 'query', note: '读窗口行（游标 after）' },
        { cap: 'relay.pending', kind: 'query', note: '读待取回的唤醒消息' },
        { cap: 'relay.health', kind: 'query', note: '活着吗（契约字段）' }
      ]
    });
  }

  if (req.method === 'GET' && url.pathname === '/lines') {
    // 行号跨重启只增不减（见 LINE_SEQ_FILE），所以这里可以老老实实按 after 过滤：
    // 游标永远是「上次见到的最大 n」，不会再出现重启后窗口收不到消息的情况。
    const after = Number(url.searchParams.get('after') || 0) || 0;
    const want = url.searchParams.get('target');
    const rows = lines.filter((l) => l.n > after && (!want || l.t === want));
    return send(200, { ok: true, cursor: lineSeq, lines: rows });
  }

  // ── D9 气泡入口（给 body-service / workdesk 用，零 token）────────────────
  // 把一行提示塞进对话窗的 lines，窗口下一轮轮询（~1s）就画成气泡；默认**不写历史**，
  // 只有 record=1 才落盘（自测/需要留痕时用）。参数：text、target(xunyu|dsh)、record。
  if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/notice') {
    const finish = (body) => {
      const text = String(body.text ?? url.searchParams.get('text') ?? '').replace(/\s*\n+\s*/g, ' ').trim();
      if (!text) return send(400, { ok: false, error: 'text 不能为空' });
      const target = String(body.target ?? url.searchParams.get('target') ?? '') === 'dsh' ? 'dsh' : 'xunyu';
      const record = body.record === true || body.record === 1 || body.record === '1' || url.searchParams.get('record') === '1';
      const rec = addLine(target, 'agent', text.slice(0, 500), null, { noHistory: !record });
      log(`[气泡] ${target}${record ? '（入历史）' : ''}：${text.slice(0, 60)}`);
      return send(200, { ok: true, target, n: rec.n, ts: rec.ts, recorded: record });
    };
    if (req.method === 'GET') return finish({});
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => { let b = {}; try { b = JSON.parse(raw || '{}'); } catch {} finish(b); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/chat') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', async () => {
      let text = '';
      let target = 'xunyu';
      try {
        const body = JSON.parse(raw);
        text = String(body.text ?? '').trim();
        if (body.target === 'dsh' || body.target === 'xunyu') target = body.target;
      } catch {}
      if (!text) return send(400, { ok: false, error: 'text 不能为空' });
      if (!token) return send(503, { ok: false, error: '桥接还没给令牌' });
      // 记下这次投递前的会话 id：只有它真的变了（auto 跟随换绑）才需要清游标/跳过历史
      const sidBefore = targets[target].sessionId ?? '';
      addLine(target, 'user', text);
      try {
        let explicit = null;
        if (target === 'xunyu') {
          explicit = targets.xunyu.sessionId ?? await resolveXunyuSession();
          if (!explicit) return send(502, { ok: false, error: '还没找到鲟鱼的会话（她那边可能还没开始对话）' });
        }
        // 窗口两个页签都带 silent：回复只留给窗口（relay 的 wait 循环会取走），
        // 不触发「唤醒鲟鱼QQ 转述」——那是 QQ 私聊链路的动作，不该由窗口消息触发。
        // dsh 目标若在 targets.json 里固定了会话，就用它；否则交给桥接 auto 解析。
        const pins = readPins();
        if (target === 'dsh' && !explicit && pins.dsh) explicit = String(pins.dsh);
        // origin=relay：告诉桥接这是窗口里的正常对话，不要套 QQ 喊话的复述确认协议。
        const payload = explicit
          ? { key, target: explicit, message: text, silent: true, origin: 'relay' }
          : { key, message: text, silent: true, origin: 'relay' };
        const r = await bridge('/api/dsh/say', { method: 'POST', body: payload });
        if (!r.data?.ok) {
          log(`[${target}] 发送失败`, r.status, r.data?.error ?? '');
          return send(502, { ok: false, error: r.data?.error ?? `HTTP ${r.status}` });
        }
        targets[target].sessionId = r.data.sessionId ?? explicit;
        // 2026-10-26 修：这里原来**每发一条消息**都 cursor=0 + skipHistory=true，
        // 本意是「换绑后不要重投整段历史」，但它无条件执行 → 你发完这句之后，
        // 鲟鱼对这一句的回复被当成"历史"直接丢掉，窗口只剩自己说的话
        // （主人 18:32 报的「鲟鱼的消息没从窗口发到我这里来」就是这个）。
        // 只在**会话真的换了**（auto 跟随换绑）时才清零并跳过历史。
        const sidAfter = targets[target].sessionId;
        if (sidBefore && sidAfter && sidBefore !== sidAfter) {
          targets[target].cursor = 0;
          targets[target].skipHistory = true;
        }
        // 记住这次跟随的结果：下次重启自恢复直接照它绑，不用等第一条消息
        if (target === 'dsh' && targets[target].sessionId) writePins({ dsh: targets[target].sessionId });
        return send(200, { ok: true, target, sessionId: targets[target].sessionId });
      } catch (error) {
        return send(502, { ok: false, error: String(error?.message ?? error) });
      }
    });
    return;
  }

  // ── 审批：窗口直接处理，不经过鲟鱼 ──────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/pending') {
    // createServer 回调不是 async，这里用立即执行的 async 包一层
    (async () => {
      try {
        const r = await bridge('/api/dsh/pending?key=' + encodeURIComponent(key));
        let data = r.data ?? { ok: false, error: 'no data' };
        // 调试用：AVATAR_FAKE_PENDING=1 时冒充一条挂起审批，方便看卡片布局
        if (process.env.AVATAR_FAKE_PENDING === '1' && Array.isArray(data.pending) && data.pending.length === 0) {
          data = { ...data, pending: [{ id: 'fake', kind: 'approval', tool: 'pwsh', reason: '执行命令：npm run build（调试占位）', dangerous: true, dangerReason: '含 build', windowActive: false, canDelegate: false, ageMs: 12000, expiresInMs: 240000 }] };
        }
        send(r.status, data);
      } catch (e) {
        send(502, { ok: false, error: String(e?.message ?? e) });
      }
    })();
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/approve' || url.pathname === '/window')) {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      try {
        if (url.pathname === '/approve') {
          const decision = String(body.decision ?? 'approve');
          const r = await bridge('/api/dsh/approve', { method: 'POST', body: { key, decision, note: body.note, approvalId: body.approvalId, source: 'window' } });
          log('[审批]', decision, r.status, JSON.stringify(r.data ?? {}).slice(0, 120));
          return send(r.status, r.data ?? { ok: false, error: 'no data' });
        }
        const minutes = Math.max(1, Math.min(1440, Number(body.minutes) || 30));
        const r = await bridge('/api/dsh/delegation-window', { method: 'POST', body: { key, minutes, source: 'window' } });
        log('[代批窗口]', minutes, '分钟', r.status);
        return send(r.status, r.data ?? { ok: false, error: 'no data' });
      } catch (e) { return send(502, { ok: false, error: String(e?.message ?? e) }); }
    });
    return;
  }

  // ── 程序化换绑（2026-10-25）────────────────────────────────────────
  // 交接用：把窗口目标切到新会话，**不用重启中继**。
  // body: { target?: 'dsh'|'xunyu', sessionId }
  // 换绑成功后游标归零 + skipHistory，旧会话的回复不会被重投一遍。
  if (req.method === 'POST' && url.pathname === '/rebind') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(stripBom(raw || '{}')); } catch {}
      const target = body.target === 'xunyu' ? 'xunyu' : 'dsh';
      const sessionId = String(body.sessionId ?? '').trim();
      if (!/^session-[0-9a-z-]{8,}$/i.test(sessionId)) return send(400, { ok: false, error: 'sessionId 不合法' });
      try {
        const r = await bridge('/api/dsh/bind', { method: 'POST', body: { key, sessionId, title: target } });
        if (!r.data?.ok) return send(502, { ok: false, error: r.data?.error ?? `HTTP ${r.status}` });
        const t = targets[target];
        t.sessionId = sessionId;
        t.error = '';
        t.cursor = 0;
        t.skipHistory = true;
        const pinned = target === 'dsh' ? writePins({ dsh: sessionId }) : false;
        log(`[换绑] ${target} → ${sessionId}（已绑定；游标归零并跳过历史${target === 'dsh' ? '；已写 targets.json' : ''}）`);
        return send(200, { ok: true, target, sessionId, pinned });
      } catch (e) {
        return send(502, { ok: false, error: String(e?.message ?? e) });
      }
    });
    return;
  }

  send(404, { ok: false, error: 'unknown path' });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`中继已启动 http://127.0.0.1:${PORT}  会话=${key}  令牌=${!!token}  桌宠=${MOD}`);
  // 重启后自恢复③：把已知目标的会话重新绑到桥接（只绑定、不投递），
  // 否则 /api/dsh/wait 会 404「没有活跃的中继绑定」，窗口/QQ 看起来就是「发了没回」。
  try {
    const pins = readPins();
    for (const [name, t] of Object.entries(targets)) {
      const sid = String(t.sessionId ?? pins[name] ?? '').trim();
      if (!sid) { log('重启自恢复：' + name + ' 还没有已知会话，等第一条消息'); continue; }
      bridge('/api/dsh/bind', { method: 'POST', body: { key, sessionId: sid, title: name } })
        .then((r) => {
          // 绑定成功就把本地状态也修好，否则 /health 还挂着「等待绑定」的旧错误（2026-10-25 实测踩到）
          if (r.data?.ok) { t.sessionId = sid; t.error = ''; t.cursor = 0; t.skipHistory = true; }
          log('重启自恢复：已重新绑定 ' + name + ' → ' + sid + '（ok=' + String(r.data?.ok) + '）');
        })
        .catch((e) => log('重启自恢复：绑定 ' + name + ' 失败（' + String(e?.message ?? e) + '）'));
    }
  } catch (e) {
    log('重启自恢复：绑定流程异常（' + String(e?.message ?? e) + '）');
  }
  pollTarget('xunyu');
  pollTarget('dsh');
});
