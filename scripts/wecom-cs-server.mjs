#!/usr/bin/env node
import { readJson as readJsonIo } from './json-io.mjs';
// wecom-cs-server.mjs — WCS-001 企微客服工作台 v0（独立服务，端口 9341，零依赖）
//
// 定位：**另起一页**，不跟内部看板 workdesk（9340）混在一起，也不依赖它（代码里没有任何 9340 引用）。
// v0 只做能看见的部分：
//   收：**不接**（外部客户消息要会话存档，暂未开通）→ 会话与消息全部来自夹具 state\wecom-cs-fixtures.json
//   发：复用 D89 的队列（state\wecom-outbox.jsonl，同一套字段），本服务只**入队**，真正发是 wecom-outbox-runner.mjs
//
// 端点：
//   GET  /                        客服工作台页面（三栏）
//   GET  /api/conversations       会话列表（夹具）
//   GET  /api/messages?chat=<id>  消息列表（夹具，时间正序）
//   POST /api/send                {chat, text, by?} → 写队列一行 queued，立即返回
//   GET  /api/send/status?limit=20 队列状态（默认 20，页面取最近 5 条显示）
//   GET  /health                  模块契约 v0
//   GET  /capabilities            模块契约 v0
//
// 用法：node scripts\wecom-cs-server.mjs [--port 9341]
// 退出码：0 正常 / 1 起不来（端口占用等）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const FIXTURES = path.join(WORKSPACE, 'state', 'wecom-cs-fixtures.json');
const OUTBOX = path.join(WORKSPACE, 'state', 'wecom-outbox.jsonl');
const HEART = path.join(WORKSPACE, 'state', 'wecom-outbox-runner.json');
const PAGE = path.join(HERE, 'wecom-cs-page.html');
const TRACE = path.join(WORKSPACE, 'logs', 'trace.jsonl');
const STARTED_AT = Date.now();

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = Number(portArg >= 0 ? argv[portArg + 1] : (process.env.WECOM_CS_PORT || 9341));

const MAX_TEXT = 2000;
const MAX_PENDING = 20;
const SAFE_NOTE = 'v0：夹具会话统一发往「文件传输助手」（安全会话）；真实客户会话在会话存档接通前不写队列';

const nowMs = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
function clip(s, n) { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…'; }
function readJson(p, dflt) { try { return readJsonIo(p); } catch { return dflt; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; } }

// ── 模块契约 v0 §三：一次调用一条 trace ────────────────────────────────────
function trace(cap, ms, ok, layer, code) {
  try {
    fs.mkdirSync(path.dirname(TRACE), { recursive: true });
    const row = { t: nowMs(), trace: 'tr-' + Math.random().toString(16).slice(2, 8), module: 'wecom-cs', cap, ms, ok };
    if (!ok) { row.layer = layer || 'module'; row.code = code || 'error'; }
    fs.appendFileSync(TRACE, JSON.stringify(row) + '\n', 'utf8');
  } catch { /* trace 写不进去不能影响主流程 */ }
}

function fixtures() {
  const d = readJson(FIXTURES, null);
  if (!d || !Array.isArray(d.conversations)) return null;
  return d;
}

// 队列：与 D89 完全同一套字段（id/state/chat/text/by/t/at），我们只是再写一行
function readOutbox() {
  return readText(OUTBOX).split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
function convIdOf(row) {
  const m = String(row.by || '').match(/^wecom-cs\/(.+)$/);
  return m ? m[1] : null;
}
function runnerState() {
  const h = readJson(HEART, null);
  if (!h || !Number(h.at)) return { running: false, detail: '没有 runner 心跳（scripts\\wecom-outbox-runner.mjs 没起）' };
  const age = nowMs() - Number(h.at);
  return { running: age < 30000, ageMs: age, pid: h.pid ?? null, dry: Boolean(h.dry), lastId: h.lastId ?? null, lastState: h.lastState ?? null, lastReason: h.lastReason ?? null };
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req, limit = 12000) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > limit) req.destroy(); });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
  });
}

