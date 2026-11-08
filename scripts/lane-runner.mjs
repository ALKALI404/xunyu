#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts/lane-runner.mjs —— 链路执行器（UG-016 + UG-015 合并，一套不做两套）
//
// 主人 2026-10-29 20:35 定：「谁交了任务就像自动投送一样投给 01，01 直接验收，没问题就推当前链路下一条，
// 链路跑完或者驳回再给我报」。
//
// 三件事：**投递（提交→叫醒 01）→ 推进（01 accept→派下游）→ 收口（完成/驳回只报两端）**。
// 省 token 的核心：中间过程一个字都不进本体上下文，只有「链路完成」「链路被驳回」「必须换代」三种才报。
//
// 链路（lane）= 一串靠 `blockedBy` 串起来的票（B 依赖 A）；连通分量就是一条链路。
//
// 用法：
//   node scripts\lane-runner.mjs --once            # 跑一拍（配计划任务/acceptance-watch 调用）
//   node scripts\lane-runner.mjs --watch           # 每 60 秒一拍（常驻守护用，别挂在会话后台 job 里）
//   node scripts\lane-runner.mjs --once --dry      # 只算不发（不唤醒、不派单、不寄信）
//   node scripts\lane-runner.mjs --once --json     # 机读
//   node scripts\lane-runner.mjs --status          # 看链路与挂起项
//
// UG-087（2026-11-05）：每拍除「链路推进」外还跑一段**散票投递**——
//   没有 blockedBy 的 submitted 票（以及 01 自己的票除外）同样叫醒 01 验收，
//   限流按票记在 `logs\wake.jsonl`（同票 10 分钟冷却、最多 3 次），**一拍最多叫 1 张**。
//   看散票：`--status` 的「散票待投」段；试叫：`--once --dry`。
//
// 伴生：`acceptance-watch.mjs` 的每轮末尾会调 `tickLane()`（同一个执行器，不再各叫各的）。
//
// 测试加速：XUNYU_LANE_WAKE_COOLDOWN_MS（唤醒限流，默认 10 分钟）、XUNYU_LANE_RETRY_MS（被拒重试，默认 60 秒）、
//           XUNYU_LANE_MAX_ATTEMPTS（重试上限，默认 3）、XUNYU_LANE_NOMAIL=1（不寄信，测试用）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEvents, replay } from './worklist-core.mjs';
import { dshApi, pickAgent, dispatch as dispatchTask } from './dispatch-core.mjs';
import { readWakeLog, attemptsOf, canWake, appendWake, WAKE_COOLDOWN_MS as STANDALONE_COOLDOWN_MS, WAKE_MAX_N as STANDALONE_MAX_N, WAKE_LOG } from './wake-log.mjs';   // UG-087：叫醒账（散票限流；名字带前缀，避免和链路自己的 WAKE_COOLDOWN_MS 撞）

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..');
export const LANE_STATE = path.join(WORKSPACE, 'state', 'lane-runner.json');
export const LANE_LOG = path.join(WORKSPACE, 'logs', 'lane.jsonl');
const DELIVERY_DIR = path.join(WORKSPACE, 'records', '交付');
const TASK_DIR = path.join(WORKSPACE, 'state', 'tasks');
const MAIL_BOX = 'E:/DeepFish/Xunyu/memory/mail';
const MAIL_FILE = path.join(MAIL_BOX, 'mailbox.jsonl');

export const WAKE_COOLDOWN_MS = Number(process.env.XUNYU_LANE_WAKE_COOLDOWN_MS ?? 10 * 60 * 1000);
export const RETRY_MS = Number(process.env.XUNYU_LANE_RETRY_MS ?? 60 * 1000);
export const MAX_ATTEMPTS = Number(process.env.XUNYU_LANE_MAX_ATTEMPTS ?? 3);
/** 要人动手的工号（验收人）。 */
export const ACCEPTOR = '01';
/** 只报两端的收件人。 */
export const OWNER = '本体';

// ── UG-042：派不出去时先分类，别把"按设计就会拒"的当成故障报 ────────────────
export const LANE_PARKED = path.join(WORKSPACE, 'state', 'lane-parked.jsonl');
export const LANE_DROPPED = path.join(WORKSPACE, 'state', 'lane-dropped.jsonl');

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function appendJsonl(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    return true;
  } catch { return false; }
}

/** 夹具类：标题/单号里带"夹具|测试|fixture"的票，从不上报（用完即弃那种）。 */
const FIXTURE_WORD = /夹具|测试|fixture/i;
export const isFixtureTicket = (t) => isFixture(t) || FIXTURE_WORD.test(`${t?.title ?? ''}`);

/**
 * 派单失败分类（UG-042 接口契约）：
 *   'fatal'  —— 票已经不在"待派"状态（dropped/done/doing/submitted…），重试一万次也没用，立刻放弃；
 *   'parked' —— 票在优先名单外（派发器按设计就 409），或夹具票 → 记一行、不计失败次数、不报警；
 *   'retry'  —— 其余（真的派不出去），才计数、才在连续 MAX_ATTEMPTS 次后报警。
 * 判定顺序有讲究：**先看票状态**——已 drop 的票同时也会 `out-of-priority`，
 * 那种要报 'fatal'（任务书判据②），不能被 parked 抢走。
 */

