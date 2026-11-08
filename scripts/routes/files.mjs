#!/usr/bin/env node
/**
 * scripts/routes/files.mjs —— QQ 文件通道（WS-028）
 *
 *   POST /api/files/qq/send     { chatId, path }  → { ok, fileId, name, bytes }
 *   GET  /api/files/qq/status                     → { ok, implemented, lastAt, sentToday, recvToday, lastError }
 *   GET  /api/files/qq/received?limit=20          → { ok, items:[{id,name,bytes,savedAs,at,from}] }
 *
 * 只有「判断」在 `scripts\qq-file-core.mjs`（纯函数 + 单测）；这里是薄壳：
 * 读写盘、调网关、跑收件轮询。
 *
 * 网关（SnowLuma / OneBot）已具备：
 *   upload_private_file { user_id, file, name }      → 发私聊文件
 *   get_friend_msg_history { user_id, count }        → 取最近消息（收件靠轮询它）
 *   get_private_file_url / download_file             → 把对端发来的文件落盘
 * **群文件接口（upload_group_file）保留不接**（票面 §4：不接群聊文件）。
 *
 * 红线：只从 `输出\` 发、只往 `收件箱\` 落；路径一律 `resolveInside` 校验；
 * 禁发扩展名、4 GB 上限；状态落 `state\qq-files.json`（不每请求扫盘）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  validateSend, uniqueName, bumpStatus, shapeStatus, shapeReceived,
  parseGatewaySend, pickFileSegments, resolveInside, checkExtension,
} from '../qq-file-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..');
const STATE = path.join(WORKSPACE, 'state');
const OUTBOX_DIR = path.join(WORKSPACE, '输出');     // 发：只许从这里
const INBOX_DIR = path.join(WORKSPACE, '收件箱');    // 收：只许落这里
const STATUS_FILE = path.join(STATE, 'qq-files.json');
const BRIDGE_DIR = process.env.XUNYU_BRIDGE_DIR ?? 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1';

// ── 小工具 ───────────────────────────────────────────────────────────────────
function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-ws028`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
function ensureDirs() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
}
function readDoc() {
  const doc = readJson(STATUS_FILE, null);
  if (doc && typeof doc === 'object') return doc;
  return { implemented: true, sentToday: 0, recvToday: 0, lastAt: null, lastError: null, received: [], sent: [] };
}
function saveDoc(doc) { writeJsonAtomic(STATUS_FILE, doc); }

/** 网关地址与令牌：复用桥的 snowluma 配置（不另存一份凭据） */
function gateway() {
  const cfg = readJson(path.join(BRIDGE_DIR, 'config.json'), {}) ?? {};
  // 端口可覆盖：验收「网关停掉 → 502」时用，不去动线上桥的配置
  const httpUrl = String(process.env.XUNYU_QQ_GATEWAY_URL ?? cfg?.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg?.snowluma?.accessToken ?? '').trim();
  return { httpUrl, token };
}

async function gatewayCall(action, params, { timeoutMs = 20000 } = {}) {
  const { httpUrl, token } = gateway();
  if (!token) return { ok: false, error: '读不到网关令牌（桥 config.snowluma.accessToken 为空）' };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal: ac.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { ok: true, status: res.status, body, text };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? `网关超时（>${timeoutMs}ms）` : String(e?.message ?? e) };
  } finally { clearTimeout(t); }
}

/** 用 /download_file 把对端文件存到收件箱（base64 回包或 url 直链都行） */
async function downloadTo(url, destFile) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destFile, buf);
    return { ok: true, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? '下载超时（>60s）' : String(e?.message ?? e) };
  } finally { clearTimeout(t); }
}

