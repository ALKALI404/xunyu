import { readJson } from './json-io.mjs';
// scripts/scheduler-core.mjs —— 工作台内置调度器（WS-010：消灭外部计划任务的 cmd 黑框）
//
// 四个常驻 job 在 workdesk(9340) 进程里跑，不再 spawn cmd / 计划任务：
//   accept   60s   验收扫描 + 链路推进（复用 acceptance-watch.tickWatch，里面会调 lane-runner）
//   mail     5min  投递维护（delivery-check.checkOnce：未确认邮件的重投/上报）
//   outbox   30s   出站兜底（把 state\wecom-outbox.jsonl 里 pending 且没终态的行走 WC-004 发送器）
//   health   5min  组件健康探针（health-components.collectComponents）
//   tmpguard 每日 04:10  临时目录清理（原 XunyuTmpGuardSweep 计划任务，挪进进程内）
//
// 每条运行记录写 state\scheduler-runs.jsonl：{t, job, startTs, endTs, ok, ms, error}
// 单实例锁：state\scheduler.lock（pid 活着且不是自己 → 不起第二套）
// 开关：SCHEDULER_ENABLED=0 整个调度器不启动（回滚用）

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..');
const STATE = path.join(WORKSPACE, 'state');
const RUNS = path.join(STATE, 'scheduler-runs.jsonl');
const LOCK = path.join(STATE, 'scheduler.lock');
const OUTBOX = path.join(STATE, 'wecom-outbox.jsonl');
const RESULTS = path.join(STATE, 'wecom-outbox-result.jsonl');

const DEFAULT_INTERVALS = { accept: 60000, mail: 300000, outbox: 30000, health: 300000 };
const TMPGUARD_AT = { hour: 4, minute: 10 };

const state = {
  started: false,
  startedAt: null,
  pid: process.pid,
  jobs: {},           // job -> {intervalMs, lastStart, lastEnd, lastOk, lastError, runs, nextAt}
  timers: {},
  skipped: null
};

function logRun(rec) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(RUNS, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch { /* 日志写不了不影响调度 */ }
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function acquireLock() {
  try {
    const cur = readJson(LOCK);
    if (cur?.pid && Number(cur.pid) !== process.pid && pidAlive(cur.pid)) {
      return { ok: false, holder: cur.pid };
    }
  } catch { /* 没锁文件或坏了：直接抢 */ }
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, holder: null, error: String(e.message) };
  }
}

function runNode(script, args = [], timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(WORKSPACE, 'scripts', script), ...args], { cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, out, err: String(e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
  });
}

// ── 四个 job 的实现（都是"进程内调用"，不 spawn cmd）────────────────────────
const JOBS = {
  async accept() {
    const mod = await import('./acceptance-watch.mjs');
    const r = await mod.tickWatch({ quiet: true });
    const lane = r?.lane ?? [];
    return { detail: `待验收 ${r?.count ?? 0} 张；lane 动作 ${lane.length} 条` };
  },

  async mail() {
    const mod = await import('./delivery-check.mjs');
    const r = mod.checkOnce({ dry: false });
    return { detail: `投递检查：${JSON.stringify(r ?? {}).slice(0, 160)}` };
  },

  async outbox() {
    const readLines = (f) => {
      try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
    };
    const done = new Set(readLines(RESULTS).map((r) => r.id));
    const pending = readLines(OUTBOX).filter((r) => r.state === 'pending' && !done.has(r.id));
    if (!pending.length) return { detail: '没有待发的 outbox 行' };
    let sent = 0; let failed = 0;
    for (const row of pending.slice(0, 5)) {
      const conv = String(row.conv ?? row.chat ?? '');
      const text = String(row.text ?? '');
      const r = await runNode('vm-sender.mjs', ['--conv', conv, '--text', text, '--json'], 90000);
      let parsed = null;
      try { parsed = JSON.parse(r.out); } catch { parsed = null; }
      const ok = Boolean(parsed?.ok);
      if (ok) sent += 1; else failed += 1;
      try {
        fs.appendFileSync(RESULTS, `${JSON.stringify({ id: row.id, state: ok ? 'sent' : 'failed', evidence: parsed?.evidence ?? null, beforeHash: parsed?.beforeHash ?? null, reason: ok ? null : (parsed?.code ?? 'unknown'), detail: parsed?.detail ?? null, ms: parsed?.ms ?? null, ts: Date.now() })}\n`, 'utf8');
      } catch { /* ignore */ }
    }
    return { detail: `兜底发送 ${pending.length} 条：sent ${sent} / failed ${failed}` };
  },

  async health() {
    const mod = await import('./health-components.mjs');
    const r = await mod.collectComponents({ force: true });
    const comps = Array.isArray(r?.components) ? r.components : (Array.isArray(r) ? r : []);
    const bad = comps.filter((c) => c && c.ok === false).length;
    return { detail: `组件 ${comps.length} 个，异常 ${bad} 个` };
  },

  async tmpguard() {
    const r = await runNode('tmp-guard.mjs', ['sweep'], 120000);
    if (r.code !== 0) throw new Error(`tmp-guard sweep exit=${r.code} ${String(r.err).slice(0, 120)}`);
    return { detail: '临时目录清理完成' };
  }
};

