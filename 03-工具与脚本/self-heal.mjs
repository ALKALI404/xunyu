#!/usr/bin/env node
// scripts/self-heal.mjs —— 疼痛链路的控制器（D6-v2，2026-10-28 17:00 改口径）。
//
// 旧版（定时轮询全系统）已作废：主人定「不长期监测」。新闭环只由**疼痛事件**驱动：
//
//     疼痛(pain) → 缩回(retract) → 自愈(heal) → 复验(verify) → 摘牌(restore)
//
//   · 疼痛：别人把疼打到 pain-bus(9339) 的 /pain；本进程只读 GET /pain/status
//     （三个来源：监护者报丧 crash / 调用方疼痛 unreachable|timeout|contract / 慢兜底 silent）
//   · 缩回：标 degraded + 能力表摘掉（调 pain-bus /pain/retract）→ 调用方立刻知道"别用这条腿"
//   · 自愈：只 B 档 —— transport 且模块在 supervisor 监护表里，就交给 supervisor 轮询拉起；
//           contract / module 只报不动；C 档（改配置/换代）一律不自动
//   · 复验：每 3s 探一次、最多 30s，必须回采到 ok
//   · 摘牌：复验过 → 标回 ok、能力表恢复、写 restore；没过 → escalated，**保持 degraded、不许重试第二轮**
//
// 用法：
//   node scripts\self-heal.mjs                # 默认 --watch：常驻听疼痛
//   node scripts\self-heal.mjs --once         # 手动跑一次（处理当前未处理的疼）
//   node scripts\self-heal.mjs --once --dry-run --json
//   node scripts\self-heal.mjs --silent-after 10   # 慢兜底阈值（秒，默认 300）
//   node scripts\self-heal.mjs --port bridge=9339  # 复验用的端口覆盖（演练/排障）
//
// 退出码（--once）：0 无需动作 ｜ 1 已自愈 ｜ 2 升级给人 ｜ 3 执行错误
//
// 边界：只调 pain-bus 与本机端口探测；不碰 bridge.js 主干、不碰计划任务、不改配置。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const AUDIT_FILE = path.join(WORKSPACE, 'logs', 'heal.jsonl');
const PAIN_BUS = String(process.env.PAIN_BUS_URL || 'http://127.0.0.1:9339').replace(/\/+$/, '');

const VERIFY_INTERVAL_MS = 3000;
const VERIFY_TIMEOUT_MS = 30000;
const WATCH_POLL_MS = 1000;
const PROBE_TIMEOUT_MS = 1200;

/**
 * 模块 → 复验端口。名字必须与 supervisor 报丧时的 svc.n 一致（否则对不上号）：
 *   supervisor 表：relay 9334 / body 9335 / snowluma 3001 / probe 9337 / bridge 3100。
 * bridge 用 3100 本体判断（9337 是外挂探针，桥接死了它也还活着，拿它复验会假阳性）。
 */
const PORT_OF = new Map([
  ['relay', 9334],
  ['body', 9335],
  ['wecom', 8788],
  ['probe', 9337],
  ['bridge', 3100],
  ['pain-bus', 9339],
  ['snowluma', 3001],
  ['dsh', 60540],
  ['mod', 9333]
]);

/** supervisor 监护表（依据 avatar\supervisor.ps1 的 healModules 白名单，2026-10-28 版）。只认这里面的才允许 B 档。 */
const SUPERVISED = new Set(['relay', 'body', 'snowluma', 'bridge', 'probe']);

/** 慢兜底要看的模块（会自己喊疼的那几个；没人喊过的模块不替它哭）。 */
const SILENT_WATCH = ['relay', 'body', 'probe', 'bridge', 'snowluma'];

/** supervisor 的受控重启入口（03·维护，只绑回环；带 60s 同模块冷却）。 */
const HEAL_URL = String(process.env.HEAL_URL || 'http://127.0.0.1:9338').replace(/\/+$/, '');

const PAIN_KINDS = new Set(['crash', 'unreachable', 'timeout', 'contract', 'silent']);

