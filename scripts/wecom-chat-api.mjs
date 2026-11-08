import { readJson } from './json-io.mjs';
// scripts/wecom-chat-api.mjs —— 企微聊天组件后端（WC-007）
//
// 四个接口，挂在 workdesk 9340 上（`/api/wecom/*`）：
//   GET  /api/wecom/conversations          会话列表（读入站库 state\wecom-chats.jsonl）
//   GET  /api/wecom/messages?conv=&after=  增量消息（dir: in/out，out 带 evidence）
//   POST /api/wecom/send  {conv,text,clientMsgId}  写 outbox → 调 WC-004 发送器 → 回写结果
//   GET  /api/wecom/status                 {vm, sender, ocr, lastSync}
//
// 存储（都是 append-only）：
//   state\wecom-chats.jsonl         入站（本单只建骨架，字段见 readInbound）
//   state\wecom-outbox.jsonl        出站待发（沿用既有格式：{id, chat, text, state, ts, ...}）
//   state\wecom-outbox-result.jsonl 出站结果（**为什么单独一个文件**：既有 outboxState() 是按行计数、不按 id 归并，
//                                   往 outbox 追加"更新行"会把页面计数翻倍；所以终态另起一行一文件，两文件按 id 合并）
//
// 发送复用 WC-004：spawn `node scripts\vm-sender.mjs --conv --text --json`（常驻 watcher 通道）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..');
const CHATS = path.join(WORKSPACE, 'state', 'wecom-chats.jsonl');
const OUTBOX = path.join(WORKSPACE, 'state', 'wecom-outbox.jsonl');
const RESULTS = path.join(WORKSPACE, 'state', 'wecom-outbox-result.jsonl');
const CONVS = path.join(WORKSPACE, 'state', 'wecom-convs.json');
const VM_HEALTH = path.join(WORKSPACE, 'state', 'wecom-vm-health.json');
const SENDER = path.join(WORKSPACE, 'scripts', 'vm-sender.mjs');

const readLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
};
const append = (file, row) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
};
const nowMs = () => Date.now();
const iso = (t) => (t ? new Date(Number(t)).toISOString() : null);
const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };
// 会话名优先取 conv/chat；tesseract 采集写的字段叫 session（2026-10-30 新增），也要认
const convOf = (r) => String(r.conv ?? r.chat ?? r.session ?? '');

/** 入站库骨架：一行一条 {seq, conv, dir:'in', text, ts, from?}；本单没有采集器，文件可能是空的 */
export function readInbound() {
  return readLines(CHATS).filter((r) => r && convOf(r));
}

/** 出站：pending 行 + 终态行按 id 归并（后者覆盖前者）
 *  注意：本模块先写一条 pending 行、再 spawn vm-sender；vm-sender 自己也会往 outbox 写一条自己的行，
 *  所以这里按「conv+text+5 秒内」把 child 写的重复行剔掉（保留带 clientMsgId / by=wecom-chat-api 的那条）。 */
export function readOutbound() {
  const all = readLines(OUTBOX).map((r) => ({ ...r, conv: convOf(r) }));
  const fin = new Map();
  for (const r of readLines(RESULTS)) if (r?.id) fin.set(r.id, r);
  const apiRows = all.filter((r) => r.clientMsgId || r.by === 'wecom-chat-api');
  const key = (r) => `${r.conv}|${r.text}|${Math.round(Number(r.ts ?? 0) / 5000)}`;
  const apiKeys = new Set(apiRows.map(key));
  const rows = all.filter((r) => {
    if (r.clientMsgId || r.by === 'wecom-chat-api') return true;
    if (r.by === 'vm-sender' && apiKeys.has(key(r))) return false;   // child 的重复行
    return true;
  });
  return rows.map((r) => {
    const f = fin.get(r.id);
    if (!f) return { ...r, dir: 'out', state: r.state ?? 'pending' };
    return { ...r, dir: 'out', state: f.state ?? r.state, evidence: f.evidence ?? null, beforeHash: f.beforeHash ?? null, reason: f.reason ?? null, ms: f.ms ?? null, sentAt: f.ts ?? null };
  });
}

