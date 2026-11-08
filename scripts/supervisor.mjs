#!/usr/bin/env node
/**
 * scripts/supervisor.mjs —— 统一守护进程（WS-016，2026-11-07）
 *
 * 一句话：**一个进程管所有本地服务**。以前 services-guard / qq-bridge-watchdog / workdesk-guard /
 * XunyuAvatarSupervisor 各管一摊，谁也不知道谁在管什么；现在只有这里认 `tools\services.json`。
 *
 * 行为：
 *   - 每 15 秒巡一次（`--watch`）；也支持 `--once` 单拍（计划任务每分钟拉一次即可，有锁幂等）
 *   - 挂了 → 按 `deps` 顺序拉起（脱离父进程，supervisor 死了孩子不死）
 *   - 拉起失败 → 退避 5s/15s/60s（逻辑在 supervisor-core.mjs，有测试）
 *   - 一小时超过 5 次 / 连续 3 次拉不起来 → **不再硬拉，转 alert**（写事件，工作台可见）
 *   - 每次动作写 `logs\supervisor.jsonl`（人能读懂的一句话）
 *   - 对外只读快照 `state\supervisor.json`（工作台 /api/supervisor 直接读它，不反查进程表）
 *
 * 用法：
 *   node scripts\supervisor.mjs --once           # 跑一拍（计划任务用；有锁，重复跑是空转）
 *   node scripts\supervisor.mjs --watch          # 常驻，15 秒一拍
 *   node scripts\supervisor.mjs --status         # 人看的表
 *   node scripts\supervisor.mjs --restart <id>   # 手动重启一个（人审后用；退出码 0/1/2）
 *   node scripts\supervisor.mjs --events [N]     # 最近 N 条事件
 *
 * 退出码：0 成功｜1 业务失败（未知服务/拉起失败）｜2 用法错误｜3 已有实例在跑（仅 --once/--watch）
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRegistry, decideActions, restartBudget, backoffFor, HOUR_MS, MAX_RESTARTS_PER_HOUR } from './supervisor-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..');
export const REGISTRY_FILE = path.join(WORKSPACE, 'tools', 'services.json');
export const EVENTS_FILE = path.join(WORKSPACE, 'logs', 'supervisor.jsonl');
export const SNAPSHOT_FILE = path.join(WORKSPACE, 'state', 'supervisor.json');
export const LOCK_FILE = path.join(WORKSPACE, 'state', 'supervisor.lock');
export const FAILS_FILE = path.join(WORKSPACE, 'state', 'supervisor-fails.json');
export const TICK_MS = Number(process.env.XUNYU_SUPERVISOR_TICK_MS ?? 15000);
const PROBE_TIMEOUT_MS = Number(process.env.XUNYU_SUPERVISOR_PROBE_MS ?? 2000);

const C = { red: (s) => `\u001b[31m${s}\u001b[0m`, green: (s) => `\u001b[32m${s}\u001b[0m`, dim: (s) => `\u001b[2m${s}\u001b[0m` };
const stamp = (t = Date.now()) => new Date(t).toLocaleString('zh-CN', { hour12: false });

// ── 小工具 ───────────────────────────────────────────────────────────────────
function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);   // 原子换，工作台不会读到半截 JSON
}
export function readEvents(file = EVENTS_FILE) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
/** 事件一行一条：action 是 start/alert/skip/restart，detail 是能读懂的人话 */
function appendEvent(rec, { file = EVENTS_FILE } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    return true;
  } catch { return false; }
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
/** 拿锁：成功返回 {ok:true}；已有活实例返回 {ok:false, pid}。死 pid 的锁自动接管（记 stolen）。 */
export function acquireLock({ file = LOCK_FILE, pid = process.pid } = {}) {
  const cur = readJson(file, null);
  if (cur?.pid && Number(cur.pid) !== pid && pidAlive(cur.pid)) return { ok: false, pid: Number(cur.pid) };
  const stolen = Boolean(cur?.pid) && !pidAlive(cur.pid);
  writeJson(file, { pid, at: Date.now(), stolenFrom: stolen ? Number(cur.pid) : undefined });
  return { ok: true, stolen };
}
export function releaseLock({ file = LOCK_FILE, pid = process.pid } = {}) {
  const cur = readJson(file, null);
  if (cur && Number(cur.pid) === Number(pid)) { try { fs.unlinkSync(file); } catch { /* 没了就算了 */ } }
}

// ── 探活 ─────────────────────────────────────────────────────────────────────
function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}
async function httpProbe(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.status < 500;
  } catch { return false; } finally { clearTimeout(t); }
}
/** 一个个服务探活：给了 health 用 HTTP，否则 TCP */
export async function probeService(svc) {
  const host = svc.host ?? '127.0.0.1';
  const port = Number(svc.port);
  if (svc.health) {
    const ok = await httpProbe(svc.health);
    if (ok) return true;
    return tcpProbe(host, port);   // HTTP 挂了但端口还在（半死）也算"在听"，别乱拉
  }
  return tcpProbe(host, port);
}

