#!/usr/bin/env node
// scripts/procedural-run.mjs —— UG-028-impl：按方案 v1.1 §5 把「派单准备」串成五步
//
// 为什么有这个文件：方案说"程序化"该是一条命令，但实际每天是靠人记着四条命令的顺序。
// 本文件只做**串联与 fail-fast**，不新增机制、不改任何现有 CLI 的行为：
//   [1] pending  审核  → node scripts\worklist.mjs pending
//   [2] 预算闸         → node scripts\budget-gate.mjs --check --json
//   [3] 接口契约闸     → checkContractGate()（与 dispatch 同一实现，不复制逻辑）
//   [4] 派单           → node scripts\worklist.mjs dispatch <id>
//   [5] 收口           → 写一行汇总
//
// 契约：
//   node scripts\procedural-run.mjs --once [--ticket <单号|W-id>] [--owner <NN>]
//                                    [--dry-run] [--from <NN>] [--log <path>]
//   不给 --ticket/--owner = **自动挑票**：按 00→07 问 worklist 该派谁（口径=项目栏优先级+域依赖已清+owner 空闲），
//   跳过契约为空的票，挑不到就 exit 1 并列出每个工号为什么没挑到。
//   退出码：0 = 五步全绿 ｜ 1 = 某步失败（fail-fast，后面步不执行）｜ 2 = 用法错误
//   日志：logs\procedural.jsonl，一行一步 {t, step, name, ok, detail, ticket?}
//   失败那步也写日志（ok:false），然后立即退出 —— 所以"日志行数"就是"走到第几步"。
//
// 边界（任务书 §4）：只新增本文件与日志，**不 import 任何可变状态、不写台账**；
//   step4 的 dry-run 由 dispatch 自己实现，本文件不伪造"已派"。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replay } from './worklist-core.mjs';
import { checkContractGate } from './dispatch-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const DEFAULT_LOG = path.join(WORKSPACE, 'logs', 'procedural.jsonl');
const NODE = process.execPath;
const WORKLIST = path.join(HERE, 'worklist.mjs');
const BUDGET = path.join(HERE, 'budget-gate.mjs');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const once = has('--once');
const dryRun = has('--dry-run');
const ticketArg = opt('ticket');
const ownerArg = opt('owner');
const from = opt('from', '05') ?? '05';
const logFile = opt('log', DEFAULT_LOG) ?? DEFAULT_LOG;

function usage(msg) {
  if (msg) process.stderr.write(`✗ ${msg}\n`);
  process.stderr.write('用法：node scripts\\procedural-run.mjs --once [--ticket <单号|W-id>] [--owner <NN>] [--dry-run] [--from <NN>] [--log <path>]\n');
  process.exit(2);
}

if (has('--loop')) usage('本单只做 --once，循环请交给计划任务');
if (!once) usage('需要 --once（本脚本只跑一轮，循环由调度器负责）');
if (ticketArg && ownerArg) usage('--ticket 与 --owner 只能二选一（都不给 = 自动从项目栏挑一张）');

