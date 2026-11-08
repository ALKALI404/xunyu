#!/usr/bin/env node
/**
 * scripts/console-core.mjs —— WS-027 总控台聚合的纯函数层（零 IO、零 import）
 *
 * 总控台只做一件事：**把已有接口的形状拧成四栏**，不新造数据源。
 * 所以「拧」的部分全是纯函数——给什么输入就出什么栏；文件读取、HTTP 探测、缓存留在
 * `routes\console.mjs` 的薄壳里。
 *
 * 单测：node --test scripts\test-console-core.mjs
 */

/** 桥的活动日志一行：[14:20:38] group:xxx [reserved2] 工具统一发送：成功 2/2 条 */
const SENT_RE = /发送：成功\s*(\d+)\s*\/\s*(\d+)\s*条/;
const RECV_RE = /消息已入未读/;

/**
 * 把桥的活动日志（原始文本）统计成「今日收发 + 最近一条时间」。
 * 只认行首的 `[HH:mm:ss]`；日期按 nowMs 当天算（日志本身不带日期，跨零点会重新计）。
 * 返回 {sent, recv, lastAt, lines}——`lines` 是参与统计的行数，方便前端说清口径。
 */
export function parseActivity(raw, nowMs = Date.now()) {
  const text = String(raw ?? '');
  const day = new Date(Number(nowMs) || 0);
  let sent = 0;
  let recv = 0;
  let lastAt = null;
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines += 1;
    const t = /^\[?(\d{2}):(\d{2}):(\d{2})\]?/.exec(line);
    if (t) {
      const d = new Date(day);
      d.setHours(Number(t[1]), Number(t[2]), Number(t[3]), 0);
      const at = d.getTime();
      if (lastAt === null || at > lastAt) lastAt = at;
    }
    const m = SENT_RE.exec(line);
    if (m) sent += Number(m[1]);
    else if (RECV_RE.test(line)) recv += 1;
  }
  return { sent, recv, lastAt, lines };
}

/**
 * 桥 /api/status → channels.qq 那一行。
 * **判 ok 字段，不判 HTTP 状态码**；读不到就 ok:false + 人话原因（不显示「离线」冒充）。
 */
export function shapeQq({ statusBody = null, activity = null, error = null, nowMs = Date.now() } = {}) {
  if (error) return { ok: false, state: "unreachable", online: false, lastAt: null, sentToday: null, recvToday: null, detail: `读不到：${error}` };
  if (!statusBody || typeof statusBody !== 'object') {
    return { ok: false, state: "unreachable", online: false, lastAt: null, sentToday: null, recvToday: null, detail: '桥没回 JSON（接口不可用）' };
  }
  if (statusBody.ok === false) {
    return { ok: false, state: 'unreachable', online: false, lastAt: null, sentToday: null, recvToday: null, detail: `桥自报失败：${statusBody.error ?? 'ok=false'}` };
  }
  const sl = statusBody.snowluma ?? {};
  const connected = Boolean(sl.connected);
  const online = Boolean(sl.accountOnline);
  const stat = activity == null ? null : parseActivity(activity, nowMs);
  const detail = !connected
    ? '桥在跑，但连不上 SnowLuma'
    : !online
      ? 'SnowLuma 已连，QQ 账号不在线（要扫码）'
      : `在线（${statusBody.mode ?? '—'} 模式）`;
  return {
    ok: connected && online,
    state: connected && online ? 'ok' : 'degraded',
    online,
    lastAt: stat?.lastAt ?? null,
    sentToday: stat ? stat.sent : null,
    recvToday: stat ? stat.recv : null,
    detail,
  };
}

/** relay /health → channels.relay。绑定数以 detail 里的 `x/2` 为准，ok 以 bindings.ok 为准 */
export function shapeRelay(health, error = null) {
  const total = 2;
  if (error) return { ok: false, state: 'unreachable', bound: null, total, lastAt: null, detail: `读不到：${error}` };
  if (!health || typeof health !== 'object') return { ok: false, state: 'unreachable', bound: null, total, lastAt: null, detail: '中继没回 JSON' };
  if (health.ok === false) return { ok: false, state: 'unreachable', bound: null, total, lastAt: null, detail: `中继自报失败：${health.error ?? 'ok=false'}` };
  const b = health.checks?.bindings ?? {};
  const m = /(\d+)\s*\/\s*(\d+)/.exec(String(b.detail ?? ''));
  const bound = m ? Number(m[1]) : null;
  const lastAt = Number.isFinite(Number(health.window?.lastAt)) ? Number(health.window.lastAt) : null;
  return {
    ok: b.ok === true,
    state: b.ok === true ? 'ok' : 'degraded',
    bound,
    total: m ? Number(m[2]) : total,
    lastAt,
    detail: b.detail ? String(b.detail) : (b.ok === true ? '绑定正常' : '绑定不全'),
  };
}