// ── 业务 ────────────────────────────────────────────────────────────────
function conversationsPayload() {
  const f = fixtures();
  if (!f) return { ok: false, error: `读不到夹具：${FIXTURES}` };
  const list = f.conversations.map((c) => {
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    const last = msgs[msgs.length - 1] || null;
    return {
      id: c.id, name: c.name, initial: c.initial, company: c.company, tags: c.tags || [],
      unread: Number(c.unread || 0), wecomChat: c.wecomChat, note: c.note,
      messageCount: msgs.length,
      last: last ? { from: last.from, type: last.type, text: last.type === 'image' ? '[图片]' : clip(last.text, 60) } : null,
      lastAt: last ? last.at : null
    };
  });
  return { ok: true, at: iso(nowMs()), source: 'fixture', fixture: true, note: SAFE_NOTE, count: list.length, conversations: list };
}

function messagesPayload(chatId) {
  const f = fixtures();
  if (!f) return { ok: false, status: 500, error: `读不到夹具：${FIXTURES}` };
  const c = f.conversations.find((x) => x.id === chatId);
  if (!c) return { ok: false, status: 404, error: `没有会话 ${chatId}` };
  const msgs = (c.messages || []).slice().sort((a, b) => new Date(a.at) - new Date(b.at));
  return { ok: true, conv: { id: c.id, name: c.name, company: c.company, tags: c.tags || [], wecomChat: c.wecomChat, note: c.note, unread: c.unread || 0 }, count: msgs.length, messages: msgs };
}

function statusPayload(limit) {
  const rows = readOutbox();
  const n = (s) => rows.filter((r) => r.state === s).length;
  const recent = rows.slice(-limit).reverse().map((r) => ({
    id: r.id, state: r.state, chat: r.chat, convId: convIdOf(r), by: r.by ?? null,
    text: clip(r.text, 80), at: r.at ?? iso(Number(r.t) || 0), ms: r.ms ?? null,
    exitCode: r.exitCode ?? null, reason: r.reason ?? null, dry: Boolean(r.dry)
  }));
  return {
    ok: true, at: iso(nowMs()), file: OUTBOX,
    counts: { total: rows.length, queued: n('queued'), sending: n('sending'), sent: n('sent'), failed: n('failed') },
    runner: runnerState(), rows: recent
  };
}

