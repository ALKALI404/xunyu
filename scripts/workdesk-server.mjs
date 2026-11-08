#!/usr/bin/env node
import { readJson as readJsonIo } from './json-io.mjs';
// scripts/workdesk-server.mjs —— 本地工作台（127.0.0.1:9340）· D12 v1
//
// v0.1（D8）三个只读接口打底；D12 加：任务队列（worklist 回放）、派发（**唯一花钱的动作**）、
// 交付扫描（每 10 秒，零 token）、待验收栏。
//
// 花钱的只有 POST /api/dispatch（内部只有一次 session/prompt）。其余接口一律零 token：
//   · 会话投影：sessions/list（本地 RPC，不产生模型回合）
//   · 台账：state\worklist.jsonl（本地文件）
//   · 交付：records\交付\*（本地目录扫描）
//   · 邮件：E:\DeepFish\Xunyu\memory\mail\mailbox.jsonl（本地文件）
//
// 接口：
//   GET  /api/agents    谁在干什么（workingActivity.line）+ 忙闲 + 空闲时长
//   GET  /api/tasks     state\tasks\*.md 里没有对应交付的活
//   GET  /api/worklist  任务台账（回放后的当前状态）+ 待验收 + unlinked 交付
//   GET  /api/mail      邮件池 + 各 agent 未读
//   POST /api/dispatch  {id, confirm}  ← 唯一花钱；只许 queued + 目标空闲；配额 20/日
//   POST /api/accept    {id, note}     ← 待验收 → done
//   POST /api/reject    {id, note}     ← 待验收 → doing（并给工号落邮件）
//   GET  /              单文件工作台页（不引外网资源）

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  WORKLIST_FILE, replay as replayWorklist, summary as worklistSummary, byTarget as worklistByTarget,
  setState as wlSetState, approvePlan, rejectPlan, PLAN_STATES, rankForDispatch,
  pendingUnlocks, markUnblocked, blockedList,
  unackedList, unackMs, humanMs          // UG-007：未回执（派生）
} from './worklist-core.mjs';
import { dispatch as dispatchTask, priorityState, evaluatePriority, readConfig, quotaUsed, readAudit, DISPATCH_LOG, deliveryStatus, processDueRetries } from './dispatch-core.mjs';
import { collectCost, parseAt as parseClock, dayStart as dayStartOf } from './cost-core.mjs';
import { checkDelivery as precheckDelivery } from './check-delivery.mjs';   // D57：交付预检门
import { collectComponents } from './health-components.mjs';                 // WS-011：组件健康（谁活着谁挂了）
import { syncProjects } from './projects-sync.mjs';                            // D66：票归属自动同步
import { readMistakes, reworkForFeature, recordRework, resolveRework, syncMistakes } from './mistakes-sync.mjs';   // UG-036：返工错题本
import { handleWecomChat } from './wecom-chat-api.mjs';                        // WC-007：企微聊天组件后端（/api/wecom/*）
import { startScheduler, schedulerStatus, runJobNow } from './scheduler-core.mjs';  // WS-010：进程内调度器（替代计划任务）

const VERSION = '1.0.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const TASKS_DIR = path.join(WORKSPACE, 'state', 'tasks');
const DELIVERY_DIR = path.join(WORKSPACE, 'records', '交付');
const MAIL_BOX = 'E:\\DeepFish\\Xunyu\\memory\\mail';
const MAIL_FILE = path.join(MAIL_BOX, 'mailbox.jsonl');
const DSH_CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
const DSH_BASE_MOD = 'file:///E:/DSH_workspace/scripts/dsh-base.mjs';

// D89：代持发送队列。工作台**只写队列**，真正发是 scripts\wecom-outbox-runner.mjs（单实例、顺序发）。
const OUTBOX_FILE = path.join(WORKSPACE, 'state', 'wecom-outbox.jsonl');
const OUTBOX_HEART = path.join(WORKSPACE, 'state', 'wecom-outbox-runner.json');
const WECOM_HOLD_CFG = path.join(WORKSPACE, 'state', 'wecom-hold.json');
const OUTBOX_RECENT = 5;        // 页面只显示最近 5 条
const OUTBOX_MAX_PENDING = 20;  // 积压上限：超过就拒绝入队，避免一次塞几百条抢前台

const AGENTS_TTL_MS = 3000;
const RPC_TIMEOUT_MS = 2500;
const MAIL_PAGE = 50;

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = Number(portArg >= 0 ? argv[portArg + 1] : (process.env.WORKDESK_PORT || 9340));
/** 保险 / 学习区是独立项目，走独立验收、不经 01（主人 2026-11-06 18:05 定）。 */
const INDEPENDENT_PROJECTS = new Set(['insurance', 'study']);
const STARTED_AT = Date.now();
// D60（03，2026-10-28）：页脚版本号——构建时刻 + 进程 pid，主人一眼能判断页面新旧。
// 这里的「构建」= 本进程起服务的时刻；改文件后服务会自动重启，这个值就跟着变。
const BUILD_TAG = `${new Date(STARTED_AT).toLocaleTimeString('zh-CN', { hour12: false })} · pid ${process.pid}`;

const nowMs = () => Date.now();
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// ── 小工具 ──────────────────────────────────────────────────────────────────
function readJson(p, fallback = null) { try { return readJsonIo(p); } catch { return fallback; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; } }
function clip(s, max) { const text = String(s ?? '').replace(/\s+/g, ' ').trim(); return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }
function fmtAge(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < 1000) return '刚刚';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

// ── 运行日志（写文件，不写 stdout：父进程退出后 stdout 句柄会断，EPIPE 直接崩）──
const RUN_LOG = path.join(WORKSPACE, 'logs', 'workdesk.run.log');
function logLine(line) {
  try {
    fs.mkdirSync(path.dirname(RUN_LOG), { recursive: true });
    fs.appendFileSync(RUN_LOG, new Date().toISOString() + ' ' + line + '\n', 'utf8');
  } catch { /* 日志写不进去也不能影响主流程 */ }
}

// ── 自动接力（D22）：空闲且有 queued → 派下一件 ─────────────────────────────
// 守卫（缺一不可）：①开关打开 ②今日配额未超 ③目标 running=false ④该工号有 queued
// ⑤一次只派一件（一轮最多一件）⑥失败对该工号退避 60s，别拿 429/409 刷屏。
const relayState = {
  last: null, inFlight: false, backoff: new Map(), ticks: 0,
  // D75：票级状态——缺任务书的票不再每轮重试；连败 3 次直接拉黑
  needDoc: new Set(),   // 任务书不合格（页面标红 needs-task-doc）
  fails: new Map(),     // taskId → 连续失败次数
  skip: new Set()       // 连败 3 次后不再自动挑
};
function hasTaskDoc(ticket) {
  if (!ticket) return false;
  try { return fs.existsSync(path.join(TASKS_DIR, String(ticket) + '.md')); } catch { return false; }
}

// 2026-10-30 优先队列（主人定：优先队列与普通队列分开，自动派发只开优先）
function priorityQueue() {
  // UG-031：老函数留作兼容，真相在 dispatch-core.priorityState()（三处共用同一判定）
  const st = priorityState();
  return { active: st.active, set: new Set(st.expanded), ready: st.ready, error: st.error };
}

function relayConfig() {
  const cfg = readConfig();
  const ar = cfg.autoRelay ?? {};
  return {
    enabled: ar.enabled !== false,          // 默认开（D22 要的就是「排队就接着干」）
    intervalMs: Number(ar.intervalMs ?? 10000),
    backoffMs: Number(ar.backoffMs ?? 60000)
  };
}

async function autoRelayTick() {
  relayState.ticks += 1;
  // 解锁巡检先跑：它不碰 DSH、不花钱，不该被「接力开关」或配额卡住（D30）
  sweepUnlocks();
  const cfg = relayConfig();
  if (!cfg.enabled || relayState.inFlight) return;
  const limit = Number(readConfig().dispatchPerDay ?? 20);
  if (quotaUsed('dispatch') >= limit) return;
  relayState.inFlight = true;
  try {
    const sessions = await listSessions({ force: true });
    if (sessions.error) return;
    const agents = agentRows(sessions.items, nowMs());
    // D73：挑票改走四级优先级（P0 > 有下游 > 返工优先 > FIFO），同级 FIFO
    const allTasks = replayWorklist();
    const rankedByWorker = new Map();
    const rankOf = (no) => {
      const key = String(no);
      if (!rankedByWorker.has(key)) rankedByWorker.set(key, rankForDispatch(allTasks, { worker: key }));
      return rankedByWorker.get(key);
    };
    let dispatched = 0;
    for (const agent of agents) {
      if (!agent.no) continue;
      if (agent.running || agent.live) continue;                     // 在干就别插手
      if ((relayState.backoff.get(agent.no) ?? 0) > nowMs()) continue; // 退避中
      // D58：一个工号同时只留 1 张 doing；已有在做的就跳过（不叠单）
      if (allTasks.some((t) => t.state === 'doing' && String(t.target) === String(agent.no))) continue;

      // ── D75r：计数点包住**整个尝试**（挑票 → 校验 → 派发），任何一步抛错都 +1 ──
      let next = null, pick = null;
      try {
        // 挑票：缺任务书的票只标记（skipped-needs-doc），**不计失败**
        const prioQ = priorityQueue();
        if (prioQ.error) { logLine(`[relay] 优先名单图有问题，停派：${prioQ.error.code} ${prioQ.error.detail}`); return; }
        if (!relayState.prioLogged) { relayState.prioLogged = true; logLine(`[relay] 优先队列 active=${prioQ.active} size=${prioQ.set.size} sample=${[...prioQ.set].slice(0,3).join("|")}`); }
        for (const cand of rankOf(agent.no)) {
          if (relayState.skip.has(cand.id)) continue;
          const t = allTasks.find((x) => x.id === cand.id);
          if (!t) continue;
          // 2026-10-30 优先队列激活时：名单外的票一律不自动派（普通队列走人工）
          if (prioQ.active && !prioQ.ready.includes(String(t.ticket ?? '').toUpperCase())) continue;   // 只派依赖已清的叶子票
          if (!hasTaskDoc(t.ticket)) {
            if (!relayState.needDoc.has(cand.id)) {
              relayState.needDoc.add(cand.id);
              logLine(`[relay] 工号${agent.no} 跳过 ${cand.id}（skipped-needs-doc：缺 state\\tasks\\${t.ticket ?? '?'}.md，不计失败）`);
            }
            continue;
          }
          next = t; pick = cand; break;
        }
        if (!next) continue;   // 这个工号没得挑（或只跳过了缺任务书的），换下一个

        // 演练口（默认关）：state\relay-drill-<票号>.txt 写 N → 该票接下来 N 次故意失败。
        // **按票隔离**（不是全局单例）——否则多人/多票同时演练会互相吃计数（03 的反馈）。
        const drillFile = path.join(WORKSPACE, 'state', 'relay-drill-' + String(next.ticket ?? next.id).replace(/[^A-Za-z0-9_-]/g, '_') + '.txt');
        let drillLeft = 0;
        try { drillLeft = Number(fs.readFileSync(drillFile, 'utf8').trim()) || 0; } catch { drillLeft = 0; }
        if (drillLeft > 0) {
          try { fs.writeFileSync(drillFile, String(drillLeft - 1), 'utf8'); } catch {}
          const e = new Error('演练：故意让这次派发失败'); e.code = 'drill-failure';
          throw e;
        }

        // 真去派：失败（会话不存在/已归档/超时/配额/DSH 不可达）算 dispatch-failed
        const res = await dispatchTask(next.id, { by: 'auto-relay' });
        if (!res.ok) {
          const e = new Error(String(res.detail ?? res.code ?? 'dispatch failed'));
          e.code = res.code || 'dispatch-failed';
          throw e;
        }
        // 成功
        relayState.last = { at: nowMs(), target: agent.no, task: next.id, ticket: next.ticket ?? next.id, ok: true, code: res.code, detail: res.detail };
        logLine(`[relay] 工号${agent.no} 挑 ${next.id}（rank ${pick.rank}：${pick.why}）→ 派：OK`);
        relayState.fails.delete(next.id);   // 成功清零
        dispatched += 1;
      } catch (err) {
        const code = err?.code || 'dispatch-failed';
        if (!next) { logLine(`[relay] 工号${agent.no} 挑票异常（${code}）${String(err?.message ?? err).slice(0, 100)}`); continue; }
        const n = (relayState.fails.get(next.id) ?? 0) + 1;
        relayState.fails.set(next.id, n);
        const msg = String(err?.message ?? err);
        relayState.last = { at: nowMs(), target: agent.no, task: next.id, ticket: next.ticket ?? next.id, ok: false, code, detail: msg };
        logLine(`[relay] 工号${agent.no} 挑 ${next.id}（rank ${pick?.rank ?? '?'}：${pick?.why ?? ''}）→ 派：失败 ${code}（第 ${n} 次）${msg.slice(0, 80)}`);
        if (n >= 3) {
          relayState.skip.add(next.id);
          try {
            postMail('本体', `【接力放弃】${next.ticket ?? next.id}（${next.id}）连续 ${n} 次派不出去。最后一次错误：${code} ${msg.slice(0, 200)}。已停止自动重试。`);
          } catch (e) { logLine(`[relay] 发邮件失败 ${e?.message ?? e}`); }
          logLine(`[relay] ${next.id} 连续失败 ${n} 次 → 停手该票，不再自动挑（邮件已发本体）`);
        } else if (code !== 'drill-failure') {
          // 真实失败退避 60s；演练不退避，让 3 次尽快跑完
          relayState.backoff.set(agent.no, nowMs() + cfg.backoffMs);
        }
      }
      // D75：不 break——继续给下一个空闲工号派
    }
    if (dispatched > 1) logLine(`[relay] 本轮派出 ${dispatched} 件（多工号并行）`);
  } catch (error) {
    logLine(`[relay] 异常 ${error?.message ?? error}`);
  } finally {
    relayState.inFlight = false;
  }
}

// ── 邮件「敲门」（D17）：只有 level=活 的未读才发一次 prompt，敲过写 nudged 防重放 ──
// 普通通知永不唤醒（成本纪律：一次 prompt 就是一轮，钱只花在真急的事上）。
const ALERT_FILE = path.join(WORKSPACE, 'state', 'mail-alerts.json');
// D80：台账锁——只有持锁实例接受演练（避免"第二个实例演练、生产真派"那类事故）
const LOCK_FILE = path.join(WORKSPACE, 'state', 'worklist.lock');
const DRILL_FILE = path.join(WORKSPACE, 'state', 'drill.json');
const LOCK_STALE_MS = 60 * 1000;

/** 抢台账锁：成功 true；被别的活实例占着 false。 */
function acquireWorklistLock() {
  const now = nowMs();
  try {
    const cur = readJsonIo(LOCK_FILE);
    const fresh = now - Number(cur.at ?? 0) < LOCK_STALE_MS;
    // 心跳新鲜 **且** 那个进程真的还活着，才算被别人占着；被杀的旧实例留下的锁要能抢回来
    const alive = (() => { try { process.kill(Number(cur.pid), 0); return true; } catch { return false; } })();
    if (fresh && alive && Number(cur.pid) !== process.pid) return false;
  } catch { /* 没有锁文件 → 可以抢 */ }
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: now }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}
/** 心跳：刷 at；锁被别人抢走就认了。 */
function refreshWorklistLock() {
  try {
    const cur = readJsonIo(LOCK_FILE);
    if (Number(cur.pid) !== process.pid) return false;
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ ...cur, at: nowMs() }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}
function holdsWorklistLock() {
  try {
    const cur = readJsonIo(LOCK_FILE);
    return Number(cur.pid) === process.pid;
  } catch { return false; }
}
function readDrillFile() {
  try {
    const j = readJsonIo(DRILL_FILE);
    if (!j || !j.ticket) return null;
    if (Number(j.until ?? 0) && nowMs() > Number(j.until)) return null;
    if (Number(j.left ?? 0) <= 0) return null;
    return j;
  } catch { return null; }
}
function writeDrill(j) {
  try {
    fs.mkdirSync(path.dirname(DRILL_FILE), { recursive: true });
    fs.writeFileSync(DRILL_FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}
function drillPayload() {
  const j = readDrillFile();
  return j ? { on: true, ticket: j.ticket, times: j.times, left: j.left, count: j.count ?? 0, until: j.until } : { on: false };
}

const NUDGE_FILE = path.join(WORKSPACE, 'state', 'mail-nudged.json');
const nudgeState = { last: null, inFlight: false, ticks: 0, backoff: new Map() };

function nudgeConfig() {
  const cfg = readConfig();
  const n = cfg.nudge ?? {};
  return {
    enabled: n.enabled !== false,
    perDay: Number(n.perDay ?? 10),
    backoffMs: Number(n.backoffMs ?? 60000),
    intervalMs: Number(n.intervalMs ?? 15000),
    // D79：同一封 level=活 敲过后，超过 retryAfterMs 仍未读就再敲，最多 maxTimes 次；未读超阈值告警
    retryAfterMs: Number(n.retryAfterMs ?? 2 * 3600 * 1000),
    maxTimes: Number(n.maxTimes ?? 3),
    alertThreshold: Number(n.alertThreshold ?? 20),
    alertCooldownMs: Number(n.alertCooldownMs ?? 6 * 3600 * 1000)
  };
}
function readNudged() {
  try { return readJsonIo(NUDGE_FILE) ?? {}; } catch { return {}; }
}
function writeNudged(map) {
  try { fs.mkdirSync(path.dirname(NUDGE_FILE), { recursive: true }); fs.writeFileSync(NUDGE_FILE, `${JSON.stringify(map, null, 2)}\n`, 'utf8'); } catch { /* 写不了就不防重放，别崩 */ }
}
function tcpRecord(rec) {
  try { fs.mkdirSync(path.dirname(DISPATCH_LOG), { recursive: true }); fs.appendFileSync(DISPATCH_LOG, `${JSON.stringify(rec)}\n`, 'utf8'); } catch { /* ignore */ }
}
function nudgedToday(nudged) {
  const today = new Date().toLocaleDateString('zh-CN');
  return Object.values(nudged).filter((v) => v?.ok && v.at && new Date(v.at).toLocaleDateString('zh-CN') === today).length;
}
/** 找「邮件收件人」对应的会话：01/00/02… 按标题里的工号；本体/鲟鱼 → 本体会话。 */
function sessionForMailTo(to, agents) {
  const raw = String(to ?? '').trim();
  const no = /^工号\s*([0-9]{2})$/.exec(raw)?.[1] ?? /^0*([0-9]{2})$/.exec(raw)?.[1] ?? null;
  if (no) return agents.find((a) => a.no === no) ?? null;
  if (/本体|鲟鱼/.test(raw)) return agents.find((a) => /鲟鱼—本体|鲟鱼-本体/.test(a.title)) ?? null;
  return null;
}

/**
 * 一轮敲门：最多敲一封（一次只唤醒一个会话）。
 * 条件：level=活 + 未读（seq > 该收件人水位）+ 没敲过 + 目标会话不在跑。
 */
/**
 * D79：未读清点告警。任一工号未读 > 阈值 → 给 00 和 01 各发一封（冷却期内不重复）。
 * 只统计 level=任意 的未读；本体/工号都算。
 */
function maybeAlertUnread(mail, watermarks, cfg) {
  const all = (mail.recent ?? []);
  const byTo = new Map();
  for (const m of all) {
    if (Number(m.seq) <= (watermarks[String(m.to)] ?? 0)) continue;   // 已读
    const k = String(m.to);
    byTo.set(k, (byTo.get(k) ?? 0) + 1);
  }
  let alerted = {};
  try { alerted = readJsonIo(ALERT_FILE) ?? {}; } catch { alerted = {}; }
  let dirty = false;
  for (const [to, n] of byTo) {
    if (n <= cfg.alertThreshold) continue;
    if (nowMs() - Number(alerted[to]?.at ?? 0) < cfg.alertCooldownMs) continue;
    const text = `【未读积压】工号 ${to} 有 ${n} 条未读（阈值 ${cfg.alertThreshold}）。可能是长期不读或提醒失效，请安排人清一下：node scripts\\mail.mjs digest --as ${to}`;
    const s1 = postMail('00', text);
    const s2 = postMail('01', text);
    alerted[to] = { at: nowMs(), unread: n, mailSeq: [s1, s2] };
    dirty = true;
    logLine(`[nudge] 未读告警：${to} 有 ${n} 条未读（邮件 ${s1}/${s2}）`);
  }
  if (dirty) { try { fs.writeFileSync(ALERT_FILE, `${JSON.stringify(alerted, null, 2)}\n`, 'utf8'); } catch { /* ignore */ } }
}

async function nudgeTick({ dry = false } = {}) {
  nudgeState.ticks += 1;
  const cfg = nudgeConfig();
  if (!cfg.enabled && !dry) return { ok: true, skipped: 'disabled', candidates: [] };
  if (nudgeState.inFlight && !dry) return { ok: true, skipped: 'inflight' };

  const sessions = await listSessions({ force: true });
  if (sessions.error) return { ok: false, error: sessions.error, candidates: [] };
  const agents = agentRows(sessions.items, nowMs());
  const mail = mailState();
  const watermarks = mail.watermarks ?? {};
  const nudged = readNudged();
  // D79：任一工号未读超过阈值 → 告警给 00 和 01（同一工号 6 小时内只报一次）
  try { maybeAlertUnread(mail, watermarks, cfg); } catch (e) { logLine(`[nudge] 未读告警失败：${e?.message ?? e}`); }

  const candidates = (mail.recent ?? [])
    .filter((m) => String(m.level) === '活')
    // D79：以前是"敲过就永不再敲"，于是对方没读就永久沉默；现在按过期时间重敲，最多 maxTimes 次
    .filter((m) => {
      const rec = nudged[String(m.seq)];
      if (!rec) return true;                                   // 没敲过 → 敲
      if (Number(rec.count ?? 1) >= cfg.maxTimes) return false; // 敲满 3 次 → 不再逐封敲（转日报摘要）
      return (nowMs() - Number(rec.at ?? 0)) >= cfg.retryAfterMs; // 超过有效期还没读 → 再敲
    })
    .filter((m) => Number(m.seq) > (watermarks[String(m.to)] ?? 0)) // 还是未读
    .map((m) => {
      const agent = sessionForMailTo(m.to, agents);
      return {
        seq: m.seq, to: m.to, from: m.from, excerpt: m.excerpt,
        sessionId: agent?.id ?? null, title: agent?.title ?? null,
        running: Boolean(agent?.running || agent?.live)
      };
    });
  const knockable = candidates.filter((c) => c.sessionId && !c.running);
  if (dry) return { ok: true, dry: true, candidates, knockable, nudged: Object.keys(nudged).length, quota: { used: nudgedToday(nudged), limit: cfg.perDay } };
  if (!knockable.length) return { ok: true, candidates, knocked: null };
  if (nudgedToday(nudged) >= cfg.perDay) return { ok: true, candidates, skipped: 'quota', quota: { used: nudgedToday(nudged), limit: cfg.perDay } };

  const pick = knockable[0];
  const backoffKey = String(pick.seq);
  if ((nudgeState.backoff.get(backoffKey) ?? 0) > nowMs()) return { ok: true, candidates, skipped: 'backoff' };

  nudgeState.inFlight = true;
  try {
    const { api } = await getRpc();
    const text = `【邮件 level=活】#${pick.seq} 来自 ${pick.from}，你有一封未读的「活」邮件：\n${String(pick.excerpt ?? '').slice(0, 160)}\n（读全文：node scripts\\mail.mjs read --as ${pick.to}）`;
    const startedAt = nowMs();
    try {
      await api.sessions.prompt({ sessionId: pick.sessionId, mode: 'queue', content: [{ type: 'text', text }] });
      const prevRec = nudged[backoffKey] ?? {};
      nudged[backoffKey] = { at: startedAt, ok: true, to: pick.to, sessionId: pick.sessionId, seq: pick.seq, count: Number(prevRec.count ?? 0) + 1 };
      writeNudged(nudged);
      tcpRecord({ t: startedAt, op: 'nudge', by: 'workdesk', seq: pick.seq, to: pick.to, sessionId: pick.sessionId, promptChars: text.length, ok: true, status: 200, code: 'nudged', detail: 'level=活 未读，敲一次', ms: nowMs() - startedAt });
      nudgeState.last = { at: startedAt, seq: pick.seq, to: pick.to, ok: true };
      logLine(`[nudge] #${pick.seq} → ${pick.to}（${pick.sessionId}）第 ${nudged[backoffKey].count} 次敲`);
    } catch (error) {
      nudgeState.backoff.set(backoffKey, nowMs() + cfg.backoffMs);
      tcpRecord({ t: startedAt, op: 'nudge', by: 'workdesk', seq: pick.seq, to: pick.to, sessionId: pick.sessionId, ok: false, status: 502, code: 'prompt-failed', detail: String(error?.message ?? error).slice(0, 160) });
      nudgeState.last = { at: startedAt, seq: pick.seq, to: pick.to, ok: false };
      logLine(`[nudge] #${pick.seq} → ${pick.to} 失败：${error?.message ?? error}`);
    }
    return { ok: true, candidates, knocked: pick };
  } finally {
    nudgeState.inFlight = false;
  }
}

// ── D30：解锁巡检（前置完成后，把挡着的单放出来并通知目标工号）──
function sweepUnlocks() {
  const unlocked = [];
  try {
    for (const t of pendingUnlocks()) {
      const deps = (t.blockedBy ?? []).join('、');
      markUnblocked(t.id, { from: 'workdesk', note: '前置 ' + deps + ' 已完成，自动解锁' });
      const seq = t.target
        ? postMail(String(t.target), '【解锁】' + (t.ticket ?? t.id) + '「' + t.title + '」的前置 ' + deps + ' 已完成，现在可以派了。')
        : null;
      logLine('[unlock] ' + t.id + ' 解锁（邮件 seq=' + seq + '）');
      unlocked.push({ id: t.id, mailSeq: seq });
    }
  } catch (e) {
    logLine('[unlock] 异常 ' + (e?.message ?? e));
  }
  return unlocked;
}

// ── 邮件（发信给 01 / 工号）────────────────────────────────────────────────
function postMail(to, body, level = '通知') {
  try {
    const rows = readText(MAIL_FILE).split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const seq = (rows.length ? rows[rows.length - 1].seq : 0) + 1;
    fs.mkdirSync(MAIL_BOX, { recursive: true });
    fs.appendFileSync(MAIL_FILE, `${JSON.stringify({ seq, t: nowMs(), from: 'workdesk', to, level, body })}\n`, 'utf8');
    return seq;
  } catch { return null; }
}

// ── DSH 投影（只读）────────────────────────────────────────────────────────
let rpc = null, rpcError = '', rpcClosed = false;
async function getRpc() {
  if (rpc && !rpcClosed) return rpc;
  try {
    const [{ NodeApiClient }, { resolveDshBase }] = await Promise.all([import(DSH_CLIENT), import(DSH_BASE_MOD)]);
    const { url, source } = resolveDshBase();
    const api = new NodeApiClient(url, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });
    rpc = { NodeApiClient, api, url, source };
    rpcError = ''; rpcClosed = false;
    return rpc;
  } catch (error) {
    rpc = null; rpcError = String(error?.message ?? error).split('\n')[0];
    throw new Error(rpcError);
  }
}

function archivedIds() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const ws = readJson(path.join(home, '.dsh', 'storages', 'workspace.json'), {});
  return new Set(((ws?.global?.archivedSessionIds ?? ws?.archivedSessionIds ?? []) ?? []).map(String));
}

let cache = { at: 0, items: null, error: '' };
let inflight = null;
async function listSessions({ force = false } = {}) {
  const t = nowMs();
  if (!force && cache.items && t - cache.at < AGENTS_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { api } = await getRpc();
      const client = await import(DSH_CLIENT);
      const result = await Promise.race([
        api.sessions.list({}),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`sessions/list 超时 ${RPC_TIMEOUT_MS}ms`)), RPC_TIMEOUT_MS))
      ]);
      cache = { at: nowMs(), items: client.unwrap(result, 'session.list').items ?? [], error: '' };
      rpcClosed = false;
      return cache;
    } catch (error) {
      rpcClosed = true;
      cache = { ...cache, error: String(error?.message ?? error) };
      return cache;
    } finally { inflight = null; }
  })();
  return inflight;
}

function agentRows(items, at) {
  const archived = archivedIds();
  return (items ?? [])
    .filter((s) => !s.blank)
    .filter((s) => !archived.has(String(s.sessionId)))
    .map((s) => {
      const v = s.projections?.values ?? {};
      const wa = v.workingActivity ?? {};
      const outline = Array.isArray(v.turnOutline) ? v.turnOutline : [];
      const lastTurn = outline.length ? outline[outline.length - 1] : null;
      const updatedAt = Number(s.updatedAt ?? 0) || null;
      const waAt = Number(wa.updatedAt ?? 0) || null;
      const stamp = wa.live ? (waAt ?? updatedAt) : (updatedAt ?? waAt);
      const title = v.title ?? '(无标题)';
      const no = /工号\s*([0-9]{2})/.exec(title);
      return {
        id: String(s.sessionId),
        short: String(s.sessionId).replace(/^session-/, '').slice(0, 8),
        title,
        no: no ? no[1] : null,
        running: Boolean(s.running),
        live: Boolean(wa.live),
        phase: wa.phase ?? null,
        doingText: wa.line ?? null,
        toolCount: Number(wa.toolCount ?? 0),
        idleMs: stamp ? at - stamp : null,
        idleText: stamp ? fmtAge(at - stamp) : null,
        lastPrompt: lastTurn ? clip(lastTurn.prompt, 90) : null,
        lastResponse: lastTurn ? clip(lastTurn.response, 90) : null,
        tokens: Number(v.contextPressure?.pressureTokens ?? 0) || 0
      };
    })
    .sort((a, b) => Number(b.live) - Number(a.live) || Number(b.running) - Number(a.running) || (a.idleMs ?? 0) - (b.idleMs ?? 0));
}

// ── 会话检测（W-028 / D26，06）：只读，把「名册 ↔ 投影 ↔ 台账」三边对一遍 ──────
// 为什么要有它：名册 00 维护、投影 DSH 给、台账 04 维护，三边随时会各走各的——
// 归档了没同步名册、改了标题没同步、上下文到换代线没人提醒、queued 派给了名册里没有的工号。
// 这里只**观察**，不写任何文件、不派任何活。
const ROSTER_FILE = path.join(WORKSPACE, 'state', 'roster.json');
const BUDGET_FILE = path.join(WORKSPACE, 'state', 'context-budget.json');
const HEALTH_STALE_MS = Number(process.env.WORKDESK_STALE_MS ?? 30 * 60 * 1000);  // 标着在跑却 30 分钟没动静＝僵住

