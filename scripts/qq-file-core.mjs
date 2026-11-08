#!/usr/bin/env node
/**
 * scripts/qq-file-core.mjs —— WS-028 QQ 文件通道的纯函数层（零 IO、零 import）
 *
 * 文件通道最容易出事的地方全在「判断」上，所以这些判断一律做成纯函数：
 *   路径在不在根里（防 `..\..\Windows\win.ini`）、扩展名黑不黑、体积超没超、
 *   重名怎么加后缀、状态怎么按天滚、网关回包怎么读。
 * 真正的读写盘 / 发 HTTP 在 `routes\files.mjs` 里，只做薄壳。
 *
 * 单测：node --test scripts\test-qq-file-core.mjs
 */

/** 网关（SnowLuma/OneBot）单文件上限 4 GB；超过 200 MB 给个提示 */
export const MAX_BYTES = 4 * 1024 ** 3;
export const WARN_BYTES = 200 * 1024 ** 2;

/** 禁发的扩展名（可执行/脚本/快捷方式） */
export const BLOCKED_EXT = ['.exe', '.bat', '.cmd', '.ps1', '.js', '.vbs', '.lnk', '.scr', '.msi'];

function norm(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 目标路径必须在 root 之内（Windows 大小写不敏感）。
 * 先规范化 `..`，再用「root + 分隔符」前缀比——只比前缀会被 `...\root2` 骗过去。
 */
export function resolveInside(root, target) {
  const r = norm(root);
  const t = norm(target);
  if (!r || !t) return { ok: false, code: 'path-outside', error: '路径为空' };
  // 手工折叠 . 与 ..（不依赖 fs，纯字符串）
  const parts = [];
  for (const seg of t.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return { ok: false, code: 'path-outside', error: `路径越界：${target}` };
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const folded = parts.join('/');
  const lower = folded.toLowerCase();
  const rl = r.toLowerCase();
  if (lower === rl) return { ok: true, path: folded };
  if (!lower.startsWith(`${rl}/`)) return { ok: false, code: 'path-outside', error: `不在允许的目录内：${target}` };
  return { ok: true, path: folded };
}

/** 扩展名黑名单（只看最后一段后缀，大小写不敏感） */
export function checkExtension(name) {
  const s = String(name ?? '').toLowerCase();
  const dot = s.lastIndexOf('.');
  const ext = dot >= 0 ? s.slice(dot) : '';
  if (BLOCKED_EXT.includes(ext)) return { ok: false, code: 'blocked-type', ext, error: `禁发 ${ext}（可执行/脚本/快捷方式）` };
  return { ok: true, ext };
}

/** 体积判定：>4GB 硬拒；>200MB 放行但要提示 */
export function checkSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return { ok: false, code: 'bad-size', error: '文件大小读不出来' };
  if (n > MAX_BYTES) return { ok: false, code: 'too-large', error: `超过网关上限 4 GB（现在 ${(n / 1024 ** 3).toFixed(2)} GB）` };
  if (n > WARN_BYTES) return { ok: true, warn: `文件 ${(n / 1024 ** 2).toFixed(0)} MB，超过 200 MB 会比较慢` };
  return { ok: true, warn: null };
}

/**
 * 发送前的完整校验：路径白名单 → 扩展名 → 体积。
 * `statFn` 由调用方注入（纯函数不碰盘），P1 单测传假数据。
 */
export function validateSend({ roots = [], chatId, path, statFn }) {
  const id = String(chatId ?? '').trim();
  if (!id) return { ok: false, http: 400, code: 'bad-chat', error: '缺 chatId（要发给哪个 QQ）' };
  if (!/^\d{5,12}$/.test(id)) return { ok: false, http: 400, code: 'bad-chat', error: 'chatId 要纯数字 QQ 号' };
  const target = String(path ?? '').trim();
  if (!target) return { ok: false, http: 400, code: 'bad-path', error: '缺 path（要发哪个文件）' };
  let resolved = null;
  for (const root of roots) {
    const r = resolveInside(root, target);
    if (r.ok) { resolved = r.path; break; }
  }
  if (!resolved) return { ok: false, http: 400, code: 'path-outside', error: `只允许从 输出\\ 目录发（收到的是 ${target}）` };
  const ext = checkExtension(resolved);
  if (!ext.ok) return { ok: false, http: 400, code: ext.code, error: ext.error };
  let st;
  try { st = statFn ? statFn(resolved) : null; } catch (e) { return { ok: false, http: 400, code: 'not-found', error: `读不到文件：${e?.message ?? e}` }; }
  if (!st || !st.isFile) return { ok: false, http: 400, code: 'not-found', error: '不是普通文件（或不存在）' };
  const size = checkSize(st.size);
  if (!size.ok) return { ok: false, http: 400, code: size.code, error: size.error };
  return { ok: true, path: resolved, size: st.size, warn: size.warn, chatId: id };
}

/**
 * 重名加后缀：`a.pdf` → `a-1.pdf` → `a-2.pdf`。
 * `taken` 是已存在的文件名集合（小写比较）。
 */
export function uniqueName(taken, name) {
  const set = new Set((taken ?? []).map((x) => String(x).toLowerCase()));
  const base = String(name ?? 'file');
  if (!set.has(base.toLowerCase())) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 1; i < 10000; i += 1) {
    const cand = `${stem}-${i}${ext}`;
    if (!set.has(cand.toLowerCase())) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}

const dayKey = (ms) => new Date(Number(ms) || 0).toISOString().slice(0, 10);

/**
 * 状态文档推进：发/收各记一笔，跨天就把当日计数清零（**纯函数**，给旧文档 + 这次事件，出新文档）。
 * doc 形状：{ implemented, lastAt, sentToday, recvToday, lastError, lastSentAt, lastRecvAt, day, received:[], sent:[] }
 */
export function bumpStatus(doc, { kind, at, name = null, fileId = null, error = null, sha256 = null } = {}) {
  const now = Number(at) || Date.now();
  const prev = doc && typeof doc === 'object' ? doc : {};
  const day = dayKey(now);
  const sameDay = prev.day === day;
  const next = {
    ...prev,
    implemented: true,
    day,
    sentToday: sameDay ? Number(prev.sentToday) || 0 : 0,
    recvToday: sameDay ? Number(prev.recvToday) || 0 : 0,
    received: Array.isArray(prev.received) ? [...prev.received] : [],
    sent: Array.isArray(prev.sent) ? [...prev.sent] : [],
  };
  if (kind === 'sent') {
    next.sentToday += 1;
    next.lastSentAt = now;
    next.lastAt = now;
    next.lastError = null;
    if (name) next.sent.push({ name, fileId: fileId ?? null, at: now });
  } else if (kind === 'recv') {
    next.recvToday += 1;
    next.lastRecvAt = now;
    next.lastAt = now;
    if (name) next.received.push({ name, at: now, sha256: sha256 ?? null });
  } else if (kind === 'error') {
    next.lastError = { at: now, text: String(error ?? '未知错误').slice(0, 300) };
  }
  // 只留最近 200 条，别让状态文件长成日志
  next.sent = next.sent.slice(-200);
  next.received = next.received.slice(-200);
  return next;
}

/** 状态栏（channels.files 与 /api/files/qq/status 共用） */
export function shapeStatus(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const implemented = d.implemented === true;
  return {
    ok: implemented,
    implemented,
    lastAt: d.lastAt ?? null,
    sentToday: Number(d.sentToday) || 0,
    recvToday: Number(d.recvToday) || 0,
    lastError: d.lastError ?? null,
  };
}

/** 收件列表（倒序，默认 20 条） */
export function shapeReceived(doc, limit = 20) {
  const list = Array.isArray(doc?.received) ? doc.received : [];
  const n = Math.min(200, Math.max(1, Number(limit) || 20));
  return list.slice(-n).reverse().map((r) => ({
    id: r.id ?? r.name,
    name: r.name,
    bytes: r.bytes ?? null,
    savedAs: r.savedAs ?? r.name,
    at: r.at ?? null,
    from: r.from ?? null,
  }));
}

/**
 * 读网关回包：OneBot 的 `{status:'ok', retcode:0, data:{file_id}}`；也可能 200 + `{ok:false}`（软失败）。
 * **判字段，不判 HTTP 状态码。**
 */
export function parseGatewaySend(body, httpStatus = 200) {
  if (!body || typeof body !== 'object') return { ok: false, error: `网关没回 JSON（HTTP ${httpStatus}）` };
  if (body.ok === false) return { ok: false, error: String(body.error ?? body.message ?? 'ok=false') };
  if (body.status && body.status !== 'ok') return { ok: false, error: String(body.message ?? body.wording ?? `status=${body.status}`) };
  if (Number.isFinite(Number(body.retcode)) && Number(body.retcode) !== 0) {
    return { ok: false, error: String(body.message ?? body.wording ?? `retcode=${body.retcode}`) };
  }
  const fileId = body.data?.file_id ?? body.data?.fileId ?? body.file_id ?? null;
  return { ok: true, fileId: fileId == null ? null : String(fileId) };
}

/** 从 OneBot 消息段里挑出文件段（私聊文件消息） */
export function pickFileSegments(message) {
  const segs = Array.isArray(message) ? message : (Array.isArray(message?.message) ? message.message : []);
  return segs
    .filter((s) => s && s.type === 'file')
    .map((s) => ({
      fileId: s.data?.file_id ?? s.data?.file ?? null,
      name: s.data?.file_name ?? s.data?.name ?? s.data?.file ?? 'file.bin',
      bytes: Number(s.data?.file_size ?? s.data?.size) || null,
      url: s.data?.url ?? null,
    }))
    .filter((f) => f.fileId || f.url);
}