// 队列行：字段与 D89 一致（只多一个 by 的写法 'wecom-cs/<会话id>'，靠它把状态对回会话）
function outboxId(at) {
  const d = new Date(at);
  const p = (x) => String(x).padStart(2, '0');
  return `wo-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(16).slice(2, 6)}`;
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const t0 = Date.now();

  if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
    let html;
    try { html = fs.readFileSync(PAGE, 'utf8'); } catch { json(res, 500, { ok: false, error: `读不到页面 ${PAGE}` }); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (route === '/health' || route === '/api/health')) {
    const f = fixtures();
    const rows = readOutbox();
    const r = runnerState();
    json(res, 200, {
      ok: Boolean(f), module: 'wecom-cs', version: VERSION, port: PORT,
      pid: process.pid, uptimeMs: nowMs() - STARTED_AT, ts: nowMs(),
      checks: {
        fixtures: f ? { ok: true, detail: `${f.conversations.length} 个会话` } : { ok: false, detail: '读不到夹具', layer: 'module' },
        outbox: { ok: true, detail: `${rows.length} 行` },
        runner: { ok: Boolean(r.running), detail: r.running ? `pid ${r.pid}${r.dry ? ' · dry' : ''}` : '未运行（只入队不发送）' },
        receive: { ok: false, detail: '会话存档未接通（v0 用夹具）', layer: 'contract' }
      }
    });
    return;
  }

  if (req.method === 'GET' && route === '/capabilities') {
    json(res, 200, {
      ok: true, module: 'wecom-cs', version: VERSION,
      capabilities: [
        { cap: 'wecom-cs.conversations', kind: 'query', note: '夹具会话列表' },
        { cap: 'wecom-cs.messages', kind: 'query', note: '某个会话的消息（夹具，时间正序）' },
        { cap: 'wecom-cs.send', kind: 'action', note: '写入代持发送队列（不直接发送）' },
        { cap: 'wecom-cs.send_status', kind: 'query', note: '队列最近状态 + runner 心跳' }
      ]
    });
    return;
  }

  if (req.method === 'GET' && route === '/api/conversations') {
    const p = conversationsPayload();
    trace('wecom-cs.conversations', Date.now() - t0, Boolean(p.ok), p.ok ? null : 'module', p.ok ? null : 'fixtures');
    json(res, p.ok ? 200 : 500, p);
    return;
  }

  if (req.method === 'GET' && route === '/api/messages') {
    const chat = String(url.searchParams.get('chat') ?? '').trim();
    if (!chat) { json(res, 400, { ok: false, error: '缺 chat（会话 id，如 c-001）' }); return; }
    const p = messagesPayload(chat);
    trace('wecom-cs.messages', Date.now() - t0, Boolean(p.ok), p.ok ? null : 'contract', p.ok ? null : 'no-such-chat');
    json(res, p.ok ? 200 : (p.status || 500), p);
    return;
  }

  if (req.method === 'GET' && route === '/api/send/status') {
    // 页面 3 秒轮询一次，**不写 trace**（写一条一次，轮询会把 trace 刷满；口径见交付 §四.3）
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 20)));
    json(res, 200, statusPayload(limit));
    return;
  }

  if (req.method === 'POST' && route === '/api/send') {
    let body = null;
    try { body = JSON.parse((await readBody(req)).replace(/^\uFEFF/, '') || '{}'); } catch { body = null; }
    if (!body) { json(res, 400, { ok: false, error: '需要 JSON 体 {chat, text}' }); return; }
    const chatRaw = String(body.chat ?? '').trim();
    const text = String(body.text ?? '').trim();
    if (!chatRaw) { json(res, 400, { ok: false, error: '缺 chat：必须指定会话（不接受「发到当前窗口」）' }); return; }
    if (!text) { json(res, 400, { ok: false, error: '缺 text：没有内容不发' }); return; }
    if (text.length > MAX_TEXT) { json(res, 400, { ok: false, error: `text 太长（${text.length} 字，上限 ${MAX_TEXT}）` }); return; }

    const f = fixtures();
    const conv = (f?.conversations || []).find((c) => c.id === chatRaw) || (f?.conversations || []).find((c) => c.wecomChat === chatRaw);
    if (!conv) { json(res, 404, { ok: false, error: `未知会话 ${chatRaw}（v0 只允许发到夹具会话，避免误发真实客户）` }); return; }

    const st = statusPayload(1);
    if (st.counts.queued + st.counts.sending >= MAX_PENDING) {
      json(res, 429, { ok: false, error: `队列积压 ${st.counts.queued + st.counts.sending} 条（上限 ${MAX_PENDING}），等 runner 消化` });
      return;
    }

    const at = nowMs();
    const row = {
      id: outboxId(at), state: 'queued',
      chat: String(body.dryChat || conv.wecomChat),   // 队列里写的是**企微那边的会话名**，不是夹具 id
      text, by: `wecom-cs/${conv.id}`, t: at, at: iso(at)
    };
    try {
      fs.mkdirSync(path.dirname(OUTBOX), { recursive: true });
      fs.appendFileSync(OUTBOX, JSON.stringify(row) + '\n', 'utf8');
    } catch (e) {
      trace('wecom-cs.send', Date.now() - t0, false, 'module', 'outbox-write');
      json(res, 500, { ok: false, error: '写队列失败：' + (e?.message ?? e) });
      return;
    }
    trace('wecom-cs.send', Date.now() - t0, true);
    json(res, 200, { ok: true, id: row.id, state: 'queued', convId: conv.id, chat: row.chat, queueDepth: st.counts.queued + 1, runner: st.runner });
    return;
  }

  json(res, 404, { ok: false, error: '只有 /、/api/conversations、/api/messages?chat=、/api/send、/api/send/status、/health、/capabilities' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { try { json(res, 500, { ok: false, error: String(e?.message ?? e) }); } catch { /* ignore */ } });
});
server.on('error', (e) => {
  process.stderr.write(`wecom-cs: 监听失败 ${e?.code ?? e?.message ?? e}（9341 被占？）\n`);
  process.exitCode = 1;
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`wecom-cs v${VERSION} 监听 http://127.0.0.1:${PORT}（夹具收 · 队列发 · 不依赖 9340）\n`);
  try { fs.appendFileSync(path.join(WORKSPACE, 'logs', 'wecom-cs.run.log'), `[boot] pid=${process.pid} ${iso(Date.now())} port=${PORT}\n`, 'utf8'); } catch { /* ignore */ }
});

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 800).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