function readRoster() {
  const j = readJson(ROSTER_FILE, null);
  return j && Array.isArray(j.active) ? j : null;
}
function budgetRules() {
  const j = readJson(BUDGET_FILE, null);
  return {
    default: { warn: Number(j?.default?.warn ?? 800000), handoff: Number(j?.default?.handoff ?? 950000) },
    rules: Array.isArray(j?.rules) ? j.rules.filter((r) => r && r.title) : []
  };
}
function budgetFor(title, budget) {
  const text = String(title ?? '');
  const hit = budget.rules.find((r) => text.includes(String(r.title)));
  const b = hit ? { warn: Number(hit.warn), handoff: Number(hit.handoff), rule: String(hit.title) } : { ...budget.default, rule: '(默认)' };
  return { warn: b.warn || 800000, handoff: b.handoff || 950000, rule: b.rule };
}
function pressureOf(tokens, b) {
  if (tokens >= b.handoff) return 'handoff';
  if (tokens >= b.warn) return 'warn';
  return 'ok';
}

/**
 * 会话检测：名册（00 的 roster.json）× DSH 投影（sessions/list）× 台账（worklist 回放）。
 * 返回 checks（人看的结论）+ sessions/roster/brokenQueue（自查用的原始行）。
 */
function sessionHealth(sessions) {
  const at = nowMs();
  const archived = archivedIds();
  const items = (sessions.items ?? []).filter((s) => !s.blank && !archived.has(String(s.sessionId)));
  const roster = readRoster();
  const budget = budgetRules();

  const rows = items.map((s) => {
    const v = s.projections?.values ?? {};
    const wa = v.workingActivity ?? {};
    const outline = Array.isArray(v.turnOutline) ? v.turnOutline : [];
    const lastTurn = outline.length ? outline[outline.length - 1] : null;
    const updatedAt = Number(s.updatedAt ?? 0) || null;
    const waAt = Number(wa.updatedAt ?? 0) || null;
    const stamp = wa.live ? (waAt ?? updatedAt) : (updatedAt ?? waAt);
    const title = v.title ?? '(无标题)';
    const no = /工号\s*([0-9]{2})/.exec(title)?.[1] ?? null;
    const tokens = Number(v.contextPressure?.pressureTokens ?? 0) || 0;
    const b = budgetFor(title, budget);
    return {
      id: String(s.sessionId),
      short: String(s.sessionId).replace(/^session-/, '').slice(0, 8),
      title, no,
      live: Boolean(wa.live), running: Boolean(s.running),
      idleMs: stamp ? at - stamp : null,
      idleText: stamp ? fmtAge(at - stamp) : null,
      doingText: wa.line ? clip(wa.line, 80) : null,
      tokens, pressure: pressureOf(tokens, b), warnAt: b.warn, handoffAt: b.handoff, budgetRule: b.rule,
      archived: archived.has(String(s.sessionId)),
      stale: Boolean(s.running || wa.live) && stamp ? at - stamp > HEALTH_STALE_MS : false,
      lastPrompt: lastTurn ? clip(lastTurn.prompt, 70) : null,
      inRoster: false
    };
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // 名册侧：在位工号的 sessionId 在投影里还在不在、标题对不对、上下文到哪一档
  const rosterRows = ((roster?.active) ?? []).map((r) => {
    const sid = String(r.sessionId ?? '');
    const s = byId.get(sid) ?? null;
    const archivedHit = archived.has(sid);
    return {
      id: String(r.id ?? ''), title: String(r.title ?? ''),
      sessionId: sid, short: sid.replace(/^session-/, '').slice(0, 8),
      present: Boolean(s), archived: archivedHit,
      actualTitle: s?.title ?? null,
      titleMismatch: Boolean(s) && String(s.title ?? '') !== String(r.title ?? ''),
      tokens: s?.tokens ?? 0, pressure: s?.pressure ?? 'ok',
      warnAt: s?.warnAt ?? 0, handoffAt: s?.handoffAt ?? 0,
      idleText: s?.idleText ?? null, live: Boolean(s?.live), running: Boolean(s?.running),
      lastActive: r.lastActive ?? null,
      problem: s ? null : (archivedHit ? '已归档但仍在名册（换代未同步）' : '投影里找不到这个会话（断链）')
    };
  });
  for (const rr of rosterRows) { const s = byId.get(rr.sessionId); if (s) s.inRoster = true; }

  // 台账侧：queued 但投影里找不到这个工号 = 派不出去（判断用投影，不用名册：派单本来就按投影的工号挑）
  const brokenQueue = [];
  try {
    for (const t of replayWorklist()) {
      if (t.state !== 'queued' || !t.target) continue;
      const target = String(t.target);
      const live = rows.find((r) => r.no === target && !r.archived);
      if (!live) {
        brokenQueue.push({ id: t.id, ticket: t.ticket ?? t.id, title: clip(t.title, 60), target, reason: '投影里没有这个工号的活会话（可能已归档或没建）' });
      }
    }
  } catch (error) { brokenQueue.push({ id: '?', reason: `台账回放失败：${error?.message ?? error}` }); }

  // 检测项：一条一句人话，level 只取 ok/warn/bad
  const checks = [];
  const add = (id, level, title, detail) => checks.push({ id, level, title, detail });
  const rosterBroken = rosterRows.filter((r) => r.problem);
  const overHandoff = rows.filter((r) => r.pressure === 'handoff');
  const overWarn = rows.filter((r) => r.pressure === 'warn');
  const stale = rows.filter((r) => r.stale);
  const orphans = rows.filter((r) => r.no && !r.inRoster && !r.archived);
  const tag = (r) => (r.no ? `工号${r.no}` : r.short);
  const maxTokens = rows.reduce((m, r) => Math.max(m, r.tokens), 0);

  add('projection', sessions.error ? 'bad' : 'ok', 'DSH 投影',
    sessions.error ? `读不到：${sessions.error}` : `可读，${rows.length} 个会话（采样缓存 ${sessions.at ? fmtAge(at - sessions.at) : '—'} 前）`);
  add('roster', !roster ? 'warn' : rosterBroken.length ? 'bad' : 'ok', '名册 ↔ 投影',
    !roster ? 'roster.json 读不到，这一项没查'
      : rosterBroken.length ? `${rosterBroken.length}/${rosterRows.length} 个在位工号对不上：${rosterBroken.map((r) => `${tag(r)} ${r.short}（${r.problem}）`).join('；')}`
        : `${rosterRows.length} 个在位工号全部对得上`);
  add('pressure', overHandoff.length ? 'bad' : overWarn.length ? 'warn' : 'ok', '上下文水位',
    overHandoff.length || overWarn.length
      ? [overHandoff.length ? `已过换代线 ${overHandoff.map((r) => `${tag(r)} ${r.tokens}`).join('、')}` : '', overWarn.length ? `过提醒线 ${overWarn.map((r) => `${tag(r)} ${r.tokens}`).join('、')}` : ''].filter(Boolean).join('；')
      : `全在提醒线以下（最高 ${maxTokens}）`);
  add('stale', stale.length ? 'warn' : 'ok', '僵住检测',
    stale.length ? `${stale.length} 个会话标着在跑但 ${fmtAge(HEALTH_STALE_MS)} 没动静：${stale.map((r) => r.short).join('、')}`
      : `${fmtAge(HEALTH_STALE_MS)} 内没有「在跑却没动静」的会话`);
  add('queue', brokenQueue.length ? 'bad' : 'ok', '台账可派性',
    brokenQueue.length ? `${brokenQueue.length} 条 queued 派不出去：${brokenQueue.map((b) => `${b.ticket}→工号${b.target}（${b.reason}）`).join('；')}`
      : '排队中的活目标都健在');
  add('orphan', orphans.length ? 'warn' : 'ok', '名册外会话',
    orphans.length ? `${orphans.length} 个工号会话不在名册里：${orphans.map((r) => `工号${r.no} ${r.short}`).join('、')}（名册归 00，检测只报不修）`
      : '没有游离的工号会话');

  const rank = { bad: 2, warn: 1, ok: 0 };
  const verdict = checks.reduce((m, c) => (rank[c.level] > rank[m] ? c.level : m), 'ok');
  return {
    ok: !sessions.error, tool: 'workdesk', version: VERSION, at: iso(at), ts: at,
    dsh: { error: sessions.error || null, url: rpc?.url ?? null, cacheAgeMs: sessions.at ? at - sessions.at : null },
    summary: {
      verdict, total: rows.length, live: rows.filter((r) => r.live).length, running: rows.filter((r) => r.running).length,
      rosterActive: rosterRows.length, rosterBroken: rosterBroken.length,
      overWarn: overWarn.length, overHandoff: overHandoff.length,
      stale: stale.length, brokenQueue: brokenQueue.length, orphans: orphans.length
    },
    checks, sessions: rows, roster: rosterRows, brokenQueue, orphans
  };
}

// ── 归属分桶 + 人话名（W-030 / D26b，06）：今日花费按四桶汇总，与 token-report 对账 ──
// 归属来源优先级：① state\attribution.json（00 的机读归属表；**尚未交付**，到了自动用）
//                 ② 内建映射：workspace.json 的 path + 标题里的「工号 / QQ / 子实体 / 黑话 / 本体」，
//                    口径同 records\会话归属表.md 第一节。
// 花费口径必须与 scripts\token-report.mjs 一致：按 (sid, turn) 收敛，cacheHit 取 max，其余相加。
// 对不上就说明我复刻错了 —— 面板上直接显示对账差值，不藏。
const USAGE_LEDGER = 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\state\\token-usage.jsonl';
const PRICES_MOD = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/model-prices.js';
const ATTRIB_FILE = path.join(WORKSPACE, 'state', 'attribution.json');
const TOKEN_REPORT = path.join(WORKSPACE, 'scripts', 'token-report.mjs');
const BUCKETS = [
  { id: 'workgroup', label: '工作组' },
  { id: 'benti', label: '本体' },
  { id: 'qq', label: 'QQ 通道' },
  { id: 'other', label: '其他' }
];

let pricesMod = null;
async function getPrices() { pricesMod ??= await import(PRICES_MOD); return pricesMod; }

let wsIndexCache = { at: 0, map: null };
function workspaceIndex() {
  const t = nowMs();
  if (wsIndexCache.map && t - wsIndexCache.at < 60000) return wsIndexCache.map;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const ws = readJson(path.join(home, '.dsh', 'storages', 'workspace.json'), {});
  const map = new Map();
  for (const [wid, w] of Object.entries(ws?.tables?.workspaces ?? {})) {
    for (const sid of (w?.sessionIds ?? [])) map.set(String(sid), { id: wid, path: String(w?.path ?? ''), title: String(w?.title ?? '') });
  }
  wsIndexCache = { at: t, map };
  return map;
}

/** 四桶归属：标题先于路径（「鲟鱼QQ」物理在 Xunyu，但归 QQ 通道）。 */
function bucketFor(title, wsPath) {
  const text = String(title ?? '');
  if (/工号\s*[0-9]{2}/.test(text)) return 'workgroup';
  if (/子实体|黑话|QQ/i.test(text)) return 'qq';
  if (/本体/.test(text)) return 'benti';
  const p = String(wsPath ?? '');
  if (/DSH_workspace$/i.test(p)) return 'workgroup';
  if (/DeepFish[\\/]Xunyu$/i.test(p)) return 'benti';
  if (/qq-bridge|DeepFish-sub|slang-/i.test(p)) return 'qq';
  return 'other';
}
function shortTitle(t) {
  const s = String(t ?? '').replace(/^鲟鱼工作组/, '').replace(/^鲟鱼[—-]/, '').trim();
  return s || String(t ?? '');
}

// 今日用量：**走 cost-core 的唯一计价函数**（D44：k=base 会话快照不进金额，重复行去重）
let usageCache = { at: 0, day: null, data: null };
async function usageToday(day, { force = false } = {}) {
  if (!force && usageCache.data && usageCache.day === day && nowMs() - usageCache.at < 60000) return usageCache.data;
  try {
    const start = dayStartOf(day);
    const rep = collectCost({ from: start, to: start + 86400000 - 1, by: 'session' });
    const bySid = new Map();
    for (const s of rep.sessions) {
      bySid.set(s.sid, {
        sid: s.sid, model: '', turns: s.turns, hit: s.hit, miss: s.miss, write: s.write, out: s.out,
        tokens: s.hit + s.miss + s.write + s.out, cost: s.cost
      });
    }
    usageCache = {
      at: nowMs(), day,
      data: {
        ok: true, day,
        totalCost: rep.totals.cost,
        totalTokens: rep.totals.hit + rep.totals.miss + rep.totals.write + rep.totals.out,
        turns: rep.totals.turns,
        bySid
      }
    };
    return usageCache.data;
  } catch (error) {
    return { ok: false, day, error: `读账本失败：${String(error?.message ?? error).slice(0, 120)}`, totalCost: 0, totalTokens: 0, turns: 0, bySid: new Map() };
  }
}

// 对账：真跑一次 token-report.mjs，把「合计 ¥x」抓回来（120s 缓存；只读，不花钱）
let reconCache = { at: 0, day: null, value: null };
async function tokenReportTotal(day, { force = false } = {}) {
  if (!force && reconCache.value && reconCache.day === day && nowMs() - reconCache.at < 120000) return reconCache.value;
  try {
    const { stdout } = await promisify(execFileCb)(process.execPath, [TOKEN_REPORT, '--day', day], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    const m = /合计[^¥]*¥\s*([0-9]+(?:\.[0-9]+)?)/.exec(String(stdout));
    reconCache = { at: nowMs(), day, value: { ok: Boolean(m), report: m ? Number(m[1]) : null, error: m ? null : '没抓到「合计」行' } };
  } catch (error) {
    reconCache = { at: nowMs(), day, value: { ok: false, report: null, error: String(error?.message ?? error).split('\n')[0].slice(0, 160) } };
  }
  return reconCache.value;
}

/**
 * 归属分桶：今日花费 → 四桶 → 桶下按「工号 / 会话」下钻。
 * 人话名优先级：名册标题 > 投影标题 > 「未登记 · 8位id」——**任何一行都不许裸 id 当名字**。
 */
async function attributionState(health, { reconcile = false } = {}) {
  const prices = await getPrices();
  const day = prices.beijingParts(nowMs()).date;
  const usage = await usageToday(day);
  if (!usage.ok) return { ok: false, day, error: usage.error };

  const attrib = readJson(ATTRIB_FILE, null);
  const source = attrib ? 'state\\attribution.json（00 交付）' : '内建映射（workspace.json + 标题；attribution.json 未交付）';
  const wsIdx = workspaceIndex();
  const roster = readRoster();
  // 名册的 history 也收：换代归档掉的旧会话（今天的钱记在它们名下）靠它才认得回工号
  const rosterBySid = new Map();
  for (const r of [...((roster?.active) ?? []), ...((roster?.history) ?? [])]) {
    if (r?.sessionId && r?.title) rosterBySid.set(String(r.sessionId), r);
  }
  const rosterByNo = new Map(((roster?.active) ?? []).map((r) => [String(r.id), r]));
  const titleBySid = new Map((health.sessions ?? []).map((r) => [r.id, r.title]));

  const info = new Map();
  for (const sid of usage.bySid.keys()) {
    const ws = wsIdx.get(sid);
    const title = titleBySid.get(sid) ?? rosterBySid.get(sid)?.title ?? (ws?.title ?? '');
    const bucket = attrib?.sessions?.[sid]?.bucket ?? bucketFor(title, ws?.path);
    const no = /工号\s*([0-9]{2})/.exec(String(title ?? ''))?.[1] ?? null;
    let unitLabel;
    if (bucket === 'workgroup') {
      const r = no ? rosterByNo.get(no) : null;
      unitLabel = r ? shortTitle(r.title) : (no ? `工号${no}` : `未标工号 · ${sid.replace(/^session-/, '').slice(0, 8)}`);
    } else {
      unitLabel = shortTitle(String(title || `未登记 · ${sid.replace(/^session-/, '').slice(0, 8)}`));
    }
    info.set(sid, { bucket, unitLabel, title, no });
  }

  const buckets = BUCKETS.map((b) => ({ id: b.id, label: b.label, cost: 0, tokens: 0, sessions: 0, units: new Map() }));
  const byId = new Map(buckets.map((b) => [b.id, b]));
  for (const [sid, u] of usage.bySid.entries()) {
    const i = info.get(sid) ?? { bucket: 'other', unitLabel: `未登记 · ${sid.replace(/^session-/, '').slice(0, 8)}` };
    const b = byId.get(i.bucket) ?? byId.get('other');
    const unit = b.units.get(i.unitLabel) ?? { label: i.unitLabel, sessions: 0, cost: 0, tokens: 0, hit: 0, miss: 0, turns: 0 };
    unit.sessions += 1; unit.cost += u.cost; unit.tokens += u.tokens; unit.hit += u.hit; unit.miss += u.miss; unit.turns += u.turns;
    b.units.set(i.unitLabel, unit);
    b.cost += u.cost; b.tokens += u.tokens; b.sessions += 1;
  }
  const total = usage.totalCost;
  const out = buckets.map((b) => ({
    id: b.id, label: b.label, cost: b.cost, tokens: b.tokens, sessions: b.sessions,
    share: total ? b.cost / total : 0,
    units: [...b.units.values()].sort((x, y) => y.cost - x.cost).map((u) => ({
      label: u.label, sessions: u.sessions, cost: u.cost, tokens: u.tokens, turns: u.turns,
      hitRate: u.hit + u.miss ? u.hit / (u.hit + u.miss) : null
    }))
  }));

  // 当前在跑：命中率单列（W-030 第 ④ 条）
  const liveNow = (health.sessions ?? []).filter((r) => r.live || r.running).map((r) => {
    const u = usage.bySid.get(r.id);
    return {
      label: shortTitle(r.title), sid: r.id.replace(/^session-/, '').slice(0, 8),
      live: Boolean(r.live), running: Boolean(r.running), covered: Boolean(u),
      cost: u?.cost ?? null, turns: u?.turns ?? null,
      hitRate: u && u.hit + u.miss ? u.hit / (u.hit + u.miss) : null
    };
  });

  // 账本盲区：投影里有、桥接账本没记的会话。bridge 只订阅它 watch 的会话，
  // 新设工号（今天 05/06）不在订阅里 → 它们的花费根本进不了账本。数字偏低必须显式说，不能藏。
  const uncovered = (health.sessions ?? [])
    .filter((r) => !usage.bySid.has(r.id))
    .map((r) => ({ label: shortTitle(r.title), tokens: r.tokens, no: r.no ? String(r.no) : null }))
    .filter((r) => r.label);

  let recon = null;
  const wantRecon = reconcile || Boolean(reconCache.value && reconCache.day === day && nowMs() - reconCache.at < 120000);
  if (wantRecon) {
    const r = await tokenReportTotal(day);
    const diffPct = r.ok && r.report ? Math.abs(total - r.report) / r.report * 100 : null;
    recon = { ok: r.ok, report: r.report, diffPct, within2pct: diffPct != null && diffPct < 2, error: r.error ?? null, at: iso(nowMs()) };
  }

  return {
    ok: true, day, source,
    total: { cost: total, tokens: usage.totalTokens, turns: usage.turns, sessions: usage.bySid.size },
    buckets: out,
    current: { count: liveNow.length, rows: liveNow },
    uncovered,
    reconcile: recon
  };
}

// ── 老接口：tasks（state\tasks 里没对应交付的活）────────────────────────────
const TICKET_RE = /[A-Z]{1,3}\d{1,3}/g;
function deliveredTickets() {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(DELIVERY_DIR).filter((f) => f.endsWith('.md')); } catch { return map; }
  for (const name of files) for (const token of (String(name).match(TICKET_RE) ?? [])) {
    if (!map.has(token)) map.set(token, []);
    map.get(token).push(name);
  }
  return map;
}
function parseTask(file) {
  const text = readText(path.join(TASKS_DIR, file));
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const head = (lines.find((l) => /^#\s*/.test(l)) ?? '').replace(/^#\s*/, '').trim();
  const idMatch = /工单\s*([A-Z]{1,3}\d{1,3})/i.exec(head) ?? /^([A-Z]{1,3}\d{1,3})/i.exec(head);
  const id = idMatch ? idMatch[1].toUpperCase() : (file.match(/[A-Z]{1,3}\d{1,3}/i)?.[0] ?? file.replace(/\.md$/, '')).toUpperCase();
  const title = head
    .replace(/^工单\s*[A-Z]{1,3}\d{1,3}(-v\d+(\.\d+)?)?\s*[·:：-]?\s*/i, '')
    .replace(/^[A-Z]{1,3}\d{1,3}(-v\d+(\.\d+)?)?\s*[·:：-]?\s*/i, '')
    .replace(/^v\d+(\.\d+)?\s*[·:：-]?\s*/i, '')
    .replace(/（[^）]*）\s*$/, '')
    .trim() || file.replace(/\.md$/, '');
  const stampLine = lines.slice(0, 8).find((l) => /派单/.test(l)) ?? lines.slice(0, 8).find((l) => /20\d\d-\d\d-\d\d\s+\d\d:\d\d/.test(l)) ?? '';
  const stampMatch = /(20\d\d-\d\d-\d\d)[\sT]+(\d\d:\d\d)/.exec(stampLine);
  let assignedAt = stampMatch ? `${stampMatch[1]} ${stampMatch[2]}` : null;
  let assignedAtSource = stampMatch ? 'task' : null;
  if (!assignedAt) {
    try {
      const st = fs.statSync(path.join(TASKS_DIR, file));
      const d = new Date(st.mtimeMs);
      const p = (n) => String(n).padStart(2, '0');
      assignedAt = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      assignedAtSource = 'file-mtime';
    } catch { /* 读不到就留空 */ }
  }
  let target = null;
  const t1 = /（?派\s*([0-9]{2})/.exec(head) ?? /（?派\s*([0-9]{2})/.exec(text.slice(0, 400));
  if (t1) target = t1[1];
  if (!target) { const t2 = /（([0-9]{2})·[^）]{1,10}）/.exec(text.slice(0, 600)); if (t2) target = t2[1]; }
  if (!target) { const t3 = /records[\\/]交付[\\/]([0-9]{2})-/.exec(text.slice(0, 1200)); if (t3) target = t3[1]; }
  let mtime = null;
  try { mtime = fs.statSync(path.join(TASKS_DIR, file)).mtime.toISOString(); } catch { /* ignore */ }
  return { id, file, title: clip(title, 60), assignedAt, assignedAtSource, target, mtime };
}
function taskList() {
  let files = [];
  try { files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.md')); } catch { return []; }
  const delivered = deliveredTickets();
  const parsed = files.map(parseTask).filter(Boolean);
  const byId = new Map();
  for (const task of parsed) {
    const prev = byId.get(task.id);
    if (!prev || String(task.mtime ?? '') > String(prev.mtime ?? '')) {
      if (prev) task.alsoIn = [...(prev.alsoIn ?? []), prev.file];
      byId.set(task.id, task);
    } else prev.alsoIn = [...(prev.alsoIn ?? []), task.file];
  }
  return [...byId.values()]
    .map((task) => ({ ...task, deliveredBy: delivered.get(task.id) ?? [], done: (delivered.get(task.id) ?? []).length > 0 }))
    .sort((a, b) => String(b.assignedAt ?? '').localeCompare(String(a.assignedAt ?? '')));
}
function recentDeliveries(limit = 5) {
  try {
    return fs.readdirSync(DELIVERY_DIR).filter((f) => f.endsWith('.md'))
      .map((f) => { const st = fs.statSync(path.join(DELIVERY_DIR, f)); return { name: f, bytes: st.size, mtime: st.mtimeMs, at: new Date(st.mtimeMs).toISOString() }; })
      .sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  } catch { return []; }
}

// ── 交付扫描（D12 §四，每 10 秒，零 token）─────────────────────────────────
// D77 之后单号带横线（WS-004 / WG-012 / UG-005），原来只允许 [A-Za-z0-9_] ⇒ 新格式交付永远认不到（UG-005 实测）
const DELIVERY_RE = /^([0-9]{2})-([0-9]{8})-([A-Za-z0-9_-]+)\.md$/;
const seenDeliveries = new Map();   // 文件名 → {size, mtime}
const unlinked = new Map();         // 文件名 → {name, reason, at}
const claimed = [];                 // 最近认领记录（给页面看）
const badDeliveries = new Map();    // D57：预检不合格的交付（不进待验收）
export const __badCount = () => badDeliveries.size;

function scanDeliveries({ prime = false } = {}) {
  let files = [];
  try { files = fs.readdirSync(DELIVERY_DIR).filter((f) => f.endsWith('.md')); } catch { return; }
  const tasks = replayWorklist();

  // 文件被删掉 → unlinked / seen 里那条也要消失（工单 §四.1「删掉后恢复正常」）
  const present = new Set(files);
  for (const name of [...unlinked.keys()]) if (!present.has(name)) unlinked.delete(name);
  for (const name of [...badDeliveries.keys()]) if (!present.has(name)) badDeliveries.delete(name);   // D70：文件删了，bad 也要消失
  for (const name of [...seenDeliveries.keys()]) if (!present.has(name)) seenDeliveries.delete(name);

  for (const name of files) {
    let st;
    try { st = fs.statSync(path.join(DELIVERY_DIR, name)); } catch { continue; }
    const prev = seenDeliveries.get(name);
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;   // 没变，跳过
    seenDeliveries.set(name, { size: st.size, mtime: st.mtimeMs });

    const m = DELIVERY_RE.exec(name);
    if (!m) {
      // 启动那轮静默：README.md 这类历史文件不该在重启时炸黄条
      if (prime) continue;
      // 历史文件名（如 04-20261028-D8v01.md）也算「解析不出结构」，但只在它是新文件时提示
      unlinked.set(name, { name, reason: '文件名不是 <工号>-<YYYYMMDD>-<单号>.md', at: nowMs() });
      continue;
    }
    const [, agent, date, ticket] = m;
    // 工单 §二.2 口径：单号相等**或标题含该单号**，且 target=该工号，且状态 doing|queued。
    // 注意：标题匹配必须**按词边界**，否则「D11」会命中「D11R」「D11T」——2026-10-28 实测踩到：
    // 04-20261028-D11.md 被 D11R 那张单抢走了。所以先全等匹配，再按词边界退到标题包含。
    const norm = ticket.toUpperCase();
    const esc = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenRe = new RegExp(`(^|[^A-Za-z0-9])${esc}(?![A-Za-z0-9])`);
    const openStates = (t) => t.state === 'doing' || t.state === 'queued';
    const byTicket = tasks.filter((t) => String(t.ticket ?? '').toUpperCase() === norm && openStates(t));
    const byTitle = tasks.filter((t) => tokenRe.test(String(t.title ?? '').toUpperCase()) && openStates(t));
    const rank = (list) => list.slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const pick = rank(byTicket).find((t) => String(t.target ?? '') === String(agent))
      ?? rank(byTitle).find((t) => String(t.target ?? '') === String(agent))
      ?? null;
    const candidates = byTicket.length ? byTicket : byTitle;

    if (!pick) {
      // 启动那轮只登记、不报 unlinked（历史文件不该炸黄条），但**该认领的照认领**：
      // 否则「进程重启窗口期交的单」会被 prime 标成已见、之后永远不认领（2026-10-28 实测：D20 被吞）。
      if (prime) { unlinked.delete(name); continue; }
      // 已经认领过这个文件（任务已 submitted 且交付记录就是它）→ 静默跳过。
      // 否则「交完再补一句说明」会让同一个文件在页面上翻成 unlinked 黄条，纯误报。
      const already = tasks.some((t) => (String(t.ticket ?? '').toUpperCase() === norm
          || tokenRe.test(String(t.title ?? '').toUpperCase()))
        && String(t.target ?? '') === String(agent)
        && t.state === 'submitted'
        && (t.notes ?? []).some((n) => n.note === `delivery:${name}`));
      if (already) { unlinked.delete(name); continue; }
      const why = candidates.length
        ? `${candidates[0].id} 的目标工号是 ${candidates[0].target ?? '—'}，不是 ${agent}`
        : (tasks.some((t) => String(t.ticket ?? '').toUpperCase() === norm) ? `单号 ${ticket} 的任务都不在 doing/queued` : `没有单号为 ${ticket} 的任务`);
      unlinked.set(name, { name, reason: why, at: nowMs(), agent, date });
      continue;
    }

    // queued 还没派发就落了文件：不认领（状态机不允许 queued→submitted），但也不许抛异常刷日志。
    if (pick.state === 'queued') {
      unlinked.set(name, { name, reason: `${pick.id}（${pick.ticket ?? ''}）还没派发（queued），先不认领`, at: nowMs(), agent, date });
      continue;
    }

    // D57 预检门：不合格的交付**不进「待验收」**，标 bad 并通知提交工号与 01（可配置旁路 precheck.enabled=false）
    const precheckOn = readConfig().precheck?.enabled !== false;
    if (precheckOn) {
      const pre = precheckDelivery(path.join(DELIVERY_DIR, name));
      if (pre.level === 'FAIL') {
        badDeliveries.set(name, { name, task: pick.id, ticket, agent, missing: pre.fails, at: nowMs() });
        // 启动那轮（prime）只登记、不发信不写台账事件：否则每次重启都给 01 和工号刷一遍同样的邮件
        if (prime) continue;
        fs.appendFileSync(WORKLIST_FILE, `${JSON.stringify({ t: nowMs(), id: pick.id, op: 'precheck', from: 'workdesk', ok: false, note: `预检不合格：${pre.fails.join('；')}` })}\n`, 'utf8');
        const miss = pre.fails.join('；');
        // D70：拦住时把"怎么补救"一起说清楚（第十节判定 6：可观察证据也算）
        const hint = '补：前 3 行加「类型: 方案|实现|修复|文档」、补齐四段式（做到哪/改了什么/怎么验的/卡在哪）、文件名用 <工号>-<YYYYMMDD>-<单号>.md。'
          + '（注意：exit 码、命令代码块、回滚小节现在只是 WARN，有截图/日志/HTTP 200/mtime 这类可观察证据就够。）';
        const s1 = postMail(String(agent), `【交付预检不合格】records\\交付\\${name} 不能进待验收：${miss}\n${hint}\n改好再落一次（同名文件会被重新扫）。`);
        const s2 = postMail('01', `【预检拦截】${agent} 交的 ${name}（${pick.id}）不合格：${miss}（已通知工号 ${agent}）`);
        logLine(`[precheck] ${name} FAIL：${miss}（邮件 ${s1}/${s2}）`);
        continue;   // ★ 不进 submitted
      }
      if (pre.level === 'WARN' && !prime) {
        logLine(`[precheck] ${name} WARN（仍进待验收）：${pre.warns.join('；')}`);
      }
      badDeliveries.delete(name);
    }

    wlSetState(pick.id, 'submitted', { from: 'workdesk', note: '交付文件已落', target: pick.target });
    // 记录交付文件名（回放里当 attach 事件，页面靠它取链接）
    fs.appendFileSync(WORKLIST_FILE, `${JSON.stringify({ t: nowMs(), id: pick.id, op: 'attach', from: 'workdesk', note: `delivery:${name}` })}\n`, 'utf8');
    unlinked.delete(name);
    // 保险 / 学习区独立验收：票照常转 submitted，但不给 01 投「待验收」邮件（主人 2026-11-06 18:05 定）
    const indepPrj = String(pick.project ?? '');
    const isIndep = INDEPENDENT_PROJECTS.has(indepPrj) || (indepPrj === '' && /^(IN|ST)-/i.test(String(ticket)));
    const seq = isIndep ? null : postMail('01', `【待验收】${agent} 交了 ${ticket}：records\\交付\\${name}（状态 submitted）`);
    claimed.push({ task: pick.id, ticket, agent, file: name, at: nowMs(), mailSeq: seq });
    try {
      const r = syncProjects();
      if (r.changed) logLine(`[projects-sync] 认领后同步 ${r.diffs.length} 个 feature`);
    } catch (e) { logLine(`[projects-sync] 失败：${e?.message ?? e}`); }
    logLine(`[scan] ${name} → ${pick.id} submitted（邮件 seq=${seq}）`);
  }
}

// ── /api/mail ───────────────────────────────────────────────────────────────
function mailState() {
  const rows = readText(MAIL_FILE).split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const watermarks = {};
  try {
    for (const name of fs.readdirSync(MAIL_BOX)) {
      if (!name.endsWith('.read')) continue;
      watermarks[name.slice(0, -5)] = Number(readText(path.join(MAIL_BOX, name)).trim()) || 0;
    }
  } catch { /* 没水位就是都未读 */ }
  const unread = {};
  for (const row of rows) {
    const to = String(row.to ?? '');
    if (!to) continue;
    unread[to] = unread[to] ?? { agent: to, total: 0, unread: 0 };
    unread[to].total += 1;
    if (Number(row.seq) > (watermarks[to] ?? 0)) unread[to].unread += 1;
  }
  return {
    ok: true, file: MAIL_FILE, total: rows.length, watermarks,
    unread: Object.values(unread).sort((a, b) => b.unread - a.unread),
    recent: rows.slice(-MAIL_PAGE).reverse().map((r) => ({
      seq: r.seq, t: r.t, at: iso(r.t), from: r.from, to: r.to, level: r.level,
      body: String(r.body ?? ''),
      excerpt: clip(String(r.body ?? '').replace(/\n/g, ' '), 90),
      unread: Number(r.seq) > (watermarks[String(r.to ?? '')] ?? 0)
    }))
  };
}

// ── 方案审核 / 人工待审核箱（W-033 / D29，06）────────────────────────────────
// 数据全部来自台账回放（04 的 D28 已经把 type/planState/reviewer/planNote 写进 core）
// 和 state\plan-manual-queue.jsonl（CLI 与页面共用同一个箱，谁也不另起一份）。
const MANUAL_QUEUE = path.join(WORKSPACE, 'state', 'plan-manual-queue.jsonl');
const PLAN_OPEN = ['待审', '01审中', '转05', '待人工'];

function readManualQueue() {
  return readText(MANUAL_QUEUE).split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function pushManual(id, note, by) {
  try {
    fs.mkdirSync(path.dirname(MANUAL_QUEUE), { recursive: true });
    fs.appendFileSync(MANUAL_QUEUE, `${JSON.stringify({ t: nowMs(), id, note, by })}\n`, 'utf8');
  } catch { /* 箱写不进去不影响主流程 */ }
}

/** 卡在谁那：待审/01审中 都找 01，转05 找 05，待人工找主人/01。 */
function blockedOnOf(planState) {
  if (planState === '待审' || planState === '01审中') return '01';
  if (planState === '转05') return '05';
  if (planState === '待人工') return '主人/01';
  return null;
}

// D32：夹具与作废过滤——验收夹具票、已 dropped 的票不进「方案审核 / 待人工」。
// 口径（任务书 §1）：标题以【D28/D29/D30 验收】开头，或 ticket 形如 D29V* / D30A* / D30B*。
const FIXTURE_TITLE = /^【D(2[89]|30)\s*验收/;
const FIXTURE_TICKET = /^D(29V|30A|30B)/i;
function isFixtureTask(t) {
  if (!t) return false;
  return FIXTURE_TITLE.test(String(t.title ?? '')) || FIXTURE_TICKET.test(String(t.ticket ?? ''));
}

function planStateView(tasks) {
  const at = nowMs();
  const openRank = (s) => { const i = PLAN_OPEN.indexOf(s); return i < 0 ? 99 : i; };
  const plans = tasks
    .filter((t) => (t.type === '方案' || t.planState) && t.state !== 'dropped' && !isFixtureTask(t))
    .map((t) => {
      const stamp = Number(t.reviewedAt ?? 0) || Number(t.createdAt ?? 0) || null;
      const notes = Array.isArray(t.notes) ? t.notes.slice(-3).map((n) => ({ t: n.t, by: n.by, note: n.note })) : [];
      return {
        id: t.id, ticket: t.ticket ?? t.id, title: t.title, target: t.target ?? null,
        type: t.type ?? '—', planState: t.planState ?? null, reviewer: t.reviewer ?? null,
        reviewedAt: t.reviewedAt ?? null, planNote: t.planNote ?? null, state: t.state,
        waitingMs: stamp ? at - stamp : null, waitingText: stamp ? fmtAge(at - stamp) : null,
        blockedOn: blockedOnOf(t.planState),
        notes
      };
    })
    .sort((a, b) => openRank(a.planState) - openRank(b.planState) || (b.waitingMs ?? 0) - (a.waitingMs ?? 0));
  const summary = {};
  for (const s of PLAN_STATES) summary[s] = plans.filter((p) => p.planState === s).length;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const manual = readManualQueue().slice(-40).reverse()
    .map((r) => {
      const task = byId.get(String(r.id)) ?? null;
      return {
        task,
        row: {
          t: r.t, at: iso(r.t), id: String(r.id), note: String(r.note ?? ''), by: r.by ?? '01',
          title: task?.title ?? null, target: task?.target ?? null,
          state: task?.state ?? null, planState: task?.planState ?? null
        }
      };
    })
    .filter((x) => x.task && x.task.state !== 'dropped' && !isFixtureTask(x.task))
    .map((x) => x.row);
  return {
    plans, summary, manual,
    openCount: plans.filter((p) => PLAN_OPEN.includes(p.planState)).length,
    manualCount: manual.length
  };
}

// ── /api/worklist ───────────────────────────────────────────────────────────
function worklistState(sessions) {
  const tasks = replayWorklist();
  const agents = agentRows(sessions.items, nowMs());
  const byNo = new Map();
  for (const a of agents) if (a.no) byNo.set(a.no, a);
  const groups = worklistByTarget(tasks).map((g) => {
    const agent = byNo.get(String(g.target));
    return {
      target: g.target,
      agent: agent ? { id: agent.id, title: agent.title, running: agent.running, live: agent.live, doingText: agent.doingText, idleMs: agent.idleMs, idleText: agent.idleText } : null,
      doing: g.doing,
    queue: (g.queue || []).map((t) => (relayState.needDoc.has(t.id) ? { ...t, needsTaskDoc: true } : t)),
    pending: g.pending,
      submitted: tasks.filter((t) => String(t.target ?? '未指派') === String(g.target) && t.state === 'submitted'),
      blocker: (() => {
        const active = [...g.doing, ...g.queue][0];
        const last = active?.notes?.[active.notes.length - 1];
        return last ? { note: last.note, by: last.by, t: last.t } : null;
      })()
    };
  });
  return {
    ok: true, at: iso(nowMs()), file: WORKLIST_FILE,
    summary: worklistSummary(tasks),
    tasks: tasks.map((t) => (relayState.needDoc.has(t.id) ? { ...t, needsTaskDoc: true } : t)),
    groups,
    plan: planStateView(tasks),
    submitted: tasks.filter((t) => t.state === 'submitted').map((t) => ({
      ...t,
      file: (t.notes ?? []).map((n) => /^delivery:(.+)$/.exec(n.note)?.[1]).filter(Boolean).pop() ?? null
    })),
    unlinked: [...unlinked.values()].sort((a, b) => b.at - a.at),
    bad: [...badDeliveries.values()].sort((a, b) => b.at - a.at),
    claimed: claimed.slice(-10),
    quota: { used: quotaUsed('dispatch'), limit: Number(readConfig().dispatchPerDay), op: 'dispatch' },
    scan: { intervalMs: Number(readConfig().scanIntervalMs), seen: seenDeliveries.size }
  };
}

// ── 项目视图（D43）：state\projects.json × worklist 现算进度，不写死任何数字 ──────
const PROJECTS_FILE = path.join(WORKSPACE, 'state', 'projects.json');
// D59：在役会话判定——只留现役工号/本体/明确在役的外部会话，其余归「历史」
function isActiveAgent(a) {
  const t = String(a.title ?? '');
  if (/黑话提取|演练|一次性/.test(t)) return false;          // 工具会话 / 演练
  if (/工号\d{2}/.test(t)) return true;                      // 工号 00-07
  if (/本体/.test(t)) return true;                            // 鲟鱼本体
  if (/QQ|企微|子实体/.test(t)) return true;                  // 明确在役的外部通道
  return false;
}

// D65b（§20.2）：「完成」判定权在 01——票全 done 只算「待验收」，01 签 feature-approved 才算「已完成」。
// 签收是 worklist.jsonl 的独立事件（op:'feature-approved'/'project-approved'），不改台账结构。
function readApprovals() {
  const map = new Map();
  let raw2 = '';
  try { raw2 = fs.readFileSync(WORKLIST_FILE, 'utf8'); } catch { return map; }
  for (const line of raw2.split('\n')) {
    if (!line || line.indexOf('approved') < 0) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.op === 'feature-approved') map.set(String(ev.project) + '|' + String(ev.feature), { t: ev.t ?? 0, by: ev.from ?? '01' });
    else if (ev.op === 'project-approved') map.set(String(ev.project) + '|*', { t: ev.t ?? 0, by: ev.from ?? '01' });
  }
  return map;
}

function projectsState() {
  const pj = readJson(PROJECTS_FILE, null);
  if (!pj || !Array.isArray(pj.projects)) {
    return { ok: false, error: 'state\\projects.json 读不到或格式不对', projects: [], doing: [], planned: [], unstarted: [] };
  }
  const tasks = replayWorklist();
  const mistakeRows = readMistakes();   // UG-036：返工错题本（每个请求读一次，不缓存）
  const byTicket = new Map();
  for (const t of tasks) {
    const k = String(t.ticket ?? '').trim().toUpperCase();
    if (!k) continue;
    if (!byTicket.has(k)) byTicket.set(k, []);
    byTicket.get(k).push(t);
  }
  const arrOf = (ticket) => byTicket.get(String(ticket ?? '').trim().toUpperCase()) ?? [];
  // ── D65：按 docs\projects\工作台-workdesk.md §12 的三级推导规则 ──
  // 一级：票 → 取「最活跃的未完成态」，优先级 doing > submitted > queued > done > dropped
  const TICKET_ORDER = ['doing', 'submitted', 'queued', 'done', 'dropped'];
  function ticketState(ticket) {
    const arr = arrOf(ticket);
    if (!arr.length) return '未登记';                 // 台账查不到：数据错，不许猜
    const states = new Set(arr.map((t) => t.state));
    for (const s of TICKET_ORDER) if (states.has(s)) return s;
    return '未登记';
  }
  // 二级：功能域 → 先剔除作废票，再看有效票的组合
  function featureState(ticketStates, approved) {
    if (ticketStates.some((s) => s === '未登记')) return '阻塞';
    const valid = ticketStates.filter((s) => s !== 'dropped');
    if (!valid.length) return '作废';                 // 有效票为 0（全作废）
    if (valid.includes('doing')) return '在做';
    if (valid.includes('submitted')) return '待验收';
    if (valid.includes('queued')) return '要做';
    if (valid.every((s) => s === 'done')) {
      // §20.2：票全 done 只是「待验收」，01 签收 feature-approved 才是「已完成」
      return approved ? '已完成' : '待验收';
    }
    return '阻塞';
  }

  const approvals = readApprovals();
  const projects = pj.projects.map((p) => {
    const features = (Array.isArray(p.features) ? p.features : []).map((f) => {
      const tickets = Array.isArray(f.tickets) ? f.tickets : [];
      const detail = tickets.map((tk) => ({ ticket: tk, state: ticketState(tk) }));
      const states = detail.map((d) => d.state);
      const valid = detail.filter((d) => d.state !== 'dropped');   // 作废票不进分母
      const done = valid.filter((d) => d.state === 'done').length;
      const doing = detail.filter((d) => d.state === 'doing').map((d) => {
        const arr = arrOf(d.ticket);
        const t = arr.find((x) => x.state === 'doing') || arr[0] || {};
        return { ticket: d.ticket, id: t.id ?? null, target: t.target ?? null, title: t.title ?? '' };
      });
      // UG-033 运行时投影：只算不写（total/done/doing/queued/blocked/currentTicket/lastProgress）
      const queued = detail.filter((d) => d.state === 'queued').length;
      const blockedTickets = detail.filter((d) => {
        if (d.state === '未登记') return true;                       // 台账查不到：数据错，按卡住算
        return arrOf(d.ticket).some((x) => x.blocked === true);      // blockedBy 前置没清
      });
      const firstDoing = detail.find((d) => d.state === 'doing');
      const firstQueued = detail.find((d) => d.state === 'queued');
      const progressAt = detail.reduce((mx, d) => Math.max(mx, Number(arrOf(d.ticket)[0]?.updatedAt ?? 0) || 0), 0);
      const projection = {
        total: valid.length,
        done,
        doing: detail.filter((d) => d.state === 'doing').length,
        queued,
        blocked: blockedTickets.length,
        currentTicket: (firstDoing ?? firstQueued)?.ticket ?? null,
        lastProgress: progressAt ? iso(progressAt) : null
      };
      const reworkMark = reworkForFeature(mistakeRows, { project: p.id, feature: f.id, tickets });   // UG-036
      const appr = approvals.get(String(p.id) + '|' + String(f.id));
      const state = tickets.length ? featureState(states, Boolean(appr || approvals.has(String(p.id) + '|*'))) : '未登记';
      return {
        id: f.id, name: f.name, note: f.note ?? '', tickets, detail,
        total: valid.length,                    // 分母 = 有效票（剔除作废）
        rawTotal: tickets.length,
        done,
        pending: states.filter((s) => s === 'submitted').length,
        pct: valid.length ? done / valid.length : 0,
        doing, state, signed: Boolean(appr || approvals.has(String(p.id) + '|*')),
        projection,
        rework: reworkMark.rework, lastReworkAt: reworkMark.lastReworkAt, lastReason: reworkMark.lastReason, openMistakes: reworkMark.openMistakes,
        priority: f.priority ?? null,
        owner: f.owner ?? null,
        blockedByDomain: f.blockedByDomain ?? [],
      };
    });
    const total = features.reduce((n, f) => n + f.total, 0);
    const done = features.reduce((n, f) => n + f.done, 0);
    const pendingCount = features.reduce((n, f) => n + f.pending, 0);
    const doing = features.flatMap((f) => f.doing.map((d) => ({ ...d, feature: f.id, featureName: f.name })));
    // 三级：项目 —— 按 §12.3 顺序判，命中即停；state:"done" 手写无效（D53 那条已删）
    let status;
    if (p.state === 'paused') status = '暂停';                                   // 唯一允许的人工值
    else if (features.some((f) => f.state === '阻塞')) status = '阻塞';
    else if (features.some((f) => f.state === '在做')) status = '在做';
    else if (features.some((f) => f.state === '待验收')) status = '在做';        // 四档里并入在做，卡片标「待验收 N」
    else if (features.length && features.some((f) => f.state === '已完成')
             && features.every((f) => f.state === '已完成' || f.state === '作废')) status = '已完成';
    else status = '要做';
    return {
      id: p.id, name: p.name, doc: p.doc ?? null, summary: p.summary ?? '', note: p.note ?? '',
      state: p.state ?? null, status, total, done, pendingCount, pct: total ? done / total : 0,
      doing, features
    };
  });
  const doingAll = projects.flatMap((p) => p.doing.map((d) => ({ ...d, project: p.id, projectName: p.name })));
  const planned = projects.filter((p) => p.status === '要做');
  const unstarted = projects.flatMap((p) => p.features
    .filter((f) => !f.started && f.total > 0)
    .map((f) => ({ project: p.id, projectName: p.name, feature: f.id, featureName: f.name, tickets: f.tickets })));

  return {
    ok: true,
    source: 'state\\projects.json × worklist（现算，不写死）',
    maintainer: pj.maintainer ?? null,
    updatedAt: pj.updatedAt ?? null,
    at: iso(nowMs()),
    count: projects.length,
    projects, doing: doingAll, planned, unstarted
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function sendJson(res, code, body) {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
// ── /api/send：代持发送队列（D89）────────────────────────────────────────────
// 口径：这里**只追加一行 queued 就返回**，不在 HTTP 请求里跑发送（发送要抢前台、要几秒到几十秒）。
function readOutbox() {
  return readText(OUTBOX_FILE).split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
function outboxChats() {
  const cfg = readJson(WECOM_HOLD_CFG, {}) || {};
  return Object.keys(cfg.chats || {});   // 只给「已标定坐标」的会话做候选，写错名仍能提交（runner 会 failed 并给原因）
}
function outboxRunner() {
  const h = readJson(OUTBOX_HEART, null);
  if (!h || !Number(h.at)) return { running: false, detail: '没有 runner 心跳（scripts\\wecom-outbox-runner.mjs 没起）' };
  const age = nowMs() - Number(h.at);
  return {
    running: age < 30000, ageMs: age, pid: h.pid ?? null, dry: Boolean(h.dry), ticks: h.ticks ?? 0,
    lastId: h.lastId ?? null, lastState: h.lastState ?? null, lastReason: h.lastReason ?? null,
    lastAt: iso(Number(h.lastAt) || null)
  };
}
function outboxState() {
  const rows = readOutbox();
  const n = (s) => rows.filter((r) => r.state === s).length;
  return {
    ok: true, at: iso(nowMs()), file: OUTBOX_FILE, total: rows.length,
    queued: n('queued'), sending: n('sending'), sent: n('sent'), failed: n('failed'),
    chats: outboxChats(), runner: outboxRunner(),
    recent: rows.slice(-OUTBOX_RECENT).reverse().map((r) => ({
      id: r.id, chat: r.chat, text: clip(r.text, 60), by: r.by ?? null, state: r.state,
      at: r.at ?? iso(Number(r.t) || null), ms: r.ms ?? null, exitCode: r.exitCode ?? null,
      reason: r.reason ?? null, dry: Boolean(r.dry)
    }))
  };
}
function outboxId(at) {
  const d = new Date(at);
  const p = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `wo-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

function readBody(req, limit = 8000) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > limit) req.destroy(); });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
  });
}
async function readJsonBody(req) {
  try { return JSON.parse((await readBody(req)).replace(/^\uFEFF/, '') || '{}'); } catch { return null; }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  // WC-007：/api/wecom/* 整块交给独立模块（不改动下面任何既有路由）
  if (route.startsWith('/api/wecom/')) {
    const wc = await handleWecomChat({ req, url, route, method: req.method });
    if (wc) { sendJson(res, wc.status, wc.body); return; }
  }
  // WS-032：人设与记忆源（只读）。steward(9850) 未就绪时先挂这里，接口形状不变，
  // 以后挪到 steward 只改这一处 import 的宿主。不回正文、不回令牌。
  if (route === '/api/persona' || route === '/api/memory') {
    const { handlePersonaMemory } = await import('./persona-memory.mjs');
    const pm = await handlePersonaMemory({ route, url });
    if (pm) { sendJson(res, pm.status, pm.body); return; }
  }
  // WS-016：统一守护的「调度台」接口（只读快照 + 人审重启 + 事件流）。整块交给独立模块，
  // 不改动下面任何既有路由；supervisor 自己写 state\supervisor.json，这里只读。
  if (route === '/api/supervisor' || route === '/api/supervisor/events' || route === '/api/supervisor/restart') {
    const { handleSupervisor } = await import('./supervisor-api.mjs');
    const sup = await handleSupervisor({ route, method: req.method, url, readBody: () => readJsonBody(req) });
    if (sup) { sendJson(res, sup.status, sup.body); return; }
    sendJson(res, 404, { ok: false, error: `不支持的方法：${req.method} ${route}` });
    return;
  }
  // WS-031 + WS-027：后端支撑与总控台（自检 / 日志尾巴 / 设置 / SnowLuma / 桥接控制台 / 四栏聚合）。
  // 整块交给 scripts\routes\*，这里只挂载，不动下面任何既有路由。
  // **必须挂在这里（取会话之前）**：下面每个请求都会先 await listSessions()，那是 2.5 秒级的
  // RPC——总控台/自检/日志这些接口根本不需要它，挂在后面等于白等（实测排到 2.5 秒）。
  // deps 把工作台**已有**的算力按需传下去（成本/台账/工号），免得总控台重写一份。
  if (route.startsWith('/api/console') || route === '/api/logs/tail'
    || route === '/api/settings' || route.startsWith('/api/snowluma/') || route.startsWith('/api/bridge/')
    || route.startsWith('/api/files/qq')) {
    const ctx = {
      route, method: req.method, url,
      readBody: () => readJsonBody(req),
      deps: {
        cost: () => collectCost({ by: 'session' }),
        summary: () => worklistSummary(replayWorklist()),
        agents: async () => {
          const s = await listSessions();
          return { rows: agentRows(s.items, nowMs()), error: s?.error || null };
        },
      },
    };
    for (const mod of ['./routes/console.mjs', './routes/settings.mjs', './routes/files.mjs']) {
      const { handle: handleRoute } = await import(mod);
      const r = await handleRoute(ctx);
      if (r) { sendJson(res, r.status, r.body); return; }
    }
    sendJson(res, 404, { ok: false, error: `没有这个接口：${req.method} ${route}` });
    return;
  }

  // WS-010：调度器状态与手工触发（进程内跑，不再靠计划任务）
  if (route === '/api/scheduler/status') {
    if (req.method === 'POST') {
      const b = await readJsonBody(req).catch(() => null);
      const job = String(b?.job ?? '').trim();
      if (!job) { sendJson(res, 400, { ok: false, error: '缺 job（accept/mail/outbox/health/tmpguard）' }); return; }
      const r = await runJobNow(job).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      sendJson(res, r?.ok ? 200 : 500, { ok: Boolean(r?.ok), job, result: r, status: schedulerStatus() });
      return;
    }
    sendJson(res, 200, schedulerStatus());
    return;
  }
  const sessions = (route === '/api/agents' || route === '/api/worklist' || route === '/api/dispatch' || route === '/api/sessions-health')
    ? await listSessions({ force: url.searchParams.get('refresh') === '1' })
    : await listSessions();

  if (req.method === 'GET' && route === '/api/agents') {
    const at = nowMs();
    const agents = agentRows(sessions.items, at);
    // D21：把台账 join 到会话上。否则「排了 4 条待办」的 03/04 在页面上仍显示空闲（工单 W-021 的原话）。
    // queued = 排队条数；nextTask = 最早一条（按 order，再按创建时间）的票号 + 标题。
    const tasks = replayWorklist();
    const queueByTarget = new Map();
    for (const t of tasks) {
      if (t.state !== 'queued') continue;
      const key = String(t.target ?? '');
      const list = queueByTarget.get(key) ?? [];
      list.push(t);
      queueByTarget.set(key, list);
    }
    for (const list of queueByTarget.values()) {
      list.sort((a, b) => (Number(a.order ?? 0) - Number(b.order ?? 0)) || ((a.createdAt ?? 0) - (b.createdAt ?? 0)));
    }
    // D59：双计数——在做（doing）与排队（queued）分开算，别再混成一个 run 布尔
    const doingByTarget = new Map();
    for (const t of tasks) {
      if (t.state !== 'doing') continue;
      const key = String(t.target ?? '');
      doingByTarget.set(key, (doingByTarget.get(key) ?? 0) + 1);
    }
    for (const agent of agents) {
      const list = queueByTarget.get(String(agent.no ?? '')) ?? [];
      agent.queued = list.length;
      agent.doing = doingByTarget.get(String(agent.no ?? '')) ?? 0;
      agent.active = isActiveAgent(agent);
      agent.nextTask = list.length ? { id: list[0].id, ticket: list[0].ticket ?? list[0].id, title: list[0].title } : null;
    }
    sendJson(res, 200, {
      ok: !sessions.error, tool: 'workdesk', version: VERSION, at: iso(at), ts: at,
      source: rpc ? { url: rpc.url, method: 'sessions/list（投影，零 token）' } : null,
      cacheAgeMs: sessions.at ? at - sessions.at : null,
      error: sessions.error || null, count: agents.length, live: agents.filter((a) => a.live).length,
      activeCount: agents.filter((a) => a.active).length, historicalCount: agents.filter((a) => !a.active).length, agents
    });
    return;
  }

  // UG-007：未回执（只在内存里算，不写台账）。?ms= 仅供验收加速，默认取 XUNYU_UNACK_MS / 30 分钟
  if (req.method === 'GET' && route === '/api/unacked') {
    const msArg = Number(url.searchParams.get('ms') ?? 0);
    const limitMs = Number.isFinite(msArg) && msArg > 0 ? msArg : unackMs();
    const now = nowMs();
    const rows = replayWorklist()
      .filter((t) => t.state === 'doing' && t.dispatchedAt && !t.deliveredAt && now - t.dispatchedAt >= limitMs)
      .sort((a, b) => (a.dispatchedAt ?? 0) - (b.dispatchedAt ?? 0))
      .map((t) => ({
        id: t.id, ticket: t.ticket ?? null, target: t.target ?? null, title: t.title ?? '',
        dispatchedAt: t.dispatchedAt, waitedMs: now - t.dispatchedAt,
        waitedText: humanMs(now - t.dispatchedAt), ackBy: t.ackBy ?? null
      }));
    sendJson(res, 200, {
      ok: true, tool: 'workdesk', version: VERSION, at: iso(now),
      unackedMs: limitMs, override: msArg > 0, count: rows.length, rows,
      rule: '已投（进 doing）+ 没有 accepted 回执 + 超过阈值；派生值，不写台账'
    });
    return;
  }

  if (req.method === 'GET' && route === '/api/projects') {
    sendJson(res, 200, { tool: 'workdesk', version: VERSION, ...projectsState() });
    return;
  }

  if (req.method === 'GET' && route === '/api/acceptance/pending') {
    // UG-021：待验收 + 催办计数（与 nudgeAcceptance 同一份 nudge 日志）
    try {
      const mod = await import('./acceptance-watch.mjs');
      const rows = mod.pendingList();
      sendJson(res, 200, { ok: true, tool: 'workdesk', version: VERSION, at: iso(nowMs()), count: rows.length, rows });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/priority') {
    // UG-031：优先窗口可观测（与 worklist priority 命令、三处拦截同一函数）
    sendJson(res, 200, { tool: 'workdesk', version: VERSION, ok: true, at: iso(nowMs()), ...priorityState() });
    return;
  }

  if (req.method === 'GET' && route === '/api/tasks') {
    const tasks = taskList();
    sendJson(res, 200, {
      ok: true, tool: 'workdesk', version: VERSION, at: iso(nowMs()), count: tasks.length,
      open: tasks.filter((t) => !t.done),
      done: tasks.filter((t) => t.done).map((t) => ({ id: t.id, title: t.title, deliveredBy: t.deliveredBy })),
      recentDeliveries: recentDeliveries(5)
    });
    return;
  }

  if (req.method === 'GET' && route === '/api/worklist') {
    sendJson(res, 200, { tool: 'workdesk', version: VERSION, ...worklistState(sessions) });
    return;
  }

  if (req.method === 'GET' && route === '/api/mail') {
    sendJson(res, 200, { tool: 'workdesk', version: VERSION, at: iso(nowMs()), ...mailState() });
    return;
  }

  // D89：代持发送。GET 拿最近 5 条 + runner 心跳；POST 只入队（立即返回 queued）。
  if (req.method === 'GET' && route === '/api/send') {
    sendJson(res, 200, { tool: 'workdesk', version: VERSION, ...outboxState() });
    return;
  }

  if (req.method === 'POST' && route === '/api/send') {
    const body = await readJsonBody(req);
    if (!body) { sendJson(res, 400, { ok: false, error: '需要 JSON 体 {chat, text, by}' }); return; }
    const chat = String(body.chat ?? '').trim();
    const text = String(body.text ?? '').trim();
    const by = clip(body.by ?? 'workdesk', 20);
    if (!chat) { sendJson(res, 400, { ok: false, error: '缺 chat：必须指定会话名（防误发到当前前台会话）' }); return; }
    if (!text) { sendJson(res, 400, { ok: false, error: '缺 text：没有内容不发' }); return; }
    if (text.length > 2000) { sendJson(res, 400, { ok: false, error: `text 太长（${text.length} 字，上限 2000）` }); return; }
    const st = outboxState();
    if (st.queued + st.sending >= OUTBOX_MAX_PENDING) {
      sendJson(res, 429, { ok: false, error: `队列积压 ${st.queued + st.sending} 条（上限 ${OUTBOX_MAX_PENDING}），等 runner 消化` });
      return;
    }
    if (!st.runner.running) {
      // 不拦：先入队，runner 起来就发。但要在响应里说清楚，别让人以为已经发了
      logLine(`[send] 注意：runner 心跳 ${st.runner.ageMs ?? '—'}ms 未更新，本条只入队不发送`);
    }
    const at = nowMs();
    const row = { id: outboxId(at), state: 'queued', chat, text, by, t: at, at: iso(at) };
    try {
      fs.mkdirSync(path.dirname(OUTBOX_FILE), { recursive: true });
      fs.appendFileSync(OUTBOX_FILE, `${JSON.stringify(row)}\n`, 'utf8');
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `写队列失败：${error?.message ?? error}` });
      return;
    }
    logLine(`[send] 入队 ${row.id} →「${chat}」${text.length} 字 by=${by}`);
    const after = outboxState();
    sendJson(res, 200, { ok: true, id: row.id, state: 'queued', chat, queueDepth: after.queued, runner: after.runner });
    return;
  }

  // W-028：会话检测（只读；?refresh=1 强制重采样投影，?reconcile=1 顺带跑一次 token-report 对账）
  if (req.method === 'GET' && route === '/api/sessions-health') {
    const health = sessionHealth(sessions);
    const attribution = await attributionState(health, { reconcile: url.searchParams.get('reconcile') === '1' });
    sendJson(res, 200, { ...health, attribution });
    return;
  }

  if (req.method === 'POST' && route === '/api/relay/drill') {
    // D80：演练运行时开关。只接受持锁实例；{mode:'off'} 立刻解除
    if (!holdsWorklistLock() && !refreshWorklistLock()) {
      sendJson(res, 409, { ok: false, code: 'not-lock-holder', error: '本实例不持有台账锁，演练只允许在持锁实例上开（避免第二实例演练、生产真派）' });
      return;
    }
    const body = await readJsonBody(req);
    const mode = String(body?.mode ?? 'fail');
    if (mode === 'off') {
      try { fs.rmSync(DRILL_FILE, { force: true }); } catch { /* ignore */ }
      tcpRecord({ t: nowMs(), op: 'drill', by: String(body?.by ?? 'http'), ok: true, code: 'drill-off', detail: '手动解除演练' });
      logLine('[drill] 手动解除');
      sendJson(res, 200, { ok: true, mode: 'off' });
      return;
    }
    const ticket = String(body?.ticket ?? '').trim();
    const times = Math.max(1, Math.min(10, Number(body?.times ?? 1)));
    const minutes = Math.max(1, Math.min(60, Number(body?.minutes ?? 10)));
    if (!ticket) { sendJson(res, 400, { ok: false, error: '缺 ticket（要演练哪张票）' }); return; }
    const until = nowMs() + minutes * 60000;
    writeDrill({ ticket, mode, times, left: times, count: 0, until, untilText: new Date(until).toISOString(), by: String(body?.by ?? 'http'), at: nowMs() });
    tcpRecord({ t: nowMs(), op: 'drill', by: String(body?.by ?? 'http'), ticket, ok: true, code: 'drill-arm', detail: `演练开：${ticket} 失败 ${times} 次，${minutes} 分钟后自动解除` });
    logLine(`[drill] 开：${ticket} × ${times}（${minutes} 分钟）`);
    sendJson(res, 200, { ok: true, ticket, times, until, banner: `演练中：${ticket} 强制失败 ${times} 次` });
    return;
  }


  if (req.method === 'GET' && route === '/api/cost') {
    // D33：花费区间统计（供 06 的页面用）。默认当日 00:00 → 现在（北京时间）。
    try {
      const fromArg = url.searchParams.get('from');
      const toArg = url.searchParams.get('to');
      const from = fromArg ? parseClock(fromArg) : undefined;
      const to = toArg ? parseClock(toArg) : undefined;
      if (fromArg && from == null) { sendJson(res, 400, { ok: false, error: 'from 解析不了（要 ISO 或 YYYY-MM-DD HH:mm）' }); return; }
      if (toArg && to == null) { sendJson(res, 400, { ok: false, error: 'to 解析不了（要 ISO 或 YYYY-MM-DD HH:mm）' }); return; }
      const report = collectCost({ from, to, by: 'session' });
      sendJson(res, 200, { tool: 'workdesk', version: VERSION, at: iso(nowMs()), ...report });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }
  if (req.method === 'GET' && route === '/api/relay') {
    const cfg = relayConfig();
    sendJson(res, 200, {
      ok: true, tool: 'workdesk', version: VERSION, at: iso(nowMs()),
      enabled: cfg.enabled, intervalMs: cfg.intervalMs, backoffMs: cfg.backoffMs,
      ticks: relayState.ticks,
      last: relayState.last,
      backoff: [...relayState.backoff.entries()].filter(([, until]) => until > nowMs()).map(([agent, until]) => ({ agent, until: iso(until) })),
      quota: { used: quotaUsed('dispatch'), limit: Number(readConfig().dispatchPerDay ?? 20) },
      drill: drillPayload(),
      lockHolder: holdsWorklistLock()
    });
    return;
  }

  if (req.method === 'POST' && route === '/api/relay') {
    const body = await readJsonBody(req);
    if (!body || typeof body.enabled !== 'boolean') { sendJson(res, 400, { ok: false, error: '需要 {enabled: true|false}' }); return; }
    try {
      const cfg = readConfig();
      const next = { ...cfg, autoRelay: { ...(cfg.autoRelay ?? {}), enabled: body.enabled } };
      fs.writeFileSync(path.join(WORKSPACE, 'state', 'workdesk.config.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      const seq = postMail('01', `【自动接力】${body.enabled ? '已打开' : '已关闭'}（by 工作台按钮）`);
      logLine(`[relay] 开关 → ${body.enabled ? '开' : '关'}（邮件 seq=${seq}）`);
      sendJson(res, 200, { ok: true, enabled: body.enabled });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/nudge') {
    // 只读：算一遍「够资格被敲的门」，不真的发 prompt
    const dry = await nudgeTick({ dry: true });
    const cfg = nudgeConfig();
    sendJson(res, 200, {
      ok: dry.ok !== false, tool: 'workdesk', version: VERSION, at: iso(nowMs()),
      enabled: cfg.enabled, perDay: cfg.perDay, intervalMs: cfg.intervalMs, backoffMs: cfg.backoffMs,
      today: dry.quota?.used ?? 0, nudged: dry.nudged ?? 0,
      last: nudgeState.last, ticks: nudgeState.ticks,
      candidates: (dry.candidates ?? []).map(({ seq, to, from, excerpt, title, running, sessionId }) => ({ seq, to, from, excerpt, title, running, hasSession: Boolean(sessionId) })),
      knockable: (dry.knockable ?? []).map(({ seq, to }) => ({ seq, to })),
      error: dry.error ?? null
    });
    return;
  }

  if (req.method === 'POST' && route === '/api/nudge') {
    // 手动敲一次（会花钱）：只为排障/演练留的口子
    const r = await nudgeTick({ dry: false });
    sendJson(res, 200, { ok: true, ...r });
    return;
  }

  if (req.method === 'GET' && route === '/api/dispatch/status') {
    // UG-039：派发送达看板——{delivered, undelivered[], retrying[]}
    // delivered = 台账里 deliveredAt 有值（收到过 accepted 回执）的票数；
    // undelivered = 派了但没送到（含重试中；escalated=true 表示已放弃）；
    // retrying = 其中还能自动重试的。
    try {
      sendJson(res, 200, { ok: true, tool: 'workdesk', at: iso(nowMs()), ...deliveryStatus() });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/health/components') {
    // WS-011（07，2026-10-30）：组件健康——谁活着、谁挂了。
    // 探针在 scripts\health-components.mjs（800ms 超时、10s 缓存、状态变更写 state\health-history.jsonl）；
    // 组件清单在 state\health-components.json，加组件不用改这里。?refresh=1 绕过缓存。
    try {
      const pack = await collectComponents({
        force: url.searchParams.get('refresh') === '1',
        self: { pid: process.pid, startedAt: STARTED_AT }
      });
      sendJson(res, 200, pack);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  if (req.method === 'GET' && (route === '/api/health' || route === '/health')) {
    // D64（03，2026-10-28）：健康自证——pid 与启动时刻，配合页脚「构建」判断是不是新进程。
    sendJson(res, 200, {
      ok: true, module: 'workdesk', version: VERSION, port: PORT,
      pid: process.pid,
      startedAt: new Date(STARTED_AT).toISOString(),
      startedAtLocal: new Date(STARTED_AT).toLocaleString('zh-CN', { hour12: false }),
      uptimeMs: nowMs() - STARTED_AT, ts: nowMs(),
      checks: { dsh: { ok: !sessions.error, detail: rpc ? rpc.url : '未连接' }, scan: { ok: true, detail: `${seenDeliveries.size} 个交付已登记` } }
    });
    return;
  }

  // ── 唯一花钱：派发 ──
  if (req.method === 'POST' && route === '/api/dispatch') {
    const body = await readJsonBody(req);
    if (!body) { sendJson(res, 400, { ok: false, error: '需要 JSON 体 {id, confirm}' }); return; }
    const id = String(body.id ?? '').trim();
    const confirm = String(body.confirm ?? '').trim();
    if (!id) { sendJson(res, 400, { ok: false, error: '缺 id' }); return; }
    if (confirm !== id) {
      const rec = { t: nowMs(), op: 'dispatch', by: 'http', id, ok: false, status: 400, code: 'confirm-mismatch', detail: `confirm="${confirm}" 与 id 不一致` };
      fs.mkdirSync(path.dirname(DISPATCH_LOG), { recursive: true });
      fs.appendFileSync(DISPATCH_LOG, `${JSON.stringify(rec)}\n`, 'utf8');
      sendJson(res, 400, { ok: false, error: '必须带 confirm:"<任务id>"（精确匹配），防止误点', audit: rec });
      return;
    }
    const result = await dispatchTask(id, { by: 'http' });
    sendJson(res, result.status, result);
    return;
  }

  if (req.method === 'POST' && route === '/api/accept') {
    const body = await readJsonBody(req);
    const id = String(body?.id ?? '').trim();
    if (!id) { sendJson(res, 400, { ok: false, error: '缺 id' }); return; }
    try {
      wlSetState(id, 'done', { from: '01', note: String(body?.note ?? '验收通过').slice(0, 200) });
      const unlocked = sweepUnlocks();
      // UG-036：验收即把该票最近一条返工标 resolved
      try {
        const t = replayWorklist().find((x) => x.id === id);
        const rr = resolveRework(String(t?.ticket ?? id), { by: '01' });
        if (rr.resolved) { try { syncMistakes({ only: t?.project ?? undefined }); } catch { /* ignore */ } }
      } catch { /* 错题本失败不影响验收 */ }
      try { syncProjects(); } catch { /* 同步失败不影响验收 */ }
      sendJson(res, 200, { ok: true, id, state: 'done', unlocked });
    } catch (error) { sendJson(res, 409, { ok: false, error: String(error?.message ?? error) }); }
    return;
  }

  if (req.method === 'POST' && route === '/api/reject') {
    const body = await readJsonBody(req);
    const id = String(body?.id ?? '').trim();
    const note = String(body?.note ?? '退回重做').slice(0, 200);
    if (!id) { sendJson(res, 400, { ok: false, error: '缺 id' }); return; }
    const task = replayWorklist().find((t) => t.id === id);
    if (!task) { sendJson(res, 404, { ok: false, error: `没有任务 ${id}` }); return; }
    try {
      const back = task.state === 'submitted' ? 'doing' : 'dropped';
      wlSetState(id, back, { from: '01', note });
      // UG-036：退回即记一条错题（原话 = note，不改写）
      try {
        const mr = recordRework(task, { reason: note, category: String(body?.reason ?? 'other'), by: '01' });
        if (mr.ok) { try { syncMistakes({ only: mr.record.project ?? undefined }); } catch { /* 渲染失败不影响退回 */ } }
      } catch { /* 错题本写失败也不影响退回 */ }
      try { syncProjects(); } catch { /* D66：同步失败不影响退回 */ }
      const seq = back === 'doing' && task.target ? postMail(`${task.target}`, `【退回】${task.ticket ?? task.id}：${note}\n请按意见改完再交一次（${task.title}）`) : null;
      sendJson(res, 200, { ok: true, id, state: back, mailSeq: seq });
    } catch (error) { sendJson(res, 409, { ok: false, error: String(error?.message ?? error) }); }
    return;
  }

  // ── 方案审核（D29）：通过会派生 -impl 进 queued；驳回会发两封邮件并进人工箱 ──
  if (req.method === 'POST' && (route === '/api/plan-approve' || route === '/api/plan-reject')) {
    const body = await readJsonBody(req);
    if (!body) { sendJson(res, 400, { ok: false, error: '需要 JSON 体 {id, note}' }); return; }
    const id = String(body.id ?? '').trim();
    const note = String(body.note ?? '').slice(0, 200);
    if (!id) { sendJson(res, 400, { ok: false, error: '缺 id' }); return; }
    const task = replayWorklist().find((t) => t.id === id);
    if (!task) { sendJson(res, 404, { ok: false, error: `没有任务 ${id}` }); return; }
    const who = String(task.target ?? '01');
    try {
      if (route === '/api/plan-approve') {
        const r = approvePlan(id, { by: '01', note });
        const seq = postMail(who, `【方案通过】${id} 已通过，派生实现单 ${r.implId}（queued）。`);
        logLine(`[plan] ${id} 通过 → ${r.implId}（邮件 seq=${seq}）`);
        sendJson(res, 200, { ok: true, id, planState: '通过', implId: r.implId, derived: Boolean(r.derived), mailSeq: seq });
      } else {
        const ev = rejectPlan(id, { by: '01', note });
        const reason = ev.planNote || note || '缺说明';
        const s1 = postMail(who, `【方案驳回】${id}（${task.title ?? ''}）：${reason}\n改完再交：node scripts\\worklist.mjs plan-submit ${id} --type 方案`);
        const s2 = postMail('01', `【方案驳回待人工】${id} 被 01 驳回：${reason}（已通知工号 ${who}；进人工待审核箱）`);
        pushManual(id, `驳回：${reason}`, '01');
        logLine(`[plan] ${id} 驳回 → 邮件 ${s1}/${s2}，进人工箱`);
        sendJson(res, 200, { ok: true, id, planState: '驳回', mailSeq: s1, mailSeqTo01: s2, manual: true });
      }
    } catch (error) {
      sendJson(res, 409, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/') {
    const html = renderPage();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: '只支持 GET，花钱的只有 POST /api/dispatch' }); return; }
  sendJson(res, 404, { ok: false, error: '只有 /、/api/agents、/api/tasks、/api/worklist、/api/mail、/api/send、/api/health、/api/health/components；POST /api/dispatch|accept|reject|send' });
}

// ── WS-009：窗口壳令牌同源 ──────────────────────────────────────────────────
// 规矩：工作台的玻璃值**不手抄**，运行时从窗口壳的 tokens.css 读进来，注入成同名 CSS 变量。
// 这样窗口壳调玻璃（AV-008/AV-010 那两次）工作台自动跟上，不会再出现「像但不是一套」。
const SHELL_TOKENS_FILE = 'E:\\DeepFish\\avatar\\window\\web\\styles\\tokens.css';
// 只注入工作台用得上的、且**不与工作台自有变量撞名**的令牌。
// （--fg / --accent 在两边同名但值不同，撞名会互相覆盖，所以改名为 --xg-token-fg / --xg-token-accent）
const SHELL_TOKEN_KEYS = [
  '--l0-a', '--l0-b', '--l1-bg', '--l1-blur', '--l1-sat', '--l1-border',
  '--l2-bg', '--l2-line', '--l2-shadow', '--glass-sat', '--glass-shadow',
  '--radius-panel', '--radius-ctl', '--radius-pill',
];
// 读不到 tokens.css 时的兜底（= 2026-11-04 tokens.css 的值，别在这里"顺手优化"）
const SHELL_TOKEN_FALLBACK = {
  '--l0-a': '#F7F9FB', '--l0-b': '#EDF2F7',
  '--l1-bg': 'rgba(255, 255, 255, 0.81)', '--l1-blur': '24px', '--l1-sat': '150%', '--l1-border': 'rgba(255, 255, 255, 0.65)',
  '--l2-bg': '#FFFFFF', '--l2-line': '#DCE4EC', '--l2-shadow': '0 8px 24px rgba(15, 23, 42, 0.06)',
  '--glass-sat': '150%', '--glass-shadow': '0 8px 32px rgba(15, 23, 42, 0.10)',
  '--radius-panel': '16px', '--radius-ctl': '12px', '--radius-pill': '999px',
  '--fg': '#23262b', '--accent2': '#5b7cfa',
};

/** 从窗口壳 tokens.css 的 :root 里抽令牌；失败返回 {ok:false}，调用方用兜底。只读。 */
function readShellTokens() {
  let raw = '';
  try { raw = fs.readFileSync(SHELL_TOKENS_FILE, 'utf8'); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  const block = raw.match(/:root\s*\{([\s\S]*?)\}/);
  if (!block) return { ok: false, error: 'tokens.css 里找不到 :root 块' };
  const all = {};
  for (const m of block[1].matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) all[m[1]] = m[2].trim();
  const vars = {};
  for (const k of SHELL_TOKEN_KEYS) if (all[k]) vars[k] = all[k];
  // 这两个在窗口壳里叫 --fg / --accent2，工作台另有同名变量，所以带出来换名用
  if (all['--fg']) vars['--shell-fg'] = all['--fg'];
  if (all['--accent2']) vars['--shell-accent'] = all['--accent2'];
  const missing = SHELL_TOKEN_KEYS.filter((k) => !vars[k]);
  return { ok: true, vars, missing, mtime: fs.statSync(SHELL_TOKENS_FILE).mtime.toISOString() };
}

const SHELL_TOKENS = readShellTokens();
/** 生成注入到页面 <style> 开头的 :root 块（含判据①要读的 7 个 --xg-* 别名） */
function shellTokenCss() {
  const v = { ...SHELL_TOKEN_FALLBACK, ...(SHELL_TOKENS.ok ? SHELL_TOKENS.vars : {}) };
  const pick = (k) => v[k] ?? SHELL_TOKEN_FALLBACK[k];
  const src = SHELL_TOKENS.ok
    ? `同源：${SHELL_TOKENS_FILE}（mtime ${SHELL_TOKENS.mtime}）`
    : `**读不到 tokens.css，用的是内置兜底值**（${SHELL_TOKENS.error}）`;
  return `  /* WS-009 令牌同源层 —— ${src}
     下面 --l* / --glass-* / --radius-* 的数值全部来自窗口壳，本文件不手抄；
     --xg-* 是判据①要读的别名（窗口壳里就是这套玻璃语义）。 */
  :root{
    ${SHELL_TOKEN_KEYS.map((k) => `${k}: ${pick(k)};`).join('\n    ')}
    --xg-glass-bg: var(--l1-bg);
    --xg-glass-border: var(--l1-border);
    --xg-glass-blur: var(--l1-blur);
    --xg-glass-shadow: var(--glass-shadow);
    --xg-token-bg: var(--l2-bg);
    --xg-token-fg: ${pick('--shell-fg')};
    --xg-token-accent: ${pick('--shell-accent')};
  }`;
}

// ── WS-031：把 console-view.mjs 内联进页面（去 export），单测 import 的是同一份源码 ──
const CONSOLE_LIB_FILE = path.join(WORKSPACE, 'scripts', 'lib', 'console-view.mjs');
let CONSOLE_LIB_CACHE = null;
function consoleLibSource() {
  if (CONSOLE_LIB_CACHE != null) return CONSOLE_LIB_CACHE;
  try {
    CONSOLE_LIB_CACHE = fs.readFileSync(CONSOLE_LIB_FILE, 'utf8').replace(/^export\s+/gm, '');
  } catch (e) {
    CONSOLE_LIB_CACHE = '/* console-view.mjs 读不到：' + String(e?.message ?? e) + ' */';
  }
  return CONSOLE_LIB_CACHE;
}

// ── 页面 ────────────────────────────────────────────────────────────────────
function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鲟鱼工作组 · 工作台</title>
<style>
${shellTokenCss()}
  /* UI 规格 v1（docs\UI规格-v1.md）：暖白 + 浅灰 + 蓝。改这里之前先改规格。
     WS-009：颜色/圆角/模糊/阴影不再手抄——引用上面同源层注入的窗口壳令牌。 */
  :root{--bg:#F7F9FB;--panel:var(--l2-bg);--panel2:#EDF2F7;--line:var(--l2-line);
        --fg:#1B2733;--dim:#5A6B7B;--weak:#8A97A4;
        --accent:#4C9BE8;--accent-h:#2E6FB0;--accent-soft:#E3F0FB;
        --ok:#3E9C7A;--warn:#C98A2E;--bad:#C25B52;--purple:#2E6FB0;
        --r-card:var(--radius-ctl);--r-panel:var(--radius-panel);--r-pill:var(--radius-pill);
        --glass-hi:rgba(255,255,255,.85)}
  /* WS-015：默认态与窗口壳对齐 = **关玻璃**（可读优先）。不带 data-glass 或 =0 都走这套；
     要磨砂得显式 html[data-glass="1"]——那时 :not() 不匹配，用上面注入的窗口壳玻璃值。 */

  html:not([data-glass="1"]){--l1-bg:#ffffff;--l1-blur:0px;--l1-sat:100%;--glass-sat:100%;--glass-shadow:none}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:linear-gradient(160deg,var(--l0-a) 0%,var(--l0-b) 100%);background-attachment:fixed;color:var(--fg);font:13px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  /* L1 外壳磨砂：顶栏（blur/saturate 与窗口壳同一批令牌） */
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--xg-glass-border);background:var(--xg-glass-bg);backdrop-filter:blur(var(--xg-glass-blur)) saturate(var(--glass-sat));-webkit-backdrop-filter:blur(var(--xg-glass-blur)) saturate(var(--glass-sat));position:sticky;top:0;z-index:5}
  .tabs{display:flex;gap:8px}
  .tab{padding:4px 12px;border:1px solid var(--line);border-radius:var(--r-pill);color:var(--dim);background:var(--glass-hi);font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px}
  .tab:hover{background:var(--panel2)}
  .tab.on{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
  .badge{font-size:12px;padding:0 8px;border-radius:999px;background:var(--bad);color:#fff;min-width:20px;text-align:center;line-height:18px}
  .badge.zero{background:var(--line);color:var(--dim)}
  .grow{flex:1}.meta{color:var(--dim);font-size:12px}
  #unlinked{display:none;padding:8px 16px;color:var(--warn);background:var(--panel2);border-bottom:1px solid var(--line)}
  main{padding:16px;max-width:1400px}
  .view[hidden]{display:none}
  h2{margin:0 0 12px;font-size:20px;font-weight:600;color:var(--fg)}
  h2 .count{color:var(--dim);font-weight:400;font-size:13px}
  section.card{background:var(--l2-bg);border:1px solid var(--l2-line);border-radius:var(--r-card);box-shadow:var(--l2-shadow);overflow:hidden;margin-bottom:16px}
  .row{padding:12px 16px;border-bottom:1px solid var(--line)}
  .row:last-child{border-bottom:0}
  .row:hover{background:var(--bg)}
  .r1{display:flex;gap:8px;align-items:baseline}
  .dot{width:8px;height:8px;border-radius:999px;background:var(--line);flex:none;border:1px solid var(--line)}
  .dot.live{background:var(--ok);border-color:var(--ok)}
  .dot.run{background:var(--accent);border-color:var(--accent)}
  .dot.stuck{background:var(--panel);border:1px dashed var(--dim)}
  .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tag{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:0 8px;flex:none;line-height:18px;white-space:nowrap}
  .tag.q{color:var(--dim);border-color:var(--line)}
  .tag.do{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
  .tag.sub{color:var(--warn);border-color:var(--line);background:var(--panel2)}
  .tag.plan{color:var(--purple);border-color:var(--line);background:var(--accent-soft)}
  .tag.ok{color:var(--ok);border-color:var(--line);background:var(--panel2)}
  .tag.bad{color:var(--bad);border-color:var(--line);background:var(--panel2)}
  .tag.blk{border-style:dashed;color:var(--dim)}
  .doing{color:var(--accent);margin-top:4px;word-break:break-all}
  .sub{color:var(--dim);font-size:12px;margin-top:4px;word-break:break-all}
  .sub a{color:var(--accent)}
  .btn{font:inherit;font-size:12px;padding:2px 12px;border-radius:var(--r-pill);border:1px solid var(--line);background:var(--l2-bg);color:var(--fg);cursor:pointer}
  .btn:hover{background:var(--panel2)}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn.pri{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
  .btn.pri:hover{background:var(--accent);color:#fff}
  .btn.bad{border-color:var(--bad);color:var(--bad);background:var(--panel2)}
  .empty{padding:16px;color:var(--weak)}
  .hrow{display:grid;grid-template-columns:64px 1fr 96px 128px 72px;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line);align-items:baseline;font-size:12px}
  .hrow:last-child{border-bottom:0}
  .hrow:hover{background:var(--bg)}
  .hrow.head{color:var(--dim);font-size:12px;background:var(--panel2)}
  .hrow .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hrow.badrow{background:var(--panel2)}
  .hgroup{padding:8px 16px;border-bottom:1px solid var(--line);background:var(--panel2);font-weight:600;color:var(--fg);font-size:14px}
  .buckets{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px 16px}
  .bkt{background:var(--l2-bg);border:1px solid var(--l2-line);border-radius:var(--r-card);padding:8px 12px;cursor:pointer}
  .bkt:hover{border-color:var(--accent)}
  .bkt.on{border-color:var(--accent);background:var(--accent-soft)}
  .bkt .k{color:var(--dim);font-size:12px}
  .bkt .v{font-size:16px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
  .bkt .s{color:var(--dim);font-size:12px}
  .arow{display:grid;grid-template-columns:1fr 62px 96px 84px 96px;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line);font-size:12px;align-items:baseline}
  .arow.head{color:var(--dim);font-size:12px;background:var(--panel2)}
  .arow .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .prow{padding:12px 16px;border-bottom:1px solid var(--line)}
  .prow:last-child{border-bottom:0}
  .prow:hover{background:var(--bg)}
  .prow.bad{background:var(--panel2)}
  .prow .r1{display:flex;gap:8px;align-items:baseline}
  footer{padding:12px 16px;color:var(--dim);font-size:12px;border-top:1px solid var(--xg-glass-border);background:var(--xg-glass-bg)}
  footer .fname{color:var(--accent)}
  /* L1 外壳磨砂：右抽屉（与顶栏同一批令牌；遮罩/圆角按窗口壳 16px） */
  #drawer{position:fixed;top:0;right:0;bottom:0;width:520px;max-width:94vw;background:var(--xg-glass-bg);backdrop-filter:blur(var(--xg-glass-blur)) saturate(var(--glass-sat));-webkit-backdrop-filter:blur(var(--xg-glass-blur)) saturate(var(--glass-sat));border-left:1px solid var(--xg-glass-border);border-radius:var(--r-panel) 0 0 var(--r-panel);z-index:20;display:flex;flex-direction:column;box-shadow:var(--glass-shadow)}
  #drawer[hidden]{display:none}
  .dhead{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
  .dtabs{display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line)}
  .dtab{padding:4px 12px;border:1px solid var(--line);border-radius:var(--r-pill);color:var(--dim);background:var(--l2-bg);font:inherit;cursor:pointer}
  .dtab.on{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
  .dview{flex:1;overflow:auto;display:none}
  .dview.on{display:block}
  .dfoot{padding:8px 16px;border-top:1px solid var(--line);display:flex;gap:8px;align-items:center}
  .grp{border:1px solid var(--l2-line);border-radius:var(--r-card);margin-bottom:12px;overflow:hidden;background:var(--l2-bg)}
  .grp summary{padding:12px 16px;cursor:pointer;background:var(--panel2);font-weight:600;display:flex;gap:8px;align-items:center;list-style:none}
  .grp summary::-webkit-details-marker{display:none}
  .grp[open] summary{border-bottom:1px solid var(--line)}
  .grow-sum{flex:1}
  .gsm{color:var(--dim);font-weight:400;font-size:12px}
  .total{display:flex;align-items:baseline;gap:16px;padding:16px 16px 8px}
  .total .big{font-size:32px;font-weight:700;letter-spacing:-1px;font-variant-numeric:tabular-nums}
  .total .lbl{color:var(--dim);font-size:12px}
  .bar{display:flex;height:24px;border-radius:var(--r-card);overflow:hidden;margin:8px 16px 4px}
  .bar > span{display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:600;white-space:nowrap}
  .bar .b1{background:var(--accent)}.bar .b2{background:var(--accent-h)}.bar .b3{background:var(--ok)}.bar .b4{background:var(--dim)}
  /* D43：项目视图 */
  .psec{padding:12px 0 8px;font-size:14px;font-weight:600;color:var(--fg)}
  .pdoing{padding:8px 16px;border:1px solid var(--l2-line);border-radius:var(--r-card);background:var(--accent-soft);margin-bottom:8px;font-size:12px}
  .pcard{background:var(--l2-bg);border:1px solid var(--l2-line);border-radius:var(--r-card);margin-bottom:12px;overflow:hidden}
  .pcard summary{padding:12px 16px;cursor:pointer;display:flex;gap:8px;align-items:baseline;list-style:none}
  .pcard summary::-webkit-details-marker{display:none}
  .pcard[open] summary{border-bottom:1px solid var(--line)}
  .pname{font-weight:600;font-size:14px}
  .psum{padding:8px 16px 0;color:var(--dim);font-size:12px}
  .pbar{height:8px;border-radius:999px;background:var(--panel2);margin:8px 16px;overflow:hidden}
  .pbar span{display:block;height:100%;background:var(--accent);border-radius:999px}
  .pmeta{padding:0 16px 12px;font-size:12px;color:var(--dim)}
  .doclink{color:var(--accent);text-decoration:none}
  .doclink:hover{text-decoration:underline}
  .pfeat{padding:0 16px 12px}
  .feat{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px dashed var(--line);font-size:12px}
  .feat:last-child{border-bottom:0}
  .fname2{flex:1}
  .donefold{margin-top:16px;border-color:var(--line)}
  .doneTitle{color:var(--dim);font-weight:600}
  /* D89：代持发送（看板下方那一条） */
  .sendbox{padding:10px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line)}
  .sendbox input{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:var(--r-card);background:var(--l2-bg);color:var(--fg)}
  .sendbox input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
  .sendbox input.chat{width:190px}
  .sendbox input.text{flex:1;min-width:240px}
  .sendrow{display:grid;grid-template-columns:64px 1fr 96px 1fr;gap:8px;padding:6px 16px;border-bottom:1px solid var(--line);font-size:12px;align-items:baseline}
  .sendrow:last-child{border-bottom:0}
  .sendrow.head{color:var(--dim);background:var(--panel2)}
  .sendrow .cut{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  /* ── WS-017 调度台（工作台里的"台前"）─────────────────────────────────
     三块：服务红绿灯 / 票与工人 / 最近事件。红绿灯**不只靠颜色**：每盏灯带图标 + 文字，
     颜色只是第三重信号。点灯开小窗（重启 / 看日志），重启一律二次确认。 */
  .sup-src{margin:-4px 0 12px;color:var(--dim);font-size:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .sup-src .pill{border:1px solid var(--line);border-radius:999px;padding:0 8px;line-height:18px;background:var(--l2-bg)}
  .sup-src .pill.ok{color:var(--ok);border-color:var(--ok)}
  .sup-src .pill.warn{color:var(--warn);border-color:var(--warn)}
  .sup-src .pill.demo{color:var(--bad);border-color:var(--bad)}
  .sup-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start}
  /* WS-029：宽屏固定四列，让 ①服务 ②渠道 ③脑子 ④票与工人 一行全看得见；事件流整行铺底 */
  @media (min-width:1200px){ .sup-grid{grid-template-columns:repeat(4,minmax(0,1fr))} }
  .sup-card{background:var(--l2-bg);border:1px solid var(--l2-line);border-radius:var(--r-card);box-shadow:var(--l2-shadow);overflow:hidden;margin:0}
  .sup-h{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);font-weight:600;font-size:13px}
  .sup-h .count{color:var(--dim);font-weight:400;font-size:12px}
  .sup-h .btn{margin-left:auto}
  .sup-lights{display:grid;grid-template-columns:1fr}
  .sup-light{display:flex;gap:8px;align-items:flex-start;padding:9px 14px;border:0;border-bottom:1px solid var(--line);background:none;color:inherit;font:inherit;text-align:left;width:100%;cursor:pointer}
  .sup-light:hover{background:var(--bg)}
  .sup-light:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .sup-light .ico{width:16px;flex:none;text-align:center;font-size:13px;line-height:18px}
  .sup-light .nm{flex:1;min-width:0;line-height:18px}
  .sup-light .n{font-weight:600}
  .sup-light .p{color:var(--dim);font-size:12px;margin-left:6px}
  .sup-light .s{display:block;color:var(--weak);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sup-light .st{font-size:12px;color:var(--dim);flex:none;white-space:nowrap;line-height:18px}
  .sup-light.up .ico{color:var(--ok)}
  .sup-light.down .ico{color:var(--bad)}
  .sup-light.off .ico{color:var(--weak)}
  .sup-light.down{background:var(--panel2)}
  .sup-light.down .st{color:var(--bad);font-weight:600}
  .sup-p{display:grid;grid-template-columns:58px 1fr 82px 62px;gap:8px;padding:7px 14px;border-bottom:1px solid var(--line);font-size:12px;align-items:baseline}
  .sup-p.head{color:var(--dim);background:var(--panel2)}
  .sup-p .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sup-p .tm{color:var(--dim);text-align:right;font-variant-numeric:tabular-nums}
  .sup-sum{padding:8px 14px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);background:var(--panel2)}
  /* WS-029：② 渠道 / ③ 脑子 两栏（纯前端；数据来自 /api/console，没上线就明确降级） */
  .sup-card.wide{grid-column:1/-1}
  .sup-note{display:flex;gap:8px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--line);color:var(--dim);font-size:12px;background:var(--panel2)}
  .sup-note.warn{color:var(--warn)}
  .sup-note.bad{color:var(--bad)}
  .sup-note .btn{margin-left:auto;flex:none}
  .chan-row{display:grid;grid-template-columns:16px 62px 1fr auto;gap:8px;align-items:baseline;padding:9px 14px;border-bottom:1px solid var(--line);font-size:12px}
  .chan-row:last-child{border-bottom:0}
  .chan-row .ico{text-align:center;line-height:18px}
  .chan-row .nm{font-weight:600}
  .chan-row .det{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chan-row .st{white-space:nowrap;color:var(--dim)}
  .chan-row.on .ico,.chan-row.on .st{color:var(--ok)}
  .chan-row.off .ico,.chan-row.off .st{color:var(--bad);font-weight:600}
  /* 未接入：灰底 + 灰字，一眼看出"没做"，不是"挂了" */
  .chan-row.na{background:var(--panel2)}
  .chan-row.na .ico,.chan-row.na .st,.chan-row.na .det{color:var(--weak)}
  .brain-grid{display:grid;grid-template-columns:1fr 1fr}
  .brain-cell{padding:9px 14px;border-bottom:1px solid var(--line)}
  .brain-cell .k{color:var(--dim);font-size:12px}
  .brain-cell .v{font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .brain-cell .s{color:var(--weak);font-size:11px;margin-top:2px}
  .brain-cell.gray .v{color:var(--weak);font-weight:400}
  /* ── WS-030 诊断 / 设置 / 桥接 ─────────────────────────────────────── */
  .hgroup select,.hgroup input{font:inherit;font-size:12px;padding:2px 8px;border:1px solid var(--line);border-radius:var(--r-pill);background:var(--l2-bg);color:var(--fg)}
  .hgroup input[type=checkbox]{padding:0}
  .chk{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--dim);white-space:nowrap}
  .diag-row{display:grid;grid-template-columns:22px 140px 1fr 64px;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line);font-size:12px;align-items:baseline}
  .diag-row:last-child{border-bottom:0}
  .diag-row .ico{text-align:center;line-height:18px}
  .diag-row.ok .ico{color:var(--ok)}
  .diag-row.bad .ico{color:var(--bad);font-weight:600}
  .diag-row .nm{font-weight:600}
  .diag-row .det{color:var(--dim);word-break:break-all}
  .diag-row .ms{color:var(--weak);text-align:right;font-variant-numeric:tabular-nums}
  .logbox{height:46vh;overflow:auto;font:12px/1.55 ui-monospace,Consolas,monospace;background:var(--panel2);padding:8px 12px}
  .logbox .ln{white-space:pre-wrap;word-break:break-all}
  .logbox .ln.error{color:var(--bad)}
  .logbox .ln.warn{color:var(--warn)}
  .logbox .ln .tm{color:var(--weak)}
  .setgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;align-items:start}
  .setcard{background:var(--l2-bg);border:1px solid var(--l2-line);border-radius:var(--r-card);overflow:hidden;margin:0}
  .setcard .hh{padding:10px 14px;border-bottom:1px solid var(--line);font-weight:600;font-size:13px}
  .field{display:grid;grid-template-columns:104px 1fr;gap:8px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--line);font-size:12px}
  .field:last-child{border-bottom:0}
  .field>label{color:var(--dim)}
  .field input,.field select{font:inherit;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--l2-bg);color:var(--fg);width:100%}
  .field .hint{grid-column:2;color:var(--weak);font-size:11px}
  .masked{font-family:ui-monospace,Consolas,monospace;color:var(--dim)}
  .brhead{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
  .bcell{padding:10px 14px;border-bottom:1px solid var(--line);font-size:12px}
  .bcell .k{color:var(--dim)}
  .bcell .v{font-weight:600;margin-top:2px}
  .acts{display:flex;gap:8px;padding:10px 14px;flex-wrap:wrap;border-top:1px solid var(--line)}
  .sup-ev{display:grid;grid-template-columns:58px 18px 1fr;gap:8px;padding:6px 14px;border-bottom:1px solid var(--line);font-size:12px;align-items:baseline}
  .sup-ev:last-child{border-bottom:0}
  .sup-ev .t{color:var(--dim);font-variant-numeric:tabular-nums}
  .sup-ev .d{word-break:break-all}
  .sup-ev.bad .d{color:var(--bad)}
  .sup-ev.ok .d{color:var(--ok)}
  .sup-ev.note{padding:8px 14px;color:var(--weak);font-size:11px;display:block}
  #supM{position:fixed;inset:0;background:rgba(15,23,42,.42);display:none;align-items:center;justify-content:center;z-index:40}
  #supM.on{display:flex}
  .sup-dlg{width:min(470px,92vw);max-height:86vh;overflow:auto;background:var(--l2-bg);border:1px solid var(--l2-line);border-radius:var(--r-panel);box-shadow:var(--l2-shadow);padding:16px}
  .sup-dlg h3{margin:0 0 6px;font-size:15px}
  .sup-dlg .sub{color:var(--dim);font-size:12px;margin-bottom:12px}
  .sup-dlg textarea{width:100%;height:200px;font:12px/1.5 ui-monospace,Consolas,monospace;background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:var(--r-card);padding:8px;resize:vertical}
  .sup-dlg .row2{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
  #supToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--fg);color:var(--l2-bg);padding:8px 16px;border-radius:999px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:50;max-width:88vw}
  #supToast.on{opacity:1}
  @media (max-width:1000px){ .sup-grid{grid-template-columns:1fr} }
  /* ── WS-009 窄屏回归（判据③：280px 不许横向滚动、不许文字溢出）────────────
     原来 .hrow/.arow/.sendrow 都是固定像素列（64+96+128+72 ≈ 360px），280px 一定撑爆；
     窄屏一律改成可换行的 flex 堆叠，主列（.nm/.cut）独占一整行。 */
  @media (max-width:560px){
    header{padding:8px 10px;gap:8px}
    header .tabs{gap:6px;flex-wrap:wrap}
    header .meta{order:99;flex:1 1 100%;font-size:11px}
    main{padding:10px}
    h2{font-size:17px;margin-bottom:8px}
    .row{padding:10px}
    .r1{flex-wrap:wrap}
    /* .name 原来是 flex:1（basis 0），窄屏会被兄弟 .tag 挤到 5px 宽；给它 60% 的底，逼标签换行 */
    .r1 .name{flex:1 1 60%;min-width:0;white-space:normal;overflow-wrap:anywhere}
    .name{white-space:normal;overflow-wrap:anywhere}
    .hrow{display:flex;flex-wrap:wrap;gap:4px 8px;padding:8px 10px}
    .hrow>span{flex:0 0 auto;min-width:0}
    .hrow .nm{flex:1 1 100%;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}
    .hrow.head{display:none}
    .arow{display:flex;flex-wrap:wrap;gap:4px 8px;padding:6px 10px}
    .arow .nm{flex:1 1 100%;white-space:normal;overflow-wrap:anywhere}
    .arow.head{display:none}
    .buckets{grid-template-columns:1fr 1fr;padding:8px 10px}
    .hgroup{padding:8px 10px}
    .sendbox{padding:8px 10px}
    .sendbox input.chat{width:100%;flex:1 1 100%}
    .sendbox input.text{min-width:0;flex:1 1 100%}
    .sendrow{display:flex;flex-wrap:wrap;gap:4px 8px;padding:6px 10px}
    .sendrow .cut{flex:1 1 100%;white-space:normal;overflow-wrap:anywhere}
    .sendrow.head{display:none}
    #drawer{width:100vw;max-width:100vw;border-radius:0}
    .dhead,.dtabs,.dfoot{flex-wrap:wrap;padding:8px 10px;gap:6px}
    .total{padding:10px;gap:10px}
    .total .big{font-size:24px}
    footer{padding:10px}
  }
  /* ── 深墨模式（ST-118）：只覆盖颜色 ───────────────────────────── */
  @media (prefers-color-scheme: dark){
    :root{--bg:#141A21;--panel:#1B232C;--panel2:#222C36;--line:#2C3946;
          --fg:#E8EEF4;--dim:#9AAAAF;--weak:#6F7C89;
          --accent:#5FA8E8;--accent-h:#4C9BE8;--accent-soft:#1F2C3A;
          --ok:#5FBF9A;--warn:#D9A34E;--bad:#D97B72;--purple:#5FA8E8;
          --glass-hi:rgba(255,255,255,.10);
          --l0-a:#141A21;--l0-b:#10151B;--l1-bg:rgba(27,35,44,.88);--l1-border:rgba(255,255,255,.10);
          --l2-bg:#1B232C;--l2-line:#2C3946;--l2-shadow:none;--xg-glass-border:rgba(255,255,255,.10)}
    html:not([data-glass="1"]){--l1-bg:#1B232C;--l1-blur:0px;--l1-sat:100%;--glass-shadow:none}
    body{background:linear-gradient(160deg,var(--l0-a) 0%,var(--l0-b) 100%)}
</style>
</head>
<body>
<header>
  <strong>🐟 工作台</strong>
  <nav class="tabs">
    <button class="tab on" data-view="projects">项目</button>
    <button class="tab" data-view="dispatch" title="服务红绿灯 / 票与工人 / 最近事件（WS-017）">调度台</button>
    <button class="tab" data-view="diag" title="自检 + 内核日志（WS-030）">诊断</button>
    <button class="tab" data-view="settings" title="模型 / 采样 / 桥 / 人设（WS-030）">设置</button>
    <button class="tab" data-view="bridge" title="QQ 桥控制台（WS-030 §6）">桥接</button>
    <button class="tab" data-view="board">看板</button>
    <button class="tab" data-view="blockers">卡点 <span class="badge zero" id="b-blockers">0</span></button>
    <button class="tab" data-view="unacked" title="派出去了、超过阈值还没有 accepted 回执的票（只在内存里算）">未回执 <span class="badge zero" id="b-unacked">0</span></button>
    <button class="tab" data-view="cost">花费</button>
  </nav>
  <span class="grow"></span>
  <span class="meta" id="meta">连接中…</span>
  <button class="btn" id="drawerBtn">☰ 更多</button>
</header>
  <div id="drill" style="display:none;background:var(--panel2);border:1px solid var(--line);color:var(--warn);padding:6px 10px;border-radius:6px;margin:6px 0"></div>
  <div id="unlinked"></div>
<main>
  <div class="view" id="view-projects">
    <h2>项目 <span class="count" id="c-projects">读取中…</span></h2>
    <div id="pj-doing"></div>
    <div id="pj-list"><div class="empty">读取中…</div></div>
    <div id="pj-unstarted"></div>
    <div id="pj-done"></div>
  </div>
  <div class="view" id="view-board" hidden>
    <div id="board"><div class="empty">读取中…</div></div>
    <!-- D89：会话区下方的代持发送。页面永远只入队，发送由 runner 顺序执行（不在这里跑） -->
    <section class="card" id="sendcard">
      <div class="hgroup">代持发送 <span class="count" id="send-hint" style="font-weight:400">—</span></div>
      <div class="sendbox">
        <input class="chat" id="send-chat" list="send-chats" placeholder="会话名（必填）" autocomplete="off">
        <datalist id="send-chats"></datalist>
        <input class="text" id="send-text" placeholder="要发的内容；由后台 runner 逐条顺序发送" autocomplete="off">
        <button class="btn pri" id="send-btn">加入队列</button>
      </div>
      <div class="sendrow head"><span>时间</span><span>会话 / 内容</span><span>状态</span><span>说明</span></div>
      <div id="sendrecent"><div class="empty">读取中…</div></div>
    </section>
  </div>
  <div class="view" id="view-blockers" hidden>
    <h2>卡点 <span class="count" id="c-blockers">—</span></h2>
    <div id="blockers"><div class="empty">读取中…</div></div>
  </div>
  <div class="view" id="view-unacked" hidden>
    <h2>未回执 <span class="count" id="c-unacked">—</span></h2>
    <div id="unacked"><div class="empty">读取中…</div></div>
  </div>
  <div class="view" id="view-cost" hidden>
    <h2>今日花费 <span class="count" id="c-cost">今日 · 按归属</span></h2>
    <div id="cost"><div class="empty">读取中…</div></div>
  </div>
  <div class="view" id="view-dispatch" hidden>
    <h2>调度台 <span class="count" id="c-dispatch">读取中…</span></h2>
    <div class="sup-src" id="supSrc"></div>
    <div class="sup-grid">
      <section class="sup-card">
        <div class="sup-h">服务红绿灯 <span class="count" id="supSvcCount">—</span>
          <button class="btn" id="supRestartDown" title="只重启「挂了」的那些；点了还要再确认一次">重启挂掉的</button></div>
        <div class="sup-lights" id="supLights"><div class="empty">读取中…</div></div>
      </section>
      <section class="sup-card" id="cardChannels">
        <div class="sup-h">② 渠道 <span class="count" id="supChanCount">—</span></div>
        <div class="sup-note" id="supChanNote" hidden></div>
        <div id="supChannels"><div class="empty">读取中…</div></div>
      </section>
      <section class="sup-card" id="cardBrain">
        <div class="sup-h">③ 脑子 <span class="count" id="supBrainCount">—</span></div>
        <div class="sup-note" id="supBrainNote" hidden></div>
        <div id="supBrain"><div class="empty">读取中…</div></div>
      </section>
      <section class="sup-card">
        <div class="sup-h">票与工人 <span class="count" id="supPeopleCount">—</span></div>
        <div id="supPeople"><div class="empty">读取中…</div></div>
      </section>
      <section class="sup-card wide">
        <div class="sup-h">最近事件 <span class="count" id="supEvCount">—</span></div>
        <div id="supEvents"><div class="empty">读取中…</div></div>
      </section>
    </div>
  </div>
  <div class="view" id="view-diag" hidden>
    <h2>诊断 <span class="count" id="diagSum">读取中…</span>
      <button class="btn" id="diagRerun">重跑自检</button></h2>
    <section class="card">
      <div class="hgroup">自检 <span class="count" id="diagAt"></span></div>
      <div id="diagChecks"><div class="empty">读取中…</div></div>
    </section>
    <section class="card">
      <div class="hgroup">日志
        <select id="logSrc"><option value="kernel">内核</option><option value="bridge">桥</option><option value="services">服务</option></select>
        <input id="logKw" placeholder="关键字过滤" style="width:180px">
        <label class="chk"><input type="checkbox" id="logErr"> 仅异常</label>
        <span class="count" id="logAt"></span>
      </div>
      <div id="logBox" class="logbox">读取中…</div>
    </section>
  </div>
  <div class="view" id="view-settings" hidden>
    <h2>设置 <span class="count" id="setAt">—</span>
      <button class="btn pri" id="setSave">保存</button></h2>
    <div class="setgrid" id="setGrid"></div>
  </div>
  <div class="view" id="view-bridge" hidden>
    <h2>桥接 · QQ 桥 <span class="count" id="brSum">读取中…</span>
      <button class="btn" id="brRefresh">刷新</button></h2>
    <section class="card">
      <div class="brhead" id="brHead"></div>
      <div class="acts">
        <button class="btn" id="brRestart">重启桥</button>
        <button class="btn" id="brRtoken">刷新令牌</button>
        <button class="btn" id="brQueue">看队列</button>
      </div>
    </section>
    <div class="setgrid">
      <section class="setcard"><div class="hh">开关（只改白名单五个字段）</div><div id="brToggles"><div class="empty">读取中…</div></div></section>
      <section class="setcard"><div class="hh">权限 / 窗口</div><div id="brPerms"><div class="empty">读取中…</div></div></section>
    </div>
    <section class="card" style="margin-top:16px">
      <div class="hgroup">桥日志
        <label class="chk"><input type="checkbox" id="brFollow" checked> 跟随</label>
        <label class="chk"><input type="checkbox" id="brOnlyErr"> 仅错误</label>
        <label class="chk"><input type="checkbox" id="brSplit"> 分开</label>
        <span class="grow"></span>
        <button class="btn" id="brPause">暂停</button>
        <button class="btn" id="brCopy">复制</button>
      </div>
      <div id="brLogBox" class="logbox">读取中…</div>
    </section>
  </div>
</main>
<div id="supM" role="dialog" aria-modal="true" aria-labelledby="supDlgTitle"><div class="sup-dlg" id="supDlg"></div></div>
<div id="supToast" role="status" aria-live="polite"></div>
<aside id="drawer" hidden>
  <div class="dhead"><strong>更多</strong><span class="grow"></span><button class="btn" id="drawerClose">× 关闭</button></div>
  <nav class="dtabs">
    <button class="dtab on" data-d="mail">邮件</button>
    <button class="dtab" data-d="health">会话检测</button>
    <button class="dtab" data-d="ledger">全台账</button>
  </nav>
  <div class="dview on" id="d-mail"><div class="empty">读取中…</div></div>
  <div class="dview" id="d-health"><div class="empty">点开即采样…</div></div>
  <div class="dview" id="d-ledger"><div class="empty">读取中…</div></div>
  <div class="dfoot">
    <button class="btn" id="relayBtn" title="空闲且有排队时自动派下一件（每 10 秒看一次，一轮最多一件）">自动接力 …</button>
    <span class="sub" id="relayLast" style="margin:0">—</span>
  </div>
</aside>
<footer>只读数据全部本地（sessions/list 投影 · worklist.jsonl · records/交付 · 邮件池）· 每 5 秒刷新 · 花钱的只有「派发」
  <span class="fname" style="margin-left:8px">构建 ${BUILD_TAG}</span>
  <div id="recent">最近交付：—</div>
</footer>
<script>
${consoleLibSource()}
const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=(t)=>t?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'—';
async function j(u,opt){const r=await fetch(u,opt?{cache:'no-store',...opt}:{cache:'no-store'});const t=await r.text();try{return JSON.parse(t)}catch(e){throw new Error(u+' 非 JSON')}}

// ── 看板：按组折叠（本体 / 工作组 / QQ 通道 / 其他）────────────────────────
const GROUP_ORDER=['工作组','本体','QQ 通道','其他'];
// 规格 §5：默认只展开两个主集合（鲟鱼侧=本体、DSH 侧=工作组），其余默认折叠；展开状态记 localStorage。
const GROUP_OPEN_DEFAULT={'工作组':true,'本体':true,'QQ 通道':false,'其他':false,'__history__':false};
function groupOpen(g){
  try{const s=JSON.parse(localStorage.getItem('desk-groups')||'null');if(s&&typeof s[g]==='boolean')return s[g]}catch(e){}
  return Boolean(GROUP_OPEN_DEFAULT[g]);
}
function saveGroupOpen(g,open){
  try{let s={};try{s=JSON.parse(localStorage.getItem('desk-groups')||'{}')||{}}catch(e){}
    s[g]=open;localStorage.setItem('desk-groups',JSON.stringify(s))}catch(e){}
}
function groupOf(a){
  if(a.no)return '工作组';
  const t=String(a.title||'');
  if(/本体/.test(t))return '本体';
  if(/QQ|子实体|黑话/.test(t))return 'QQ 通道';
  return '其他';
}
function prettyName(a){
  const t=String(a.title||'');
  return a.no?('工号'+a.no):(t.replace(/^鲟鱼工作组/,'').replace(/^鲟鱼[—-]/,'')||t);
}
/** 折叠态摘要：在干 N / 空闲 M + 最该看的一条（卡住优先 > 在干 > 最久空闲）。 */
function groupSummary(list){
  const live=list.filter(a=>a.live||a.running);
  const stuck=list.filter(a=>!(a.live||a.running)&&(a.idleMs||0)>30*60*1000).sort((x,y)=>(y.idleMs||0)-(x.idleMs||0));
  let hint='';
  if(stuck.length)hint='⏸ '+prettyName(stuck[0])+' 卡 '+(stuck[0].idleText||'');
  else if(live.length)hint='▶ '+prettyName(live[0])+' 在干';
  else if(list.length){const old=list.slice().sort((x,y)=>(y.idleMs||0)-(x.idleMs||0))[0];hint=prettyName(old)+' 闲 '+(old.idleText||'')}
  return {text:'在干 '+live.length+' / 空闲 '+(list.length-live.length),hint:hint};
}
// ── 项目视图（D43）：项目卡 + 进度条 + 正在做/要做（数字全部来自 /api/projects 现算）──
const PSTATUS_CLS={'在做':'do','要做':'q','暂停':'blk','已完成':'ok','阻塞':'bad'};
// D54：折叠状态外置——tick 每 5 秒整块重绘，展开态只存 DOM 里会被冲掉（「一关就弹开」的根因）
const EXPANDED_KEY='workdesk.expanded.v1';
const EXPANDED=(function(){try{return JSON.parse(localStorage.getItem(EXPANDED_KEY)||'{}')||{}}catch(e){return {}}})();
function saveExpanded(){try{localStorage.setItem(EXPANDED_KEY,JSON.stringify(EXPANDED))}catch(e){}}
function isOpen(key){return EXPANDED[key]===true}   // 没记录 = 收起（D54 默认收起）
function setOpen(key,val){EXPANDED[key]=Boolean(val);saveExpanded()}
// D56：只认用户点击。toggle 事件在重绘/程序化改 open 时也会触发——D54 就是栽在这：
// 重绘把「一次自动打开」记成用户意图 true，下一次重绘就保持打开，表现为「一关就弹开」。
document.addEventListener('click',function(e){
  const sum=e.target&&e.target.closest?e.target.closest('summary'):null;
  if(!sum)return;
  const d=sum.parentElement;
  if(!d||d.tagName!=='DETAILS')return;
  if(!d.dataset.pj&&!d.dataset.grp)return;
  e.preventDefault();               // 自己控制开合，不让浏览器默认行为再 toggle 一次
  d.open=!d.open;
  if(d.dataset.pj)setOpen(d.dataset.pj,d.open);
  else saveGroupOpen(d.dataset.grp,d.open);
},false);

function renderProjects(d){
  const list=document.getElementById('pj-list');
  if(!list)return;
  const doingBox=document.getElementById('pj-doing'),unBox=document.getElementById('pj-unstarted'),doneBox=document.getElementById('pj-done');
  const cnt=document.getElementById('c-projects');
  if(cnt)cnt.textContent=(d&&d.count!=null?d.count+' 个项目':'—')+(d&&d.updatedAt?' · 台账更新 '+String(d.updatedAt).slice(11,16):'');
  if(!d||!d.ok){
    list.innerHTML='<div class="empty" style="color:var(--bad)">'+esc((d&&d.error)||'读不到项目数据')+'</div>';
    if(doingBox)doingBox.innerHTML='';if(unBox)unBox.innerHTML='';if(doneBox)doneBox.innerHTML='';return;
  }
  const pctOf=(p)=>Math.max(0,Math.min(100,Math.round((p.pct||0)*100)));
  const cardOf=(p)=>{
    const pct=pctOf(p);
    const doc=p.doc
      ?('<a class="doclink" href="#" data-doc="'+esc(p.doc)+'">'+esc(String(p.doc).split('/').pop())+'</a>')
      :'<span class="tag blk">未登记文档</span>';
    // D65：功能域状态直接用「三级推导」的结果（f.state），页面不再自己推
    const FCLS={'在做':'do','待验收':'sub','要做':'q','已完成':'ok','作废':'blk','阻塞':'bad','未登记':'bad'};
    const feats=(p.features||[]).map(f=>{
      const stt=f.state||'未登记';
      const cls=FCLS[stt]||'q';
      return '<div class="feat"><span class="fname2">'+esc(f.name)+'</span>'+
        '<span class="tag '+cls+'">'+esc(stt)+(f.state==='待验收'&&f.pending?(' '+f.pending):'')+'</span>'+
        '<span class="gsm">'+f.done+'/'+f.total+' · '+Math.round((f.pct||0)*100)+'%</span>'+
        ((f.detail&&f.detail.some(d=>d.state==='未登记'))?('<span class="tag bad">未登记票</span>'):'')+
        '</div>';
    }).join('');
    return '<details class="pcard" data-pj="'+esc(p.id)+'"'+(isOpen(p.id)?' open':'')+'>'+
      '<summary><span class="pname">'+esc(p.name)+'</span>'+
      '<span class="tag '+(PSTATUS_CLS[p.status]||'q')+'">'+esc(p.status)+'</span>'+
      (p.pendingCount?('<span class="tag sub">待验收 '+p.pendingCount+'</span>'):'')+
      '<span class="grow-sum"></span><span class="gsm">'+p.done+' / '+p.total+' 单 · '+pct+'%</span></summary>'+
      '<div class="psum">'+esc(p.summary||'（未登记摘要）')+'</div>'+
      '<div class="pbar"><span style="width:'+pct+'%"></span></div>'+
      '<div class="pmeta">项目文档：'+doc+'</div>'+
      (feats?('<div class="pfeat">'+feats+'</div>'):'<div class="pfeat gsm" style="padding:0 16px 12px">（没有登记子功能）</div>')+
      '</details>';
  };
  // 正在做（当前 doing 的单）
  const doing=d.doing||[];
  if(doingBox)doingBox.innerHTML=doing.length?('<div class="psec">正在做</div>'+doing.map(x=>
    '<div class="pdoing">'+esc(x.projectName)+' · '+esc(x.featureName)+' · <b>'+esc(x.ticket)+'</b> doing · '+esc(x.target||'—')+'</div>').join('')):'';
  // D53：上方三区顺序固定「在做 → 要做 → 暂停」；已完成不在这里
  const all=(d.projects||[]).filter(p=>p.status!=='已完成');
  let html='';
  ['在做','要做','暂停'].forEach((k)=>{
    const arr=all.filter(p=>p.status===k);
    if(!arr.length)return;
    html+='<div class="psec">'+k+'（'+arr.length+'）</div>'+arr.map(cardOf).join('');
  });
  list.innerHTML=html||'<div class="empty">没有进行中的项目</div>';
  // D53：最下面单独一栏「已完成 · N」，默认折叠，没有也要显示
  const doneArr=(d.projects||[]).filter(p=>p.status==='已完成');
  if(doneBox){
    doneBox.innerHTML='<details class="pcard donefold" data-pj="__done__"'+(isOpen('__done__')?' open':'')+'>'+
      '<summary><span class="pname doneTitle">已完成 · '+doneArr.length+'</span></summary>'+
      (doneArr.length?doneArr.map(cardOf).join(''):'<div class="empty">暂无已完成项目</div>')+
      '</details>';
  }
  document.querySelectorAll('[data-doc]').forEach(a=>a.addEventListener('click',e=>{
    e.preventDefault();
    const rel=a.dataset.doc;
    const full='E:/DSH_workspace/'+rel;
    // WebView2 的 window.chrome.webview.postMessage 只在主框架生效——在 iframe 里发到不了宿主。
    // 所以嵌在窗口里时发给父窗口（index.html），由它转发给壳。
    if(window.parent&&window.parent!==window){
      try{window.parent.postMessage({type:'desk:open',path:full},'*')}catch(err){alert('打不开：'+err.message)}
      return;
    }
    const wv=(window.chrome&&window.chrome.webview)?window.chrome.webview:null;
    if(wv){try{wv.postMessage({type:'open',path:full})}catch(err){alert('打不开：'+err.message)}}
    else alert('当前不在鲟鱼窗口里（浏览器打开时）。文档相对路径：' + rel);
  }));
  const un=d.unstarted||[];
  if(unBox)unBox.innerHTML=un.length?('<div class="psec">要做（未开工子功能）</div>'+un.map(x=>
    '<div class="pdoing">'+esc(x.projectName)+' · '+esc(x.featureName)+' · 票号 '+esc((x.tickets||[]).join(', '))+'</div>').join('')):'';
}


function renderBoard(agents,wl){
  const box=document.getElementById('board');
  const all=(agents.agents||[]);
  const activeRows=all.filter(a=>a.active);
  const histRows=all.filter(a=>!a.active);
  const groups={};GROUP_ORDER.forEach(g=>groups[g]=[]);
  activeRows.forEach(a=>{groups[groupOf(a)].push(a)});
  const qByNo={};((wl&&wl.groups)||[]).forEach(g=>{qByNo[String(g.target)]=g});

  // D59：一行 = 在做 N / 排队 M + ⚠（N>1）；状态文案不再混用 run 布尔
  const rowOf=(a)=>{
    const qlist=(qByNo[String(a.no||'')]||{}).queue||[];
    const dn=Number(a.doing||0),qn=Number(a.queued||0);
    const busy=Boolean(a.live||a.running);
    const stuck=!busy&&(a.idleMs||0)>30*60*1000;
    const countTag='<span class="tag '+(dn>1?'bad':(dn?'do':'q'))+'">在做 '+dn+' / 排队 '+qn+(dn>1?' ⚠':'')+'</span>';
    const stateTag='<span class="tag '+(busy?'ok':(dn>0?'warn':'q'))+'">'+(busy?'在跑':(dn>0?'有票没动':'空闲'))+'</span>';
    return '<div class="row"><div class="r1">'+
      '<span class="dot '+(a.live?'live':(a.running?'run':(stuck?'stuck':'')))+'"></span>'+
      '<span class="name">'+esc(prettyName(a))+'</span>'+
      countTag+stateTag+
      '<span class="tag q">'+esc(a.idleText||'—')+'</span>'+
      '</div>'+
      (a.doingText?('<div class="doing">'+esc(a.doingText)+'</div>'):'')+
      qlist.map(t=>'<div class="sub">· '+esc(t.ticket||t.id)+' '+esc(t.title)+(t.needsTaskDoc?' <span class="tag bad">缺任务书</span>':'')+' <button class="btn pri" data-dispatch="'+esc(t.id)+'" '+(busy?'disabled':'')+'>派发</button></div>').join('')+
      '</div>';
  };

  let html='';
  if(agents.error)html+='<div class="empty" style="color:var(--bad)">DSH 投影读不到：'+esc(agents.error)+'</div>';
  if(!activeRows.length)html+='<div class="empty">无在役会话</div>';
  GROUP_ORDER.forEach(g=>{
    const list=groups[g]||[];
    if(!list.length)return;
    const sum=groupSummary(list);
    html+='<details class="grp" data-grp="'+esc(g)+'"'+(groupOpen(g)?' open':'')+'>'+
      '<summary><span>'+esc(g)+'</span>'+
      '<span class="gsm">'+esc(sum.text)+'</span>'+
      '<span class="grow-sum"></span>'+
      (sum.hint?('<span class="gsm">'+esc(sum.hint)+'</span>'):'')+
      '</summary>'+
      list.slice().sort((x,y)=>Number(y.live)-Number(x.live)||Number(y.running)-Number(x.running)).map(rowOf).join('')+
      '</details>';
  });
  // D59：非在役会话（已归档/一次性工具会话）归「历史」，默认折叠
  if(histRows.length){
    html+='<details class="grp" data-grp="__history__"'+(groupOpen('__history__')?' open':'')+'>'+
      '<summary><span>历史</span><span class="gsm">'+histRows.length+' 个（一次性 / 已归档 / 工具会话）</span><span class="grow-sum"></span></summary>'+
      histRows.map(rowOf).join('')+
      '</details>';
  }
  box.innerHTML=html||'<div class="empty">无在役会话</div>';
  bindDispatch();
}

function bindDispatch(){
  document.querySelectorAll('[data-dispatch]').forEach(b=>b.addEventListener('click',async()=>{
    const id=b.dataset.dispatch;
    if(!window.confirm('派发 '+id+'？这会真的给目标工号起一轮（花钱，唯一花钱的动作）。'))return;
    b.disabled=true;b.textContent='派发中…';
    try{const r=await j('/api/dispatch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,confirm:id})});
      b.textContent=r.ok?'已派':'失败';if(!r.ok)alert('派发失败：'+r.detail);}catch(e){alert('派发失败：'+e.message);b.textContent='派发'}
    tick();
  }));
}

// ── 卡点：待验收 / 待审方案 / 驳回待处理 ──────────────────────────────────
const PLAN_OPEN=['待审','01审中','转05','待人工'];
function planBadge(s){
  if(s==='待审')return '<span class="tag">待审</span>';
  if(s==='01审中')return '<span class="tag warn">01 审中</span>';
  if(s==='转05')return '<span class="tag warn">转 05</span>';
  if(s==='待人工')return '<span class="tag bad">待人工</span>';
  if(s==='通过')return '<span class="tag ok">通过</span>';
  if(s==='驳回')return '<span class="tag bad">驳回</span>';
  return '<span class="tag">—</span>';
}
// ── UG-007：未回执（派生值，台账里没有这个状态；这个页只看不改）────────────────
const UNACK_OVERRIDE=(function(){try{const v=Number(new URLSearchParams(location.search).get('unackMs')||0);return v>0?v:0}catch(e){return 0}})();
const UNACK_URL='/api/unacked'+(UNACK_OVERRIDE?('?ms='+UNACK_OVERRIDE):'');
let lastUnacked=null;
function renderUnacked(d){
  if(d)lastUnacked=d;
  const x=lastUnacked||{rows:[],count:0,unackedMs:0};
  const badge=document.getElementById('b-unacked');
  if(badge){badge.textContent=x.count||0;badge.className='badge'+(x.count?'':' zero')}
  const cnt=document.getElementById('c-unacked');
  if(cnt){
    const ms=Number(x.unackedMs||0);
    const th=ms<60000?(Math.round(ms/1000)+' 秒'):(Math.round(ms/60000)+' 分钟');
    cnt.textContent=(x.count||0)+' 张 · 阈值 '+th+(x.override?'（URL 覆盖）':'')+' · 只在内存里算';
  }
  const box=document.getElementById('unacked');
  if(!box)return;
  const rows=x.rows||[];
  box.innerHTML=rows.length?
    '<section class="card"><h2>派出去了、还没回执 <span class="count">'+rows.length+' 张</span></h2>'+
    rows.map(t=>'<div class="row"><div class="r1">'+
      '<span class="tag warn">'+esc(t.id)+'</span>'+
      '<span class="tag">工号 '+esc(t.target||'—')+'</span>'+
      '<span class="name">'+esc(t.ticket||'—')+' · '+esc(t.title)+'</span>'+
      '<span class="tag bad">派了 '+esc(t.waitedText)+'</span></div>'+
      '<div class="sub">派出 '+esc(clock(t.dispatchedAt))+' · '+(t.ackBy?('最后回执 '+esc(t.ackBy)):'从未 accepted')+'</div></div>').join('')+
    '</section>'
    :'<div class="empty">没有未回执的票（派出去超过阈值、还没人 accepted 的会出现在这里）</div>';
}

function renderBlockers(wl){
  const subs=wl.submitted||[];
  const p=wl.plan||{};
  const openPlan=(p.plans||[]).filter(t=>PLAN_OPEN.indexOf(t.planState)>=0);
  const rejected=(p.manual||[]).filter(m=>m.planState==='驳回');
  const total=subs.length+openPlan.length+rejected.length;
  const badge=document.getElementById('b-blockers');
  badge.textContent=total;badge.className='badge'+(total?'':' zero');
  document.getElementById('c-blockers').textContent='待验收 '+subs.length+' · 待审方案 '+openPlan.length+' · 驳回待处理 '+rejected.length;
  const subRows=subs.map(t=>{
    const file=t.file;
    const href=file?'file:///E:/DSH_workspace/records/交付/'+encodeURIComponent(file):null;
    return '<div class="row"><div class="r1"><span class="tag warn">'+esc(t.id)+'</span>'+
      (t.needsTaskDoc?('<span class="tag bad">缺任务书</span>'):'')+
      '<span class="name">'+esc(t.ticket||'—')+' · '+esc(t.title)+'</span></div>'+
      '<div class="sub">工号 '+esc(t.target||'—')+' · 交于 '+esc(t.notes&&t.notes.length?clock(t.notes[t.notes.length-1].t):'—')+'</div>'+
      (file?'<div class="sub"><a href="'+href+'" target="_blank">'+esc(file)+'</a></div>':'')+
      '<div style="margin-top:4px"><button class="btn pri" data-accept="'+esc(t.id)+'">通过</button> '+
      '<button class="btn bad" data-reject="'+esc(t.id)+'">退回</button></div></div>';
  }).join('')||'<div class="empty">没有待验收的交付</div>';
  const planRows=openPlan.map(t=>'<div class="prow"><div class="r1">'+
      '<span class="tag warn">'+esc(t.type)+'</span>'+
      '<span class="name">'+esc(t.id)+' · '+esc(t.title)+'</span>'+planBadge(t.planState)+'</div>'+
      '<div class="sub">'+esc(t.target?('工号'+t.target):'未指派')+
        (t.reviewer?(' · 审 '+esc(t.reviewer)):'')+
        (t.waitingText?(' · 等 '+esc(t.waitingText)):'')+
        (t.blockedOn?(' · <b style="color:var(--warn)">卡在 '+esc(t.blockedOn)+'</b>'):'')+
      '</div>'+(t.planNote?('<div class="sub">「'+esc(t.planNote)+'」</div>'):'')+
      ((t.planState==='待人工')?('<div style="margin-top:3px">'+
        '<button class="btn pri" data-plan-approve="'+esc(t.id)+'">通过</button> '+
        '<button class="btn" data-plan-reject="'+esc(t.id)+'">驳回</button></div>'):'')+
      '</div>').join('')||'<div class="empty">暂无待审方案</div>';
  const rejRows=rejected.map(m=>'<div class="prow bad"><div class="r1">'+
      '<span class="tag bad">'+esc(m.id)+'</span>'+
      '<span class="name">'+esc(m.title||m.id)+'</span>'+
      '<span class="tag">'+esc(clock(m.at))+'</span></div>'+
      '<div class="sub">'+esc(m.note)+' · by '+esc(m.by)+'</div></div>').join('')||'<div class="empty">暂无待人工</div>';
  document.getElementById('blockers').innerHTML=
    '<section class="card"><h2>待验收 <span class="count">'+subs.length+'</span></h2>'+subRows+'</section>'+
    '<section class="card"><h2>待审方案 <span class="count">'+openPlan.length+'</span></h2>'+planRows+'</section>'+
    '<section class="card"><h2>驳回待处理 <span class="count">'+rejected.length+'</span></h2>'+rejRows+'</section>';
  document.querySelectorAll('[data-accept]').forEach(b=>b.addEventListener('click',async()=>{
    const id=b.dataset.accept;const note=window.prompt('验收备注（可空）','通过')||'验收通过';
    const r=await j('/api/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,note})});
    if(!r.ok)alert('失败：'+(r.error||''));tick();
  }));
  document.querySelectorAll('[data-reject]').forEach(b=>b.addEventListener('click',async()=>{
    const id=b.dataset.reject;const note=window.prompt('退回理由（会发给工号）','缺自测，退回')||'退回重做';
    const r=await j('/api/reject',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,note})});
    if(!r.ok)alert('失败：'+(r.error||''));tick();
  }));
  document.querySelectorAll('[data-plan-approve]').forEach(b=>b.addEventListener('click',async()=>{
    const id=b.dataset.planApprove;
    if(!window.confirm('通过 '+id+' 的方案？会派生 '+id+'-impl 实现单进 queued——目标空闲时自动接力可能立刻派出去（花钱）。'))return;
    b.disabled=true;
    try{const r=await j('/api/plan-approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,note:'页面通过'})});
      if(!r.ok)alert('失败：'+(r.error||''));}catch(e){alert('失败：'+e.message)}
    tick();
  }));
  document.querySelectorAll('[data-plan-reject]').forEach(b=>b.addEventListener('click',async()=>{
    const id=b.dataset.planReject;
    const note=window.prompt('驳回理由（会发给工号和 01，并进人工箱）','缺回滚方案与验收口径')||'缺说明';
    b.disabled=true;
    try{const r=await j('/api/plan-reject',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,note})});
      if(!r.ok)alert('失败：'+(r.error||''));}catch(e){alert('失败：'+e.message)}
    tick();
  }));
  const un=(wl.unlinked||[]);
  // D80：演练中横幅（relay.drill 由 /api/relay 带回来）
  {
    const db=document.getElementById('drill');
    const d=window.__relay&&window.__relay.drill;
    if(d&&d.on){db.style.display='block';db.textContent='⚠ 演练中：'+d.ticket+' 强制失败 '+d.times+' 次（已用 '+(d.count||0)+'，剩 '+(d.left||0)+'，'+(d.until?new Date(d.until).toLocaleTimeString('zh-CN',{hour12:false}):'')+' 自动解除）'}
    else db.style.display='none';
  }
  const bad=(wl.bad||[]);
  const banner=document.getElementById('unlinked');
  const parts=[];
  if(un.length)parts.push('unlinked（不猜、不自动挂）：'+un.map(u=>u.name).join('、'));
  // D57：预检不合格的交付单列（它**不进**待验收）
  if(bad.length)parts.push('预检不合格（不进待验收）：'+bad.map(b=>b.name+'〔'+b.task+'｜'+(b.missing||[]).join('/')+'〕').join('、'));
  if(parts.length){banner.style.display='block';banner.textContent=parts.join('　｜　')}
  else banner.style.display='none';
}
// ── 花费：总额 + 三桶横条 + 明细 ─────────────────────────────────────────
let bucketOpen=null;
function renderCost(d){
  const box=document.getElementById('cost');
  const a=d&&d.attribution;
  if(!a||!a.ok){box.innerHTML='<div class="empty">花费数据不可用：'+esc(a&&a.error||'未知')+'</div>';return}
  const money=(n)=>n==null?'未记账':'¥'+(Number(n)||0).toFixed(2);
  const pct=(n)=>n==null?'—':(n*100).toFixed(0)+'%';
  const total=a.total.cost||0;
  const buckets=a.buckets||[];
  const bar=buckets.map((b,i)=>'<span class="b'+(i+1)+'" style="width:'+((total?b.cost/total*100:0))+'%" title="'+esc(b.label)+' '+money(b.cost)+'">'+(total&&b.cost/total>0.09?esc(b.label):'')+'</span>').join('');
  const legend=buckets.map((b,i)=>'<span class="sub" style="margin:0 10px 0 0"><b class="b'+(i+1)+'" style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;background:'+(['#5aa9e6','#b48ce6','#3ecf8e','#7d8b9c'][i])+'"></b>'+esc(b.label)+' '+money(b.cost)+' · '+pct(b.share)+'</span>').join('');
  const rc=a.reconcile;
  const reconLine=rc?('对账 token-report '+money(rc.report)+' vs 本面板 '+money(a.total.cost)+'，差 '+(rc.diffPct==null?'—':rc.diffPct.toFixed(2)+'%')+(rc.within2pct?' <span class="tag ok">在 2% 内</span>':' <span class="tag bad">超出 2%</span>'))
    :'对账：还没有跑（点标题栏「刷新」或切到本区会顺带跑一次）';
  const unc=(a.uncovered||[]);
  const uncLine=unc.length?('<div class="row" style="padding:4px 11px"><span class="sub" style="margin:0;color:var(--warn)">⚠ 账本未覆盖：'+unc.map(u=>esc(u.label)).join('、')+'（不在 bridge 的会话订阅里，今天花钱也进不了账本）</span></div>'):'';
  const openId=bucketOpen||(buckets.slice().sort((x,y)=>(y.cost||0)-(x.cost||0))[0]||{}).id||null;
  const cards=buckets.map(b=>'<div class="bkt'+(b.id===openId?' on':'')+'" data-bucket="'+esc(b.id)+'" data-on="'+(b.id===openId?'1':'0')+'">'+
      '<div class="k">'+esc(b.label)+'</div><div class="v">'+money(b.cost)+'</div>'+
      '<div class="s">'+esc(String(b.sessions))+' 会话 · 占 '+pct(b.share)+'</div></div>').join('');
  const details=buckets.map(b=>'<div class="bd" id="bd-'+esc(b.id)+'" style="display:'+(b.id===openId?'block':'none')+'">'+
      '<div class="arow head"><span>归属</span><span>会话</span><span>今日</span><span>命中率</span><span>tokens</span></div>'+
      ((b.units||[]).length?b.units.map(u=>'<div class="arow"><span class="nm" title="'+esc(u.label)+'">'+esc(u.label)+'</span>'+
        '<span>'+esc(String(u.sessions))+'</span><span>'+money(u.cost)+'</span><span>'+pct(u.hitRate)+'</span><span>'+esc(Number(u.tokens||0).toLocaleString('en-US'))+'</span></div>').join('')
        :'<div class="arow"><span class="nm" style="color:var(--dim)">这桶今天没花钱</span></div>')+
      '</div>').join('');
  const cur=(a.current&&a.current.rows)||[];
  const curRows=cur.length?cur.map(r=>'<div class="arow"><span class="nm" title="'+esc(r.label)+'">'+esc(r.label)+'</span>'+
      '<span>'+(r.turns==null?'未记账':(r.turns+' 轮'))+'</span><span>'+money(r.cost)+'</span><span>'+(r.hitRate==null?'—':(r.hitRate*100).toFixed(1)+'%')+'</span>'+
      '<span>'+(r.live?'在干活':(r.running?'在跑':'—'))+'</span></div>').join('')
    :'<div class="arow"><span class="nm" style="color:var(--dim)">现在没有在跑回合的会话</span></div>';
  box.innerHTML=
    '<section class="card">'+
      '<div class="total"><span class="big">'+money(total)+'</span><span class="lbl">今日 · '+esc(a.day||'')+' · '+esc(String(a.total.sessions||0))+' 个会话 · '+esc(String(a.total.turns||0))+' 轮</span>'+
      '<span class="grow"></span><button class="btn" id="costRefresh">刷新对账</button></div>'+
      '<div class="bar">'+bar+'</div>'+
      '<div style="padding:2px 11px 8px">'+legend+'</div>'+
      '<div class="row" style="padding:4px 11px"><span class="sub" style="margin:0">'+reconLine+'</span></div>'+
      uncLine+
      '<div class="buckets">'+cards+'</div>'+details+
    '</section>'+
    '<section class="card"><h2>当前在跑 <span class="count">命中率单列</span></h2>'+
      '<div class="arow head"><span>会话</span><span>轮次</span><span>今日</span><span>命中率</span><span>状态</span></div>'+curRows+'</section>';
  document.querySelectorAll('#cost [data-bucket]').forEach(el=>el.addEventListener('click',()=>{
    const id=el.dataset.bucket,bd=document.getElementById('bd-'+id);
    const on=el.dataset.on!=='1';
    bucketOpen=on?id:null;
    document.querySelectorAll('#cost [data-bucket]').forEach(x=>{x.dataset.on='0';x.classList.remove('on')});
    document.querySelectorAll('#cost .bd').forEach(x=>{x.style.display='none'});
    if(on){el.dataset.on='1';el.classList.add('on');if(bd)bd.style.display='block'}
  }));
  const btn=document.getElementById('costRefresh');
  if(btn)btn.addEventListener('click',async()=>{
    btn.disabled=true;btn.textContent='采样中…';
    try{renderCost(await j('/api/sessions-health?refresh=1&reconcile=1'))}catch(e){alert('采样失败：'+e.message)}
    btn.disabled=false;btn.textContent='刷新对账';
  });
}

// ── 抽屉：邮件 / 会话检测 / 全台账 ───────────────────────────────────────
function renderMail(d,ng){
  const unreadTotal=(d.unread||[]).reduce((n,u)=>n+u.unread,0);
  const nn=ng?(' · 活待敲 '+((ng.knockable||[]).length)+'（今日 '+ng.today+'/'+ng.perDay+'）'):'';
  const box=document.getElementById('d-mail');
  if(!box)return;
  box.innerHTML='<div class="hgroup">'+esc(d.total)+' 封 · 未读 '+unreadTotal+nn+'</div>'+
    ((d.recent||[]).map(m=>'<div class="row"><div class="r1">'+
      '<span class="name" style="'+(m.unread?'color:var(--warn)':'')+'">#'+esc(m.seq)+' '+esc(m.from)+' → '+esc(m.to)+'</span>'+
      '<span class="tag">'+esc(m.level)+'</span></div><div class="sub">'+esc(m.excerpt)+'</div></div>').join('')||'<div class="empty">没有邮件</div>');
}
// UI 规格 v1 §1 状态映射：queued 灰边 / doing 蓝 / submitted 琥珀 / planned 紫 / done 绿 / rejected 红 / blocked 虚线灰
const STATE_CLS={queued:'q',doing:'do',submitted:'sub',planned:'plan',done:'ok',rejected:'bad',blocked:'blk'};
function stateTag(s){return '<span class="tag '+(STATE_CLS[String(s||'')]||'q')+'">'+esc(s)+'</span>'}
function renderLedger(wl){
  const box=document.getElementById('d-ledger');
  if(!box)return;
  const gs=wl.groups||[];
  box.innerHTML=gs.map(g=>{
    const items=[].concat(g.doing||[],g.queue||[]);
    return '<div class="hgroup">工号 '+esc(g.target)+' · 排队 '+((g.queue||[]).length)+'</div>'+
      (items.length?items.map(t=>'<div class="row"><div class="r1">'+
        stateTag(t.state)+
        (t.type==='方案'?'<span class="tag plan">方案·'+esc(t.planState||'—')+'</span>':'')+
        '<span class="name">'+esc(t.id)+' · '+esc(t.ticket||'—')+' · '+esc(t.title)+'</span></div>'+
        '<div class="sub">'+esc(t.note||'')+'</div></div>').join('')
        :'<div class="sub" style="padding:0 16px 8px">没有任务</div>');
  }).join('')||'<div class="empty">台账是空的</div>';
}
function renderRelay(r){
  const btn=document.getElementById('relayBtn');
  const last=document.getElementById('relayLast');
  if(!btn)return;
  btn.textContent='自动接力 '+(r.enabled?'开':'关');
  btn.className='btn '+(r.enabled?'pri':'bad');
  btn.dataset.enabled=r.enabled?'1':'0';
  const q=r.quota||{};
  let text='配额 '+(q.used==null?'—':q.used+'/'+q.limit);
  if(r.last){text+=' · 上次 '+esc(r.last.target)+'←'+esc(r.last.task)+' '+(r.last.ok?'OK':esc(r.last.code||'失败'))+' '+clock(r.last.at)}
  if((r.backoff||[]).length){text+=' · 退避 '+(r.backoff.map(b=>b.agent).join('/'))}
  last.textContent=text;
}
document.getElementById('relayBtn').addEventListener('click',async()=>{
  const btn=document.getElementById('relayBtn');
  const want=btn.dataset.enabled!=='1';
  if(!window.confirm(want?'打开自动接力？空闲且有 queued 时会自动派活（花钱）。':'关闭自动接力？'))return;
  btn.disabled=true;
  try{
    const r=await j('/api/relay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:want})});
    if(!r.ok)alert('切换失败：'+(r.error||''));
  }catch(e){alert('切换失败：'+e.message)}
  btn.disabled=false;tick();
});

// 会话检测（原 D26/D26b 面板，原样搬进抽屉）
function attrBlockHtml(a){return ''}
function renderHealth(d){
  const box=document.getElementById('d-health');
  if(!box)return;
  const s=d.summary||{};
  if(d.dsh&&d.dsh.error){box.innerHTML='<div class="empty">DSH 投影读不到：'+esc(d.dsh.error)+'</div>';return}
  const lv=(l)=>l==='bad'?'bad':l==='warn'?'warn':'ok';
  const mark=(l)=>l==='bad'?'✗':l==='warn'?'!':'✓';
  const ptag=(p)=>p==='handoff'?'<span class="tag bad">换代线</span>':(p==='warn'?'<span class="tag warn">提醒线</span>':'<span class="tag ok">安全</span>');
  const head=(cols)=>'<div class="hrow head">'+cols.map(c=>'<span>'+esc(c)+'</span>').join('')+'</div>';
  const checks=(d.checks||[]).map(c=>'<div class="row" style="padding:6px 11px"><div class="r1">'+
    '<span class="tag '+lv(c.level)+'">'+mark(c.level)+'</span><span class="name">'+esc(c.title)+'</span></div>'+
    '<div class="sub">'+esc(c.detail)+'</div></div>').join('');
  const roster=(d.roster||[]).map(r=>'<div class="hrow'+(r.problem?' badrow':'')+'">'+
    '<span>'+esc(r.id)+'</span>'+
    '<span class="nm" title="'+esc(r.title)+'">'+esc(r.title)+'</span>'+
    '<span>'+esc(r.short)+'</span>'+
    '<span>'+(r.problem?'<span class="tag bad">'+esc(r.problem)+'</span>':(r.titleMismatch?'<span class="tag warn">标题不符</span>':'<span class="tag ok">在位</span>'))+'</span>'+
    '<span>'+esc(r.idleText||'—')+'</span></div>').join('');
  const sess=(d.sessions||[]).slice().sort((a,b)=>(b.pressure==='handoff')-(a.pressure==='handoff')||((b.pressure==='warn')-(a.pressure==='warn'))||(b.tokens-a.tokens)).map(r=>'<div class="hrow">'+
    '<span>'+esc(r.short)+'</span>'+
    '<span class="nm" title="'+esc(r.title)+'">'+esc(r.title)+(r.no?'':' <span class="tag">非工号</span>')+'</span>'+
    '<span>'+(r.live?'<span class="tag ok">在干活</span>':(r.running?'<span class="tag warn">在跑</span>':'<span class="tag">闲</span>'))+'</span>'+
    '<span>'+ptag(r.pressure)+' '+esc(String(r.tokens))+'</span>'+
    '<span>'+esc(r.idleText||'—')+'</span></div>').join('');
  const bq=(d.brokenQueue||[]).length?('<div class="hgroup">台账里派不出去的 queued</div>'+d.brokenQueue.map(b=>'<div class="row" style="padding:6px 11px"><div class="r1">'+
    '<span class="tag bad">'+esc(b.ticket||'—')+'</span><span class="name">'+esc(b.title||'')+'</span></div>'+
    '<div class="sub">→ 工号 '+esc(b.target||'—')+' · '+esc(b.reason||'')+'</div></div>').join('')):'';
  box.innerHTML=
    '<div class="row" style="display:flex;gap:10px;align-items:center;padding:6px 11px">'+
      '<span class="tag '+lv(s.verdict)+'">'+(s.verdict==='bad'?'有问题':(s.verdict==='warn'?'注意':'正常'))+'</span>'+
      '<span class="sub" style="margin:0">采样 '+esc(clock(d.at))+' · 名册在编 '+esc(String(s.rosterActive||0))+' · 断链 '+esc(String(s.rosterBroken||0))+
        ' · 提醒线 '+esc(String(s.overWarn||0))+' · 换代线 '+esc(String(s.overHandoff||0))+' · 僵住 '+esc(String(s.stale||0))+'</span>'+
      '<span class="grow"></span><button class="btn" id="healthRefresh">重新采样</button></div>'+
    checks+
    '<div class="hgroup">名册 ↔ 投影</div>'+head(['工号','名册标题','会话','状态','空闲'])+roster+
    '<div class="hgroup">全部会话（按上下文水位排）</div>'+head(['会话','标题','忙闲','上下文','空闲'])+sess+
    bq;
  const btn=document.getElementById('healthRefresh');
  if(btn)btn.addEventListener('click',async()=>{
    btn.disabled=true;btn.textContent='采样中…';
    try{renderHealth(await j('/api/sessions-health?refresh=1&reconcile=1'))}catch(e){alert('采样失败：'+e.message)}
    btn.disabled=false;btn.textContent='重新采样';
  });
}

// ── 代持发送（D89）────────────────────────────────────────────────────────
const NL=String.fromCharCode(10);   // 页面里别写反斜杠 n 的字面量：这一段是服务端模板字符串，它会被展开成真的换行，把 JS 拆断
function sendTag(s,dry){
  if(s==='sent')return '<span class="tag ok">已发送'+(dry?' dry':'')+'</span>';
  if(s==='failed')return '<span class="tag bad">失败</span>';
  if(s==='sending')return '<span class="tag do">发送中</span>';
  if(s==='queued')return '<span class="tag q">排队</span>';
  return '<span class="tag">'+esc(s||'—')+'</span>';
}
let sendChatsKey=null;
function renderSend(d){
  if(!d)return;
  const r=d.runner||{};
  const hint=document.getElementById('send-hint');
  if(hint){
    hint.innerHTML='待发 '+esc(String(d.queued||0))+(d.sending?'（在发 '+esc(String(d.sending))+'）':'')+
      ' · '+(r.running?'<span class="tag ok">runner 在线</span>':'<span class="tag bad">runner 未运行</span>')+
      ' · 已发 '+esc(String(d.sent||0))+' / 失败 '+esc(String(d.failed||0))+
      (r.dry?' <span class="tag warn">dry</span>':'');
  }
  const dl=document.getElementById('send-chats');
  const key=(d.chats||[]).join('|');
  if(dl&&key!==sendChatsKey){dl.innerHTML=(d.chats||[]).map(c=>'<option value="'+esc(c)+'">').join('');sendChatsKey=key}
  const box=document.getElementById('sendrecent');
  if(!box)return;
  const rows=d.recent||[];
  box.innerHTML=rows.length?rows.map(x=>'<div class="sendrow">'+
    '<span class="cut">'+esc(String(x.at||'').slice(11,19)||'—')+'</span>'+
    '<span class="cut" title="'+esc(x.text||'')+'">'+esc(x.chat||'—')+' · '+esc(x.text||'')+'</span>'+
    '<span>'+sendTag(x.state,x.dry)+'</span>'+
    '<span class="cut" title="'+esc(x.reason||'')+'">'+esc(x.reason||(x.state==='queued'?'等 runner 取':'—'))+'</span>'+
    '</div>').join(''):'<div class="empty">还没有发送记录</div>';
}
document.getElementById('send-btn').addEventListener('click',async function(){
  const chatEl=document.getElementById('send-chat'),textEl=document.getElementById('send-text'),btn=this;
  const chat=(chatEl.value||'').trim(),text=(textEl.value||'').trim();
  if(!chat){alert('必须填会话名：不指定会话不发（防误发到当前前台会话）');chatEl.focus();return}
  if(!text){alert('内容不能为空');textEl.focus();return}
  if(!window.confirm('加入发送队列？'+NL+'会话：'+chat+NL+'内容：'+text.slice(0,120)))return;
  btn.disabled=true;const old=btn.textContent;btn.textContent='入队中…';
  try{
    const r=await j('/api/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat,text,by:'workdesk'})});
    if(r.ok){textEl.value='';btn.textContent='已入队 '+esc(String(r.queueDepth||1))}
    else{alert('入队失败：'+(r.error||''));btn.textContent=old}
  }catch(e){alert('入队失败：'+e.message);btn.textContent=old}
  btn.disabled=false;tick();
  setTimeout(function(){btn.textContent=old},4000);
});

// ── WS-017 调度台：服务红绿灯 / 票与工人 / 最近事件 ──────────────────────
// 数据源三档（页面上会写明是哪一档，不混）：
//   api   —— WS-016 的 /api/supervisor 已上线，全用它（含事件、重启、日志）
//   probe —— 接口还没上（404）：本页自己 15s 探一次端口，状态照样准；重启/日志按钮会明确说"等 WS-016"
//   demo  —— ?supdemo=1：纯演示数据，只为把结构/交互拍给人看，页头红字标着
const SUP_SV=[
  {id:'workdesk', name:'工作台',  port:9340, expect:1, urls:['http://127.0.0.1:9340/api/health'], log:'logs/workdesk.out.log', self:1},
  {id:'winproxy', name:'窗口反代', port:9342, expect:1, urls:['http://127.1.1.4:9342/','http://127.0.0.1:9342/'], log:'serve.mjs（窗口页预览）'},
  {id:'insurance',name:'保险',    port:9343, expect:1, urls:['http://127.9.1.1:9343/','http://127.0.0.1:9343/'], log:'logs/insurance*.log'},
  {id:'qqbridge', name:'QQ 桥',   port:3100, expect:1, urls:['http://127.0.0.1:3100/'], log:'logs/bridge*.log'},
  {id:'study',    name:'学习区',  port:9350, expect:1, urls:['http://127.1.1.3:9350/health','http://127.0.0.1:9350/health'], log:'logs/study*.log'},
  {id:'engine',   name:'引擎',    port:9351, expect:0, urls:['http://127.1.1.3:9351/','http://127.0.0.1:9351/'], log:'—'},
  {id:'examroom', name:'临时考场',port:9352, expect:0, retired:1, urls:[], log:'—'},
  {id:'relay',    name:'relay',   port:9334, expect:1, urls:['http://127.0.0.1:9334/health'], log:'logs/relay04.log'}
];
const SUP={mode:'probe',at:0,busy:false,services:[],events:[],demo:false,apiDown:false};
const SUP_EV_KEY='ws017-events';
const SUP_DEMO=(function(){try{return /(?:^|[?&])supdemo=1(?:&|$)/.test(String(location.search||''))}catch(e){return false}})();
function supPill(kind,text,title){return '<span class="pill '+kind+'" title="'+esc(title||'')+'">'+esc(text)+'</span>'}
function supLoadEvents(){try{var a=JSON.parse(localStorage.getItem(SUP_EV_KEY)||'[]');return Array.isArray(a)?a:[]}catch(e){return []}}
function supSaveEvents(){try{localStorage.setItem(SUP_EV_KEY,JSON.stringify(SUP.events.slice(0,60)))}catch(e){}}
function supEvent(kind,id,text){
  SUP.events.unshift({at:Date.now(),kind:kind,id:id,text:text});
  SUP.events=SUP.events.slice(0,60);supSaveEvents();
  if(currentView==='dispatch'){supRenderEvents();supRenderLights()}
}
function supLastAction(id){
  for(var i=0;i<SUP.events.length;i++){if(SUP.events[i].id===id)return clock(SUP.events[i].at)+' '+SUP.events[i].text}
  return '—';
}
function supProbe(url,ms){
  return new Promise(function(res){
    var done=false,ac=null,t=null;
    try{ac=new AbortController()}catch(e){}
    t=setTimeout(function(){if(done)return;done=true;try{if(ac)ac.abort()}catch(e){};res(false)},ms||2500);
    var opt={mode:'no-cors',cache:'no-store'};
    if(ac)opt.signal=ac.signal;
    fetch(url,opt).then(function(){if(done)return;done=true;clearTimeout(t);res(true)})
      .catch(function(){if(done)return;done=true;clearTimeout(t);res(false)});
  });
}
async function supProbeOne(sv){
  // 这一页就是工作台自己起的：工作台要是挂了，这行 JS 根本不会跑 ⇒ 直接算在跑，不去探自己
  if(sv.self)return true;
  for(var i=0;i<sv.urls.length;i++){ if(await supProbe(sv.urls[i],2500)) return true }
  return false;
}
// 带耗时的探活：401 的服务会卡到超时（= 活着），死端口秒拒（= 挂了），见 lib 的 portStateFromProbe
function supProbeDetail(url,ms){
  return new Promise(function(res){
    var t0=Date.now(),done=false,ac=null;
    try{ac=new AbortController()}catch(e){}
    var to=setTimeout(function(){ if(done)return; done=true; try{if(ac)ac.abort()}catch(e){}; res({ok:false,ms:Date.now()-t0,err:'abort',status:0}) },ms||2000);
    var opt={mode:'no-cors',cache:'no-store'}; if(ac)opt.signal=ac.signal;
    fetch(url,opt).then(function(r){ if(done)return; done=true; clearTimeout(to); res({ok:true,ms:Date.now()-t0,status:r.status||0}) })
      .catch(function(e){ if(done)return; done=true; clearTimeout(to); res({ok:false,ms:Date.now()-t0,err:String(e)}) });
  });
}
function supApi(path,opt){
  return fetch(path,opt?Object.assign({cache:'no-store'},opt):{cache:'no-store'}).then(function(r){
    return r.text().then(function(t){
      var body=null;try{body=JSON.parse(t)}catch(e){}
      return {status:r.status,body:body,text:t};
    });
  });
}
async function supLoad(force){
  if(SUP.busy&&!force)return;
  SUP.busy=true;
  try{
    if(SUP_DEMO){ SUP.mode='demo'; SUP.services=supDemoServices(); SUP.events=supDemoEvents(); SUP.at=Date.now(); supRenderAll(); return }
    var r=await supApi('/api/supervisor').catch(function(){return {status:0,body:null}});
    if(r.status===200&&r.body&&r.body.ok&&Array.isArray(r.body.services)){
      SUP.mode='api';
      SUP.services=r.body.services.map(function(s){
        var up=Boolean(s.up),la=s.lastAction||null;
        var laText=la?((la.at?clock(la.at)+' ':'')+String(la.action||'')+(la.detail?(' · '+la.detail):'')):'—';
        // 掉线且从没动作过 = 本来就没启用（灰）；掉线但有动作/失败记录 = 真挂了（红）
        var st=up?'up':((!la&&!Number(s.fails||0))?'off':'down');
        return {id:String(s.id||''),name:String(s.name||s.id||''),port:s.port,host:s.host||'',up:up,
                state:st,lastAction:laText,detail:'',
                restarts:Number(s.restartsLastHour||0),fails:Number(s.fails||0)};
      });
      // 灯 = supervisor 状态 ∧ 本页直探端口（谁先发现掉线谁说了算）
      // 为什么加这一下：supervisor 自己也有一拍延迟（实测它 10s 后才把 up 翻成 false），
      // 直接探端口能让灯在页面的 15s 轮询里就变红，不用再叠一层等待。
      var probes=await Promise.all(SUP.services.map(function(s){
        if(!s.up)return Promise.resolve(true);                 // 已经红了就不用再探
        if(s.id==='workdesk')return Promise.resolve(true);     // 页面自己就是它起的
        // QQ 桥对一切请求回 401（带 WWW-Authenticate）：no-cors 探针会被当成网络错误，
        // 于是"桥明明活着"却报红。它这一类只信 supervisor，不直探。
        if(s.id==='qq-bridge')return Promise.resolve(true);
        var host=s.host||'127.0.0.1';
        // 注册表里的 host 是"服务身份"（有的绑 127.2.1.1 / 127.9.1.1），实际也可能只绑回环：两个都试
        var urls=['http://'+host+':'+s.port+'/'];
        if(host!=='127.0.0.1')urls.push('http://127.0.0.1:'+s.port+'/');
        return (async function(){
          for(var i=0;i<urls.length;i++){ if(await supProbe(urls[i],1500))return true }
          return false;
        })();
      }));
      SUP.services.forEach(function(s,i){
        s.probeOk=probes[i];
        if(s.up&&!probes[i]){ s.up=false; s.state='down'; s.detail='端口不通（supervisor 还没翻）'; }
      });
      var ev=await supApi('/api/supervisor/events?limit=20').catch(function(){return {status:0,body:null}});
      SUP.events=(ev.body&&Array.isArray(ev.body.events))?ev.body.events.map(function(e){
        var act=String(e.action||'');
        return {at:typeof e.at==='number'?e.at:(Date.parse(e.at)||Date.now()),
                kind:(/fail|give|down|挂|超|stolen|err/i.test(act)?'bad':'ok'),
                id:String(e.id||''),text:act+(e.detail?(' · '+e.detail):'')};
      }):[];
      SUP.at=Date.now();supRenderAll();supConsole();return;
    }
    // 接口没上：本地探测兜底（不写任何台账，只读端口）
    SUP.mode='probe';SUP.apiDown=true;
    var prev={};SUP.services.forEach(function(s){prev[s.id]=s.up});
    var list=await Promise.all(SUP_SV.map(async function(sv){
      var up=await supProbeOne(sv);
      return {id:sv.id,name:sv.name,port:sv.port,up:up,expect:sv.expect,log:sv.log,
              state:up?'up':(sv.expect?'down':'off'),lastAction:''};
    }));
    list.forEach(function(s){
      s.lastAction=supLastAction(s.id);
      if(typeof prev[s.id]==='boolean'&&prev[s.id]!==s.up){
        supEvent(s.up?'ok':'bad',s.id,s.up?('起来了（:'+s.port+'）'):('掉了（:'+s.port+'）'));
      }
    });
    SUP.services=list;SUP.at=Date.now();supRenderAll();supConsole();
  }catch(e){
    SUP.mode='probe';
    var box=document.getElementById('supLights');
    if(box)box.innerHTML='<div class="empty">读取失败：'+esc(e.message)+'</div>';
  }finally{SUP.busy=false}
}
function supDemoServices(){
  return SUP_SV.map(function(sv,i){
    var up=(sv.id!=='examroom');
    return {id:sv.id,name:sv.name,port:sv.port,up:up,expect:sv.expect,log:sv.log,
            state:up?'up':(sv.expect?'down':'off'),
            lastAction:i===3?'15:03 拉起失败（端口占用），已退避 2 次':(i===5?'14:40 墙钟超限，停止重启（1 小时内 5 次）':supLastAction(sv.id))};
  });
}
const SUP_DEMO_SAMPLES=[
  {k:'bad',id:'qqbridge',d:'3100 掉了 → 5s 后拉起（2.1s）'},
  {k:'ok',id:'study',d:'9350 手动重启成功（1.4s）'},
  {k:'bad',id:'engine',d:'9351 挂起超时，退避重试 1/3'},
  {k:'ok',id:'relay',d:'9334 心跳恢复'},
  {k:'bad',id:'examroom',d:'9352 一键拉起失败（端口占用），不再硬拉'},
  {k:'ok',id:'workdesk',d:'9340 自检通过'},
  {k:'bad',id:'insurance',d:'9343 连续 5 次重启，一小时上限 → 停止并告警'}
];
function supDemoEvents(){
  var now=Date.now(),out=[];
  for(var i=0;i<20;i++){
    var s=SUP_DEMO_SAMPLES[i%SUP_DEMO_SAMPLES.length];
    out.push({at:now-i*7*60000,kind:s.k,id:s.id,text:s.d,demo:true});
  }
  return out;
}
function supStateText(sv){return sv.state==='up'?'在跑':(sv.state==='down'?'挂了':'未启用')}
function supIco(sv){return sv.state==='up'?'✔':(sv.state==='down'?'✖':'○')}
function supShort(t){var s=String(t||'');return s.length>34?(s.slice(0,34)+'…'):s}
function supRenderSrc(){
  var el=document.getElementById('supSrc');if(!el)return;
  if(SUP.mode==='api'){
    el.innerHTML=supPill('ok','数据源：/api/supervisor（WS-016）','服务状态与事件都来自 supervisor；重启走 POST /api/supervisor/restart')
      +'<span class="meta">刷新 15 秒 · 只换这一块，不闪页</span>';
  }else if(SUP.mode==='demo'){
    el.innerHTML=supPill('demo','演示数据（?supdemo=1）','给结构验收看的假数据，页面上每个数字都不是真的')
      +'<span class="meta">真数据要等 WS-016 的 /api/supervisor</span>';
  }else{
    el.innerHTML=supPill('warn','数据源：本地端口探测（WS-016 未上线）','接口 404：本页直接探 8 个本地端口，能连上=在跑，连不上=挂了/未启用；重启与日志要等 supervisor')
      +'<span class="meta">刷新 15 秒 · 端口活着 ≠ 业务正常</span>';
  }
}
function supRenderLights(){
  var box=document.getElementById('supLights');if(!box)return;
  var rows=SUP.services||[];
  if(!rows.length){box.innerHTML='<div class="empty">暂无</div>';return}
  box.innerHTML=rows.map(function(sv){
    var st=sv.state||'off';
    return '<button class="sup-light '+st+'" data-sup="'+esc(sv.id)+'" title="'
      +esc(sv.name+' · 端口 '+sv.port+' · 最近：'+(sv.lastAction||'—'))+'">'
      +'<span class="ico" aria-hidden="true">'+supIco(sv)+'</span>'
      +'<span class="nm"><span class="n">'+esc(sv.name)+'</span><span class="p">:'+esc(sv.port)+'</span>'
      +'<span class="s">'+(sv.detail?esc(sv.detail)+' · ':'')+(sv.restarts?('近 1 小时重启 '+sv.restarts+' 次 · '):'')+esc(supShort(sv.lastAction))+'</span></span>'
      +'<span class="st">'+esc(supStateText(sv))+'</span></button>';
  }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('[data-sup]'),function(b){
    b.addEventListener('click',function(){supOpen(b.getAttribute('data-sup'))});
  });
  var n=rows.length,up=rows.filter(function(s){return s.state==='up'}).length,down=rows.filter(function(s){return s.state==='down'}).length;
  document.getElementById('supSvcCount').textContent=up+' 在跑 / '+down+' 挂了 / '+n+' 个';
  document.getElementById('c-dispatch').textContent=(SUP.mode==='api'?'supervisor':(SUP.mode==='demo'?'演示':'端口探测'))+' · '+clock(SUP.at||Date.now());
}
function supRenderPeople(){
  var box=document.getElementById('supPeople');if(!box)return;
  var ag=(lastAgents&&lastAgents.agents)||[];
  var wl=lastWl||{},sum=wl.summary||{};
  var live=ag.filter(function(a){return a.active});
  var rows=live.slice(0,8).map(function(a){
    var doing=Number(a.doing||0),q=Number(a.queued||0);
    var st=doing?'在做':(q?'排队中':'空闲');
    var cur=(a.nextTask&&(a.nextTask.ticket||a.nextTask.id))||'—';
    var tok=a.tokens?(Math.round(Number(a.tokens)/1000)+'k'):'—';
    return '<div class="sup-p"><span>'+esc(a.no?('工号'+a.no):prettyName(a))+'</span>'
      +'<span class="nm" title="'+esc(String(a.doingText||''))+'">'+esc(st)+(doing>1?(' ×'+doing):'')+' · '+esc(cur)+'</span>'
      +'<span class="tm">'+esc(a.idleText||'—')+'</span>'
      +'<span class="tm" title="上下文用量">'+esc(tok)+'</span></div>';
  }).join('');
  box.innerHTML='<div class="sup-p head"><span>工号</span><span>状态 · 当前票</span><span>空闲</span><span>压力</span></div>'
    + (rows||'<div class="empty">暂无</div>')
    + '<div class="sup-sum">待验收 '+esc(String(sum.submitted==null?'—':sum.submitted))+' 张 · 排队 '+esc(String(sum.queued==null?'—':sum.queued))+' 张 · 在做 '+esc(String(sum.doing==null?'—':sum.doing))+' 张</div>';
  document.getElementById('supPeopleCount').textContent=live.length+' 人在场';
}
function supRenderEvents(){
  var box=document.getElementById('supEvents');if(!box)return;
  var list=(SUP.events||[]).slice(0,20);
  var head=(SUP.mode==='probe')?'<div class="sup-ev note">WS-016 未上线：下面是本页 15 秒侦测到的状态变化（点灯重启也会记在这里）</div>':'';
  box.innerHTML=head+(list.length?list.map(function(e){
    return '<div class="sup-ev '+(e.kind==='bad'?'bad':'ok')+'"><span class="t">'+esc(String(clock(e.at)).slice(0,8))+'</span>'
      +'<span aria-hidden="true">'+(e.kind==='bad'?'✖':'✔')+'</span><span class="d">'+esc(e.text)+'</span></div>';
  }).join(''):'<div class="empty">暂无</div>');
  document.getElementById('supEvCount').textContent=list.length+' / 20';
}
function supRenderAll(){supRenderSrc();supRenderLights();supRenderPeople();supRenderEvents()}
function supToast(msg){
  var el=document.getElementById('supToast');if(!el)return;
  el.textContent=msg;el.classList.add('on');
  clearTimeout(supToast.__t);supToast.__t=setTimeout(function(){el.classList.remove('on')},2600);
}
function supSvc(id){for(var i=0;i<SUP.services.length;i++)if(SUP.services[i].id===id)return SUP.services[i];return null}
function supDlg(html){document.getElementById('supDlg').innerHTML=html;document.getElementById('supM').classList.add('on')}
function supClose(){document.getElementById('supM').classList.remove('on')}
function supOpen(id){
  var sv=supSvc(id);if(!sv)return;
  supDlg('<h3 id="supDlgTitle">'+esc(sv.name)+' <span class="meta">:'+esc(sv.port)+'</span></h3>'
    +'<div class="sub">状态：<b>'+esc(supStateText(sv))+'</b> · 最近：'+esc(sv.lastAction||'—')+'</div>'
    +'<div class="sub">'+(SUP.mode==='api'?'重启接口：POST /api/supervisor/restart（WS-016）':(SUP.mode==='demo'?'演示模式：重启是模拟的':'重启接口未就绪：要等 WS-016 的 /api/supervisor/restart'))+'</div>'
    +'<div class="row2"><button class="btn bad" id="supActLog">看日志</button>'
    +'<button class="btn pri" id="supActRestart">重启</button>'
    +'<button class="btn" id="supActClose">关闭</button></div>');
  document.getElementById('supActClose').addEventListener('click',supClose);
  document.getElementById('supActLog').addEventListener('click',function(){supLog(id)});
  document.getElementById('supActRestart').addEventListener('click',function(){supAskRestart(id)});
}
function supAskRestart(id){
  var sv=supSvc(id);if(!sv)return;
  supDlg('<h3 id="supDlgTitle">确定重启「'+esc(sv.name)+'」？</h3>'
    +'<div class="sub">端口 '+esc(sv.port)+'，重启期间会短暂不可用（别在跑东西的时候点）。这是第二次确认：点「确定重启」才真的发请求。</div>'
    +'<div class="row2"><button class="btn" id="supNo">取消</button><button class="btn bad" id="supYes">确定重启</button></div>');
  document.getElementById('supNo').addEventListener('click',supClose);
  document.getElementById('supYes').addEventListener('click',function(){supClose();supRestart(id)});
}
async function supRestart(id){
  var sv=supSvc(id);if(!sv)return;
  var name=sv.name;
  if(SUP.mode==='demo'){
    await new Promise(function(r){setTimeout(r,700)});
    supEvent('ok',id,'演示：重启成功（0.7s）');
    supToast('演示模式：已模拟重启「'+name+'」');
    return;
  }
  try{
    var r=await supApi('/api/supervisor/restart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})});
    if(r.status===200&&r.body&&r.body.ok){
      supToast('已重启「'+name+'」（'+(r.body.ms==null?'—':r.body.ms)+'ms）');
      supEvent('ok',id,'手动重启成功（'+(r.body.ms==null?'—':r.body.ms)+'ms）');
      setTimeout(function(){supLoad(true)},2500);
    }else{
      var why=(r.status===404||r.status===405)
        ? '重启接口还没上（WS-016 未交付）'
        : ((r.body&&(r.body.error||r.body.message))||('HTTP '+r.status));
      supToast('重启失败：'+why);
      supEvent('bad',id,'手动重启失败：'+why);
    }
  }catch(e){
    supToast('重启接口未就绪（WS-016）：'+e.message);
    supEvent('bad',id,'点了重启：接口未就绪（WS-016）');
  }
}
async function supLog(id){
  var sv=supSvc(id);if(!sv)return;
  supDlg('<h3 id="supDlgTitle">'+esc(sv.name)+' · 日志</h3><div class="sub">读取中…</div>'
    +'<div class="row2"><button class="btn" id="supLogClose">关闭</button></div>');
  document.getElementById('supLogClose').addEventListener('click',supClose);
  var text='';
  try{
    var r=await supApi('/api/supervisor/log?id='+encodeURIComponent(id));
    if(r.status===200&&r.body&&r.body.ok&&r.body.lines)text=r.body.lines;
  }catch(e){}
  if(!text){
    text=(SUP.mode==='demo'
      ? '[demo] '+(sv.log||'—')+'\\n15:03:12 start pid=12345\\n15:03:14 listening on '+sv.port+'\\n14:40:02 连续重启 5 次，进入退避'
      : '看日志要等 WS-016 的日志接口（/api/supervisor/log）。\\n现在还没上，这里只能给路径参考：'+(sv.log||'—'));
  }
  supDlg('<h3 id="supDlgTitle">'+esc(sv.name)+' · 日志</h3><textarea readonly></textarea>'
    +'<div class="row2"><button class="btn" id="supLogClose">关闭</button></div>');
  var ta=document.querySelector('#supDlg textarea');if(ta)ta.value=text;
  document.getElementById('supLogClose').addEventListener('click',supClose);
}
function supEnter(){
  supRenderAll();
  supConsole();
  if(!SUP.at||Date.now()-SUP.at>15000)supLoad();
}
document.getElementById('supM').addEventListener('click',function(e){if(e.target&&e.target.id==='supM')supClose()});
document.addEventListener('keydown',function(e){if(e.key==='Escape')supClose()});
document.getElementById('supRestartDown').addEventListener('click',function(){
  var down=(SUP.services||[]).filter(function(s){return s.state==='down'});
  if(!down.length){supToast('现在没有挂掉的服务');return}
  var names=down.map(function(s){return s.name+'(:'+s.port+')'}).join('、');
  supDlg('<h3 id="supDlgTitle">重启 '+down.length+' 个挂掉的服务？</h3>'
    +'<div class="sub">'+esc(names)+'</div>'
    +'<div class="sub">只碰「挂了」的，在跑的一个都不动。这是第二次确认。</div>'
    +'<div class="row2"><button class="btn" id="supNo">取消</button><button class="btn bad" id="supYes">确定重启</button></div>');
  document.getElementById('supNo').addEventListener('click',supClose);
  document.getElementById('supYes').addEventListener('click',async function(){
    supClose();
    for(var i=0;i<down.length;i++)await supRestart(down[i].id);
  });
});

// ── WS-029 ② 渠道 / ③ 脑子：只读 /api/console（WS-027）────────────────────
// 契约：channels.{qq,relay,files} + brain.{persona,memory,model}
// /api/console 没上线（404）或超时 → 明确写"读不到"，能本地探测的照旧探测，**不假装正常**。
const CON={at:0,busy:false,mode:'',data:null,cost:null};
function conBytes(n){
  var b=Number(n)||0;
  if(b>=1048576)return (b/1048576).toFixed(1)+' MB';
  if(b>=1024)return Math.round(b/1024)+' KB';
  return b+' B';
}
function conWhen(t){ return t?' · 最近 '+clock(t):'' }
function conTime(t){ return t?clock(t):'' }
function supApiT(path,ms){
  return new Promise(function(res){
    var ac=null;try{ac=new AbortController()}catch(e){}
    var to=setTimeout(function(){try{if(ac)ac.abort()}catch(e){}},ms||6000);
    var opt={cache:'no-store'}; if(ac)opt.signal=ac.signal;
    fetch(path,opt).then(function(r){
      return r.text().then(function(t){
        clearTimeout(to);
        var body=null;try{body=JSON.parse(t)}catch(e){}
        res({status:r.status,body:body});
      });
    }).catch(function(e){clearTimeout(to);res({status:0,body:null,err:String(e&&e.message||e)})});
  });
}
function conNote(text,cls){
  ['supChanNote','supBrainNote'].forEach(function(id){
    var el=document.getElementById(id); if(!el)return;
    if(!text){el.hidden=true;el.className='sup-note';el.innerHTML='';return}
    el.hidden=false;el.className='sup-note '+(cls||'');
    el.innerHTML='<span>'+esc(text)+'</span><button class="btn" id="'+id+'-retry">重试</button>';
    var b=document.getElementById(id+'-retry');
    if(b)b.addEventListener('click',function(){supConsole(true)});
  });
}
function chanRow(cls,ico,name,detail,st){
  return '<div class="chan-row '+cls+'"><span class="ico" aria-hidden="true">'+ico+'</span>'
    +'<span class="nm">'+esc(name)+'</span><span class="det" title="'+esc(detail||'')+'">'+esc(detail||'—')+'</span>'
    +'<span class="st">'+esc(st)+'</span></div>';
}
function supRenderChannels(){
  var box=document.getElementById('supChannels'); if(!box)return;
  var ch=(CON.data&&CON.data.channels)||null;
  var rows=[];
  if(ch){
    var q=ch.qq||{};
    var qOk=Boolean(q.ok);
    var qOn=qOk&&Boolean(q.online);
    var qDetail=qOk
      ? ('今发 '+(q.sentToday==null?'—':q.sentToday)+' / 收 '+(q.recvToday==null?'—':q.recvToday))+conWhen(q.lastAt)
      : ('读不到'+(q.detail?('（'+q.detail+'）'):''));
    rows.push(chanRow(qOk?(qOn?'on':'off'):'na', qOn?'●':'○', 'QQ', qDetail, qOk?(qOn?'在线':'离线'):'读不到'));
    var r=ch.relay||{};
    var rOk=Boolean(r.ok), bound=r.bound, total=(r.total==null?2:r.total);
    var full=(bound!=null)&&(Number(bound)>=Number(total));
    rows.push(chanRow(rOk?(full?'on':'off'):'na', rOk?'●':'○', '窗口 relay',
      (rOk?('绑定 '+bound+'/'+total+conWhen(r.lastAt)):('读不到'+(r.detail?('（'+r.detail+'）'):''))),
      rOk?(full?'正常':'未满'):'读不到'));
    var f=ch.files||{};
    var fImpl=Boolean(f.implemented);
    rows.push(chanRow('na','—','QQ 文件通道',
      fImpl?(f.detail||'已接入'):(f.detail||'未接入（网关有能力，本地没实现）'),
      fImpl?'已接入':'未接入'));
  }else{
    // 降级：QQ 借 supervisor 的判断（401 让页面探不准），relay 自己探；只说通不通，不说业务
    var qUp=CON.probe?CON.probe.qq:null, rUp=CON.probe?CON.probe.relay:null;
    rows.push(qUp===null
      ? chanRow('na','○','QQ','读不到（supervisor 也没有它的状态）','读不到')
      : chanRow(qUp?'on':'off', qUp?'●':'○', 'QQ',
          qUp?'端口 3100 通；今发/收 要等总控台接口':'端口 3100 不通', qUp?'在线':'离线'));
    rows.push(rUp===null
      ? chanRow('na','○','窗口 relay','读不到','读不到')
      : chanRow(rUp?'on':'off', rUp?'●':'○', '窗口 relay',
          rUp?'端口 9334 通；绑定数 要等总控台接口':'端口 9334 不通', rUp?'在线':'离线'));
    rows.push(chanRow('na','—','QQ 文件通道','未接入（网关有能力，本地没实现）','未接入'));
  }
  box.innerHTML=rows.join('');
  var n=document.getElementById('supChanCount');
  if(n)n.textContent=(CON.mode==='api'?'总控台':'本地兜底');
}
function supRenderBrain(){
  var box=document.getElementById('supBrain'); if(!box)return;
  var b=(CON.data&&CON.data.brain)||null;
  var cells=[];
  var pv='读不到',ps='';
  if(b&&b.persona&&b.persona.file){
    var p=b.persona;
    pv=String(p.file).split(/[\\/]/).pop()+' · '+(p.chars==null?'—':Number(p.chars).toLocaleString()+' B');
    ps=[p.mtime?conTime(p.mtime):'', p.hasFrontMatter?'':'无参数段'].filter(Boolean).join(' · ');
  }else ps=(CON.mode==='api'?'总控台没给 persona':'要等 /api/console');
  cells.push('<div class="brain-cell"><div class="k">人设</div><div class="v">'+esc(pv)+'</div><div class="s">'+esc(ps)+'</div></div>');
  var mv='读不到',ms='';
  if(b&&b.memory){
    var m=b.memory;
    mv=(m.lines==null?'—':Number(m.lines).toLocaleString()+' 条')+' / '+(m.bytes==null?'—':conBytes(m.bytes));
    ms=(m.files==null?'':(m.files+' 个文件'));
  }else ms=(CON.mode==='api'?'总控台没给 memory':'要等 /api/console');
  cells.push('<div class="brain-cell"><div class="k">记忆</div><div class="v">'+esc(mv)+'</div><div class="s">'+esc(ms)+'</div></div>');
  var cv='¥'+(CON.cost&&CON.cost.totals?Number(CON.cost.totals.cost||0).toFixed(2):'—');
  var cs=CON.cost&&CON.cost.range?CON.cost.range.label:'/api/cost 读不到';
  cells.push('<div class="brain-cell"><div class="k">今日花费</div><div class="v">'+esc(cv)+'</div><div class="s">'+esc(cs)+'</div></div>');
  cells.push('<div class="brain-cell gray"><div class="k">模型</div><div class="v">经 DSH，无本地读数</div><div class="s">窗口不直连模型</div></div>');
  box.innerHTML='<div class="brain-grid">'+cells.join('')+'</div>';
  var n=document.getElementById('supBrainCount');
  if(n)n.textContent=(CON.mode==='api'?'总控台':'总控台未上线');
}
async function supConsole(force){
  if(CON.busy&&!force)return;
  CON.busy=true;
  try{
    var cv=await supApiT('/api/cost',6000).catch(function(){return null});
    if(cv&&cv.status===200&&cv.body)CON.cost=cv.body;
    var r=await supApiT('/api/console',6000);
    if(r.status===200&&r.body&&r.body.ok){
      CON.mode='api';CON.data=r.body;CON.probe=null;
      conNote('', '');
      supRenderChannels();supRenderBrain();
      CON.at=Date.now();return;
    }
    CON.data=null;
    CON.mode=(r.status===404||r.status===0&&/404/.test(String(r.err||'')))?'missing':'error';
    // 兜底：QQ 桥直接探端口（它回 401 会卡到超时 = 活着；死端口秒拒 = 挂了），
    // relay 有 /health 能秒回，正常探即可。
    function supSvcUp(id){ for(var i=0;i<SUP.services.length;i++){ if(SUP.services[i].id===id) return Boolean(SUP.services[i].up) } return null }
    var qDetail=await supProbeDetail('http://127.0.0.1:3100/',2200);
    var qUp=portStateFromProbe(qDetail,2200)==='up';
    var svR=supSvcUp('relay');
    var rUp=(svR===null)?(portStateFromProbe(await supProbeDetail('http://127.0.0.1:9334/health',1500),1500)==='up'):svR;
    CON.probe={qq:qUp,relay:rUp};
    if(CON.mode==='missing')conNote('总控台接口未上线（/api/console 404，WS-027 未交付）：下面用本地探测兜底','warn');
    else conNote('读不到总控台（9340 没起？）'+(r.err?('：'+r.err):''),'bad');
    supRenderChannels();supRenderBrain();
    CON.at=Date.now();
  }catch(e){
    CON.mode='error';CON.data=null;
    conNote('读不到总控台（9340 没起？）：'+e.message,'bad');
    supRenderBrain();
  }finally{CON.busy=false}
}

// ── WS-030 诊断 / 设置 / 桥接（数据全部来自后端，页面只渲染）──────────────
const DGV={sel:null,set:null,cli:null,
  logs:{src:'kernel',kw:'',err:false,lastAt:0,busy:false},
  br:{seq:0,paused:false,onlyErr:false,split:false,status:null,busy:false}};
function dgFmt(ts){ try{ return clock(ts).slice(0,8) }catch(e){ return '—' } }

async function dgSelftest(){
  const box=document.getElementById('diagChecks'); if(!box)return;
  try{
    const r=await j('/api/console/selftest');
    DGV.sel=r;
    const roll=rollupChecks(r.checks);
    document.getElementById('diagSum').innerHTML='<span class="tag '+(roll.level==='ok'?'ok':(roll.level==='bad'?'bad':'sub'))+'">'+roll.icon+' '+esc(roll.label)+'</span>';
    document.getElementById('diagAt').textContent=r.atText?('采样 '+r.atText):'';
    box.innerHTML=(r.checks||[]).map(function(c){
      return '<div class="diag-row '+(c.ok?'ok':'bad')+'">'
        +'<span class="ico">'+(c.ok?'✔':'✖')+'</span>'
        +'<span class="nm">'+esc(c.name)+'</span>'
        +'<span class="det">'+esc(c.detail||'')+'</span>'
        +'<span class="ms">'+(c.ms==null?'':esc(c.ms+' ms'))+'</span></div>';
    }).join('')||'<div class="empty">暂无</div>';
  }catch(e){
    box.innerHTML='<div class="empty" style="color:var(--bad)">读不到自检：'+esc(e.message)+'</div>';
    document.getElementById('diagSum').textContent='自检失败';
  }
}
function dgLine(l){
  const lv=String(l.level||'').toLowerCase();
  return '<div class="ln '+esc(lv)+'"><span class="tm">'+esc(dgFmt(l.at))+'</span> '+esc(l.text||'')+'</div>';
}
async function dgLogs(reset){
  const box=document.getElementById('logBox'); if(!box||DGV.logs.busy)return;
  DGV.logs.busy=true;
  try{
    const r=await j('/api/logs/tail?src='+encodeURIComponent(DGV.logs.src)+'&lines=500');
    let lines=r.lines||[];
    lines=filterLogLines(lines,{keyword:DGV.logs.kw,onlyError:DGV.logs.err});
    if(reset||!DGV.logs.lastAt){
      const t=tailLogLines(lines,500);
      box.innerHTML=t.lines.map(dgLine).join('')||'<div class="empty">暂无日志</div>';
      DGV.logs.lastAt=lines.length?Number(lines[lines.length-1].at||0):0;
      box.scrollTop=box.scrollHeight;
    }else{
      const fresh=lines.filter(function(l){return Number(l.at||0)>DGV.logs.lastAt});
      if(fresh.length){
        const nearBottom=(box.scrollHeight-box.scrollTop-box.clientHeight)<40;
        const frag=document.createElement('div');
        frag.innerHTML=fresh.map(dgLine).join('');
        while(frag.firstChild)box.appendChild(frag.firstChild);
        DGV.logs.lastAt=Number(fresh[fresh.length-1].at||DGV.logs.lastAt);
        while(box.childNodes.length>800)box.removeChild(box.firstChild);
        if(nearBottom)box.scrollTop=box.scrollHeight;      // 真滚动：只在贴底时跟着走
      }
    }
    document.getElementById('logAt').textContent='源 '+DGV.logs.src+' · 尾 500 行'+(r.truncated?'（已截断）':'');
  }catch(e){
    box.innerHTML='<div class="empty" style="color:var(--bad)">读不到日志：'+esc(e.message)+'</div>';
  }finally{ DGV.logs.busy=false }
}

function stField(id,label,val,opt){
  const o=opt||{};
  const input=o.kind==='sel'
    ? '<select id="'+id+'">'+(o.options||[]).map(function(x){return '<option '+(String(x)===String(val)?'selected':'')+'>'+esc(x)+'</option>'}).join('')+'</select>'
    : (o.kind==='chk'
      ? '<input type="checkbox" id="'+id+'" '+(val?'checked':'')+'>'
      : '<input type="'+(o.kind==='num'?'number':'text')+'" id="'+id+'" value="'+esc(val==null?'':val)+'" '+(o.step?('step="'+o.step+'" '):'')+'>');
  return '<div class="field"><label for="'+id+'">'+esc(label)+'</label>'+input
    +(o.hint?('<div class="hint">'+esc(o.hint)+'</div>'):'')+'</div>';
}
async function stLoad(){
  const grid=document.getElementById('setGrid'); if(!grid)return;
  try{
    const v=await j('/api/settings'); DGV.set=v;
    const m=v.model||{}, s=v.sampling||{}, b=v.bridge||{}, p=v.persona||{};
    document.getElementById('setAt').textContent='读取 '+clock(Date.now())+(v.samplingFile?' · '+v.samplingFile:'');
    grid.innerHTML=
      '<section class="setcard"><div class="hh">模型</div>'
      + stField('s_provider','provider',m.provider,{hint:'当前来源：'+(m.keySource||'—')})
      + stField('s_base','baseUrl',m.baseUrl)
      + stField('s_model','model',m.name)
      + '<div class="field"><label for="s_key">API Key</label><input type="password" id="s_key" placeholder="留空 = 不改"></div>'
      + '<div class="field"><label>当前</label><span class="masked">'+esc(m.keyMasked||'—')+(m.hasKey?'（已存）':'（未存）')+'</span></div>'
      + '</section>'
      + '<section class="setcard"><div class="hh">采样</div>'
      + stField('s_temp','温度',s.temperature,{kind:'num',step:'0.1'})
      + stField('s_max','max tokens',s.maxTokens,{kind:'num'})
      + stField('s_freq','频率惩罚',s.freqPenalty,{kind:'num',step:'0.1'})
      + stField('s_pres','在场惩罚',s.presPenalty,{kind:'num',step:'0.1'})
      + stField('s_timeout','超时 ms',s.timeoutMs,{kind:'num'})
      + stField('s_deep','深度思考',Boolean(s.deepThink),{kind:'chk'})
      + '</section>'
      + '<section class="setcard"><div class="hh">桥</div>'
      + stField('s_burl','SnowLuma 地址',b.url,{hint:b.tokenSource?('令牌来源：'+b.tokenSource):''})
      + '<div class="field"><label for="s_btoken">桥令牌</label><input type="password" id="s_btoken" placeholder="留空 = 不改"></div>'
      + '<div class="field"><label>当前</label><span class="masked">'+esc(b.tokenMasked||'—')+'</span></div>'
      + '</section>'
      + '<section class="setcard"><div class="hh">人设</div>'
      + '<div class="field"><label>文件</label><span class="masked" style="word-break:break-all">'+esc(p.path||'—')+'</span></div>'
      + '<div class="field"><label>mtime</label><span>'+esc(p.mtime?clock(p.mtime):'—')+'</span></div>'
      + '<div class="field"><label>字数</label><span>'+(p.chars==null?'—':esc(p.chars))+'</span></div>'
      + '<div class="field"><label>说明</label><span class="masked">人设是文件，只显示路径与统计；正文不在页面里编辑</span></div>'
      + '</section>';
  }catch(e){
    grid.innerHTML='<div class="empty" style="color:var(--bad)">读不到设置：'+esc(e.message)+'</div>';
  }
}
async function stSave(){
  const btn=document.getElementById('setSave'); if(!btn)return;
  const val=function(id){const el=document.getElementById(id);return el?el.value:''};
  const chk=function(id){const el=document.getElementById(id);return el?Boolean(el.checked):false};
  const form={model:{provider:val('s_provider'),baseUrl:val('s_base'),name:val('s_model'),key:val('s_key')},
    sampling:{temperature:val('s_temp'),maxTokens:val('s_max'),freqPenalty:val('s_freq'),presPenalty:val('s_pres'),timeoutMs:val('s_timeout'),deepThink:chk('s_deep')},
    bridge:{url:val('s_burl'),token:val('s_btoken')}};
  const patch=mergeSettingsPatch(form,DGV.set||{});
  if(!Object.keys(patch).length){alert('没有要保存的改动');return}
  if(!confirm('保存设置？\\n只提交有变化的字段；Key/令牌留空表示不改。'))return;
  btn.disabled=true;const old=btn.textContent;btn.textContent='保存中…';
  try{
    const r=await j('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
    var msg='已保存：'+((r.applied||[]).join('、')||'（无）');
    if(r.warnings&&r.warnings.length)msg+='\\n提醒：'+r.warnings.join('；');
    if(r.restartNeeded)msg+='\\n要重启桥才生效';
    alert(msg);
    stLoad();
  }catch(e){alert('保存失败：'+e.message)}
  finally{btn.disabled=false;btn.textContent=old}
}

async function brLoad(){
  const head=document.getElementById('brHead'); if(!head)return;
  try{
    const s=await j('/api/bridge/status'); DGV.br.status=s;
    const light=bridgeLight(s);
    document.getElementById('brSum').innerHTML='<span class="tag '+(light.level==='ok'?'ok':(light.level==='bad'?'bad':'sub'))+'">'+light.icon+' '+esc(light.label)+'</span>';
    head.innerHTML=
      '<div class="bcell"><div class="k">桥心跳</div><div class="v">'+esc(agoText(s.lastHeartbeatAgoMs))+' 前</div></div>'
      +'<div class="bcell"><div class="k">DSH 会话已绑定</div><div class="v">'+esc(String(s.sessionBound==null?'—':s.sessionBound))+'</div></div>'
      +'<div class="bcell"><div class="k">队列深度</div><div class="v">'+esc(String(s.queueDepth==null?'—':s.queueDepth))+'</div></div>'
      +'<div class="bcell"><div class="k">错误数</div><div class="v">'+esc(String(s.errorCount==null?'—':s.errorCount))+'</div></div>'
      +'<div class="bcell"><div class="k">模式</div><div class="v">'+esc(s.mode||'—')+'</div></div>'
      +'<div class="bcell"><div class="k">SnowLuma</div><div class="v">'+esc(!s.snowluma?'未知':(s.snowluma.accountOnline?'已登录在线':(s.snowluma.connected?'已连未登录':'未连')))+'</div></div>';
    const cfg=s.config||{};
    const tog=document.getElementById('brToggles');
    tog.innerHTML=stField('b_sendDelay','发送间隔 ms',cfg.sendDelayMs==null?300:cfg.sendDelayMs,{kind:'num'})
      +stField('b_ack','发送后回执',cfg.ackMessage==null?true:Boolean(cfg.ackMessage),{kind:'chk'})
      +stField('b_qto','提问超时 ms',cfg.questionTimeoutMs==null?5000:cfg.questionTimeoutMs,{kind:'num'})
      +stField('b_allow','允许（逗号分隔）',(cfg.allow||[]).join(','),{hint:'白名单字段，其他字段只读'})
      +stField('b_deny','拒绝（逗号分隔）',(cfg.deny||[]).join(','))
      +'<div class="acts"><button class="btn pri" id="brSaveToggles">保存开关</button>'
      +(s.configAvailable===false?'<span class="masked">config 读不到，开关只读</span>':'')+'</div>';
    const sv=document.getElementById('brSaveToggles');
    if(sv)sv.addEventListener('click',brSaveToggles);
    const perms=document.getElementById('brPerms');
    perms.innerHTML=
      '<div class="field"><label>桥在线</label><span>'+esc(s.up?'是':'否')+'</span></div>'
      +'<div class="field"><label>会话已绑</label><span>'+esc(s.sessionBound?'是':'否')+'</span></div>'
      +'<div class="field"><label>收消息</label><span>'+esc(s.lastLogAgoMs!=null?(agoText(s.lastLogAgoMs)+' 前有日志'):'—')+'</span></div>'
      +'<div class="field"><label>最近错误</label><span>'+esc(s.lastError?String(s.lastError).slice(0,120):'无')+'</span></div>';
  }catch(e){
    head.innerHTML='<div class="empty" style="color:var(--bad)">读不到桥状态：'+esc(e.message)+'</div>';
  }
}
async function brSaveToggles(){
  const val=function(id){const el=document.getElementById(id);return el?el.value:''};
  const chk=function(id){const el=document.getElementById(id);return el?Boolean(el.checked):false};
  const patch=pickBridgePatch({sendDelayMs:Number(val('b_sendDelay')),ackMessage:chk('b_ack'),questionTimeoutMs:Number(val('b_qto')),
    allow:val('b_allow').split(',').map(function(x){return x.trim()}).filter(Boolean),
    deny:val('b_deny').split(',').map(function(x){return x.trim()}).filter(Boolean)});
  if(!confirm('保存桥开关？只改白名单五个字段：'+Object.keys(patch).join('、')))return;
  const keys=Object.keys(patch);
  try{
    for(const k of keys){
      const r=await j('/api/bridge/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k,value:patch[k]})});
      if(!r.ok)throw new Error(k+'：'+(r.error||'失败'));
    }
    alert('已保存：'+keys.join('、'));
    brLoad();
  }catch(e){alert('保存失败：'+e.message)}
}
async function brLogs(reset){
  const box=document.getElementById('brLogBox'); if(!box||DGV.br.paused||DGV.br.busy)return;
  DGV.br.busy=true;
  try{
    const src=DGV.br.onlyErr?'errors':(DGV.br.split?'all':'all');
    const r=await j('/api/bridge/logs?src='+src+'&after='+(reset?0:DGV.br.seq)+'&lines=200');
    const lines=r.lines||[];
    if(reset){box.innerHTML=''}
    if(lines.length){
      const nearBottom=(box.scrollHeight-box.scrollTop-box.clientHeight)<40;
      const frag=document.createElement('div');
      frag.innerHTML=lines.map(dgLine).join('');
      while(frag.firstChild)box.appendChild(frag.firstChild);
      if(r.nextSeq)DGV.br.seq=r.nextSeq;
      while(box.childNodes.length>600)box.removeChild(box.firstChild);
      if(nearBottom)box.scrollTop=box.scrollHeight;
    }else if(!box.childNodes.length||reset){box.innerHTML='<div class="empty">暂无桥日志</div>'}
  }catch(e){
    box.innerHTML='<div class="empty" style="color:var(--bad)">读不到桥日志：'+esc(e.message)+'</div>';
  }finally{ DGV.br.busy=false }
}

function dgEnter(){
  dgSelftest();DGV.logs.lastAt=0;dgLogs(true);
  clearInterval(DGV.timer);
  DGV.timer=setInterval(function(){ if(currentView==='diag'){dgLogs(false)} },3000);
}
function stEnter(){ stLoad(); clearInterval(DGV.timer); }
function brEnter(){
  brLoad(); DGV.br.seq=0; brLogs(true);
  clearInterval(DGV.timer);
  let tick=0;
  DGV.timer=setInterval(function(){
    if(currentView!=='bridge')return;
    brLogs(false);
    if((++tick%5)===0)brLoad();          // 日志 2s、状态 10s
  },2000);
}
document.getElementById('diagRerun').addEventListener('click',dgSelftest);
document.getElementById('logSrc').addEventListener('change',function(){DGV.logs.src=this.value;DGV.logs.lastAt=0;dgLogs(true)});
document.getElementById('logKw').addEventListener('input',function(){DGV.logs.kw=this.value;DGV.logs.lastAt=0;dgLogs(true)});
document.getElementById('logErr').addEventListener('change',function(){DGV.logs.err=this.checked;DGV.logs.lastAt=0;dgLogs(true)});
document.getElementById('setSave').addEventListener('click',stSave);
document.getElementById('brRefresh').addEventListener('click',function(){brLoad();DGV.br.seq=0;brLogs(true)});
document.getElementById('brRestart').addEventListener('click',async function(){
  if(!confirm('重启桥？走 supervisor 的 /api/supervisor/restart（不直接 kill）'))return;
  try{ const r=await j('/api/bridge/restart',{method:'POST'}); alert(r.ok?('已请求重启：'+(r.detail||r.action||'ok')):('失败：'+(r.error||''))); brLoad(); }
  catch(e){ alert('重启失败：'+e.message) }
});
document.getElementById('brRtoken').addEventListener('click',async function(){
  try{ const r=await j('/api/bridge/refresh-token',{method:'POST'}); alert(r.ok?('令牌已刷新'+(r.note?('：'+r.note):'')):('失败：'+(r.error||''))); brLoad(); }
  catch(e){ alert('刷新失败：'+e.message) }
});
document.getElementById('brQueue').addEventListener('click',async function(){
  try{ const r=await j('/api/bridge/status'); alert('队列深度：'+(r.queueDepth==null?'—':r.queueDepth)+'\\n最近错误：'+(r.lastError||'无')); }
  catch(e){ alert('读不到：'+e.message) }
});
document.getElementById('brFollow').addEventListener('change',function(){ if(this.checked){const b=document.getElementById('brLogBox'); if(b)b.scrollTop=b.scrollHeight} });
document.getElementById('brOnlyErr').addEventListener('change',function(){DGV.br.onlyErr=this.checked;DGV.br.seq=0;brLogs(true)});
document.getElementById('brPause').addEventListener('click',function(){DGV.br.paused=!DGV.br.paused;this.textContent=DGV.br.paused?'继续':'暂停'});
document.getElementById('brCopy').addEventListener('click',function(){
  const b=document.getElementById('brLogBox'); const t=b?b.innerText:'';
  if(navigator.clipboard)navigator.clipboard.writeText(t).then(function(){alert('已复制 '+t.length+' 字符')},function(){alert('复制失败，手动选吧')});
  else alert('这台浏览器不给剪贴板权限，手动选吧');
});

// ── 状态与刷新 ───────────────────────────────────────────────────────────
let currentView='projects',drawerOpen=false,dTab='mail',lastProjects=null;
let lastAgents=null,lastWl=null,lastHealth=null;
function setView(name){
  currentView=name;
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.view===name));
  document.querySelectorAll('.view').forEach(v=>{v.hidden=(v.id!=='view-'+name)});
  if(name==='cost'){
    if(lastHealth)renderCost(lastHealth);
    else document.getElementById('cost').innerHTML='<div class="empty">采样中…</div>';
    j('/api/sessions-health?reconcile=1').then(d=>{lastHealth=d;renderCost(d)}).catch(e=>{document.getElementById('cost').innerHTML='<div class="empty">采样失败：'+esc(e.message)+'</div>'});
  }
  if(name==='blockers'&&lastWl)renderBlockers(lastWl);
  if(name==='unacked')renderUnacked();
  if(name==='dispatch')supEnter();
  if(name==='diag')dgEnter();
  if(name==='settings')stEnter();
  if(name==='bridge')brEnter();
  if(name==='projects'){
    if(lastProjects)renderProjects(lastProjects);
    j('/api/projects').then(d=>{lastProjects=d;renderProjects(d)}).catch(e=>{const el=document.getElementById('pj-list');if(el)el.innerHTML='<div class="empty" style="color:var(--bad)">读不到项目：'+esc(e.message)+'</div>'});
  }
}
function setDrawer(open){
  drawerOpen=open;
  document.getElementById('drawer').hidden=!open;
  if(open&&dTab==='health'&&lastHealth)renderHealth(lastHealth);
  if(open&&dTab==='health'&&!lastHealth)j('/api/sessions-health?reconcile=1').then(d=>{lastHealth=d;renderHealth(d)}).catch(e=>{document.getElementById('d-health').innerHTML='<div class="empty">采样失败：'+esc(e.message)+'</div>'});
}
function setDTab(name){
  dTab=name;
  document.querySelectorAll('.dtab').forEach(b=>b.classList.toggle('on',b.dataset.d===name));
  document.querySelectorAll('.dview').forEach(v=>{v.classList.toggle('on',v.id==='d-'+name)});
  if(name==='health')setDrawer(true);
  if(name==='health'){j('/api/sessions-health?reconcile=1').then(d=>{lastHealth=d;renderHealth(d)}).catch(e=>{document.getElementById('d-health').innerHTML='<div class="empty">采样失败：'+esc(e.message)+'</div>'})}
}
async function tick(){
  try{
    const needHealth=(currentView==='cost')||(drawerOpen&&dTab==='health');
    const needProjects=(currentView==='projects');
    const reqs=[j('/api/agents'),j('/api/tasks'),j('/api/worklist'),j('/api/mail'),j('/api/relay'),j('/api/nudge')];
    if(needHealth)reqs.push(j('/api/sessions-health'));
    if(needProjects)reqs.push(j('/api/projects'));
    reqs.push(j('/api/send'));            // D89：队列永远要看（发送状态是主人在等的东西）
    reqs.push(j(UNACK_URL));              // UG-007：顶部「未回执 N」永远要看
    const r=await Promise.all(reqs);
    const [agents,tasks,wl,mail,relay,nudge]=r;
    lastAgents=agents;lastWl=wl;
    if(needHealth&&r[6])lastHealth=r[6];
    if(needProjects){const pi=needHealth?7:6;if(r[pi]){lastProjects=r[pi];renderProjects(lastProjects)}}
    renderBoard(agents,wl);
    renderBlockers(wl);
    renderMail(mail,nudge);
    window.__relay=relay;
    renderRelay(relay);
    renderLedger(wl);
    renderSend(r[r.length-2]);
    renderUnacked(r[r.length-1]);
    if(currentView==='cost'&&lastHealth)renderCost(lastHealth);
    if(currentView==='dispatch'){   // WS-017：票与工人跟着 5s 走；服务灯/事件 15s 一次
      supRenderPeople();
      if(!SUP.at||Date.now()-SUP.at>=15000)supLoad();
      else supRenderLights();
    }
    if(drawerOpen&&dTab==='health'&&lastHealth)renderHealth(lastHealth);
    const recent=(tasks.recentDeliveries||[]).map(x=>'<span class="fname">'+esc(x.name)+'</span>').join('　·　');
    document.getElementById('recent').innerHTML='最近交付'+(recent?('：'+recent):'：—')+'　·　dispatch 配额 '+(wl.quota?wl.quota.used+'/'+wl.quota.limit:'—');
    // D33：花费面板标题显示统计区间（/api/cost，服务端 10s 缓存）
    if(currentView==='cost'){
      j('/api/cost').then(c=>{
        const el=document.getElementById('c-cost');
        if(el&&c&&c.ok)el.textContent='统计区间 '+c.range.label+' · ¥'+Number(c.totals.cost).toFixed(2);
      }).catch(()=>{});
    }
    document.getElementById('meta').textContent='更新 '+clock(Date.now())+(agents.error?' · 投影读不到':' · 零 token（除派发）');
  }catch(e){document.getElementById('meta').textContent='刷新失败：'+e.message}
}
const VIEWS=['projects','dispatch','diag','settings','bridge','board','blockers','unacked','cost'];
function hashName(){return (location.hash||'').replace(/^#/,'')}
function viewFromHash(){const h=hashName();return VIEWS.includes(h)?h:'projects'}   // D43：没 hash 时第一屏是「项目」
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{setView(b.dataset.view);try{history.replaceState(null,'','#'+b.dataset.view)}catch(e){}}));
document.querySelectorAll('.dtab').forEach(b=>b.addEventListener('click',()=>setDTab(b.dataset.d)));
document.getElementById('drawerBtn').addEventListener('click',()=>setDrawer(true));
document.getElementById('drawerClose').addEventListener('click',()=>setDrawer(false));
window.addEventListener('hashchange',()=>{if(hashName()==='more')setDrawer(true);else setView(hashName())});
window.addEventListener('keydown',(e)=>{if(e.key==='Escape')setDrawer(false)});
setView(viewFromHash());
if(hashName()==='more')setDrawer(true);
tick();setInterval(tick,5000);
</script>
</body>
</html>`;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
if (acquireWorklistLock()) logLine('[lock] 本实例持有台账锁（演练只在这里生效）');
else logLine('[lock] 台账锁被其他实例持有（演练会 409）');
setInterval(() => { refreshWorklistLock(); }, 20000).unref?.();

scanDeliveries({ prime: true });   // 存量只登记、不认领：历史交付不该在启动时炸出一堆 unlinked
const scanTimer = setInterval(() => { try { scanDeliveries(); } catch (e) { logLine(`[scan] 异常 ${e?.message ?? e}`); } }, Number(readConfig().scanIntervalMs || 10000));
scanTimer.unref();

// D22 自动接力：每 10 秒看一眼「谁空闲 + 谁有 queued」；一轮最多派一件。
const relayTimer = setInterval(() => { autoRelayTick().catch((e) => logLine(`[relay] tick 异常 ${e?.message ?? e}`)); }, relayConfig().intervalMs);
relayTimer.unref();

// D17 敲门：只对 level=活 的未读，一封只敲一次（nudged 防重放）；普通通知永不动。
const nudgeTimer = setInterval(() => { nudgeTick().catch((e) => logLine(`[nudge] tick 异常 ${e?.message ?? e}`)); }, nudgeConfig().intervalMs);
nudgeTimer.unref();

// UG-039：未送达的重试驱动（5 秒一轮；只处理"到点了"的，没排队的票一分钱不花）
const deliveryRetryTimer = String(process.env.DELIVERY_RETRY_TICK ?? '1') === '0' ? null : setInterval(() => {
  processDueRetries({ limit: 2 })
    .then((rows) => { for (const r of rows) logLine(`[delivery] 重试 ${r.id}（${r.ticket ?? '—'}）→ ${r.delivered ? '送达' : `仍未送达：${r.lastError ?? ''}`}`); })
    .catch((e) => logLine(`[delivery] 重试异常 ${e?.message ?? e}`));
}, 5000);
deliveryRetryTimer?.unref?.();

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('uncaughtException', (error) => logLine(`uncaughtException: ${error?.stack ?? error}`));
process.on('unhandledRejection', (reason) => logLine(`unhandledRejection: ${reason?.stack ?? reason}`));

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }));
});
server.on('error', (error) => {
  process.stderr.write(error?.code === 'EADDRINUSE'
    ? `workdesk: ${PORT} 已被占用（可能已有工作台在跑）\n`
    : `workdesk: 监听失败 ${error?.code ?? error?.message ?? error}\n`);
  process.exitCode = 1;
});
  // 2026-11-07 地址迁移兜底：旧书签/旧脚本还指着 127.0.0.1，额外镜像一个监听，避免"刷新失败"
  try {
    const mirror = http.createServer((req, res) => server.emit('request', req, res));
    mirror.listen(PORT, '127.0.0.1', () => process.stdout.write('workdesk 兼容监听 http://127.0.0.1:' + PORT + '（旧书签可用）\n'));
    mirror.on('error', (e) => process.stdout.write('workdesk 兼容监听失败 ' + (e?.code ?? e?.message) + '\n'));
  } catch (e) {
    process.stdout.write('workdesk 兼容监听异常 ' + String(e?.message ?? e) + '\n');
  }
server.listen(PORT, '127.1.1.2', () => {
  process.stdout.write(`workdesk ${VERSION} 监听 http://127.1.1.2:${PORT}（10s 扫交付；花钱的只有 dispatch）\n`);
  // WS-010：内置调度器（accept 60s / mail 5min / outbox 30s / health 5min / tmpguard 每日 04:10）
  try {
    const st = startScheduler();
    process.stdout.write(`[scheduler] enabled=${st.enabled} skipped=${st.skipped ?? '—'}\n`);
  } catch (e) {
    process.stdout.write(`[scheduler] start-failed ${String(e?.message ?? e)}\n`);
  }
  // WS-028：QQ 文件通道登记 + 收件轮询（60s 一次；XUNYU_QQ_FILE_POLL=0 可关）
  // 这里用 then 不用 await：listen 的回调不是 async 函数。
  import('./routes/files.mjs')
    .then(({ startFileChannel }) => {
      const fc = startFileChannel();
      process.stdout.write(`[qq-files] inbox=${fc.inbox} outbox=${fc.outbox} poll=${fc.pollMs}ms\n`);
    })
    .catch((e) => process.stdout.write(`[qq-files] start-failed ${String(e?.message ?? e)}\n`));
  // D64（03）：启动痕迹落到生命周期日志，和 supervisor 的「拉起」行并排，方便对齐重启。
  try {
    fs.appendFileSync(path.join(WORKSPACE, 'logs', 'workdesk.run.log'),
      `[boot] pid=${process.pid} startedAt=${new Date(STARTED_AT).toISOString()} version=${VERSION} port=${PORT}\n`, 'utf8');
  } catch { }
});
const shutdown = () => { clearInterval(scanTimer); clearInterval(relayTimer); clearInterval(nudgeTimer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
