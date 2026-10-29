#!/usr/bin/env node
// scripts/workdesk-server.mjs —— 本地工作台（127.0.0.1:9340）· D12 v1
//
// v0.1（D8）三个只读接口打底；D12 加：任务队列（worklist 回放）、派发（**唯一花钱的动作**）、
// 交付扫描（每 10 秒，零 token）、待验收栏。
//
// 花钱的只有 POST /api/dispatch（内部只有一次 session/prompt）。其余接口一律零 token：
//   · 会话投影：sessions/list（本地 RPC，不产生模型回合）
//   · 台账：state\worklist.jsonl（本地文件）
//   · 交付：records\交付\*（本地目录扫描）
//   · 邮件：<Xunyu根>\memory\mail\mailbox.jsonl（本地文件）
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
  setState as wlSetState, approvePlan, rejectPlan, PLAN_STATES,
  pendingUnlocks, markUnblocked, blockedList
} from './worklist-core.mjs';
import { dispatch as dispatchTask, readConfig, quotaUsed, readAudit, DISPATCH_LOG } from './dispatch-core.mjs';
import { collectCost, parseAt as parseClock, dayStart as dayStartOf } from './cost-core.mjs';   // D44：唯一计价函数

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const TASKS_DIR = path.join(WORKSPACE, 'state', 'tasks');
const DELIVERY_DIR = path.join(WORKSPACE, 'records', '交付');
const MAIL_BOX = '<Xunyu根>\\memory\\mail';
const MAIL_FILE = path.join(MAIL_BOX, 'mailbox.jsonl');
const DSH_CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
const DSH_BASE_MOD = 'file:///E:/DSH_workspace/scripts/dsh-base.mjs';

const AGENTS_TTL_MS = 3000;
const RPC_TIMEOUT_MS = 2500;
const MAIL_PAGE = 50;

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = Number(portArg >= 0 ? argv[portArg + 1] : (process.env.WORKDESK_PORT || 9340));
const STARTED_AT = Date.now();

const nowMs = () => Date.now();
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// ── 小工具 ──────────────────────────────────────────────────────────────────
function readJson(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } }
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
const relayState = { last: null, inFlight: false, backoff: new Map(), ticks: 0 };

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
    const queued = replayWorklist()
      .filter((t) => t.state === 'queued' && t.target && !t.blocked)   // D30：前置没完成的单不派
      .sort((a, b) => (Number(a.order ?? 0) - Number(b.order ?? 0)) || ((a.createdAt ?? 0) - (b.createdAt ?? 0)));
    for (const agent of agents) {
      if (!agent.no) continue;
      if (agent.running || agent.live) continue;                     // 在干就别插手
      if ((relayState.backoff.get(agent.no) ?? 0) > nowMs()) continue; // 退避中
      const next = queued.find((t) => String(t.target) === String(agent.no));
      if (!next) continue;
      // 演练口（默认关）：只用来验「失败退避 60s」这条守卫，生产不设这个环境变量就没有这分支。
      if (process.env.WORKDESK_RELAY_DRILL_FAIL === '1') {
        delete process.env.WORKDESK_RELAY_DRILL_FAIL;
        relayState.backoff.set(agent.no, nowMs() + cfg.backoffMs);
        relayState.last = { at: nowMs(), target: agent.no, task: next.id, ticket: next.ticket ?? next.id, ok: false, code: 'drill-failure', detail: '演练：故意失败一次，验退避' };
        logLine(`[relay] 工号${agent.no} 演练失败 → 退避 ${cfg.backoffMs}ms`);
        break;
      }
      const res = await dispatchTask(next.id, { by: 'auto-relay' });
      relayState.last = {
        at: nowMs(), target: agent.no, task: next.id, ticket: next.ticket ?? next.id,
        ok: res.ok, code: res.code, detail: res.detail
      };
      logLine(`[relay] 工号${agent.no} 空闲有空单 → 派 ${next.id}：${res.ok ? 'OK' : `失败 ${res.code}`}`);
      if (!res.ok) relayState.backoff.set(agent.no, nowMs() + cfg.backoffMs);
      break;   // ★ 一次只派一件
    }
  } catch (error) {
    logLine(`[relay] 异常 ${error?.message ?? error}`);
  } finally {
    relayState.inFlight = false;
  }
}