let lastTmpGuardDay = null;

async function runJob(name) {
  const job = state.jobs[name];
  if (!job) return;
  if (job.running) return;
  job.running = true;
  const startTs = Date.now();
  job.lastStart = startTs;
  let ok = true; let error = null; let detail = null;
  try {
    const r = await JOBS[name]();
    detail = r?.detail ?? null;
  } catch (e) {
    ok = false;
    error = String(e?.message ?? e).slice(0, 300);
  }
  const endTs = Date.now();
  job.running = false;
  job.lastEnd = endTs;
  job.lastOk = ok;
  job.lastError = error;
  job.detail = detail;
  job.runs = (job.runs ?? 0) + 1;
  logRun({ t: endTs, job: name, startTs, endTs, ok, ms: endTs - startTs, error, detail });
  return { ok, error, detail, ms: endTs - startTs };
}

/** 启动调度器（幂等；SCHEDULER_ENABLED=0 时不启） */
export function startScheduler({ intervals = {} } = {}) {
  if (state.started) return schedulerStatus();
  if (String(process.env.SCHEDULER_ENABLED ?? '1') === '0') { state.skipped = 'SCHEDULER_ENABLED=0'; return schedulerStatus(); }
  const lock = acquireLock();
  if (!lock.ok) { state.skipped = `已有调度器在跑（pid ${lock.holder ?? '?'}）`; return schedulerStatus(); }

  const iv = { ...DEFAULT_INTERVALS, ...intervals };
  for (const name of Object.keys(JOBS)) {
    const intervalMs = name === 'tmpguard' ? 60000 : iv[name];
    state.jobs[name] = { intervalMs, runs: 0, lastStart: null, lastEnd: null, lastOk: null, lastError: null, nextAt: Date.now() };
  }

  for (const name of ['accept', 'mail', 'outbox', 'health']) {
    // 启动即跑一轮（别让新起的服务空等一个周期）
    setTimeout(() => { runJob(name); }, 1500);
    state.timers[name] = setInterval(() => { runJob(name); }, state.jobs[name].intervalMs);
    if (state.timers[name].unref) state.timers[name].unref();   // 定时器不阻止进程退出
  }
  // tmpguard：每分钟看一次"是不是到了 04:10 且今天还没跑"
  state.timers.tmpguard = setInterval(() => {
    const d = new Date();
    const day = d.toISOString().slice(0, 10);
    if (d.getHours() === TMPGUARD_AT.hour && d.getMinutes() === TMPGUARD_AT.minute && lastTmpGuardDay !== day) {
      lastTmpGuardDay = day;
      runJob('tmpguard');
    }
  }, 60000);
  if (state.timers.tmpguard.unref) state.timers.tmpguard.unref();

  state.started = true;
  state.startedAt = Date.now();
  return schedulerStatus();
}

export function schedulerStatus() {
  const now = Date.now();
  const jobs = {};
  for (const [name, j] of Object.entries(state.jobs)) {
    jobs[name] = {
      intervalMs: j.intervalMs,
      runs: j.runs,
      lastStart: j.lastStart ? new Date(j.lastStart).toISOString() : null,
      lastEnd: j.lastEnd ? new Date(j.lastEnd).toISOString() : null,
      lastOk: j.lastOk,
      lastError: j.lastError,
      detail: j.detail ?? null,
      nextAt: state.started && !j.running ? new Date((j.lastEnd ?? j.lastStart ?? now) + j.intervalMs).toISOString() : null,
      running: Boolean(j.running)
    };
  }
  return {
    ok: true,
    enabled: state.started,
    skipped: state.skipped,
    pid: state.pid,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    jobs,
    runs: countRuns(),
    at: new Date(now).toISOString()
  };
}

function countRuns() {
  try { return fs.readFileSync(RUNS, 'utf8').split(/\r?\n/).filter(Boolean).length; } catch { return 0; }
}

/** 手工触发一个 job（调试/验收用） */
export async function runJobNow(name) {
  if (!state.jobs[name]) return { ok: false, error: `没有这个 job：${name}` };
  return runJob(name);
}