/** 已知会话：入站库里出现过的 + state\wecom-convs.json 里登记的 */
export function knownConvs() {
  // 2026-10-30：以 state\wecom\index.json（wecom-dispatch 维护的"正常会话"）为准，
  // 只有它不存在时才回退到"从入站库的每一行猜会话名"——否则早期错标产生的
  // 垃圾名（「21：47」「蝓入框坐标」）会永远挂在列表里。
  const idx = readJson(path.join(WORKSPACE, 'state', 'wecom', 'index.json'));
  const keep = idx && idx.conversations && Object.keys(idx.conversations).length
    ? new Set(Object.keys(idx.conversations))
    : null;

  const map = new Map();
  for (const r of readInbound()) {
    const c = convOf(r);
    if (!c) continue;
    if (keep && !keep.has(c)) continue;
    const cur = map.get(c) ?? { id: c, name: c, unread: 0, lastTs: null, lastText: null, source: 'inbound' };
    const ts = Number(r.atMs ?? r.ts ?? Date.parse(r.at ?? '') ?? 0) || 0;
    cur.lastTs = Math.max(Number(cur.lastTs ?? 0), ts) || null;
    if (r.text) cur.lastText = String(r.text).slice(0, 80);
    if (String(r.side ?? r.dir ?? 'in') === 'in' && r.unread) cur.unread += 1;
    map.set(c, cur);
  }
  if (keep) {
    // 索引里有、但还没采到消息的会话，也要出现在列表里（否则新会话不显示）
    for (const [name, meta] of Object.entries(idx.conversations)) {
      if (map.has(name)) continue;
      map.set(name, { id: name, name, unread: Number(meta.unread ?? 0), lastTs: null, lastText: meta.lastText ?? null, source: 'index' });
    }
  }
  return [...map.values()];
}

let healthCache = { at: 0, value: null };
/** 问 WC-004 的常驻 watcher 活着没（3 秒上限；缓存 30 秒，避免每次 status 都开 ssh） */
async function vmHealth({ force = false } = {}) {
  if (!force && healthCache.value && nowMs() - healthCache.at < 30000) return healthCache.value;
  const out = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(process.execPath, [SENDER, '--health', '--json'], { cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      child.stdout.on('data', (c) => { buf += c; });
      child.on('error', (e) => finish({ ok: false, code: 'spawn-failed', detail: String(e.message).slice(0, 120) }));
      child.on('close', () => {
        try { finish(JSON.parse(buf)); } catch { finish({ ok: false, code: 'bad-output', detail: buf.slice(0, 120) }); }
      });
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, code: 'timeout', detail: 'vm-sender --health 超时' }); }, 8000);
    } catch (e) { finish({ ok: false, code: 'spawn-failed', detail: String(e.message).slice(0, 120) }); }
  });
  healthCache = { at: nowMs(), value: out };
  return healthCache.value;
}

// 通用：跑一次发送器并拿回它的输出（2026-10-30 新增，供 /api/wecom/open 用）
//
// ── WC-014 追加（2026-10-30 23:45，主人：切会话/发消息偶尔 502 fetch failed）──────
// 每次 spawn vm-sender 它都会**自己开一条 SSH 本地转发**（scripts\vm-sender.mjs: LOCAL_PORT 默认 18766，
// 且带 ExitOnForwardFailure=yes）——两条同时跑就抢同一个端口 ⇒ 后到的那条直接失败，
// 表现就是 /api/wecom/open 或 /api/wecom/send 返回 502 {code:-1,out:"fetch failed"}。
// 所以这里加一把**模块内互斥锁**：同一时刻只允许一个 sender 进程；失败按"可重试码"重试 1 次。
// 另外每次调用记一行 state\wecom-sender-log.jsonl（验收要看"连点时没有 fetch failed"）。
const SENDER_LOG = path.join(WORKSPACE, 'state', 'wecom-sender-log.jsonl');
const OPEN_TIMEOUT_MS = 12000;   // open 单次上限：卡死的搜索别扣住互斥锁（发送在排队）
const RETRYABLE = new Set(['tunnel-failed', 'spawn-failed', 'no-result', 'not-listening']);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

let senderTail = Promise.resolve();
let senderWaiting = 0;
function withSenderLock(label, fn) {
  senderWaiting += 1;
  const waitStart = Date.now();
  const run = senderTail.then(fn, fn);
  senderTail = run.catch(() => {}).then(() => { senderWaiting -= 1; });
  return run.then((res) => {
    try {
      fs.appendFileSync(SENDER_LOG, JSON.stringify({
        at: iso(Date.now()), label, waitedMs: Date.now() - waitStart, waiting: senderWaiting,
        code: res && res.code !== undefined ? res.code : null,
        ok: res && res.code === 0 ? true : (res && res.ok) === true,
        retried: Boolean(res && res.retried),
        out: String((res && (res.out || res.detail || res.code)) ?? '').slice(0, 160),
      }) + '\n', 'utf8');
    } catch { /* 日志失败不影响主流程 */ }
    return res;
  }, (err) => {
    try {
      fs.appendFileSync(SENDER_LOG, JSON.stringify({ at: iso(Date.now()), label, waitedMs: Date.now() - waitStart, error: String(err && err.message || err).slice(0, 160) }) + '\n', 'utf8');
    } catch { /* ignore */ }
    throw err;
  });
}