// ── 拉起（脱离父进程）────────────────────────────────────────────────────────
/** 起一个服务：detached + stdio ignore，supervisor 自己退出也不带走它。 */
export function startService(svc, { spawnFn = spawn } = {}) {
  const [cmd, ...args] = svc.cmd;
  const cwd = svc.cwd ?? WORKSPACE;
  try {
    const child = spawnFn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, pid: child.pid ?? null };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ── 一拍 ─────────────────────────────────────────────────────────────────────
/**
 * 跑一拍：探活 → 决策（纯函数）→ 执行 → 记事件 → 写快照。
 * 返回 { at, states, actions, snapshot }。
 */
export async function tick({ now = Date.now(), registry = null, probeFn = probeService, spawnFn = spawn, persist = true, dry = false } = {}) {
  const reg = registry ?? loadRegistry(REGISTRY_FILE);
  const events = readEvents();
  const failsDoc = readJson(FAILS_FILE, { services: {} }) ?? { services: {} };
  const fails = failsDoc.services ?? {};
  const states = {};
  const since = {};

  for (const svc of reg.services) {
    const up = await probeFn(svc);
    states[svc.id] = { up };
    if (up) { fails[svc.id] = 0; since[svc.id] = since[svc.id] ?? null; }
  }

  const actions = decideActions({ services: reg.services, states, events, failures: fails, now });
  const executed = [];
  for (const a of actions) {
    if (a.action === 'start') {
      const svc = reg.services.find((s) => s.id === a.id);
      const r = dry ? { ok: true, pid: null, dry: true } : startService(svc, { spawnFn });
      // 拉起后要**回头看一眼**：spawn 成功只代表进程被创建；命令不存在/立刻退出时
      // spawn 照样返回成功（WS-016 自测踩到：连着 4 次"成功"，其实一次都没起来）。
      let cameUp = false;
      if (r.ok && !dry) {
        for (let i = 0; i < 4 && !cameUp; i += 1) {
          await new Promise((res) => setTimeout(res, 300));
          cameUp = await probeFn(svc);
        }
      }
      const ok = Boolean(r.ok) && (dry || cameUp);
      const detail = !r.ok
        ? `${svc.name}（${svc.port}）拉起失败：${r.error}`
        : (dry || cameUp ? `${svc.name}（${svc.port}）没起，已拉起${dry ? '（dry）' : ''}` : `${svc.name}（${svc.port}）拉起后仍不通（命令跑不起来？）`);
      const rec = { at: now, id: a.id, action: 'start', ok, detail };
      fails[a.id] = Number(fails[a.id] ?? 0) + (ok ? 0 : 1);
      if (persist && !dry) appendEvent(rec);
      executed.push({ ...a, ...r, ok, cameUp, event: rec });
    } else if (a.action === 'alert') {
      const rec = { at: now, id: a.id, action: 'alert', ok: false, detail: a.detail ?? a.reason };
      // 同一档告警 30 分钟内不重复刷（避免每 15 秒一行把日志冲垮）
      const dup = readEvents().some((e) => e.id === a.id && e.action === 'alert' && now - Number(e.at) < 30 * 60_000);
      if (persist && !dry && !dup) appendEvent(rec);
      executed.push({ ...a, event: rec, duplicate: dup });
    } else {
      executed.push(a);
    }
  }

  if (persist && !dry) writeJson(FAILS_FILE, { services: fails });

  const snapshot = buildSnapshot({ reg, states, events, fails, now });
  if (persist && !dry) writeJson(SNAPSHOT_FILE, snapshot);
  return { at: now, states, actions: executed, snapshot };
}

/** 工作台/--status 读的快照：服务红绿灯 + 最近 20 条事件 */
export function buildSnapshot({ reg, states, events, fails, now = Date.now() }) {
  const services = reg.services.map((svc) => {
    const hist = events.filter((e) => String(e.id) === svc.id);
    const last = hist[hist.length - 1] ?? null;
    return {
      id: svc.id,
      name: svc.name,
      port: Number(svc.port),
      host: svc.host ?? '127.0.0.1',
      log: svc.log ?? null,
      up: Boolean(states?.[svc.id]?.up),
      since: null,
      restartsLastHour: restartBudget(events, svc.id, { now }),
      fails: Number(fails?.[svc.id] ?? 0),
      lastAction: last ? { at: last.at, action: last.action, detail: last.detail } : null,
    };
  });
  return {
    ok: true,
    at: now,
    services,
    recentEvents: events.slice(-20),
    policy: { maxRestartsPerHour: MAX_RESTARTS_PER_HOUR, backoffMs: [backoffFor(1), backoffFor(2), backoffFor(3)], hourMs: HOUR_MS },
  };
}

/** 手动重启一个服务（人审后；不受退避限制，但**仍受一小时上限**保护） */
export async function restartOne(id, { now = Date.now(), probeFn = probeService, spawnFn = spawn } = {}) {
  const t0 = Date.now();
  const reg = loadRegistry(REGISTRY_FILE);
  const svc = reg.services.find((s) => s.id === id);
  if (!svc) return { ok: false, code: 404, error: `未知服务：${id}（注册表里没有）` };
  const events = readEvents();
  const used = restartBudget(events, id, { now });
  const max = Number(svc.restart?.maxPerHour ?? MAX_RESTARTS_PER_HOUR);
  if (used >= max) {
    return { ok: false, code: 429, error: `一小时内已重启 ${used} 次，超过上限 ${max}（等冷却或人工排查）`, used, max };
  }
  const before = await probeFn(svc);
  if (before) return { ok: true, action: 'already-up', id, ms: Date.now() - t0 };
  const r = startService(svc, { spawnFn });
  appendEvent({ at: now, id, action: 'restart', ok: r.ok, detail: r.ok ? `${svc.name}（${svc.port}）手动拉起（人审）` : `${svc.name} 手动拉起失败：${r.error}` });
  if (!r.ok) return { ok: false, code: 500, action: 'failed', id, ms: Date.now() - t0, error: r.error, cmd: svc.cmd };
  return { ok: true, action: 'restarted', id, ms: Date.now() - t0, pid: r.pid ?? null };
}

// ── 人看的输出 ───────────────────────────────────────────────────────────────
function printSnapshot(snap) {
  const dot = (up) => (up ? C.green('●') : C.red('○'));
  console.log(`服务 ${snap.services.length} 个｜${stamp(snap.at)}`);
  for (const s of snap.services) {
    const last = s.lastAction ? `${stamp(s.lastAction.at)} ${s.lastAction.action} ${String(s.lastAction.detail ?? '').slice(0, 46)}` : '—';
    console.log(`  ${dot(s.up)} ${String(s.id).padEnd(13)} :${String(s.port).padEnd(5)} 重启(1h)=${String(s.restartsLastHour).padEnd(2)} 连败=${s.fails}  上次：${last}`);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

  if (has('--events')) {
    const n = Number(val('--events') ?? argv[argv.indexOf('--events') + 1] ?? 20) || 20;
    for (const e of readEvents().slice(-n)) console.log(`${stamp(e.at)}  ${String(e.id).padEnd(13)} ${e.action.padEnd(7)} ${e.detail ?? ''}`);
    process.exitCode = 0;
    return;
  }
  if (has('--status')) {
    const reg = loadRegistry(REGISTRY_FILE);
    const snap = readJson(SNAPSHOT_FILE, null) ?? buildSnapshot({ reg, states: {}, events: readEvents(), fails: readJson(FAILS_FILE, { services: {} })?.services ?? {}, now: Date.now() });
    printSnapshot(snap);
    const lock = readJson(LOCK_FILE, null);
    console.log(C.dim(`锁：${lock?.pid ? `pid ${lock.pid}（${pidAlive(lock.pid) ? '在跑' : '已死'}）` : '无'}｜事件 ${readEvents().length} 条`));
    process.exitCode = 0;
    return;
  }
  if (has('--restart')) {
    const id = val('--restart');
    if (!id) { console.error('用法：supervisor.mjs --restart <id>'); process.exitCode = 2; return; }
    const r = await restartOne(id);
    console.log(JSON.stringify(r));
    process.exitCode = r.ok ? 0 : (r.code === 404 ? 1 : 1);
    return;
  }
  if (!has('--once') && !has('--watch')) { console.error('用法：supervisor.mjs --once | --watch | --status | --restart <id> | --events [N]'); process.exitCode = 2; return; }

  const lock = acquireLock();
  if (!lock.ok) {
    console.log(C.dim(`已有 supervisor 在跑（pid ${lock.pid}），本次空转退出（单实例锁）`));
    process.exitCode = 3;
    return;
  }
  if (lock.stolen) appendEvent({ at: Date.now(), id: 'supervisor', action: 'lock-stolen', ok: true, detail: '上一个 supervisor 已死，接管锁' });

  try {
    const run = async () => {
      try {
        const r = await tick({});
        printSnapshot(r.snapshot);
        return r;
      } catch (error) {
        appendEvent({ at: Date.now(), id: 'supervisor', action: 'error', ok: false, detail: String(error?.message ?? error).slice(0, 200) });
        console.error(C.red(`巡检异常：${error?.message ?? error}`));
        return null;
      }
    };
    await run();
    if (has('--watch')) {
      console.log(C.dim(`常驻：每 ${Math.round(TICK_MS / 1000)}s 一拍（pid ${process.pid}）`));
      setInterval(() => { run(); }, TICK_MS);
      const stop = () => { releaseLock(); process.exit(0); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    } else {
      releaseLock();
      process.exitCode = 0;
    }
  } catch (error) {
    releaseLock();
    console.error(C.red(String(error?.message ?? error)));
    process.exitCode = 1;
  }
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