// ── 邮件「敲门」（D17）：只有 level=活 的未读才发一次 prompt，敲过写 nudged 防重放 ──
// 普通通知永不唤醒（成本纪律：一次 prompt 就是一轮，钱只花在真急的事上）。
const NUDGE_FILE = path.join(WORKSPACE, 'state', 'mail-nudged.json');
const nudgeState = { last: null, inFlight: false, ticks: 0, backoff: new Map() };

function nudgeConfig() {
  const cfg = readConfig();
  const n = cfg.nudge ?? {};
  return {
    enabled: n.enabled !== false,
    perDay: Number(n.perDay ?? 10),
    backoffMs: Number(n.backoffMs ?? 60000),
    intervalMs: Number(n.intervalMs ?? 15000)
  };
}
function readNudged() {
  try { return JSON.parse(fs.readFileSync(NUDGE_FILE, 'utf8').replace(/^\uFEFF/, '')) ?? {}; } catch { return {}; }
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

  const candidates = (mail.recent ?? [])
    .filter((m) => String(m.level) === '活')
    .filter((m) => !nudged[String(m.seq)])                       // 敲过的永不再敲
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
      nudged[backoffKey] = { at: startedAt, ok: true, to: pick.to, sessionId: pick.sessionId, seq: pick.seq };
      writeNudged(nudged);
      tcpRecord({ t: startedAt, op: 'nudge', by: 'workdesk', seq: pick.seq, to: pick.to, sessionId: pick.sessionId, promptChars: text.length, ok: true, status: 200, code: 'nudged', detail: 'level=活 未读，敲一次', ms: nowMs() - startedAt });
      nudgeState.last = { at: startedAt, seq: pick.seq, to: pick.to, ok: true };
      logLine(`[nudge] #${pick.seq} → ${pick.to}（${pick.sessionId}）敲了一次`);
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
        doing: wa.line ?? null,
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
      doing: wa.line ? clip(wa.line, 80) : null,
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
const DELIVERY_RE = /^([0-9]{2})-([0-9]{8})-([A-Za-z0-9_]+)\.md$/;
const seenDeliveries = new Map();   // 文件名 → {size, mtime}
const unlinked = new Map();         // 文件名 → {name, reason, at}
const claimed = [];                 // 最近认领记录（给页面看）

function scanDeliveries({ prime = false } = {}) {
  let files = [];
  try { files = fs.readdirSync(DELIVERY_DIR).filter((f) => f.endsWith('.md')); } catch { return; }
  const tasks = replayWorklist();

  // 文件被删掉 → unlinked / seen 里那条也要消失（工单 §四.1「删掉后恢复正常」）
  const present = new Set(files);
  for (const name of [...unlinked.keys()]) if (!present.has(name)) unlinked.delete(name);
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

    wlSetState(pick.id, 'submitted', { from: 'workdesk', note: '交付文件已落', target: pick.target });
    // 记录交付文件名（回放里当 attach 事件，页面靠它取链接）
    fs.appendFileSync(WORKLIST_FILE, `${JSON.stringify({ t: nowMs(), id: pick.id, op: 'attach', from: 'workdesk', note: `delivery:${name}` })}\n`, 'utf8');
    unlinked.delete(name);
    const seq = postMail('01', `【待验收】${agent} 交了 ${ticket}：records\\交付\\${name}（状态 submitted）`);
    claimed.push({ task: pick.id, ticket, agent, file: name, at: nowMs(), mailSeq: seq });
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
      agent: agent ? { id: agent.id, title: agent.title, running: agent.running, live: agent.live, doing: agent.doing, idleMs: agent.idleMs, idleText: agent.idleText } : null,
      doing: g.doing, queue: g.queue, pending: g.pending,
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
    tasks, groups,
    plan: planStateView(tasks),
    submitted: tasks.filter((t) => t.state === 'submitted').map((t) => ({
      ...t,
      file: (t.notes ?? []).map((n) => /^delivery:(.+)$/.exec(n.note)?.[1]).filter(Boolean).pop() ?? null
    })),
    unlinked: [...unlinked.values()].sort((a, b) => b.at - a.at),
    claimed: claimed.slice(-10),
    quota: { used: quotaUsed('dispatch'), limit: Number(readConfig().dispatchPerDay), op: 'dispatch' },
    scan: { intervalMs: Number(readConfig().scanIntervalMs), seen: seenDeliveries.size }
  };
}