function runSenderOnce(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SENDER, ...args], { cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; let err = '';
    child.stdout.on('data', (c) => { buf += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ code: -1, out: String(e.message).slice(0, 160) }));
    child.on('close', (code) => resolve({ code, out: buf || err }));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 60000);
  });
}

// 串行执行 + 失败重试 1 次（open 是幂等的，重试安全）
function runSender(args) {
  return withSenderLock('open:' + String(args[1] ?? ''), async () => {
    const first = await runSenderOnce(args, OPEN_TIMEOUT_MS);
    if (first.code === 0) return first;
    await sleepMs(600);                       // 给上一条隧道一点时间真正退出
    const second = await runSenderOnce(args, OPEN_TIMEOUT_MS);
    return { ...second, retried: true, firstCode: first.code, firstOut: String(first.out ?? '').slice(0, 120) };
  });
}

function callSenderOnce(conv, text) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SENDER, '--conv', conv, '--text', text, '--json'], { cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; let err = '';
    child.stdout.on('data', (c) => { buf += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ ok: false, code: 'spawn-failed', detail: String(e.message).slice(0, 160) }));
    child.on('close', () => {
      try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, code: 'bad-sender-output', detail: (buf || err).slice(0, 200) }); }
    });
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 90000);
  });
}

// 发送也走同一把锁；**只对"隧道没起来"这类可重试码重试**——
// 已经可能粘贴成功的失败（paste-ineffective / chat-not-verified）绝不重试，免得重复发出去。
function callSender(conv, text) {
  return withSenderLock('send:' + conv, async () => {
    const first = await callSenderOnce(conv, text);
    if (first && first.ok) return first;
    if (!first || !RETRYABLE.has(String(first.code ?? ''))) return first;
    await sleepMs(600);
    const second = await callSenderOnce(conv, text);
    return { ...second, retried: true, firstCode: first.code };
  });
}

const readBody = (req, limit = 8000) => new Promise((resolve) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { raw += c; if (raw.length > limit) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); } });
  req.on('error', () => resolve(null));
});

function outboxId() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `wo-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(16).slice(2, 6)}`;
}