// ── 日志：一行一步，失败也写（同一步只写一行：fail 不重复记账）────────────
const loggedSteps = new Set();
function logStep(step, name, ok, detail, extra = {}) {
  const rec = { t: Date.now(), step, name, ok, detail: String(detail ?? ''), ...extra };
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${JSON.stringify(rec)}\n`, 'utf8');
    loggedSteps.add(step);
  } catch (e) {
    process.stderr.write(`⚠ 写日志失败：${e.message}\n`);
  }
  return rec;
}

function fail(step, name, detail, extra) {
  if (!loggedSteps.has(step)) logStep(step, name, false, detail, extra);
  process.stderr.write(`✗ 停在第 ${step} 步（${name}）：${detail}\n`);
  process.stderr.write(`  日志：${path.relative(WORKSPACE, logFile)}（第 ${step} 步是最后一步，后面步未执行）\n`);
  process.exit(1);
}

/** 跑子命令，返回 {code, out, err}；spawn 本身出错按 code=-1 处理 */
function run(cmd, args) {
  const r = spawnSync(NODE, [cmd, ...args], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) return { code: -1, out: '', err: String(r.error.message) };
  return { code: r.status ?? (r.signal ? 124 : -1), out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** 按单号或台账 id 找票（大小写不敏感） */
function findTask(arg) {
  const key = String(arg ?? '').trim().toUpperCase();
  if (!key) return null;
  return replay().find((t) => String(t.id ?? '').toUpperCase() === key || String(t.ticket ?? '').toUpperCase() === key) ?? null;
}

/** 用 dispatch 自己的挑票逻辑发现"该派谁"（--owner 模式下用；dry-run，不落状态） */
function discoverByOwner(owner) {
  // 注意参数顺序：worklist 的 pos 解析会把「裸 flag 后面的值」当成位置参数，
  // 所以 `--dry-run` 必须放最后（`--owner 04 --from 05 --dry-run`）。
  const r = run(WORKLIST, ['dispatch', '--owner', owner, '--from', from, '--dry-run']);
  const m = /项目栏挑票：(\S+?)（/.exec(r.out);
  if (r.code !== 0 || !m) return { task: null, code: r.code, detail: (r.err || r.out).trim().split('\n').pop() || '没有可派的票' };
  return { task: findTask(m[1]), code: 0, detail: `项目栏挑中 ${m[1]}` };
}

const started = Date.now();
const steps = [];
process.stdout.write(`procedural-run ｜ from=${from} ｜ ${dryRun ? 'DRY-RUN（不派发）' : '真派'}\n`);

// ── 1) 待审（inbox/proposed）───────────────────────────────────────────────
{
  const r = run(WORKLIST, ['pending']);
  const m = /待审\s*(\d+)\s*条/.exec(r.out);
  const n = m ? Number(m[1]) : null;
  const detail = r.code === 0 ? `待审 ${n ?? '?'} 条` : `pending 退出码 ${r.code}：${r.err.trim()}`;
  const rec = logStep(1, 'pending', r.code === 0, detail);
  steps.push(rec);
  if (!rec.ok) fail(1, 'pending', detail);
  process.stdout.write(`[1/5] ✓ 待审 ${n ?? '?'} 条\n`);
}

// ── 2) 预算闸（--check = 只读，不写锁不告警）────────────────────────────────
{
  const r = run(BUDGET, ['--check', '--json']);
  let gate = null;
  try { gate = JSON.parse(r.out).gate; } catch { /* 下面统一报错 */ }
  if (!gate) {
    fail(2, 'budget', `预算闸没给可解析的 JSON（退出码 ${r.code}）：${(r.err || r.out).trim().slice(0, 160)}`);
  }
  const detail = `¥${Number(gate.spent).toFixed(2)} ｜ level=${gate.level} ｜ ${gate.locked ? '已锁' : '未锁'} ｜ ${gate.reason}`;
  const ok = !gate.locked && (r.code === 0 || r.code === 1);
  const rec = logStep(2, 'budget', ok, detail, { locked: !!gate.locked, level: gate.level, spent: gate.spent });
  steps.push(rec);
  if (!rec.ok) fail(2, 'budget', `预算闸已锁：${gate.reason}`);
  process.stdout.write(`[2/5] ✓ ${detail}\n`);
}

// ── 3) 接口契约闸（复用 dispatch 的实现，保证与真派同一判据）─────────────────
let task = null;
{
  let pickHow = '';
  if (ticketArg) {
    task = findTask(ticketArg);
    if (!task) fail(3, 'contract', `台账里找不到 ${ticketArg}`);
    pickHow = '显式 --ticket';
  } else {
    // 两种挑票：--owner 指定工号；都不给 = 自动扫工号（00→07），挑第一张「能派且契约非空」的
    const owners = ownerArg ? [ownerArg] : ['00', '01', '02', '03', '04', '05', '06', '07'];
    const skipped = [];
    for (const o of owners) {
      const d = discoverByOwner(o);
      if (!d.task) { skipped.push(`${o}:${(d.detail.match(/\[?(\d{3} [a-z-]+)\]?/)?.[1] ?? d.detail).slice(0, 42)}`); continue; }
      const g0 = checkContractGate(d.task);
      if (!g0.ok) { skipped.push(`${o}:${d.task.ticket ?? d.task.id}=${g0.code}`); continue; }
      task = d.task;
      pickHow = ownerArg ? `--owner ${o} 挑中` : `自动挑中（扫了 ${skipped.length + 1} 个工号）`;
      break;
    }
    if (!task) {
      fail(3, 'contract', `没有能派的票（已扫 ${owners.join('/')}）：${skipped.join('；').slice(0, 300)}`, { skipped });
    }
  }
  const g = checkContractGate(task);
  const detail = g.ok
    ? `${task.ticket ?? task.id} 接口契约 OK（${path.basename(g.book ?? '') || 'task book'}）｜${pickHow}`
    : `${task.ticket ?? task.id} ${g.code}：${g.detail}`;
  const rec = logStep(3, 'contract', !!g.ok, detail, { ticket: task.ticket ?? task.id, id: task.id, pickedBy: pickHow });
  steps.push(rec);
  if (!rec.ok) fail(3, 'contract', detail, { ticket: task.ticket ?? task.id, id: task.id });
  process.stdout.write(`[3/5] ✓ ${detail}\n`);
}

// ── 4) 派单 ────────────────────────────────────────────────────────────────
{
  const args = ['dispatch', task.id, '--from', from];
  if (dryRun) args.push('--dry-run');
  const r = run(WORKLIST, args);
  const outLines = r.out.trim().split('\n');
  const tail = outLines[outLines.length - 1] || '';
  const ok = r.code === 0;
  const codeName = r.code === 4 ? 'not-delivered' : r.code === 3 ? 'quota' : r.code === 0 ? (dryRun ? 'dry-run' : 'dispatched') : `exit ${r.code}`;
  const detail = ok ? `${task.ticket ?? task.id} → ${task.target ?? '?'}（${codeName}）${tail ? ` ｜ ${tail.slice(0, 120)}` : ''}` : `${task.ticket ?? task.id} 派发失败（${codeName}）：${(r.err || r.out).trim().split('\n').slice(-2).join(' ｜ ').slice(0, 240)}`;
  const rec = logStep(4, 'dispatch', ok, detail, { ticket: task.ticket ?? task.id, id: task.id, dryRun });
  steps.push(rec);
  if (!rec.ok) fail(4, 'dispatch', detail, { id: task.id });
  process.stdout.write(`[4/5] ✓ ${detail}\n`);
}

// ── 5) 收口 ────────────────────────────────────────────────────────────────
{
  const ms = Date.now() - started;
  const detail = `五步全绿 ｜ ${task.ticket ?? task.id} ｜ ${dryRun ? 'dry-run（票未动）' : '已派'} ｜ ${ms}ms`;
  const rec = logStep(5, 'done', true, detail, { ticket: task.ticket ?? task.id, id: task.id, ms, dryRun });
  steps.push(rec);
  process.stdout.write(`[5/5] ✓ ${detail}\n`);
  process.stdout.write(`日志：${path.relative(WORKSPACE, logFile)}（本轮 ${steps.length} 行）\n`);
  process.exit(0);
}