/** QQ 文件通道 → channels.files。WS-028 落地前固定「未接入」，不画成离线 */
export function shapeFiles(doc) {
  if (!doc || doc.implemented !== true) {
    return { ok: false, state: 'not-implemented', implemented: false, detail: '未接入（网关有能力，本地没实现）', lastAt: null, sentToday: null, recvToday: null, lastError: null };
  }
  return {
    ok: true,
    state: doc.lastError ? 'degraded' : 'ok',
    implemented: true,
    detail: doc.lastError ? `最近一次失败：${doc.lastError}` : '已接入',
    lastAt: doc.lastAt ?? null,
    sentToday: doc.sentToday ?? 0,
    recvToday: doc.recvToday ?? 0,
    lastError: doc.lastError ?? null,
  };
}

/** 四栏里有没有「读不到」的：qq/relay 任一 unreachable 就算降级（files 未接入是设计，不算） */
export function degradedOf(channels) {
  const c = channels ?? {};
  const bad = (s) => s === 'unreachable' || s === 'degraded';
  return bad(c.qq?.state) || bad(c.relay?.state);
}

/** 人设文件 → brain.persona。只回元信息，**不回正文** */
export function shapePersona({ file, mtime = null, text = null, error = null } = {}) {
  if (error || text == null) return { file, mtime, chars: null, hasFrontMatter: false, ok: false, detail: error ?? '读不到人设文件' };
  const s = String(text);
  return {
    file,
    mtime,
    chars: [...s].length,
    hasFrontMatter: /^---\r?\n/.test(s),
    ok: s.length > 0,
    detail: null,
  };
}

/**
 * 记忆目录扫描结果 → brain.memory。
 * entries 是 [{path, bytes, lines}]；纯函数只做汇总。
 */
export function shapeMemory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let bytes = 0;
  let lines = 0;
  for (const e of list) {
    bytes += Number(e?.bytes) || 0;
    lines += Number(e?.lines) || 0;
  }
  return { files: list.length, lines, bytes };
}

/** cost-core 的报告 → cost 那一块。tokens = 命中+未命中+输出 */
export function shapeCost(report) {
  const t = report?.totals ?? {};
  const tokens = (Number(t.hit) || 0) + (Number(t.miss) || 0) + (Number(t.out) || 0);
  return {
    today: Number(t.cost) || 0,
    turns: Number(t.turns) || 0,
    tokens,
    currency: report?.currency ?? 'CNY',
    from: report?.range?.fromText ?? null,
    to: report?.range?.toText ?? null,
  };
}

/** worklist 的 summary → tickets 三个数 */
export function shapeTickets(summary) {
  return {
    queued: Number(summary?.queued) || 0,
    doing: Number(summary?.doing) || 0,
    submitted: Number(summary?.submitted) || 0,
  };
}

/**
 * supervisor 快照 → services 栏（透传，不加工）。
 * `upOverride` 是实时探活结果（{id:boolean}）：端口探活比 15 秒一轮的快照更及时，
 * 「杀掉一个服务 15 秒内变红」靠的就是它。
 */
export function shapeServices(snapshot, upOverride = null) {
  const list = Array.isArray(snapshot?.services) ? snapshot.services : [];
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    port: s.port,
    up: upOverride && typeof upOverride[s.id] === 'boolean' ? upOverride[s.id] : Boolean(s.up),
    restartsLastHour: Number(s.restartsLastHour) || 0,
    lastAction: s.lastAction ?? null,
  }));
}

/**
 * 3–5 秒缓存的判定（纯函数）：返回 {hit, ageMs}。
 * ttl <= 0 视为不吃缓存（selftest 那种要当下的）。
 */
export function cacheDecision(nowMs, cachedAt, ttlMs) {
  const now = Number(nowMs) || 0;
  const at = Number(cachedAt) || 0;
  const ttl = Number(ttlMs) || 0;
  if (!at || ttl <= 0) return { hit: false, ageMs: null };
  const ageMs = now - at;
  return { hit: ageMs >= 0 && ageMs < ttl, ageMs: ageMs >= 0 ? ageMs : null };
}