/** 处理 /api/wecom/*；不是我的路由返回 null（让 workdesk 继续走自己的分支） */
export async function handleWecomChat({ req, url, route, method }) {
  if (!route.startsWith('/api/wecom/')) return null;
  const q = url.searchParams;

  if (method === 'GET' && route === '/api/wecom/conversations') {
    const convs = knownConvs().sort((a, b) => Number(b.lastTs ?? 0) - Number(a.lastTs ?? 0));
    return { status: 200, body: { ok: true, count: convs.length, conversations: convs, at: iso(nowMs()) } };
  }

  if (method === 'GET' && route === '/api/wecom/messages') {
    const conv = String(q.get('conv') ?? '').trim();
    const after = Number(q.get('after') ?? 0) || 0;
    const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 50) || 50));
    if (!conv) return { status: 400, body: { ok: false, error: '缺 conv（会话名）' } };
    // 2026-10-30：tesseract 采集的行是 {at, atMs, session, side, text}，
    // 老格式是 {seq, conv, dir, text, ts}。两个都要认，否则消息列表永远空。
    const inbound = readInbound().filter((r) => convOf(r) === conv)
      .map((r) => ({
        seq: Number(r.seq ?? r.atMs ?? r.ts ?? Date.parse(r.at ?? '') ?? 0) || 0,
        dir: String(r.side ?? r.dir ?? 'in'),
        text: String(r.text ?? ''),
        ts: r.ts ?? (r.at ? Date.parse(r.at) : null),
        from: r.from ?? null,
      }));
    const outbound = readOutbound().filter((r) => r.conv === conv)
      .map((r) => ({ seq: Number(r.sentAt ?? r.ts ?? 0), dir: 'out', text: String(r.text ?? ''), ts: r.ts ?? null, state: r.state, evidence: r.evidence ?? null, id: r.id }));
    const rows = [...inbound, ...outbound].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit);
    return { status: 200, body: { ok: true, conv, after, count: rows.length, nextAfter: rows.length ? rows[rows.length - 1].seq : after, messages: rows } };
  }

  // 2026-10-30 23:32（主人：许驰的消息不进上下文）：窗口里"点开会话"必须真的让
  // VM 里的企微切到那个会话，否则 OCR 只读到当前画面，别的会话永远没有新消息。
  if (method === 'POST' && route === '/api/wecom/open') {
    const body = await readBody(req);
    if (!body) return { status: 400, body: { ok: false, error: '需要 JSON 体 {conv}' } };
    const conv = String(body.conv ?? body.chat ?? '').trim();
    if (!conv) return { status: 400, body: { ok: false, error: '缺 conv' } };
    const r = await runSender(['--open', conv, '--json']);
    return { status: r.code === 0 ? 200 : 502, body: { ok: r.code === 0, conv, code: r.code, out: String(r.out ?? '').slice(0, 400) } };
  }

  if (method === 'POST' && route === '/api/wecom/send') {
    const body = await readBody(req);
    if (!body) return { status: 400, body: { ok: false, error: '需要 JSON 体 {conv, text, clientMsgId?}' } };
    const conv = String(body.conv ?? body.chat ?? '').trim();
    const text = String(body.text ?? '').trim();
    const clientMsgId = String(body.clientMsgId ?? '').trim();
    if (!conv) return { status: 400, body: { ok: false, error: '缺 conv（会话名）：必须指定，防发错人' } };
    if (!text) return { status: 400, body: { ok: false, error: '缺 text（不允许发空消息）' } };
    if (text.length > 2000) return { status: 400, body: { ok: false, error: `text 太长（${text.length} 字，上限 2000）` } };

    // ② 幂等：同一个 clientMsgId 重复提交 → 直接回已有记录
    if (clientMsgId) {
      const prev = readOutbound().find((r) => r.clientMsgId === clientMsgId);
      if (prev) return { status: 200, body: { ok: prev.state === 'sent', idempotent: true, id: prev.id, state: prev.state, evidence: prev.evidence ?? null } };
    }

    // ③ 会话必须已知（入站库出现过，或 wecom-convs.json 里登记过）→ 否则 4xx 且**不写 outbox**
    if (!knownConvs().some((c) => c.name === conv || c.id === conv)) {
      return { status: 404, body: { ok: false, error: `未知会话「${conv}」：先让它出现在入站库或 state\\wecom-convs.json，拒绝盲发`, known: knownConvs().map((c) => c.name) } };
    }

    const id = outboxId();
    append(OUTBOX, { id, chat: conv, conv, text, state: 'pending', ts: nowMs(), by: 'wecom-chat-api', clientMsgId: clientMsgId || null });

    let last = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      last = await callSender(conv, text);
      const transient = last?.code === 'tunnel-failed' || last?.code === 'no-result';
      if (last?.ok) break;
      if (!transient) break;           // 会话不存在/没验证成功这类不重试（重试也是白发）
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    const ok = Boolean(last?.ok);
    const fin = append(RESULTS, {
      id, state: ok ? 'sent' : 'failed', evidence: last?.evidence ?? null, beforeHash: last?.beforeHash ?? null,
      reason: ok ? null : (last?.code ?? 'unknown'), detail: last?.detail ?? null, ms: last?.ms ?? null, ts: nowMs(), attempts: last ? undefined : undefined
    });
    return { status: ok ? 200 : 502, body: { ok, id, conv, state: fin.state, evidence: fin.evidence, reason: fin.reason, detail: fin.detail, ms: fin.ms } };
  }

  if (method === 'GET' && route === '/api/wecom/status') {
    const vm = await vmHealth({ force: q.get('refresh') === '1' });
    const outs = readOutbound();
    const lastRow = outs[outs.length - 1] ?? null;
    const inb = readInbound();
    const lastSyncMs = mtime(CHATS);
    return {
      status: 200,
      body: {
        ok: true,
        vm: { ok: Boolean(vm?.ok), hwnd: vm?.hwnd ?? null, session: vm?.session ?? null, code: vm?.code ?? null, checkedAt: iso(healthCache.at) },
        sender: {
          ok: Boolean(lastRow && lastRow.state === 'sent'),
          lastId: lastRow?.id ?? null, lastState: lastRow?.state ?? null, lastAt: iso(Number(lastRow?.sentAt ?? lastRow?.ts ?? 0) || null),
          pending: outs.filter((r) => r.state === 'pending').length,
          failed: outs.filter((r) => r.state === 'failed').length,
          total: outs.length
        },
        ocr: { enabled: false, note: '入站识别/采集未接入（本单只建骨架）', inboundRows: inb.length, file: 'state\\wecom-chats.jsonl' },
        lastSync: iso(lastSyncMs),
        at: iso(nowMs())
      }
    };
  }

  return { status: 404, body: { ok: false, error: `没有这个接口：${route}` } };
}