// SKIP-INDEPENDENT-20261106 —— 独立项目名单：这些项目自己验收，不叫 01
const INDEPENDENT_PROJECTS = new Set(['insurance', 'study']);
function isIndependentProject(t) {
  const prj = String(t?.project ?? '');
  if (INDEPENDENT_PROJECTS.has(prj)) return true;
  const tk = String(t?.ticket ?? '');
  // 保险项目的票号形如 IN-0xx；为免误伤，只在 project 缺失时才用票号兜底
  if (!prj && /^IN-\d{3}$/.test(tk)) return true;
  return false;
}

export function classifyDispatchFailure(ticket, code) {
  const st = String(ticket?.state ?? '');
  if (st && st !== 'queued' && st !== 'inbox') return 'fatal';
  if (isFixtureTicket(ticket)) return 'parked';
  if (code === 'out-of-priority') return 'parked';
  if (code === 'priority-dangling' || code === 'priority-cycle') return 'parked';
  return 'retry';
}

/** 记一行 parked；同一张票只记一次（判据④）。 */
export function recordParked(ticket, code, reason, { now = Date.now(), persist = true } = {}) {
  const id = typeof ticket === 'string' ? ticket : (ticket?.id ?? '—');
  if (readJsonl(LANE_PARKED).some((r) => r.ticket === id)) return { ok: false, duplicate: true, id };
  if (persist) appendJsonl(LANE_PARKED, { ts: now, ticket: id, code, reason: String(reason ?? '').slice(0, 300) });
  return { ok: true, duplicate: false, id };
}

/** 记一行 dropped（fatal 的票不再进候选集）。 */
export function recordDropped(ticket, code, reason, { now = Date.now(), persist = true } = {}) {
  const id = typeof ticket === 'string' ? ticket : (ticket?.id ?? '—');
  if (readJsonl(LANE_DROPPED).some((r) => r.ticket === id)) return { ok: false, duplicate: true, id };
  if (persist) appendJsonl(LANE_DROPPED, { ts: now, ticket: id, code, reason: String(reason ?? '').slice(0, 300) });
  return { ok: true, duplicate: false, id };
}

/** LANE_NOISY=0 → 退回"任何失败都报"的老行为（回滚开关）。 */
const noiseSplitOn = () => process.env.LANE_NOISY !== '0';

// ── 小工具 ──────────────────────────────────────────────────────────────────
const isFixture = (t) => t?.src === 'fixture' || String(t?.target ?? '') === 'test';
const when = (t) => (t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '—');

export function readState(file = LANE_STATE) {
  try { return readJson(file) ?? {}; } catch { return {}; }
}
function writeState(s, file = LANE_STATE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
}

/** 机器日志：logs\lane.jsonl（一行一步，append-only）。 */
export function logLane(rec) {
  try {
    fs.mkdirSync(path.dirname(LANE_LOG), { recursive: true });
    fs.appendFileSync(LANE_LOG, `${JSON.stringify({ t: Date.now(), ...rec })}\n`, 'utf8');
  } catch { /* ignore */ }
}

/** 人类日志：`[lane] <票号> <动作> <结果>` 一行。 */
export function human(action) {
  const line = `[lane] ${action.id ?? '—'} ${action.act} ${action.result}${action.extra ? `（${action.extra}）` : ''}`;
  console.log(line);
  return line;
}

function lastMailSeq() {
  try {
    const lines = fs.readFileSync(MAIL_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.length ? Number(JSON.parse(lines[lines.length - 1]).seq) || 0 : 0;
  } catch { return 0; }
}

/** 寄信（默认走 mail.mjs CLI；测试可注入 mailFn）。level=活 才会把本体叫醒。 */
export function postMail(to, body, level = '通知') {
  if (process.env.XUNYU_LANE_NOMAIL === '1') return null;
  try {
    execFileSync(process.execPath, [path.join(WORKSPACE, 'scripts', 'mail.mjs'), 'post', '--to', to, '--from', 'lane-runner', '--body', body, ...(level === '活' ? ['--level', '活'] : [])], { stdio: 'ignore' });
    return lastMailSeq();
  } catch { return null; }
}

// ── 唤醒通道（原 UG-015 的 wakeAgent）──────────────────────────────────────
async function listSessions(api, unwrap) {
  const res = await Promise.race([
    api.sessions.list({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('sessions/list 超时')), 4000))
  ]);
  return unwrap(res, 'session.list').items ?? [];
}

/**
 * 给工号投一次 `session/prompt`（唯一花钱动作之一）。
 * 返回 { ok, code, accepted, sessionId, chars, result }；**被拒必须带 code**，调用方据此挂起重试。
 */