// ── 小工具 ──────────────────────────────────────────────────────────────────
const nowMs = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const opts = {
    mode: 'watch',
    json: false,
    dryRun: false,
    silentAfterSec: 300,
    portOverrides: new Map(),
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--watch') opts.mode = 'watch';
    else if (arg === '--once') opts.mode = 'once';
    else if (arg === '--json') opts.json = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--silent-after') {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('--silent-after 需要正数秒');
      i += 1;
      opts.silentAfterSec = v;
    } else if (arg === '--port') {
      const value = argv[i + 1];
      const m = /^([a-z0-9_-]+)=(\d{1,5})$/.exec(String(value ?? ''));
      if (!m) throw new Error(`--port 格式应为 <module>=<port>：${value}`);
      i += 1;
      opts.portOverrides.set(m[1], Number(m[2]));
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

// ── pain-bus 客户端 ─────────────────────────────────────────────────────────
async function busGet(pathname) {
  const response = await fetch(`${PAIN_BUS}${pathname}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(2500)
  });
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text.replace(/^\uFEFF/, '')) };
}

async function busPost(pathname, body) {
  const response = await fetch(`${PAIN_BUS}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(2500)
  });
  try {
    return { status: response.status, json: JSON.parse((await response.text()).replace(/^\uFEFF/, '')) };
  } catch {
    return { status: response.status, json: null };
  }
}

async function readStatus() {
  const { status, json } = await busGet('/pain/status');
  if (status !== 200 || !json?.ok) throw new Error(`pain-bus /pain/status 返回 HTTP ${status}`);
  return json;
}

/** 刷新 last-seen（"我看过它，它还活着"）：只更新心跳，不产生新的疼、不写 pain.jsonl。 */
async function busTouch(module) {
  try {
    await busPost('/pain/touch', { module });
    return true;
  } catch {
    return false;
  }
}

/**
 * 请 supervisor 受控重启（03·维护的 9338 入口：白名单 + 同模块 60s 冷却 + 自己记账）。
 * 本进程**绝不**自己 Start-Process —— 两套守护抢同一个 PID 会互相踩。
 * @returns {Promise<{requested:boolean, http:number|null, note:string, json:object|null}>}
 */
