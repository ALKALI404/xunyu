#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// wecom-outbox-runner.mjs — D89 代持发送队列的消费者（零 token）
//
// 工作台 POST /api/send 只往 state\wecom-outbox.jsonl 追加一行 {state:'queued'}，
// 本脚本轮询这个文件，**一次只拿一条**，调 D82 的 scripts\wecom-hold.mjs send，
// 把结果写回同一行（ok/failed + reason + at）。
//
// 用法：
//   node scripts/wecom-outbox-runner.mjs                 # 常驻（默认 3 秒一轮）
//   node scripts/wecom-outbox-runner.mjs --once          # 只处理一条就退出（自测/排查）
//   node scripts/wecom-outbox-runner.mjs --dry           # 不调企微，只跑通队列与顺序
//   node scripts/wecom-outbox-runner.mjs --interval 5000
//
// 为什么要单实例：两条消息同时抢前台会互相污染输入框，顺序发是硬要求。
// 锁文件 state\wecom-outbox-runner.lock（带 pid）；心跳写 state\wecom-outbox-runner.json 给页面看。
//
// 退出码：0 正常退出 / 1 已有实例在跑 / 2 参数错误

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const OUTBOX = path.join(WORKSPACE, 'state', 'wecom-outbox.jsonl');
const TEXT_DIR = path.join(WORKSPACE, 'state', 'wecom-outbox-text');
const LOCK = path.join(WORKSPACE, 'state', 'wecom-outbox-runner.lock');
const HEART = path.join(WORKSPACE, 'state', 'wecom-outbox-runner.json');
const HOLD = path.join(HERE, 'wecom-hold.mjs');
const LOG = path.join(WORKSPACE, 'logs', 'wecom-outbox-runner.log');

const HOLD_TIMEOUT_MS = 120000;   // 单条最多 2 分钟（点会话 + 逐字输入 + 等 1.5 秒 + 截图 + 判空）
const STALE_SENDING_MS = 180000;  // 标着 sending 超过 3 分钟 = runner 中途死了，回收成 failed
const GAP_MS = 1200;              // 两条之间留一点空，别把前一次的回车/校验撞上
const LIVE_LOCK_MS = 60000;       // 锁超过 1 分钟没更新且 pid 不在 = 僵尸锁

function logLine(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch { /* 日志写不进去不影响主流程 */ }
}

function readRows() {
  const raw = fs.readFileSync(OUTBOX, 'utf8').replace(/^\uFEFF/, '');
  return raw.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { id: '', state: 'bad', raw: line, reason: '队列行不是合法 JSON' }; }
  });
}