export async function wakeAgent(agentNo, text, { now = Date.now(), sessionId = null } = {}) {
  const rec = { op: 'wake', to: String(agentNo), at: now };
  try {
    const { api, unwrap } = await dshApi();
    const sessions = await listSessions(api, unwrap);
    // UG-087：显式给 sessionId 就按 id 找（散票投递从 roster 取 01 的 id，不许写死也不许另写一套发送）；
    // 找不到就是 no-agent——**不静默**，调用方会把它记成 error 并显示「未叫醒」。
    const session = sessionId
      ? sessions.find((x) => String(x.sessionId) === String(sessionId))
      : pickAgent(sessions, agentNo);
    if (!session) {
      return finishWake({ ...rec, ok: false, code: 'no-agent', detail: sessionId ? `会话 ${sessionId} 不在会话列表（工号 ${agentNo}）` : `没有工号 ${agentNo} 的会话` });
    }
    rec.sessionId = String(session.sessionId);
    rec.title = String(session.projections?.values?.title ?? '');
    if (session.running === true) {
      return finishWake({ ...rec, ok: false, code: 'target-busy', sessionId: rec.sessionId, detail: `工号 ${agentNo} 正在跑（run=true），这一拍不硬塞` });
    }
    const res = await api.sessions.prompt({ sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text }] });
    const result = res?.result ?? res ?? {};
    const accepted = Boolean(result?.value?.accepted ?? result?.accepted ?? result?.ok ?? false);
    return finishWake({
      ...rec, ok: accepted, accepted, code: accepted ? 'accepted' : 'prompt-rejected', chars: text.length, result,
      detail: accepted ? 'session/prompt 已投（mode=queue）' : `未接受：${JSON.stringify(result).slice(0, 200)}`
    });
  } catch (error) {
    return finishWake({ ...rec, ok: false, code: String(error?.code ?? 'prompt-failed'), detail: String(error?.message ?? error).slice(0, 200) });
  }
}
function finishWake(rec) {
  logLane(rec);
  if (!rec.ok) human({ id: rec.sessionId ?? rec.to, act: 'wake', result: `失败 ${rec.code}`, extra: rec.detail });
  else human({ id: rec.to, act: 'wake', result: `OK accepted=${rec.accepted}`, extra: `${rec.chars} 字` });
  return rec;
}

// ── 交付路径 / 验收要点（唤醒正文用，≤10 行）────────────────────────────────
export function deliveryPathOf(ticket) {
  const want = String(ticket ?? '').trim().toLowerCase();
  if (!want) return null;
  try {
    const hit = fs.readdirSync(DELIVERY_DIR).find((f) => f.toLowerCase().endsWith(`-${want}.md`));
    return hit ? `records\\交付\\${hit}` : null;
  } catch { return null; }
}

