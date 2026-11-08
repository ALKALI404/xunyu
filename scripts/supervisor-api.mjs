#!/usr/bin/env node
/**
 * scripts/supervisor-api.mjs —— 工作台（9340）上的「调度台」接口（WS-016）
 *
 * 为什么不另开端口：主人要求「少一个口少一份维护」；这三个接口挂在工作台，
 * 复用它的鉴权/日志/错误形状，不引入第二个常驻 HTTP。
 *
 *   GET  /api/supervisor                 → 全部服务状态（读 supervisor 写的快照，不反查进程表）
 *   POST /api/supervisor/restart {id}    → 手动重启（人审）
 *   GET  /api/supervisor/events?limit=50 → 事件流
 *
 * 错误码按契约：404 未知服务 / 429 一小时重启超限（说清超限）/ 500 拉起失败（附命令与退出码）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const SNAPSHOT = path.join(WORKSPACE, 'state', 'supervisor.json');
const EVENTS = path.join(WORKSPACE, 'logs', 'supervisor.jsonl');

function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; }
}
function readEvents(limit = 50) {
  try {
    return fs.readFileSync(EVENTS, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).slice(-limit);
  } catch { return []; }
}

/** 契约形状：只给客户端要的字段，不把内部细节（deps/cmd/cwd）漏出去 */
function shape(snap, now = Date.now()) {
  const ageMs = snap?.at ? now - Number(snap.at) : null;
  return {
    ok: true,
    at: Number(snap?.at ?? now),
    stale: ageMs == null ? true : ageMs > 90_000,        // 快照 90 秒没更新 = supervisor 可能没在跑
    ageMs,
    services: (snap?.services ?? []).map((s) => ({
      id: s.id, name: s.name, port: s.port, host: s.host, log: s.log ?? null,
      up: Boolean(s.up),
      since: s.since ?? null,
      restartsLastHour: Number(s.restartsLastHour ?? 0),
      fails: Number(s.fails ?? 0),
      lastAction: s.lastAction ?? null,
    })),
  };
}

/**
 * 处理三类请求。返回 { status, body }；未知路由返回 null（交回工作台原来那套）。
 * `readBody` 由调用方注入（工作台已有 readJsonBody，不重写一套）。
 */
export async function handleSupervisor({ route, method, url, readBody }) {
  if (route === '/api/supervisor' && method === 'GET') {
    const snap = readJson(SNAPSHOT, null);
    if (!snap) return { status: 503, body: { ok: false, error: 'supervisor 还没跑过（state\\supervisor.json 不存在）', hint: 'node scripts\\supervisor.mjs --once' } };
    return { status: 200, body: shape(snap) };
  }

  if (route === '/api/supervisor/events' && method === 'GET') {
    const limit = Math.min(200, Math.max(1, Number(url?.searchParams?.get('limit') ?? 50) || 50));
    const events = readEvents(limit).map((e) => ({ at: e.at, id: e.id, action: e.action, detail: e.detail ?? '' }));
    return { status: 200, body: { ok: true, count: events.length, events } };
  }

  if (route === '/api/supervisor/restart' && method === 'POST') {
    const body = await readBody();
    if (body === null) return { status: 400, body: { ok: false, error: '请求体不是合法 JSON' } };
    const id = String(body?.id ?? '').trim();
    if (!id) return { status: 400, body: { ok: false, error: '缺 id（要重启哪个服务）' } };
    const { restartOne } = await import('./supervisor.mjs');
    const r = await restartOne(id);
    if (r.code === 404) return { status: 404, body: { ok: false, id, error: r.error } };
    if (r.code === 429) return { status: 429, body: { ok: false, id, error: r.error, used: r.used, max: r.max } };
    if (!r.ok) return { status: 500, body: { ok: false, id, action: 'failed', error: r.error, cmd: r.cmd, ms: r.ms } };
    return { status: 200, body: { ok: true, id, action: r.action, ms: r.ms } };
  }

  if (route === '/api/supervisor/log' && method === 'GET') {
    // 调度台页面（06 的 UI）点"看日志"用；不给任意路径，只给注册表里登记的 log。
    const id = String(url?.searchParams?.get('id') ?? '').trim();
    if (!id) return { status: 400, body: { ok: false, error: '缺 id' } };
    const reg = readJson(path.join(WORKSPACE, 'tools', 'services.json'), null);
    const svc = (reg?.services ?? []).find((s) => s.id === id);
    if (!svc) return { status: 404, body: { ok: false, error: `未知服务：${id}` } };
    if (!svc.log) return { status: 200, body: { ok: true, id, log: null, lines: [], note: '注册表里没给 log' } };
    const file = path.resolve(WORKSPACE, svc.log);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean).slice(-80).map((l) => l.slice(0, 400));
      return { status: 200, body: { ok: true, id, log: svc.log, lines, bytes: raw.length } };
    } catch (e) {
      return { status: 200, body: { ok: true, id, log: svc.log, lines: [], note: `日志读不到：${e?.code ?? e}` } };
    }
  }

  return null;
}