// 写回时先并一次「当前文件里我们没见过的行」，避免把刚入队的那条覆盖掉（服务端是 append）。
function writeRows(rows) {
  let merged = rows;
  try {
    const mine = new Set(rows.map((r) => r.id));
    const extra = readRows().filter((r) => r && r.id && !mine.has(r.id));
    if (extra.length) merged = rows.concat(extra);
  } catch { /* 读不到就用自己这份 */ }
  const tmp = `${OUTBOX}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(OUTBOX), { recursive: true });
  fs.writeFileSync(tmp, merged.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, OUTBOX);
  return merged;
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  const mine = { pid: process.pid, at: Date.now() };
  try {
    fs.writeFileSync(LOCK, JSON.stringify(mine), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    let cur = null;
    try { cur = readJson(LOCK); } catch { /* 坏锁当僵尸 */ }
    const stale = !cur || !alive(Number(cur.pid)) || Date.now() - Number(cur.at ?? 0) > LIVE_LOCK_MS;
    if (!stale) {
      logLine(`[lock] 已有 runner pid=${cur?.pid} 在跑，本实例退出`);
      return false;
    }
    logLine(`[lock] 接管僵尸锁（原 pid=${cur?.pid ?? '?'}）`);
    try { fs.writeFileSync(LOCK, JSON.stringify(mine), 'utf8'); } catch { return false; }
    return true;
  }
}

function touchLock() {
  try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8'); } catch { /* ignore */ }
}
function releaseLock() {
  try {
    const cur = readJson(LOCK);
    if (Number(cur.pid) === process.pid) fs.rmSync(LOCK, { force: true });
  } catch { /* ignore */ }
}

const state = { startedAt: Date.now(), ticks: 0, lastId: null, lastState: null, lastReason: null, lastAt: null, processed: 0, dry: false };

function heartbeat(extra = {}) {
  Object.assign(state, extra);
  try {
    fs.writeFileSync(HEART, JSON.stringify({ ...state, pid: process.pid, at: Date.now() }), 'utf8');
  } catch { /* ignore */ }
}

function reasonFromExit(code, stderr, stdout) {
  const tail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).pop()
    || String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const tip = code === 2 ? '找不到企微窗口（客户端没开 / 最小化到托盘）'
    : code === 3 ? '发送后输入框没变空（发送未确认）'
      : code === 1 ? '参数或坐标标定问题'
        : '未知失败';
  return `exit${code ?? 'null'} ${tip}${tail ? '：' + tail.slice(0, 220) : ''}`;
}

function send(textFile, chat) {
  return new Promise((resolve) => {
    const args = [HOLD, 'send', '--chat', chat, '--text-file', textFile];
    const child = spawn(process.execPath, args, { cwd: WORKSPACE, windowsHide: true });
    let out = '', err = '', killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch { /* ignore */ } }, HOLD_TIMEOUT_MS);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: err + e.message, killed }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, killed }); });
  });
}

function shotOf(stdout) {
  const m = String(stdout).match(/截图：(.+\.png)/);
  return m ? m[1].trim() : null;
}

async function workOnce(dry) {
  let rows;
  try { rows = readRows(); } catch { return { acted: false, reason: '没有队列文件' }; }

  // 回收：上一轮 runner 死在半路
  let changed = false;
  const now = Date.now();
  for (const r of rows) {
    if (r && r.state === 'sending' && now - Number(r.startedAt ?? 0) > STALE_SENDING_MS) {
      r.state = 'failed'; r.failedAt = now; r.at = new Date(now).toISOString();
      r.reason = 'runner 中断：这条 3 分钟内没跑完，标记失败（可重发）';
      changed = true;
      logLine(`[reclaim] ${r.id} → failed（sending 超时）`);
    }
  }
  if (changed) rows = writeRows(rows);

  const next = rows.find((r) => r && r.state === 'queued');
  if (!next) return { acted: false };

  next.state = 'sending';
  next.startedAt = now;
  next.at = new Date(now).toISOString();
  writeRows(rows);
  logLine(`[send] ${next.id} 开始 · chat=「${next.chat}」 by=${next.by ?? '?'}`);
  heartbeat({ lastId: next.id, lastState: 'sending', lastAt: now });

  fs.mkdirSync(TEXT_DIR, { recursive: true });
  const textFile = path.join(TEXT_DIR, `${String(next.id).replace(/[^A-Za-z0-9_-]/g, '_')}.txt`);
  fs.writeFileSync(textFile, String(next.text ?? ''), 'utf8');

  let result;
  if (dry) {
    result = { code: 0, out: '[dry] 未调用企微', err: '', killed: false };
  } else {
    result = await send(textFile, String(next.chat));
  }
  const doneAt = Date.now();

  // 重新读一次（别的进程可能追加了新行），只改我们这条
  let after = [];
  try { after = readRows(); } catch { after = rows; }
  const row = after.find((r) => r.id === next.id) ?? next;
  const ok = result.code === 0 && !result.killed;
  row.state = ok ? 'sent' : 'failed';
  row.dry = dry || undefined;
  row.exitCode = result.code;
  row.ms = doneAt - Number(next.startedAt);
  row.at = new Date(doneAt).toISOString();
  row.reason = ok
    ? (dry ? 'dry-run：未调企微，仅验证队列与顺序' : `wecom-hold exit 0${shotOf(result.out) ? '，截图 ' + path.basename(shotOf(result.out)) : ''}`)
    : (result.killed ? `超时 ${HOLD_TIMEOUT_MS / 1000}s：进程被 runner 杀掉` : reasonFromExit(result.code, result.err, result.out));
  row.shot = shotOf(result.out) || undefined;
  writeRows(after);

  try { fs.rmSync(textFile, { force: true }); } catch { /* ignore */ }
  logLine(`[${row.state}] ${next.id} ${row.ms}ms ${row.reason}`);
  heartbeat({ lastId: next.id, lastState: row.state, lastReason: row.reason, lastAt: doneAt, processed: state.processed + 1 });
  return { acted: true, id: next.id, state: row.state, reason: row.reason };
}

async function main() {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  const dry = argv.includes('--dry');
  const iArg = argv.indexOf('--interval');
  const interval = iArg >= 0 ? Math.max(1000, Number(argv[iArg + 1] || 3000)) : 3000;

  if (!fs.existsSync(HOLD)) { console.error(`[runner] 找不到 ${HOLD}（D82 的 CLI 不在）`); process.exit(2); }
  if (!acquireLock()) process.exit(1);
  state.dry = dry;
  heartbeat({ dry, pid: process.pid });
  logLine(`[boot] pid=${process.pid} interval=${interval}ms dry=${dry} once=${once}`);

  const stop = () => { releaseLock(); logLine(`[exit] pid=${process.pid}`); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const tick = async () => {
    state.ticks += 1;
    touchLock();
    heartbeat({});
    let r = { acted: false };
    try { r = await workOnce(dry); } catch (e) { logLine(`[tick] 异常 ${e?.stack ?? e}`); }
    return r;
  };

  if (once) { await tick(); releaseLock(); return; }

  logLine('[boot] 进入轮询');
  while (true) {
    const r = await tick();
    await new Promise((res) => setTimeout(res, r.acted ? GAP_MS : interval));
  }
}

main().catch((e) => { logLine(`[fatal] ${e?.stack ?? e}`); releaseLock(); process.exit(1); });