/** 从任务书里抠「验收要点」：找含“验收/判据”的小节，取前 5 条，每条 ≤70 字。 */
export function acceptanceBrief(ticket, { file = null } = {}) {
  const p = file ?? path.join(TASK_DIR, `${String(ticket ?? '').trim()}.md`);
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,3}\s*.*(验收|判据)/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && out.length < 5; i += 1) {
    const l = lines[i].trim();
    if (/^#{1,3}\s/.test(l)) break;
    const m = /^(?:[-*\d]+[.)]?\s+|[-*]\s+)(.+)$/.exec(l);
    if (!m) continue;
    const text = m[1].replace(/[*`]/g, '').trim();
    if (text.length < 4) continue;
    out.push(text.length > 70 ? `${text.slice(0, 70)}…` : text);
  }
  return out;
}

/** 唤醒正文：单号 + 交付路径 + 验收要点（≤10 行）。 */
export function wakeTextFor(tickets) {
  const lines = [];
  for (const t of tickets) {
    const path1 = deliveryPathOf(t.ticket);
    lines.push(`【待验收】${t.ticket ?? t.id}（${t.id}，${t.target}）${String(t.title ?? '').slice(0, 30)}`);
    if (path1) lines.push(`  交付：${path1}`);
    const brief = acceptanceBrief(t.ticket);
    if (brief.length) lines.push(`  要点：${brief.slice(0, 3).join('；')}`);
  }
  lines.push(`验收：node scripts\\worklist.mjs accept <票号> --note "结论"（驳回请写清哪条不达标）`);
  return lines.slice(0, 10).join('\n');
}

// ── UG-087：散票投递（没有链路的 submitted 也要送进 01 的验收队列）──────────
/** 从名册取某工号当前的 sessionId（**不许写死**——今晚吃过写死 id 的亏）。取不到返回 null。 */
export function rosterSessionId(agentNo) {
  try {
    const j = readJson(path.join(WORKSPACE, 'state', 'roster.json')) ?? {};
    const row = (j.active ?? []).find((x) => String(x.id) === String(agentNo));
    return row?.sessionId ? String(row.sessionId) : null;
  } catch { return null; }
}

/** 单票唤醒正文：票号 + 单号 + 交付路径 + 主人 21:30 口径（一次一张、只看证据、别复跑）。 */
export function standaloneWakeText(t) {
  const lines = [`【待验收·单票】${t.ticket ?? t.id}（${t.id}，${t.target}）${String(t.title ?? '').slice(0, 40)}`];
  const p = deliveryPathOf(t.ticket) ?? deliveryPathOf(t.id);
  if (p) lines.push(`  交付：${p}`);
  const brief = acceptanceBrief(t.ticket);
  if (brief.length) lines.push(`  要点：${brief.slice(0, 2).join('；')}`);
  lines.push('  口径：一次一张、只看证据、别复跑（复跑判据是替工号干活）。');
  lines.push('  收：node scripts\\worklist.mjs accept ' + (t.id ?? '') + ' --note "结论"');
  return lines.slice(0, 8).join('\n');
}

/**
 * 一拍内的「散票投递」：扫所有 submitted、排除是 01 自己的票/夹具/在链路里的票，
 * 按叫醒账限流（同票 10 分钟冷却、最多 3 次），**一拍最多叫醒 1 张**。
 * 与 tickLane 并列、不互相依赖；`--dry` 只报"会叫醒谁"。
 */
export async function dispatchStandalone({ now = Date.now(), dry = false, tasks = null, wakeFn = null, skipIfWoke = false } = {}) {
  const all = tasks ?? replay(readEvents());
  const rows = readWakeLog();
  const wake = wakeFn ?? wakeAgent;
  const actions = [];
  const candidates = all
    .filter((t) => t && t.state === 'submitted' && !isFixture(t) && String(t.target ?? '') !== ACCEPTOR)
    .filter((t) => laneOf(t.id, all).length === 1)   // 单票 = 没有任何 blockedBy 关系
    // SKIP-INDEPENDENT-20261106：保险项目（insurance）走独立验收，不经 01（主人 2026-11-06 定）
    // 判据：票所属 project 或 title/ticket 前缀属于保险项目，就跳过，不叫 01
    .filter((t) => !isIndependentProject(t))
    .sort((a, b) => Number(a.submittedAt ?? a.createdAt ?? 0) - Number(b.submittedAt ?? b.createdAt ?? 0));

  const report = candidates.map((t) => {
    const key = String(t.ticket ?? t.id);
    const gate = canWake(key, { now, rows });
    const hist = attemptsOf(key, rows);
    return { id: t.id, ticket: key, title: String(t.title ?? ''), gate, attempts: hist.length, last: hist[hist.length - 1] ?? null, task: t };
  });

  if (!report.length) return { at: now, actions, dry, candidates: [] };
  if (skipIfWoke) {
    actions.push({ id: report[0].id, act: '散票', result: '本拍已叫过 01', extra: '链路投递优先，散票下一拍' });
    return { at: now, actions, dry, candidates: report };
  }
  const picked = report.find((r) => r.gate.ok);
  if (!picked) {
    const why = report.map((r) => `${r.ticket}:${r.gate.reason}`).join(' ');
    actions.push({ id: report[0].id, act: '散票', result: '全部限流', extra: why.slice(0, 120) });
    return { at: now, actions, dry, candidates: report };
  }
  const text = standaloneWakeText(picked.task);
  if (dry) {
    actions.push({ id: picked.id, act: '散票', result: 'dry', extra: `会叫醒 ${ACCEPTOR}：${picked.ticket}（第 ${picked.attempts + 1} 次）` });
    return { at: now, actions, dry, candidates: report, preview: text };
  }
  const sessionId = rosterSessionId(ACCEPTOR);
  const r = await wake(ACCEPTOR, text, { now, sessionId });
  const n = picked.attempts + 1;
  const rec = { t: now, ticket: picked.ticket, id: picked.id, sessionId: r.sessionId ?? sessionId ?? null, n, ok: Boolean(r.ok), kind: 'standalone', code: r.code ?? null };
  if (!r.ok) rec.detail = String(r.detail ?? '').slice(0, 200);
  appendWake(rec);
  if (r.ok) {
    actions.push({ id: picked.id, act: '散票投01', result: `OK accepted=${r.accepted}`, extra: `${picked.ticket} 第 ${n} 次｜${r.sessionId ?? sessionId ?? '—'}` });
  } else {
    actions.push({ id: picked.id, act: '散票投01', result: `未叫醒 ${r.code}`, extra: `${picked.ticket} 第 ${n} 次｜${String(r.detail ?? '').slice(0, 80)}` });
  }
  return { at: now, actions, dry, candidates: report, rec };
}

// ── 链路（连通分量）──────────────────────────────────────────────────────────
/** 跟某张票通过 blockedBy 边连在一起的所有票（双向），含自己。 */
export function laneOf(id, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    const node = byId.get(cur);
    const neighbours = [...(node?.blockedBy ?? [])];
    for (const t of tasks) if ((t.blockedBy ?? []).includes(cur)) neighbours.push(t.id);
    for (const n of neighbours) if (!seen.has(n) && byId.has(n)) { seen.add(n); queue.push(n); }
  }
  return [...seen].sort((a, b) => String(a).localeCompare(String(b)));
}
const OPEN = new Set(['inbox', 'proposed', 'queued', 'doing', 'submitted']);
export const laneKeyOf = (ids) => `lane:${[...ids].sort()[0]}`;

/** 这条链路一共投出去多少字（读 logs\dispatch.jsonl 的 promptChars；拿不到就当 0）。 */
export function promptCharsOf(ids) {
  const want = new Set(ids.map(String));
  try {
    const raw = fs.readFileSync(path.join(WORKSPACE, 'logs', 'dispatch.jsonl'), 'utf8');
    let sum = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || !want.has(String(JSON.parse(line).id ?? ''))) continue;
      try { sum += Number(JSON.parse(line).promptChars ?? 0); } catch { /* 坏行跳过 */ }
    }
    return sum;
  } catch { return 0; }
}

// ── 主判定（纯函数式：事件、状态、三个副作用都可注入）────────────────────────
/**
 * 跑一拍。返回 { actions, state }；dry=true 时只算，不唤醒/不派单/不寄信/不写盘。
 * deps：wakeFn(agentNo,text)、dispatchFn(id,opts)、mailFn(to,body,level)、now
 */
export async function tickLane({ now = Date.now(), dry = false, state = null, events = null, wakeFn = null, dispatchFn = null, mailFn = null, persist = true, quiet = false } = {}) {
  const s = state ?? readState();
  s.lanes = s.lanes ?? {};
  s.pending = s.pending ?? [];
  s.reported = s.reported ?? [];
  const actions = [];
  const mail = mailFn ?? ((to, body, level) => (dry ? null : postMail(to, body, level)));
  const wake = wakeFn ?? wakeAgent;
  const dispatch = dispatchFn ?? dispatchTask;
  const allEvents = events ?? readEvents();
  const tasks = replay(allEvents);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // 事件游标：只看新事件。首次运行往回看 10 分钟（只捡「刚刚提交的」，不重放历史——
  // 否则装上的第一拍会把 6 小时里所有 done 都当成链路完成报给本体，既吵又花钱）
  const maxT = allEvents.reduce((m, e) => Math.max(m, Number(e.t ?? 0)), 0);
  const LOOKBACK_MS = Number(process.env.XUNYU_LANE_LOOKBACK_MS ?? 10 * 60 * 1000);
  if (s.lastEventT == null) s.lastEventT = now - LOOKBACK_MS;

  // 扫一遍算每条 state 事件的前一个状态（用来识别 submitted→queued = 驳回）
  const prevStateOf = new Map();
  {
    const cur = new Map();
    for (const ev of allEvents) {
      if (ev?.id && ev.op === 'state') {
        prevStateOf.set(`${ev.t}:${ev.id}:${ev.state}`, cur.get(ev.id) ?? 'inbox');
        cur.set(ev.id, ev.state);
      } else if (ev?.id && ev.op === 'add') {
        cur.set(ev.id, ev.state ?? 'inbox');
      }
    }
  }

  const fresh = allEvents.filter((e) => Number(e.t ?? 0) > Number(s.lastEventT ?? 0));
  const newSubmitted = [];
  const newDone = [];
  const newRejected = [];

  // 首次启动：往回看 6 小时里的事件都算新（不再另外扫「当前 submitted」——避免和事件重复计数）
  for (const ev of fresh) {
    const t = byId.get(ev.id);
    if (!t || isFixture(t)) continue;
    if (ev.op !== 'state') continue;
    const prev = prevStateOf.get(`${ev.t}:${ev.id}:${ev.state}`) ?? null;
    if (ev.state === 'submitted') {
      // 保险 / 学习区独立验收：不投给 01（主人 2026-11-06 18:05 定）
      if (!isIndependentProject(t)) newSubmitted.push(ev.id);
    }
    else if (ev.state === 'done') newDone.push(ev.id);
    else if (ev.state === 'queued' && prev === 'submitted') newRejected.push({ id: ev.id, ev });
  }
  s.lastEventT = Math.max(Number(s.lastEventT ?? 0), maxT);
  s.bootstrapped = true;

  /** ── ① 提交即投：唤醒 01（10 分钟限流；清单变了立刻叫） ── */
  const doWake = async (ids) => {
    if (!ids.length) return;
    const key = ids.join(',');
    const last = s.lastWake ?? null;
    const pend = s.wakePending ?? null;
    const tickets = ids.map((id) => byId.get(id)).filter(Boolean);
    const text = wakeTextFor(tickets);
    if (pend) {
      if (now < Number(pend.nextAt ?? 0)) { actions.push({ id: ids[0], act: 'wake', result: '等待重试', extra: `${when(pend.nextAt)} 再来` }); return; }
    } else if (last && last.ids === key && now - Number(last.at ?? 0) < WAKE_COOLDOWN_MS) {
      actions.push({ id: ids[0], act: 'wake', result: '限流跳过', extra: `${Math.ceil((WAKE_COOLDOWN_MS - (now - last.at)) / 1000)}s 后可再叫` });
      return;
    }
    if (dry) { actions.push({ id: ids[0], act: 'wake', result: 'dry', extra: `${ids.length} 张` }); return; }
    const r = await wake(ACCEPTOR, text, { now });
    if (r.ok) {
      s.lastWake = { at: now, ids: key, count: ids.length, sessionId: r.sessionId ?? null, accepted: Boolean(r.accepted) };
      s.wakePending = null;
      const seq = mail(ACCEPTOR, `${text}\n（留痕：lane-runner ${when(now)} 唤醒）`);
      actions.push({ id: ids[0], act: '投01', result: `OK accepted=${r.accepted}`, extra: `邮件 #${seq ?? '—'}`, seq });
    } else {
      const attempts = Number(s.wakePending?.attempts ?? 0) + 1;
      s.wakePending = { ids: key, attempts, nextAt: now + RETRY_MS, code: r.code, detail: r.detail };
      actions.push({ id: ids[0], act: '投01', result: `被拒 ${r.code}`, extra: `第 ${attempts} 次，${Math.round(RETRY_MS / 1000)}s 后重试` });
      if (attempts >= MAX_ATTEMPTS) {
        const seq = mail(OWNER, `【链路卡住】连续 ${attempts} 次叫不醒 ${ACCEPTOR}：${r.code} ${r.detail}\n待验收：${ids.join('、')}`, '活');
        s.wakePending = null;
        actions.push({ id: ids[0], act: '报本体', result: '唤醒连败', extra: `邮件 #${seq ?? '—'}`, seq });
      }
    }
  };

  /** ── ② 验收即推进 / ③ 无下游且链路清空 → 报完成 ── */
  const handleDone = async (id) => {
    const task = byId.get(id);
    const down = tasks.filter((t) => (t.blockedBy ?? []).includes(id) && t.state !== 'dropped' && t.state !== 'done' && !isFixture(t));
    if (down.length) {
      const next = down.find((t) => t.state === 'queued' && !t.blocked) ?? down[0];
      if (dry) { actions.push({ id, act: '推进', result: 'dry', extra: `→ ${next.id}` }); return; }
      const r = await dispatch(next.id, { by: 'lane-runner' });
      if (r.ok) {
        s.pending = s.pending.filter((p) => p.id !== next.id);
        actions.push({ id, act: '推进', result: `→ ${next.id} 已派`, extra: next.ticket ?? '' });
      } else if (r.code === 'load-gate') {
        const seq = mail(OWNER, `【需先换代】链路 ${laneOf(id, tasks).join('→')} 卡在派 ${next.id}（${next.ticket ?? ''}）：${r.detail}\n负载闸挡住了，换完代再继续；该链路已暂停。`, '活');
        markLane(s, id, tasks, { status: 'paused', reason: `load-gate@${next.id}` });
        actions.push({ id, act: '推进', result: `load-gate 暂停`, extra: `报本体 #${seq ?? '—'}`, seq });
      } else {
        // UG-042：先分类再决定怎么记账——名单外/已作废的票不该把本体吵醒
        const verdict = noiseSplitOn() ? classifyDispatchFailure(next, r.code) : 'retry';
        if (verdict === 'parked') {
          const rec = recordParked(next, r.code, r.detail, { now, persist: !dry });
          actions.push({ id: next.id, act: '停放', result: `parked ${r.code}`, extra: rec.duplicate ? '已记过（不重复写）' : '记 lane-parked｜不计数、不报警' });
        } else if (verdict === 'fatal') {
          const rec = recordDropped(next, r.code, r.detail, { now, persist: !dry });
          s.pending = s.pending.filter((p) => p.id !== next.id);
          actions.push({ id: next.id, act: '放弃', result: `fatal ${r.code}`, extra: `票状态=${next.state}${rec.duplicate ? '（已记过）' : '，记 lane-dropped'}` });
        } else {
          const attempts = Number((s.pending.find((p) => p.id === next.id)?.attempts) ?? 0) + 1;
          s.pending = [...s.pending.filter((p) => p.id !== next.id), { id: next.id, attempts, nextAt: now + RETRY_MS, code: r.code, detail: r.detail, after: id }];
          actions.push({ id, act: '推进', result: `失败 ${r.code}`, extra: `→ ${next.id} 第 ${attempts} 次` });
          if (attempts >= MAX_ATTEMPTS) {
            const seq = mail(OWNER, `【链路卡住】${next.id}（${next.ticket ?? ''}）连续 ${attempts} 次派不出去：${r.code} ${r.detail}\n链路：${laneOf(id, tasks).join('→')}`, '活');
            s.pending = s.pending.filter((p) => p.id !== next.id);
            actions.push({ id: next.id, act: '报本体', result: '派单连败', extra: `邮件 #${seq ?? '—'}`, seq });
          }
        }
      }
      return;
    }
    // 没有下游：看整条链路是否已清空
    const lane = laneOf(id, tasks);
    if (lane.length < 2) { actions.push({ id, act: '收口', result: '单票不算链路（不报）' }); return; }
    const open = lane.filter((x) => OPEN.has(byId.get(x)?.state));
    const key = laneKeyOf(lane);
    if (open.length) { actions.push({ id, act: '收口', result: '链路还有未闭环', extra: open.join('、') }); return; }
    if (s.reported.includes(key)) { actions.push({ id, act: '收口', result: '已报过' }); return; }
    const first = byId.get(lane[0]);
    const started = Math.min(...lane.map((x) => Number(byId.get(x)?.createdAt ?? now)));
    const mins = Math.max(0, Math.round((now - started) / 60000));
    const tickets = lane.map((x) => byId.get(x)?.ticket ?? x).join(' / ');
    const chars = promptCharsOf(lane);
    const seq = mail(OWNER, `【链路完成】${lane[0]}→${lane[lane.length - 1]}（${task?.project ?? '—'}/${task?.feature ?? '—'}）\n单号：${tickets}\n耗时：${mins} 分钟｜${lane.length} 张全过\n投递 prompt 合计 ${chars} 字（≈ ${Math.round(chars / 4)} token，只算派单正文）\n（中间过程没进你上下文；细节在 records\\交付\\ 与 logs\\lane.jsonl）`, '活');
    s.reported.push(key);
    markLane(s, id, tasks, { status: 'done', reason: '链路完成' });
    actions.push({ id, act: '报完成', result: `链路完成 ${lane.length} 张`, extra: `邮件 #${seq ?? '—'}`, seq });
  };

  /** ── ④ 驳回即上报并停链 ── */
  const handleReject = (id, ev) => {
    const lane = laneOf(id, tasks);
    const key = laneKeyOf(lane);
    const task = byId.get(id);
    // 单票（lane 只有它自己）被驳回 = 普通打回，01 已经会重派；不进本体上下文（只留痕）
    if (lane.length < 2) { actions.push({ id, act: '驳回', result: '单票不算链路（不报）', extra: String(ev.note ?? '').slice(0, 40) }); return; }
    const rejectCount = allEvents.filter((e) => e.id === id && e.op === 'state' && e.reason).length;
    const downstream = lane.filter((x) => x !== id).map((x) => `${byId.get(x)?.ticket ?? x}(${byId.get(x)?.state ?? '?'})`).join('、');
    if (s.lanes[key]?.status === 'stopped' && s.lanes[key]?.reason === 'reject') { actions.push({ id, act: '驳回', result: '已报过' }); return; }
    let seq = null;
    if (!dry) {
      seq = mail(OWNER, `【链路被驳回】${task?.ticket ?? id}（${id}）\n理由：${String(ev.note ?? '').slice(0, 500) || '（没写）'}\n该票历史驳回：${rejectCount} 次\n链路停在 ${id}，下游不动：${downstream || '（无下游）'}\n等你看完再动，不会自动重试。`, '活');
    }
    markLane(s, id, tasks, { status: 'stopped', reason: 'reject', stoppedAt: now });
    actions.push({ id, act: '驳回', result: '停链并报本体', extra: `邮件 #${seq ?? '—'}`, seq });
  };

  /** ── ⑤ 挂起重试（被拒 60s 后再来，3 次才报） ── */
  const retryPending = async () => {
    for (const p of [...s.pending]) {
      if (now < Number(p.nextAt ?? 0)) continue;
      if (dry) { actions.push({ id: p.id, act: '重试', result: 'dry' }); continue; }
      const r = await dispatch(p.id, { by: 'lane-runner' });
      if (r.ok) {
        s.pending = s.pending.filter((x) => x.id !== p.id);
        actions.push({ id: p.id, act: '重试', result: '已派' });
      } else {
        // UG-042：重试同样先分类——名单外/已作废的票从候选集剔除，不再陪跑
        const ptask = byId.get(p.id);
        const verdict = noiseSplitOn() ? classifyDispatchFailure(ptask, r.code) : 'retry';
        if (verdict === 'parked') {
          const rec = recordParked(ptask ?? p.id, r.code, r.detail, { now, persist: !dry });
          s.pending = s.pending.filter((x) => x.id !== p.id);
          actions.push({ id: p.id, act: '停放', result: `parked ${r.code}`, extra: rec.duplicate ? '已记过｜移出候选' : '记 lane-parked｜移出候选、不报警' });
        } else if (verdict === 'fatal') {
          const rec = recordDropped(ptask ?? p.id, r.code, r.detail, { now, persist: !dry });
          s.pending = s.pending.filter((x) => x.id !== p.id);
          actions.push({ id: p.id, act: '放弃', result: `fatal ${r.code}`, extra: `票状态=${ptask?.state ?? '?'}${rec.duplicate ? '（已记过）' : '，记 lane-dropped'}` });
        } else {
          const attempts = Number(p.attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            const seq = mail(OWNER, `【链路卡住】${p.id} 连续 ${attempts} 次派不出去：${r.code} ${r.detail}`, '活');
            s.pending = s.pending.filter((x) => x.id !== p.id);
            actions.push({ id: p.id, act: '报本体', result: '重试耗尽', extra: `邮件 #${seq ?? '—'}`, seq });
          } else {
            s.pending = s.pending.map((x) => (x.id === p.id ? { ...x, attempts, nextAt: now + RETRY_MS, code: r.code, detail: r.detail } : x));
            actions.push({ id: p.id, act: '重试', result: `仍失败 ${r.code}`, extra: `第 ${attempts} 次` });
          }
        }
      }
    }
  };

  await doWake(newSubmitted);
  // ⑤b 唤醒重试：没有新事件也要到点再叫一次（否则一次 target-busy 就永远不叫了）
  if (s.wakePending && !newSubmitted.length && now >= Number(s.wakePending.nextAt ?? 0)) {
    const ids = String(s.wakePending.ids ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (ids.length) await doWake(ids);
  }
  for (const id of newDone) await handleDone(id);
  for (const r of newRejected) handleReject(r.id, r.ev);
  await retryPending();

  for (const a of actions) if (!quiet && a.result !== 'dry') human(a);
  if (!dry && persist) writeState(s);
  return { at: now, actions, state: s, dry };
}

function markLane(s, id, tasks, patch) {
  const lane = laneOf(id, tasks);
  const key = laneKeyOf(lane);
  s.lanes[key] = { ...(s.lanes[key] ?? { tickets: lane, from: lane[0] }), ...patch, tickets: lane, updatedAt: Date.now() };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const dry = argv.includes('--dry');
  const watch = argv.includes('--watch');
  const status = argv.includes('--status');
  if (argv.includes('--parked')) {
    const parked = readJsonl(LANE_PARKED);
    const dropped = readJsonl(LANE_DROPPED);
    const ids = new Set(parked.map((r) => r.ticket));
    console.log(`parked ${parked.length} 行 / 去重后 ${ids.size} 张票｜dropped ${dropped.length} 行`);
    for (const r of parked) console.log(`  parked  ${r.ticket}  ${r.code}  ${String(r.reason ?? '').slice(0, 60)}`);
    for (const r of dropped) console.log(`  dropped ${r.ticket}  ${r.code}  ${String(r.reason ?? '').slice(0, 60)}`);
    return;
  }
  if (argv.includes('--classify')) {
    const i = argv.indexOf('--classify');
    const id = argv[i + 1];
    const code = argv[i + 2] ?? 'out-of-priority';
    const t = replay(readEvents()).find((x) => x.id === id) ?? { id, state: 'queued', title: '' };
    console.log(`${id} state=${t.state} title=${String(t.title ?? '').slice(0, 30)} code=${code} -> ${classifyDispatchFailure(t, code)}`);
    return;
  }
  if (status) {
    const s = readState();
    console.log(`链路 ${Object.keys(s.lanes ?? {}).length} 条｜挂起 ${(s.pending ?? []).length} 项｜已报 ${(s.reported ?? []).length} 条`);
    for (const [k, v] of Object.entries(s.lanes ?? {})) console.log(`  ${k}  ${v.status}  ${(v.tickets ?? []).join('→')}  ${v.reason ?? ''}`);
    for (const p of s.pending ?? []) console.log(`  挂起 ${p.id} 第 ${p.attempts} 次，${when(p.nextAt)} 重试（${p.code}）`);
    if (s.wakePending) console.log(`  唤醒挂起 ${s.wakePending.ids} 第 ${s.wakePending.attempts} 次（${s.wakePending.code}）`);
    // UG-087：散票待投（没有链路的 submitted）——票号 / 第几次叫醒 / 最后叫醒时间 / 是否叫醒过
    const tasks = replay(readEvents());
    const wakeRows = readWakeLog();
    const stand = tasks
      .filter((t) => t && t.state === 'submitted' && !isFixture(t) && String(t.target ?? '') !== ACCEPTOR)
      .filter((t) => laneOf(t.id, tasks).length === 1);
    console.log(`散票待投 ${stand.length} 张（一拍只叫 1 张；冷却 ${Math.round(STANDALONE_COOLDOWN_MS / 60000)} 分 / 上限 ${STANDALONE_MAX_N} 次）`);
    for (const t of stand) {
      const key = String(t.ticket ?? t.id);
      const hist = attemptsOf(key, wakeRows);
      const last = hist[hist.length - 1] ?? null;
      const gate = canWake(key, { rows: wakeRows });
      const at = last ? new Date(Number(last.t)).toLocaleString('zh-CN', { hour12: false }) : '—';
      const verdict = last && !last.ok ? `未叫醒（${last.code}）` : gate.ok ? '可叫' : `${gate.reason}`;
      console.log(`  ${key}（${t.id}）第 ${hist.length} 次｜最后 ${at}｜${verdict}`);
    }
    return;
  }
  let inFlight = false;
  const runOnce = async () => {
    const r = await tickLane({ dry, quiet: json });
    // UG-087：链路之外再补一段「散票投递」。若这一拍刚给 01 投过链路清单，就不在
    // 同一拍再叫一次（宁可晚一拍，也不要一分钟两封）。
    const wokeThisTick = (r.actions ?? []).some((a) => String(a.act).includes('投01') && /accepted=true/.test(String(a.result)));
    const st = await dispatchStandalone({ dry, skipIfWoke: wokeThisTick });
    const merged = { ...r, standalone: st };
    if (json) { console.log(JSON.stringify(merged, null, 2)); return merged; }
    for (const a of st.actions ?? []) if (a.result !== 'dry') human(a);
    if (dry) for (const a of st.actions ?? []) console.log(`[lane·dry] 散票 ${a.id} ${a.result}  ${a.extra ?? ''}`);
    if (!r.actions.length && !(st.actions ?? []).length) console.log('[lane] 本拍无动作');
    return merged;
  };
  const run = async () => {
    if (inFlight) return null;
    inFlight = true;
    try { return await runOnce(); } finally { inFlight = false; }
  };
  if (watch) {
    console.log(`链路执行器在跑：每 60 秒一拍（唤醒限流 ${Math.round(WAKE_COOLDOWN_MS / 60000)} 分 / 被拒重试 ${Math.round(RETRY_MS / 1000)}s × ${MAX_ATTEMPTS}）`);
    await run();
    setInterval(run, 60000);
  } else {
    await run();
    process.exitCode = 0;
  }
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();