// ── 项目视图（D43）：state\projects.json × worklist 现算进度，不写死任何数字 ──────
const PROJECTS_FILE = path.join(WORKSPACE, 'state', 'projects.json');
function projectsState() {
  const pj = readJson(PROJECTS_FILE, null);
  if (!pj || !Array.isArray(pj.projects)) {
    return { ok: false, error: 'state\\projects.json 读不到或格式不对', projects: [], doing: [], planned: [], unstarted: [] };
  }
  const tasks = replayWorklist();
  const byTicket = new Map();
  for (const t of tasks) {
    const k = String(t.ticket ?? '').trim().toUpperCase();
    if (!k) continue;
    if (!byTicket.has(k)) byTicket.set(k, []);
    byTicket.get(k).push(t);
  }
  const arrOf = (ticket) => byTicket.get(String(ticket ?? '').trim().toUpperCase()) ?? [];
  const pick = (ticket) => {
    const arr = arrOf(ticket);
    if (!arr.length) return null;
    return arr.find((t) => t.state === 'doing')
      ?? arr.find((t) => t.state === 'submitted')
      ?? arr.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
      ?? null;
  };
  const doneOf = (ticket) => arrOf(ticket).some((t) => t.state === 'done');

  const projects = pj.projects.map((p) => {
    const features = (Array.isArray(p.features) ? p.features : []).map((f) => {
      const tickets = Array.isArray(f.tickets) ? f.tickets : [];
      const done = tickets.filter(doneOf).length;
      const picked = tickets.map((tk) => ({ tk, task: pick(tk) }));
      const doing = picked.filter((x) => x.task && x.task.state === 'doing').map((x) => ({
        ticket: x.tk, id: x.task.id, target: x.task.target ?? null, title: x.task.title ?? ''
      }));
      return {
        id: f.id, name: f.name, note: f.note ?? '', tickets,
        total: tickets.length, done,
        pct: tickets.length ? done / tickets.length : 0,
        doing,
        started: picked.some((x) => x.task && ['doing', 'submitted', 'done'].includes(x.task.state))
      };
    });
    const total = features.reduce((n, f) => n + f.total, 0);
    const done = features.reduce((n, f) => n + f.done, 0);
    const doing = features.flatMap((f) => f.doing.map((d) => ({ ...d, feature: f.id, featureName: f.name })));
    let status;
    if (p.state === 'paused') status = '暂停';
    else if (total > 0 && done >= total) status = '已完成';
    else if (doing.length) status = '在做';
    else if (features.some((f) => f.started)) status = '在做';   // 有 submitted 但暂时没 doing，也算在做
    else status = '要做';
    return {
      id: p.id, name: p.name, doc: p.doc ?? null, summary: p.summary ?? '', note: p.note ?? '',
      state: p.state ?? null, status, total, done, pct: total ? done / total : 0,
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
    for (const agent of agents) {
      const list = queueByTarget.get(String(agent.no ?? '')) ?? [];
      agent.queued = list.length;
      agent.nextTask = list.length ? { id: list[0].id, ticket: list[0].ticket ?? list[0].id, title: list[0].title } : null;
    }
    sendJson(res, 200, {
      ok: !sessions.error, tool: 'workdesk', version: VERSION, at: iso(at), ts: at,
      source: rpc ? { url: rpc.url, method: 'sessions/list（投影，零 token）' } : null,
      cacheAgeMs: sessions.at ? at - sessions.at : null,
      error: sessions.error || null, count: agents.length, live: agents.filter((a) => a.live).length, agents
    });
    return;
  }

  if (req.method === 'GET' && route === '/api/projects') {
    sendJson(res, 200, { tool: 'workdesk', version: VERSION, ...projectsState() });
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

  // W-028：会话检测（只读；?refresh=1 强制重采样投影，?reconcile=1 顺带跑一次 token-report 对账）
  if (req.method === 'GET' && route === '/api/sessions-health') {
    const health = sessionHealth(sessions);
    const attribution = await attributionState(health, { reconcile: url.searchParams.get('reconcile') === '1' });
    sendJson(res, 200, { ...health, attribution });
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
      quota: { used: quotaUsed('dispatch'), limit: Number(readConfig().dispatchPerDay ?? 20) }
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

  if (req.method === 'GET' && route === '/api/health') {
    sendJson(res, 200, {
      ok: true, module: 'workdesk', version: VERSION, port: PORT, uptimeMs: nowMs() - STARTED_AT, ts: nowMs(),
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
  sendJson(res, 404, { ok: false, error: '只有 /、/api/agents、/api/tasks、/api/worklist、/api/mail、/api/health；POST /api/dispatch|accept|reject' });
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
  /* UI 规格 v1（docs\UI规格-v1.md）：暖白 + 浅灰 + 蓝。改这里之前先改规格。 */
  :root{--bg:#FAF7F2;--panel:#FFFFFF;--panel2:#F3EFE8;--line:#E4DED4;
        --fg:#1F2328;--dim:#5C6470;--weak:#8A929C;
        --accent:#2F6BFF;--accent-h:#1F55DB;--accent-soft:#EAF0FF;
        --ok:#15803D;--warn:#B45309;--bad:#B91C1C;--purple:#6D28D9}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  header{display:flex;align-items:center;gap:12px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
  .tabs{display:flex;gap:8px}
  .tab{padding:4px 12px;border:1px solid var(--line);border-radius:6px;color:var(--dim);background:var(--panel);font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px}
  .tab:hover{background:var(--panel2)}
  .tab.on{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
  .badge{font-size:12px;padding:0 8px;border-radius:999px;background:var(--bad);color:#fff;min-width:20px;text-align:center;line-height:18px}
  .badge.zero{background:var(--line);color:var(--dim)}
  .grow{flex:1}.meta{color:var(--dim);font-size:12px}
  #unlinked{display:none;padding:8px 16px;color:var(--warn);background:#FDF6E8;border-bottom:1px solid var(--line)}
  main{padding:16px;max-width:1400px}
  .view[hidden]{display:none}
  h2{margin:0 0 12px;font-size:20px;font-weight:600;color:var(--fg)}
  h2 .count{color:var(--dim);font-weight:400;font-size:13px}
  section.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:16px}
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
  .tag.sub{color:var(--warn);border-color:#E9D2B4;background:#FDF6E8}
  .tag.plan{color:var(--purple);border-color:#D9CBF5;background:#F5F1FE}
  .tag.ok{color:var(--ok);border-color:#BFDDCB;background:#EFF7F2}
  .tag.bad{color:var(--bad);border-color:#F1C4C4;background:#FDF2F2}
  .tag.blk{border-style:dashed;color:var(--dim)}
  .doing{color:var(--accent);margin-top:4px;word-break:break-all}
  .sub{color:var(--dim);font-size:12px;margin-top:4px;word-break:break-all}
  .sub a{color:var(--accent)}
  .btn{font:inherit;font-size:12px;padding:2px 8px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--fg);cursor:pointer}
  .btn:hover{background:var(--panel2)}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn.pri{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
  .btn.pri:hover{background:var(--accent);color:#fff}
  .btn.bad{border-color:var(--bad);color:var(--bad);background:#FDF2F2}
  .empty{padding:16px;color:var(--weak)}
  .hrow{display:grid;grid-template-columns:64px 1fr 96px 128px 72px;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line);align-items:baseline;font-size:12px}
  .hrow:last-child{border-bottom:0}
  .hrow:hover{background:var(--bg)}
  .hrow.head{color:var(--dim);font-size:12px;background:var(--panel2)}
  .hrow .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hrow.badrow{background:#FDF2F2}
  .hgroup{padding:8px 16px;border-bottom:1px solid var(--line);background:var(--panel2);font-weight:600;color:var(--fg);font-size:14px}
  .buckets{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px 16px}
  .bkt{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 12px;cursor:pointer}
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
  .prow.bad{background:#FDF2F2}
  .prow .r1{display:flex;gap:8px;align-items:baseline}
  footer{padding:12px 16px;color:var(--dim);font-size:12px;border-top:1px solid var(--line)}
  footer .fname{color:var(--accent)}
  #drawer{position:fixed;top:0;right:0;bottom:0;width:520px;max-width:94vw;background:var(--panel);border-left:1px solid var(--line);z-index:20;display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(31,35,40,.08)}
  #drawer[hidden]{display:none}
  .dhead{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
  .dtabs{display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line)}
  .dtab{padding:4px 12px;border:1px solid var(--line);border-radius:6px;color:var(--dim);background:var(--panel);font:inherit;cursor:pointer}
  .dtab.on{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
  .dview{flex:1;overflow:auto;display:none}
  .dview.on{display:block}
  .dfoot{padding:8px 16px;border-top:1px solid var(--line);display:flex;gap:8px;align-items:center}
  .grp{border:1px solid var(--line);border-radius:10px;margin-bottom:12px;overflow:hidden;background:var(--panel)}
  .grp summary{padding:12px 16px;cursor:pointer;background:var(--panel2);font-weight:600;display:flex;gap:8px;align-items:center;list-style:none}
  .grp summary::-webkit-details-marker{display:none}
  .grp[open] summary{border-bottom:1px solid var(--line)}
  .grow-sum{flex:1}
  .gsm{color:var(--dim);font-weight:400;font-size:12px}
  .total{display:flex;align-items:baseline;gap:16px;padding:16px 16px 8px}
  .total .big{font-size:32px;font-weight:700;letter-spacing:-1px;font-variant-numeric:tabular-nums}
  .total .lbl{color:var(--dim);font-size:12px}
  .bar{display:flex;height:24px;border-radius:6px;overflow:hidden;margin:8px 16px 4px}
  .bar > span{display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:600;white-space:nowrap}
  .bar .b1{background:#2F6BFF}.bar .b2{background:#6D28D9}.bar .b3{background:#15803D}.bar .b4{background:#8A929C}
  /* D43：项目视图 */
  .psec{padding:12px 0 8px;font-size:14px;font-weight:600;color:var(--fg)}
  .pdoing{padding:8px 16px;border:1px solid var(--line);border-radius:10px;background:var(--accent-soft);margin-bottom:8px;font-size:12px}
  .pcard{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:12px;overflow:hidden}
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
</style>
</head>
<body>
<header>
  <strong>🐟 工作台</strong>
  <nav class="tabs">
    <button class="tab on" data-view="projects">项目</button>
    <button class="tab" data-view="board">看板</button>
    <button class="tab" data-view="blockers">卡点 <span class="badge zero" id="b-blockers">0</span></button>
    <button class="tab" data-view="cost">花费</button>
  </nav>
  <span class="grow"></span>
  <span class="meta" id="meta">连接中…</span>
  <button class="btn" id="drawerBtn">☰ 更多</button>
</header>
<div id="unlinked"></div>
<main>
  <div class="view" id="view-projects">
    <h2>项目 <span class="count" id="c-projects">读取中…</span></h2>
    <div id="pj-doing"></div>
    <div id="pj-list"><div class="empty">读取中…</div></div>
    <div id="pj-unstarted"></div>
  </div>
  <div class="view" id="view-board" hidden><div id="board"><div class="empty">读取中…</div></div></div>
  <div class="view" id="view-blockers" hidden>
    <h2>卡点 <span class="count" id="c-blockers">—</span></h2>
    <div id="blockers"><div class="empty">读取中…</div></div>
  </div>
  <div class="view" id="view-cost" hidden>
    <h2>今日花费 <span class="count" id="c-cost">今日 · 按归属</span></h2>
    <div id="cost"><div class="empty">读取中…</div></div>
  </div>
</main>
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
  <div id="recent">最近交付：—</div>
</footer>
<script>
const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=(t)=>t?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'—';
async function j(u,opt){const r=await fetch(u,opt?{cache:'no-store',...opt}:{cache:'no-store'});const t=await r.text();try{return JSON.parse(t)}catch(e){throw new Error(u+' 非 JSON')}}

// ── 看板：按组折叠（本体 / 工作组 / QQ 通道 / 其他）────────────────────────
const GROUP_ORDER=['工作组','本体','QQ 通道','其他'];
// 规格 §5：默认只展开两个主集合（鲟鱼侧=本体、DSH 侧=工作组），其余默认折叠；展开状态记 localStorage。
const GROUP_OPEN_DEFAULT={'工作组':true,'本体':true,'QQ 通道':false,'其他':false};
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
const PSTATUS_CLS={'在做':'do','要做':'q','暂停':'blk','已完成':'ok'};
function renderProjects(d){
  const list=document.getElementById('pj-list');
  if(!list)return;
  const doingBox=document.getElementById('pj-doing'),unBox=document.getElementById('pj-unstarted');
  const cnt=document.getElementById('c-projects');
  if(cnt)cnt.textContent=(d&&d.count!=null?d.count+' 个项目':'—')+(d&&d.updatedAt?' · 台账更新 '+String(d.updatedAt).slice(11,16):'');
  if(!d||!d.ok){
    list.innerHTML='<div class="empty" style="color:var(--bad)">'+esc((d&&d.error)||'读不到项目数据')+'</div>';
    if(doingBox)doingBox.innerHTML='';if(unBox)unBox.innerHTML='';return;
  }
  const doing=d.doing||[];
  if(doingBox)doingBox.innerHTML=doing.length?('<div class="psec">正在做</div>'+doing.map(x=>
    '<div class="pdoing">'+esc(x.projectName)+' · '+esc(x.featureName)+' · <b>'+esc(x.ticket)+'</b> doing · '+esc(x.target||'—')+'</div>').join('')):'';
  list.innerHTML=(d.projects||[]).map(p=>{
    const pct=Math.max(0,Math.min(100,Math.round((p.pct||0)*100)));
    const doc=p.doc
      ?('<a class="doclink" href="#" data-doc="'+esc(p.doc)+'">'+esc(String(p.doc).split('/').pop())+'</a>')
      :'<span class="tag blk">未登记文档</span>';
    const feats=(p.features||[]).map(f=>{
      let st='planned';
      if(f.doing&&f.doing.length)st='doing';
      else if(f.total>0&&f.done>=f.total)st='done';
      else if(f.started)st='submitted';
      const stt={doing:'在做',submitted:'进行中',done:'完成',planned:'未开工'}[st];
      return '<div class="feat"><span class="fname2">'+esc(f.name)+'</span>'+
        '<span class="tag '+(STATE_CLS[st]||'q')+'">'+stt+'</span>'+
        '<span class="gsm">'+f.done+'/'+f.total+' · '+Math.round((f.pct||0)*100)+'%</span></div>';
    }).join('');
    return '<details class="pcard" data-pj="'+esc(p.id)+'" open>'+
      '<summary><span class="pname">'+esc(p.name)+'</span>'+
      '<span class="tag '+(PSTATUS_CLS[p.status]||'q')+'">'+esc(p.status)+'</span>'+
      '<span class="grow-sum"></span><span class="gsm">'+p.done+' / '+p.total+' 单 · '+pct+'%</span></summary>'+
      '<div class="psum">'+esc(p.summary||'（未登记摘要）')+'</div>'+
      '<div class="pbar"><span style="width:'+pct+'%"></span></div>'+
      '<div class="pmeta">项目文档：'+doc+'</div>'+
      (feats?('<div class="pfeat">'+feats+'</div>'):'<div class="pfeat gsm" style="padding:0 16px 12px">（没有登记子功能）</div>')+
      '</details>';
  }).join('')||'<div class="empty">projects.json 里没有项目</div>';
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
  const rows=(agents.agents||[]).filter(a=>a.running||a.live||a.no||/鲟鱼|QQ|子实体|企微|黑话/.test(String(a.title||'')));
  const groups={};GROUP_ORDER.forEach(g=>groups[g]=[]);
  rows.forEach(a=>{groups[groupOf(a)].push(a)});
  const qByNo={};((wl&&wl.groups)||[]).forEach(g=>{qByNo[String(g.target)]=g});
  let html='';
  if(agents.error)html+='<div class="empty" style="color:var(--bad)">DSH 投影读不到：'+esc(agents.error)+'</div>';
  GROUP_ORDER.forEach(g=>{
    const list=groups[g]||[];
    if(!list.length)return;
    const sum=groupSummary(list);
    html+='<details class="grp" data-grp="'+esc(g)+'"'+(groupOpen(g)?' open':'')+'>'+
      '<summary><span>'+esc(g)+'</span>'+
      '<span class="gsm">'+esc(sum.text)+'</span>'+
      '<span class="grow-sum"></span>'+
      (sum.hint?('<span class="gsm">'+esc(sum.hint)+'</span>'):'')+
      '</summary>';
    list.slice().sort((x,y)=>Number(y.live)-Number(x.live)||Number(y.running)-Number(x.running)).forEach(a=>{
      const q=qByNo[String(a.no||'')];
      const qlist=(q&&q.queue)||[];
      const qn=qlist.length||(a.queued||0);
      const busy=Boolean(a.live||a.running);
      const stuck=!busy&&(a.idleMs||0)>30*60*1000;
      html+='<div class="row"><div class="r1">'+
        '<span class="dot '+(a.live?'live':(a.running?'run':(stuck?'stuck':'')))+'"></span>'+
        '<span class="name">'+esc(prettyName(a))+'</span>'+
        '<span class="tag q">'+esc(a.idleText||'—')+'</span>'+
        (qn?('<span class="tag plan">排队 '+qn+(a.nextTask?(' · 下一条 '+esc(a.nextTask.ticket)) : '')+'</span>'):'')+
        '</div>'+
        (a.doing?('<div class="doing">'+esc(a.doing)+'</div>'):'')+
        qlist.map(t=>'<div class="sub">· '+esc(t.ticket||t.id)+' '+esc(t.title)+' <button class="btn pri" data-dispatch="'+esc(t.id)+'" '+(busy?'disabled':'')+'>派发</button></div>').join('')+
        '</div>';
    });
    html+='</details>';
  });
  box.innerHTML=html||'<div class="empty">没有会话</div>';
  document.querySelectorAll('.grp[data-grp]').forEach(el=>{
    el.addEventListener('toggle',()=>saveGroupOpen(el.dataset.grp,el.open));
  });
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
  const banner=document.getElementById('unlinked');
  if(un.length){banner.style.display='block';banner.textContent='unlinked（不猜、不自动挂）：'+un.map(u=>u.name).join('、')}
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
      '<span class="name" style="'+(m.unread?'color:#e3b341':'')+'">#'+esc(m.seq)+' '+esc(m.from)+' → '+esc(m.to)+'</span>'+
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
    const r=await Promise.all(reqs);
    const [agents,tasks,wl,mail,relay,nudge]=r;
    lastAgents=agents;lastWl=wl;
    if(needHealth&&r[6])lastHealth=r[6];
    if(needProjects){const pi=needHealth?7:6;if(r[pi]){lastProjects=r[pi];renderProjects(lastProjects)}}
    renderBoard(agents,wl);
    renderBlockers(wl);
    renderMail(mail,nudge);
    renderRelay(relay);
    renderLedger(wl);
    if(currentView==='cost'&&lastHealth)renderCost(lastHealth);
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
const VIEWS=['projects','board','blockers','cost'];
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
scanDeliveries({ prime: true });   // 存量只登记、不认领：历史交付不该在启动时炸出一堆 unlinked
const scanTimer = setInterval(() => { try { scanDeliveries(); } catch (e) { logLine(`[scan] 异常 ${e?.message ?? e}`); } }, Number(readConfig().scanIntervalMs || 10000));
scanTimer.unref();

// D22 自动接力：每 10 秒看一眼「谁空闲 + 谁有 queued」；一轮最多派一件。
const relayTimer = setInterval(() => { autoRelayTick().catch((e) => logLine(`[relay] tick 异常 ${e?.message ?? e}`)); }, relayConfig().intervalMs);
relayTimer.unref();

// D17 敲门：只对 level=活 的未读，一封只敲一次（nudged 防重放）；普通通知永不动。
const nudgeTimer = setInterval(() => { nudgeTick().catch((e) => logLine(`[nudge] tick 异常 ${e?.message ?? e}`)); }, nudgeConfig().intervalMs);
nudgeTimer.unref();

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
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`workdesk ${VERSION} 监听 http://127.0.0.1:${PORT}（10s 扫交付；花钱的只有 dispatch）\n`);
});
const shutdown = () => { clearInterval(scanTimer); clearInterval(relayTimer); clearInterval(nudgeTimer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