// ── 发 ───────────────────────────────────────────────────────────────────────
async function sendFile(body) {
  ensureDirs();
  // 只允许从「输出\」发；收件箱只进不出
  const v = validateSend({
    roots: [OUTBOX_DIR],
    chatId: body?.chatId,
    path: body?.path,
    statFn: (p) => { const st = fs.statSync(p); return { isFile: st.isFile(), size: st.size }; },
  });
  if (!v.ok) return { status: v.http ?? 400, body: { ok: false, code: v.code, error: v.error } };

  const name = path.basename(v.path);
  const r = await gatewayCall('upload_private_file', { user_id: Number(v.chatId), file: v.path, name });
  if (!r.ok) {
    saveDoc(bumpStatus(readDoc(), { kind: 'error', at: Date.now(), error: `网关不通：${r.error}` }));
    return { status: 502, body: { ok: false, code: 'gateway-down', error: `网关不通：${r.error}` } };
  }
  const parsed = parseGatewaySend(r.body, r.status);
  if (!parsed.ok) {
    saveDoc(bumpStatus(readDoc(), { kind: 'error', at: Date.now(), error: `网关拒绝：${parsed.error}` }));
    // 网关有回包但业务失败 → 502（不是 200）
    return { status: 502, body: { ok: false, code: 'gateway-rejected', error: `网关拒绝：${parsed.error}`, gateway: r.body } };
  }
  const doc = bumpStatus(readDoc(), { kind: 'sent', at: Date.now(), name, fileId: parsed.fileId });
  saveDoc(doc);
  return { status: 200, body: { ok: true, fileId: parsed.fileId, name, bytes: v.size, warn: v.warn ?? null, chatId: v.chatId } };
}

// ── 收（轮询对端消息历史）────────────────────────────────────────────────────
// 为什么用轮询而不是再开一条 WS：桥已经占着 SnowLuma 的 WS，再连一条可能把事件抢走
// （那会直接让 QQ 收发失灵）。get_friend_msg_history 是只读 HTTP，抢不走任何东西。
const POLL_INTERVAL_MS = Number(process.env.XUNYU_QQ_FILE_POLL_MS ?? 60000);
const seenFiles = new Set();

function pollTargets() {
  const cfg = readJson(path.join(BRIDGE_DIR, 'config.json'), {}) ?? {};
  const ids = new Set();
  if (cfg.ownerQQ) ids.add(String(cfg.ownerQQ));
  for (const x of cfg?.allow?.private ?? []) if (x) ids.add(String(x));
  return [...ids].filter((x) => /^\d{5,12}$/.test(x));
}

let selfIdCache = { at: 0, id: null };
async function selfQQ() {
  if (selfIdCache.id && Date.now() - selfIdCache.at < 600000) return selfIdCache.id;
  const r = await gatewayCall('get_login_info', {}, { timeoutMs: 10000 });
  const id = r.body?.data?.user_id ? String(r.body.data.user_id) : null;
  if (id) selfIdCache = { at: Date.now(), id };
  return id;
}