async function requestHeal(module) {
  try {
    const response = await fetch(`${HEAL_URL}/heal?module=${encodeURIComponent(module)}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(25000)
    });
    let json = null;
    try { json = JSON.parse((await response.text()).replace(/^\uFEFF/, '')); } catch { json = null; }
    if (response.status === 429) {
      return { requested: true, http: 429, note: `supervisor 冷却中（${json?.error ?? '60s'}），本轮交给它自己那轮拉起`, json };
    }
    if (!response.ok) {
      return { requested: false, http: response.status, note: `supervisor 拒绝：${json?.error ?? response.status}`, json };
    }
    const ms = json?.ms ?? null;
    return { requested: true, http: response.status, note: `supervisor 已受控重启${json?.healed ? `（pid ${json.pidBefore ?? '?'} → ${json.pidAfter ?? '?'}，${ms}ms）` : '（未在 20s 内回来，交复验判定）'}`, json };
  } catch (error) {
    return { requested: false, http: null, note: `9338 不可达（${String(error?.message ?? error).slice(0, 80)}）：只登记，等 supervisor 自己轮询`, json: null };
  }
}

// ── 探测 ────────────────────────────────────────────────────────────────────
function probeTcp(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try { socket.connect(port, '127.0.0.1'); } catch { done(false); }
  });
}

async function probeHealth(module, port) {
  // bridge 本体 3100 的 /api/health 要 console-token，这里只认端口（与 supervisor 自己的判据一致）。
  const paths = { relay: '/health', body: '/health', wecom: '/health', probe: '/health', 'pain-bus': '/health' };
  const pathname = paths[module];
  if (!pathname) return null; // 该模块没有可探的 /health（bridge/dsh/mod），只认端口
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    const json = JSON.parse((await response.text()).replace(/^\uFEFF/, ''));
    return json?.ok !== false;
  } catch {
    return false;
  }
}

function portOf(module, opts) {
  if (opts.portOverrides.has(module)) return opts.portOverrides.get(module);
  return PORT_OF.get(module) ?? null;
}

async function probeModule(module, opts) {
  const port = portOf(module, opts);
  if (!port) return { ok: false, why: `不知道 ${module} 的端口，无法证明恢复` };
  const open = await probeTcp(port);
  if (!open) return { ok: false, why: `端口 ${port} 不通` };
  const health = await probeHealth(module, port);
  if (health === false) return { ok: false, why: `端口 ${port} 通了但 /health 不是 ok` };
  return { ok: true, why: `端口 ${port} 通${health === null ? '' : '，/health ok'}` };
}

// ── 定位 ────────────────────────────────────────────────────────────────────
function classify(pain) {
  if (pain === 'contract') return 'contract';
  if (pain === 'module') return 'module';
  return 'transport'; // crash / unreachable / timeout / silent
}

// ── 审计 ────────────────────────────────────────────────────────────────────
function appendAudit(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── 一个闭环 ────────────────────────────────────────────────────────────────
/**
 * 处理一个模块的疼：疼痛 → 缩回 → 自愈 → 复验 → 摘牌。
 * @returns {Promise<object>} 审计记录 {t,module,pain,act,verify,result}
 */
async function handleModule(module, painRecord, opts) {
  const startedAt = nowMs();
  const layer = classify(painRecord.pain);
  const supervised = SUPERVISED.has(module);
  const record = {
    t: startedAt,
    module,
    pain: painRecord.pain,
    layer,
    act: null,
    verify: null,
    result: 'observed',
    dryRun: opts.dryRun
  };

  // contract / module：只报不动（清单口径：contract 只 A，不自动改代码/配置）
  if (layer !== 'transport') {
    record.result = opts.dryRun ? 'dry-run' : 'observed';
    record.note = `layer=${layer}：只报不动（不修改代码/配置）`;
    appendAudit(record);
    return record;
  }

  // silent 是弱信号：先探一次。探得活 → 只刷新 last-seen，别为了"安静"把好模块摘了。
  if (painRecord.pain === 'silent') {
    const probe = await probeModule(module, opts);
    if (probe.ok) {
      if (!opts.dryRun) await busTouch(module);
      record.result = opts.dryRun ? 'dry-run' : 'no-action';
      record.verify = { ok: true, verifyAt: iso(nowMs()), recoveredInMs: 0, attempts: 1, lastProbe: probe.why };
      record.note = `静默但可达（${probe.why}）：只刷新 last-seen，不缩回`;
      appendAudit(record);
      return record;
    }
  }

  // 调用方疼痛（unreachable / timeout）也可能骗人：调用方自己指错端口、或只是它那侧网络抖一下，
  // 模块本身可能好好的。同样先探一次 —— 探得活就只刷新 last-seen，不缩回、不重启。
  // 依据：2026-10-28 演练②，一个指向死端口的 relay 副本报了 body unreachable，
  // 控制器照单全收 → 真 body 被摘牌并重启（pid 49032→42260，白停 5.4s）。
  if (painRecord.pain === 'unreachable' || painRecord.pain === 'timeout') {
    const probe = await probeModule(module, opts);
    if (probe.ok) {
      if (!opts.dryRun) await busTouch(module);
      record.result = opts.dryRun ? 'dry-run' : 'no-action';
      record.verify = { ok: true, verifyAt: iso(nowMs()), recoveredInMs: 0, attempts: 1, lastProbe: probe.why };
      record.note = `调用方报不可达，但本机探测可达（${probe.why}）：判为调用方视角偏差，不缩回、不重启`;
      appendAudit(record);
      return record;
    }
  }

  // ① 缩回（先止血）：dry-run 不真的改总线状态
  const retractReason = `pain=${painRecord.pain} by=${painRecord.by || '?'} code=${painRecord.code || '-'}`;
  if (!opts.dryRun) {
    await busPost('/pain/retract', { module, reason: retractReason, by: 'self-heal' });
  }
  record.retracted = !opts.dryRun;

  if (!supervised) {
    record.act = { kind: 'none', reason: `${module} 不在 supervisor 监护表里（${retractReason}）：只缩回 + 升级给人` };
    record.result = opts.dryRun ? 'dry-run' : 'escalated';
    appendAudit(record);
    return record;
  }

  // ② 自愈：请 supervisor 受控重启（本进程绝不自己起进程）
  const actAt = nowMs();
  const heal = opts.dryRun
    ? { requested: false, http: null, note: 'dry-run：只登记不请求' }
    : await requestHeal(module);
  record.act = {
    kind: 'restart-via-supervisor',
    module,
    at: iso(actAt),
    requested: heal.requested,
    http: heal.http,
    note: heal.note
  };

  if (opts.dryRun) {
    record.result = 'dry-run';
    appendAudit(record);
    return record;
  }

  // ③ 复验：每 3s 回采，最多 30s
  const samples = [];
  let verified = false;
  let verifyAt = null;
  let lastWhy = '';
  for (;;) {
    const at = nowMs();
    const probe = await probeModule(module, opts);
    samples.push({ at, ok: probe.ok, why: probe.why });
    lastWhy = probe.why;
    if (probe.ok) { verified = true; verifyAt = at; break; }
    if (nowMs() - actAt >= VERIFY_TIMEOUT_MS) break;
    const remain = VERIFY_TIMEOUT_MS - (nowMs() - actAt);
    await sleep(Math.max(200, Math.min(VERIFY_INTERVAL_MS, remain)));
  }
  record.verify = {
    ok: verified,
    verifyAt: verified ? iso(verifyAt) : null,
    recoveredInMs: verified ? verifyAt - actAt : null,
    attempts: samples.length,
    lastProbe: lastWhy
  };

  // ④ 摘牌 / 升级
  if (verified) {
    await busPost('/pain/restore', { module, by: 'self-heal' });
    record.result = 'healed';
    record.note = `复验通过（第 ${samples.length} 次回采，耗时 ${fmtDuration(verifyAt - actAt)}），已摘牌`;
  } else {
    // 保持 degraded：**不 restore**，也不重试第二轮
    record.result = 'escalated';
    record.note = `复验 30s 未通过（${samples.length} 次回采，最后：${lastWhy}）；保持 degraded，交给人，不自动重试第二轮`;
  }
  appendAudit(record);
  return record;
}

// ── 慢兜底：只查 last-seen 超时的模块（不是轮询全部）────────────────────────
/** 测试/演练口子：把额外模块临时纳入慢兜底观察（默认只认 SILENT_WATCH）。 */
const SILENT_EXTRA = String(process.env.SELF_HEAL_SILENT_EXTRA || '').split(',').map((s) => s.trim()).filter(Boolean);
const SILENT_SCOPE = new Set([...SILENT_WATCH, ...SILENT_EXTRA]);

async function slowFallback(status, opts, log) {
  const cutoff = opts.silentAfterSec * 1000;
  const fired = [];
  for (const item of status.modules ?? []) {
    if (!SILENT_SCOPE.has(item.module)) continue;
    if (!item.lastSeen) continue;            // 从没喊过疼的模块不替它哭
    if (item.state === 'degraded') continue;  // 已经在降级里，别叠噪音
    if ((item.ageMs ?? 0) < cutoff) continue;
    // 先把"安静"当疑问而不是结论：探一下，活着就只刷新 last-seen。
    const probe = await probeModule(item.module, opts);
    if (probe.ok && !opts.dryRun) {
      await busTouch(item.module);
      log(`[兜底] ${item.module} 安静 ${fmtDuration(item.ageMs)}，但探测可达（${probe.why}）→ 刷新 last-seen`);
      continue;
    }
    const { status: code } = await busPost('/pain', {
      pain: 'silent',
      module: item.module,
      by: 'self-heal',
      code: 'last-seen-stale',
      detail: `last-seen ${fmtDuration(item.ageMs)} 前 > ${opts.silentAfterSec}s；探测：${probe.why}`
    });
    fired.push({ module: item.module, ageMs: item.ageMs, http: code });
    log(`[兜底] ${item.module} last-seen ${fmtDuration(item.ageMs)} 前、探测不可达（${probe.why}）→ 补发 silent pain`);
  }
  return fired;
}

/** 待处理的疼：模块有 lastPain 且还是 pain 类型、状态不是 degraded（已升级的不重来）。 */
function pendingPains(status) {
  return (status.modules ?? [])
    // 自己不在待处理之列：控制器挂了是 supervisor 的活（它监护 + 报丧），
    // 自己既救不了自己，也不该把自己标成 degraded 让看板一直 WARN。
    .filter((m) => m.module !== 'self-heal')
    .filter((m) => m.lastPain && PAIN_KINDS.has(String(m.lastPain.pain)) && m.state !== 'degraded')
    .map((m) => ({ module: m.module, pain: m.lastPain.pain, at: m.lastPain.at, by: m.lastPain.by, code: m.lastPain.code, state: m.state }));
}

// ── 输出 ────────────────────────────────────────────────────────────────────
function renderCycle(record) {
  const lines = [];
  lines.push(`[${iso(record.t)}] ${record.module} ← pain=${record.pain}（layer=${record.layer}）`);
  lines.push(`  缩回: ${record.retracted ? '已标 degraded + 能力表摘掉' : '未动（dry-run 或非 transport）'}`);
  lines.push(`  自愈: ${record.act ? `${record.act.kind}${record.act.note ? `（${record.act.note}）` : (record.act.reason ? `（${record.act.reason}）` : '')}` : '无'}`);
  if (record.verify) {
    lines.push(`  复验: ${record.verify.ok ? `通过，${fmtDuration(record.verify.recoveredInMs)}（第 ${record.verify.attempts} 次回采）@ ${record.verify.verifyAt}` : `未通过（${record.verify.attempts} 次回采，最后：${record.verify.lastProbe}）`}`);
  } else {
    lines.push('  复验: 跳过');
  }
  lines.push(`  结论: ${record.result.toUpperCase()}${record.note ? ` —— ${record.note}` : ''}`);
  return lines.join('\n');
}

function exitCodeOf(records) {
  if (!records.length) return 0;
  if (records.some((r) => r.result === 'escalated')) return 2;
  if (records.some((r) => r.result === 'healed')) return 1;
  return 0;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write([
      '用法: node scripts\\self-heal.mjs [--watch|--once] [--json] [--dry-run] [--silent-after 秒] [--port 模块=端口]',
      '  默认 --watch（常驻听 pain-bus 9339）；--once 跑一次就退',
      '退出码（--once）：0 无需动作 ｜ 1 已自愈 ｜ 2 升级给人 ｜ 3 执行错误'
    ].join('\n') + '\n');
    return;
  }

  const log = (line) => { if (!opts.json) process.stdout.write(`${line}\n`); };

  // ── 一次性 ──
  if (opts.mode === 'once') {
    let status;
    try {
      status = await readStatus();
    } catch (error) {
      const fail = { tool: 'self-heal', version: VERSION, mode: 'once', at: iso(nowMs()), result: 'error', error: `pain-bus 不可达或返回异常：${String(error?.message ?? error)}` };
      appendAudit({ t: nowMs(), module: null, pain: null, act: null, verify: null, result: 'error', error: fail.error });
      process.stdout.write(opts.json ? `${JSON.stringify(fail, null, 2)}\n` : `self-heal: ${fail.error}\n结论: ERROR（exit=3）\n`);
      process.exitCode = 3;
      return;
    }

    const silent = await slowFallback(status, opts, log);
    const afterSilent = silent.length ? await readStatus() : status;
    const pending = pendingPains(afterSilent);

    log(`pain-bus ${status.module ?? 'ok'} · seq=${status.seq ?? '?'} · 已知模块 ${(status.modules ?? []).length} · degraded ${(status.degraded ?? []).length}`);
    if (silent.length) log(`慢兜底补发 ${silent.length} 条 silent pain：${silent.map((s) => s.module).join(', ')}`);

    if (!pending.length) {
      const out = {
        tool: 'self-heal', version: VERSION, mode: opts.mode, dryRun: opts.dryRun,
        at: iso(nowMs()), result: 'no-action', conclusion: '无需动作（没有未处理的疼痛）',
        degraded: afterSilent.degraded ?? [], cycles: []
      };
      if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      else process.stdout.write('检测: 没有未处理的疼痛\n结论: 无需动作　exit=0\n');
      process.exitCode = 0;
      return;
    }

    log(`待处理疼痛 ${pending.length} 项：${pending.map((p) => `${p.module}/${p.pain}`).join(', ')}`);
    const records = [];
    for (const item of pending) {
      const record = await handleModule(item.module, item, opts);
      records.push(record);
      if (!opts.json) process.stdout.write(`${renderCycle(record)}\n`);
    }
    // escalated 的保持 degraded（已由 retract 写入），不再第二轮
    const code = exitCodeOf(records);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        tool: 'self-heal', version: VERSION, mode: opts.mode, dryRun: opts.dryRun,
        at: iso(nowMs()), records, exitCode: code,
        conclusion: code === 2 ? 'ESCALATED（有模块复验未过或不可自愈，保持 degraded）'
          : code === 1 ? 'HEALED（全部复验通过，已摘牌）'
            : '无需动作'
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`结论: ${code === 2 ? 'ESCALATED' : code === 1 ? 'HEALED' : '无需动作'}　exit=${code}\n`);
    }
    process.exitCode = code;
    return;
  }

  // ── 常驻（默认）──
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  log(`self-heal ${VERSION} --watch：监听 ${PAIN_BUS}/pain（慢兜底 ${opts.silentAfterSec}s，dry-run=${opts.dryRun}）`);

  // 起手先给自己摘牌：上一代实例若被 supervisor 报过 crash，总线里会留一条 degraded，
  // 而「自己救不了自己」导致它永远挂着、看板一直 WARN（2026-10-28 验收⑤实测）。
  // 我此刻活着、还能跟总线说话，这就是「已恢复」的证据。
  busPost('/pain/restore', { module: 'self-heal', by: 'self-heal' }).catch(() => {});

  // 同理，总线重启后内存态归零（modules / seq 全清），慢兜底会因为「这个模块从没喊过疼」
  // 而不看它，等于兜底失效（2026-10-28 实测）。起手给受观察模块补一次 last-seen：
  // 探得活才 touch；探不动的留给下一条真事件。
  for (const name of SILENT_WATCH) {
    try {
      const probe = await probeModule(name, opts);
      if (probe.ok) await busTouch(name);
    } catch { /* 探不动就算了，别在启动阶段拖死 */ }
  }

  const handled = new Set();   // `${module}|${pain}|${at}` 已处理过的疼，防重复
  const inFlight = new Set();
  let lastSilentCheck = 0;
  let cycles = 0;
  let healed = 0;
  let escalated = 0;

  while (!stopping) {
    let status = null;
    try {
      status = await readStatus();
    } catch (error) {
      log(`[watch] pain-bus 不可达（${String(error?.message ?? error)}），1s 后重试`);
      await sleep(WATCH_POLL_MS);
      continue;
    }

    // 慢兜底：每 silentAfter 秒查一次 last-seen（不是轮询全部模块）
    if (nowMs() - lastSilentCheck >= opts.silentAfterSec * 1000) {
      lastSilentCheck = nowMs();
      try {
        const fired = await slowFallback(status, opts, log);
        if (fired.length) status = await readStatus();
      } catch (error) {
        log(`[watch] 慢兜底异常：${String(error?.message ?? error)}`);
      }
    }

    for (const item of pendingPains(status)) {
      const key = `${item.module}|${item.pain}|${item.at}`;
      if (handled.has(key) || inFlight.has(item.module)) continue;
      inFlight.add(item.module);
      try {
        const record = await handleModule(item.module, item, opts);
        cycles += 1;
        if (record.result === 'healed') healed += 1;
        if (record.result === 'escalated') escalated += 1;
        handled.add(key);
        if (opts.json) process.stdout.write(`${JSON.stringify(record)}\n`);
        else process.stdout.write(`${renderCycle(record)}\n`);
      } catch (error) {
        log(`[watch] 处理 ${item.module} 异常：${String(error?.message ?? error)}`);
      } finally {
        inFlight.delete(item.module);
      }
    }
    await sleep(WATCH_POLL_MS);
  }

  log(`self-heal --watch 退出：处理 ${cycles} 轮，healed ${healed}，escalated ${escalated}`);
  process.exitCode = 0;
}

main().catch((error) => {
  process.stderr.write(`self-heal 崩溃：${error?.stack ?? error}\n`);
  try {
    appendAudit({ t: Date.now(), module: null, pain: null, act: null, verify: null, result: 'error', error: String(error?.message ?? error) });
  } catch { /* ignore */ }
  process.exitCode = 3;
});