async function pollOnce() {
  const targets = pollTargets();
  if (!targets.length) return { scanned: 0, saved: 0 };
  ensureDirs();
  let saved = 0;
  for (const uid of targets) {
    const r = await gatewayCall('get_friend_msg_history', { user_id: Number(uid), count: 20, reverse_order: false }, { timeoutMs: 15000 });
    if (!r.ok || !r.body) continue;
    // 网关回的是 {data:{messages:[...]}}；早期版本是 {data:[...]}，两种都认（不然收件永远是 0）
    const list = Array.isArray(r.body.data) ? r.body.data : (Array.isArray(r.body?.data?.messages) ? r.body.data.messages : []);
    const me = await selfQQ();
    for (const msg of list) {
      // 自己发的文件不算「收到」：跳过 sender 是自己的消息，免得把自己发出去的又下载回收件箱
      if (me && String(msg?.sender?.user_id ?? '') === String(me)) continue;
      for (const seg of pickFileSegments(msg)) {
        const key = seg.fileId ? `${uid}:${seg.fileId}` : `${uid}:${seg.name}:${seg.bytes ?? 0}`;
        if (seenFiles.has(key)) continue;
        // 去重必须**跨进程**：seenFiles 是内存集合，工作台一重启就清空，
        // 那样同一份文件会被反复下载成 a.pdf / a-1.pdf / a-2.pdf（实测发生过）。
        // 所以再查一遍落盘记录：同一个 file_id 或同一 (名字,大小,发送人) 收过就跳过。
        const docBefore = readDoc();
        const already = (docBefore.received ?? []).some((x) =>
          (seg.fileId && String(x.id) === String(seg.fileId)) ||
          (!seg.fileId && x.name === seg.name && Number(x.bytes) === Number(seg.bytes) && String(x.from) === String(uid))
        );
        if (already) { seenFiles.add(key); continue; }
        seenFiles.add(key);
        let url = seg.url;
        if (!url && seg.fileId) {
          const u = await gatewayCall('get_private_file_url', { user_id: Number(uid), file_id: seg.fileId }, { timeoutMs: 15000 });
          url = u.body?.data?.url ?? null;
        }
        if (!url) continue;
        const safeName = String(seg.name ?? 'file.bin').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file.bin';
        const ext = checkExtension(safeName);
        if (!ext.ok) {   // 禁发类型也不往收件箱落盘（防手滑双击）
          saveDoc(bumpStatus(readDoc(), { kind: 'error', at: Date.now(), error: `收到禁发类型 ${safeName}，已拒绝落盘` }));
          continue;
        }
        const savedName = uniqueName(fs.readdirSync(INBOX_DIR), safeName);
        const dest = path.join(INBOX_DIR, savedName);
        const dl = await downloadTo(url, dest);
        if (!dl.ok) {
          saveDoc(bumpStatus(readDoc(), { kind: 'error', at: Date.now(), error: `接收失败 ${safeName}：${dl.error}` }));
          continue;
        }
        const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
        const doc = readDoc();
        const next = bumpStatus(doc, { kind: 'recv', at: Date.now(), name: safeName, sha256 });
        next.received[next.received.length - 1] = {
          ...next.received[next.received.length - 1],
          id: seg.fileId ?? savedName, name: safeName, savedAs: savedName,
          bytes: dl.bytes, sha256, from: uid,
        };
        saveDoc(next);
        saved += 1;
      }
    }
  }
  return { scanned: targets.length, saved };
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  const enabled = process.env.XUNYU_QQ_FILE_POLL !== '0';
  if (!enabled) return;
  // 首次延迟 20 秒：别跟工作台启动抢资源
  setTimeout(() => { pollOnce().catch(() => { /* 轮询失败不打扰主流程 */ }); }, 20000).unref?.();
  pollTimer = setInterval(() => { pollOnce().catch(() => { /* */ }); }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

// ── 路由 ─────────────────────────────────────────────────────────────────────
export async function handle({ route, method, url, readBody }) {
  if (!route.startsWith('/api/files/qq')) return null;

  if (route === '/api/files/qq/send') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '只支持 POST' } };
    const body = await readBody();
    if (body === null || typeof body !== 'object') return { status: 400, body: { ok: false, error: '请求体不是合法 JSON' } };
    return sendFile(body);
  }

  if (route === '/api/files/qq/status') {
    if (method !== 'GET') return { status: 405, body: { ok: false, error: '只支持 GET' } };
    const doc = readDoc();
    if (doc.implemented !== true) saveDoc({ ...doc, implemented: true });
    return { status: 200, body: { ...shapeStatus({ ...doc, implemented: true }), at: Date.now() } };
  }

  if (route === '/api/files/qq/received') {
    if (method !== 'GET') return { status: 405, body: { ok: false, error: '只支持 GET' } };
    const limit = Number(url.searchParams.get('limit') ?? 20);
    return { status: 200, body: { ok: true, items: shapeReceived(readDoc(), limit), at: Date.now() } };
  }

  if (route === '/api/files/qq/poll') {
    // 手动触发一次收件轮询（验收/排障用，正常靠 60 秒定时）
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '只支持 POST' } };
    const r = await pollOnce().catch((e) => ({ scanned: 0, saved: 0, error: String(e?.message ?? e) }));
    return { status: 200, body: { ok: !r.error, ...r } };
  }

  return { status: 404, body: { ok: false, error: `没有这个接口：${method} ${route}` } };
}

// ── 启动即登记 + 起轮询 ──────────────────────────────────────────────────────
export function startFileChannel() {
  ensureDirs();
  const doc = readDoc();
  if (doc.implemented !== true) saveDoc({ ...doc, implemented: true });
  startPolling();
  return { inbox: INBOX_DIR, outbox: OUTBOX_DIR, pollMs: POLL_INTERVAL_MS };
}
