import { readJson } from './json-io.mjs';
// scripts/worklist-core.mjs —— 任务状态机的单一真相（append-only，回放得当前状态）。
//
// 工单 D10 §一：`state\worklist.jsonl`，一行一条变更；当前状态 = 回放最后一条同 id 的 `state`。
// 谁都能读（worklist.mjs CLI / workdesk 服务 / 以后别的脚本），**零 token**：只碰本地文件。
//
// 事件形状（工单原文）：
//   {"t":1793…,"id":"W-012","op":"add|state|reorder|drop","from":"04|01|本体|主人",
//    "state":"inbox|proposed|queued|doing|done|dropped","target":"03","title":"…","note":"…","src":"mail#7|task:D8|manual"}
//
// 状态机：inbox → proposed → queued → doing → done ／ 任何一步都能 dropped。
// 邮件转任务必须是 src=mail#<seq>，且**只经 01**（from=01）才允许 inbox→proposed→queued。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..');
export const WORKLIST_FILE = path.join(WORKSPACE, 'state', 'worklist.jsonl');

export const STATES = ['inbox', 'proposed', 'queued', 'doing', 'submitted', 'done', 'dropped'];
export const OPEN_STATES = ['inbox', 'proposed', 'queued', 'doing'];

// ── D28：方案审核态（只在 type=方案 的任务上有意义）──────────────────────────
// 待审 → 01审中 → 转05 → 通过／驳回；任何一步都能转「待人工」等人拍板。
export const PLAN_STATES = ['待审', '01审中', '转05', '待人工', '通过', '驳回'];
export const TASK_TYPES = ['方案', '实现', '修复', '文档'];
/** 命令行 --note 的内联上限（超过就截断并警告）。--note-file 可到 NOTE_FILE_LIMIT。 */
export const NOTE_LIMIT = 500;
export const NOTE_FILE_LIMIT = 8192;
// UG-007（B1）未回执态：**只在 replay 里算出来**，不写进 state 机、不新增状态词，历史票照样可回溯。
// 判据：已派（dispatchedAt 有值）+ 没有 accepted 回执（deliveredAt 为空）+ 在干（state=doing）+ 超过阈值。
// 测试加速：XUNYU_UNACK_MS=1000（每次调用时读，方便同一个进程里改阈值）
export const UNACK_DEFAULT_MS = 30 * 60 * 1000;
export function unackMs() {
  const v = Number(process.env.XUNYU_UNACK_MS ?? 0);
  return Number.isFinite(v) && v > 0 ? v : UNACK_DEFAULT_MS;
}
/** 时长人话：45 秒 / 12 分 / 3 小时 20 分 */
export function humanMs(ms) {
  const s = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
const PLAN_TRANSITIONS = {
  待审: ['01审中', '转05', '待人工', '通过', '驳回'],
  '01审中': ['转05', '待人工', '通过', '驳回'],
  转05: ['待人工', '通过', '驳回'],
  待人工: ['通过', '驳回'],
  通过: [],          // 通过是终态：派生实现单之后不再改方案态
  驳回: ['待审']     // 驳回后可以改了再交一次
};
/** 允许的状态迁移（写错方向就别落盘，免得回放出诡异状态）。 */
const TRANSITIONS = {
  inbox: ['proposed', 'queued', 'dropped'],   // D12：01 自己加的单可以直接进 queued
  proposed: ['queued', 'dropped'],
  queued: ['doing', 'dropped'],
  doing: ['submitted', 'done', 'dropped', 'queued'],   // D58：doing→queued = 退回排队（打回/误派/放弃当前轮）
  submitted: ['done', 'queued', 'doing', 'dropped'],   // accept→done；reject→退回 queued（D58，重派交给接力）
  done: [],
  dropped: []
};

export function readEvents(file = WORKLIST_FILE) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过，别让一条脏数据毁掉整个回放 */ }
  }
  return out;
}

export function appendEvent(event, file = WORKLIST_FILE) {
  const rec = { t: event.t ?? Date.now(), ...event };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
  return rec;
}

/** 回放：按 id 归并，`order` 决定展示顺序（默认按首次出现时间）。 */
export function replay(events = readEvents()) {
  const map = new Map();
  for (const ev of events) {
    if (!ev || !ev.id) continue;
    const prev = map.get(ev.id) ?? {
      id: ev.id, ticket: null, title: '', target: null, state: 'inbox', src: '', by: '',
      type: null, planState: null, reviewer: null, reviewedAt: null, planNote: '', comments: [],
      project: null, feature: null, kind: null,
      ownerAsked: false, startedAt: null, submittedAt: null, lastRejectReason: null, rejects: [],
      dispatchedAt: null, deliveredAt: null, ackBy: null,   // UG-007：派了/回执了（都是事件时间，派生用）
      blockedBy: [], blocked: false, unblockedAt: null, unblockedBy: null, unblockedReason: '',
      createdAt: ev.t ?? null, updatedAt: ev.t ?? null, order: 0, notes: [], history: []
    };
    if (ev.op === 'add') {
      prev.title = ev.title ?? prev.title;
      prev.ticket = ev.ticket ?? prev.ticket;
      prev.target = ev.target ?? prev.target;
      prev.src = ev.src ?? prev.src;
      prev.by = ev.from ?? prev.by;
      prev.type = ev.type ?? prev.type;
      prev.project = ev.project ?? prev.project;
      prev.ownerAsked = ev.ownerAsked === true;
      prev.feature = ev.feature ?? prev.feature;
      prev.kind = ev.kind ?? prev.kind;
      prev.createdAt = ev.t ?? prev.createdAt;
      prev.state = STATES.includes(ev.state) ? ev.state : 'inbox';
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    } else if (ev.op === 'plan') {
      // 方案态变更：一条事件记一次审核动作（谁、什么态、什么时候、给谁看、备注）
      if (PLAN_STATES.includes(ev.planState)) prev.planState = ev.planState;
      if (ev.type) prev.type = ev.type;
      if (ev.reviewer) prev.reviewer = ev.reviewer;
      if (ev.t) prev.reviewedAt = ev.t;
      if (ev.planNote != null) prev.planNote = String(ev.planNote).slice(0, 500);
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    } else if (ev.op === 'state') {
      if (STATES.includes(ev.state)) prev.state = ev.state;
      if (ev.target) prev.target = ev.target;
      if (ev.ticket) prev.ticket = String(ev.ticket);   // D78：重编（改号）走 state 事件承载，append-only 可回放
      // D73 埋点②：doing 记开工时间（返工重开就刷新），submitted 记交付时间
      if (ev.state === 'doing') {
        prev.startedAt = ev.t ?? null;
        prev.submittedAt = null;
        // UG-007：进 doing = 这一轮派出去了（dispatch 只会走 setState('doing')），回执窗口从头算
        prev.dispatchedAt = ev.t ?? Date.now();
        prev.deliveredAt = null;
        prev.ackBy = null;
      }
      if (ev.state === 'submitted') { prev.submittedAt = ev.t ?? null; }
      // D73 埋点③：驳回原因（枚举）进事件，用于返工统计
      if (ev.reason) prev.lastRejectReason = String(ev.reason);
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    } else if (ev.op === 'comment') {
      // D62：补证据通道——不改状态，只追加一条评论（回放时进 comments，list --detail 按时间线展示）
      prev.comments.push({ t: ev.t, by: ev.from ?? '', body: String(ev.body ?? '').slice(0, 8000) });
    } else if (ev.op === 'dep') {
      // D30：依赖链。mode=add 加前置；mode=remove 摘掉；unblock 只是「已通知解锁」的标记
      if (ev.mode === 'remove' && ev.on) {
        prev.blockedBy = (prev.blockedBy ?? []).filter((x) => x !== ev.on);
      } else if (ev.mode === 'unblock') {
        prev.unblockedAt = ev.t ?? Date.now();
      } else if (ev.on && !(prev.blockedBy ?? []).includes(ev.on)) {
        prev.blockedBy = [...(prev.blockedBy ?? []), ev.on];
        prev.unblockedAt = null;
      }
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    } else if (ev.op === 'unblocked') {
      // UG-011：前置全部闭环 → 本条自动解锁（append-only，时间与原因都进事件；不改 state 机）
      prev.unblockedAt = ev.t ?? Date.now();
      prev.unblockedBy = ev.from ?? 'auto';
      prev.unblockedReason = String(ev.reason ?? ev.note ?? '').slice(0, 300);
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    } else if (ev.op === 'reorder') {
      prev.order = Number(ev.order ?? 0);
    } else if (ev.op === 'drop') {
      prev.state = 'dropped';
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    } else if (ev.op === 'attach') {
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    } else if (ev.op === 'reconcile') {
      // UG-068：台账 ↔ 项目栏对账。只改归属（project/feature），不动 state（状态机一个字没碰）
      if (ev.project) prev.project = String(ev.project);
      if (ev.feature) prev.feature = String(ev.feature);
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    } else if (ev.op === 'accepted' || ev.op === 'ack') {
      // UG-007：对方回执。只记「谁、什么时候收到了」，**不动 state**（状态机主链一个字没改）
      prev.deliveredAt = ev.t ?? Date.now();
      prev.ackBy = ev.from ?? null;
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    }
    prev.updatedAt = ev.t ?? prev.updatedAt;
    prev.history.push(ev);
    map.set(ev.id, prev);
  }
  const all = [...map.values()];
  for (const t of all) {
    const waiting = (t.blockedBy ?? []).filter((id) => {
      const dep = map.get(id);
      if (!dep) return true;                       // 前置不在台账里：当它没完成，别放行
      return dep.state !== 'done' && dep.state !== 'dropped';
    });
    t.blocked = waiting.length > 0;
    t.blockedOn = waiting;
  }
  // UG-007：派生态派生（这里只算，不写盘；所以历史票的 state 完全不受影响）
  const now = Date.now();
  const limit = unackMs();
  for (const t of all) {
    const waiting = Boolean(t.dispatchedAt) && !t.deliveredAt;
    const ageMs = waiting ? Math.max(0, now - t.dispatchedAt) : 0;
    t.ackWaitedMs = ageMs;
    t.ackWaitedText = waiting ? humanMs(ageMs) : null;
    t.unacked = Boolean(t.state === 'doing' && waiting && ageMs >= limit);
    t.dispatchState = !t.dispatchedAt ? null
      : (t.deliveredAt ? 'delivered'
        : (t.unacked ? 'unacknowledged' : 'dispatched'));
  }
  return all.sort((a, b) => (a.order - b.order) || ((a.createdAt ?? 0) - (b.createdAt ?? 0)));
}

/** UG-007：未回执清单（派生，按「派出去多久」从久到近）。 */
export function unackedList(tasks = replay()) {
  return tasks.filter((t) => t.unacked === true)
    .sort((a, b) => (a.dispatchedAt ?? 0) - (b.dispatchedAt ?? 0));
}

/** UG-007：记一次回执（对方 accepted）。只追加事件，不改状态。 */
export function ackDispatch(id, { from = '01', note = '' } = {}) {
  const task = replay().find((t) => t.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  const ev = appendEvent({ t: Date.now(), id, op: 'accepted', from, note: String(note ?? '').slice(0, 500) || '对方已回执' });
  return { event: ev, task };
}

export function nextId(events = readEvents()) {
  let max = 0;
  for (const ev of events) {
    const m = /^W-(\d+)$/.exec(String(ev.id ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `W-${String(max + 1).padStart(3, '0')}`;
}

/** 加一条任务（默认 inbox）。返回事件。 */
export function addTask({ title, target = null, ticket = null, note = '', src = 'manual', from = '本体', id = null, state = 'inbox', type = null, project = null, feature = null, kind = null, ownerAsked = false } = {}) {
  const events = readEvents();
  const taskId = id ?? nextId(events);
  if (events.some((e) => e.id === taskId && e.op === 'add')) {
    throw new Error(`任务 ${taskId} 已存在`);
  }
  return appendEvent({ t: Date.now(), id: taskId, op: 'add', from, state, target, ticket, type, project, feature, kind, ownerAsked: ownerAsked === true, title: String(title ?? '').slice(0, 200), note: String(note ?? '').slice(0, 8000), src });
}

/** 改状态（会校验迁移方向）。 */
export function setState(id, state, { from = '01', note = '', target = null, reason = null } = {}) {
  const events = readEvents();
  const task = replay(events).find((x) => x.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  if (!STATES.includes(state)) throw new Error(`状态不合法：${state}`);
  const allowed = TRANSITIONS[task.state] ?? [];
  // D58：doing→queued 必须写理由（打回/误派/放弃当前轮），否则拒绝
  if (task.state === 'doing' && state === 'queued' && !String(note ?? '').trim()) {
    throw new Error(`${id} 退回排队必须写 --note（为什么退回：打回/误派/放弃当前轮）`);
  }
  if (!allowed.includes(state)) {
    throw new Error(`不允许 ${task.state} → ${state}（${id}）`);
  }
  return appendEvent({ t: Date.now(), id, op: 'state', from, state, target: target ?? task.target, note: String(note ?? '').slice(0, 8000), ...(reason ? { reason: String(reason) } : {}) });
}

/** 01 审核通过：inbox → proposed → queued（两步都落盘，审核这件事可回放）。 */
export function approve(id, { target = null, from = '01', note = '' } = {}) {
  const events = readEvents();
  const task = replay(events).find((x) => x.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  const events_out = [];
  if (task.state === 'inbox') events_out.push(setState(id, 'proposed', { from, note: note || '审核通过' }));
  events_out.push(setState(id, 'queued', { from, target: target ?? task.target, note: note || '审核通过，进队列' }));
  return events_out;
}

export function reject(id, { from = '01', note = '' } = {}) {
  return setState(id, 'dropped', { from, note: note || '审核驳回' });
}

export function drop(id, { from = '01', note = '' } = {}) {
  return setState(id, 'dropped', { from, note: note || '不做了' });
}

/** 置顶/置底：order 用首尾差值，不改别人的相对次序。 */
export function reorder(id, where = 'top') {
  const tasks = replay();
  const task = tasks.find((x) => x.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  const orders = tasks.map((x) => Number(x.order ?? 0));
  const order = where === 'bottom' ? Math.max(0, ...orders) + 10 : Math.min(0, ...orders) - 10;
  return appendEvent({ t: Date.now(), id, op: 'reorder', from: '01', order });
}

/** 按工号分组：队列（queued 在前，doing 单独看）+ 待审。 */
export function byTarget(tasks = replay()) {
  const groups = new Map();
  for (const task of tasks) {
    const key = task.target ?? '未指派';
    if (!groups.has(key)) groups.set(key, { target: key, queue: [], doing: [], pending: [], done: [], dropped: [] });
    const g = groups.get(key);
    if (task.state === 'queued') g.queue.push(task);
    else if (task.state === 'doing') g.doing.push(task);
    else if (task.state === 'inbox' || task.state === 'proposed') g.pending.push(task);
    else if (task.state === 'done') g.done.push(task);
    else if (task.state === 'dropped') g.dropped.push(task);
  }
  return [...groups.values()];
}

export function summary(tasks = replay()) {
  const count = (s) => tasks.filter((x) => x.state === s).length;
  return {
    total: tasks.length,
    inbox: count('inbox'), proposed: count('proposed'), queued: count('queued'),
    doing: count('doing'), submitted: count('submitted'), done: count('done'), dropped: count('dropped'),
    pending: count('inbox') + count('proposed')
  };
}

// ── D28：方案审核（core 只管台账，发邮件交给 CLI，保持这个文件无副作用）──────
const OPEN_PLAN = ['待审', '01审中', '转05', '待人工'];

function planEvent(id, planState, { from = '01', type = null, note = '', planNote = null } = {}) {
  return appendEvent({
    t: Date.now(), id, op: 'plan', from, planState, type,
    reviewer: from, planNote: planNote == null ? note : planNote, note
  });
}

/** 提交方案：待审（或从「驳回」改完再交）。 */
export function submitPlan(id, { type = '方案', from = null, note = '' } = {}) {
  const task = replay().find((t) => t.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  if (!TASK_TYPES.includes(type)) throw new Error(`类型不合法：${type}（可选 ${TASK_TYPES.join('/')}）`);
  if (task.planState && task.planState !== '驳回') throw new Error(`${id} 的方案已是「${task.planState}」，不能重复提交`);
  const who = from ?? (task.target ? `工号${task.target}` : '？');
  return planEvent(id, '待审', { from: who, type, note: note || `提交${type}，待审`, planNote: '' });
}

/** 01 的中间态流转：01审中 / 转05 / 待人工 / 通过 / 驳回 都由这里走（通过/驳回有专用入口）。 */
export function reviewPlan(id, { state, by = '01', note = '' } = {}) {
  const task = replay().find((t) => t.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  if (!PLAN_STATES.includes(state)) throw new Error(`方案态不合法：${state}（可选 ${PLAN_STATES.join('/')}）`);
  if (state === '通过' || state === '驳回') throw new Error(`${state} 请用 plan-approve / plan-reject（它们还要派生或发信）`);
  const cur = task.planState ?? '待审';
  if (!(PLAN_TRANSITIONS[cur] ?? []).includes(state)) throw new Error(`方案态不允许 ${cur} → ${state}（${id}）`);
  return planEvent(id, state, { from: by, note, planNote: note });
}

/** 方案通过 → 派生 <id>-impl 实现单进 queued（已存在就复用，不重复派生）。 */
export function approvePlan(id, { by = '01', note = '' } = {}) {
  const task = replay().find((t) => t.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  if (task.planState === '通过') throw new Error(`${id} 的方案已经通过过了`);
  const cur = task.planState ?? '待审';
  if (!OPEN_PLAN.includes(cur)) throw new Error(`方案态 ${cur} 不能通过（${id}）`);
  const ev = planEvent(id, '通过', { from: by, note: note || '方案通过，派生实现单' });
  const implId = `${id}-impl`;
  let derived = null;
  if (!readEvents().some((e) => e.id === implId && e.op === 'add')) {
    derived = addTask({
      id: implId,
      title: `${task.title}（实现）`,
      target: task.target,
      ticket: task.ticket ? `${task.ticket}-impl` : null,
      note: `派生自 ${id}（方案通过）`,
      src: `plan:${id}`,
      from: by,
      state: 'queued',
      type: '实现'
    });
  }
  return { event: ev, implId, derived };
}

/** 方案驳回 → 记录理由（发邮件由 CLI 做）。 */
export function rejectPlan(id, { by = '01', note = '' } = {}) {
  const task = replay().find((t) => t.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  const cur = task.planState ?? '待审';
  if (!OPEN_PLAN.includes(cur)) throw new Error(`方案态 ${cur} 不能驳回（${id}）`);
  return planEvent(id, '驳回', { from: by, note, planNote: note || '缺说明' });
}

export function planSummary(tasks = replay()) {
  const counts = {};
  for (const s of PLAN_STATES) counts[s] = tasks.filter((t) => t.planState === s).length;
  return counts;
}

// ── D30：依赖链（blockedBy）──────────────────────────────────────────────────
/** 加一条前置：B --on A 意思是「A 不做完，B 不许派」。 */
export function addDependency(id, onId, { from = '01', note = '' } = {}) {
  const tasks = replay();
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  if (!tasks.some((t) => t.id === onId)) throw new Error(`前置任务不存在：${onId}`);
  if (id === onId) throw new Error('不能依赖自己');
  if ((task.blockedBy ?? []).includes(onId)) throw new Error(`${id} 已经依赖 ${onId}`);
  // 环检测：从 onId 顺着它的前置走，能走回 id 就是环
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set();
  const walk = (cur) => {
    if (cur === id) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    const node = byId.get(cur);
    return (node?.blockedBy ?? []).some((next) => walk(next));
  };
  if (walk(onId)) throw new Error(`会形成环：${onId} 已经（间接）依赖 ${id}`);
  return appendEvent({ t: Date.now(), id, op: 'dep', mode: 'add', on: onId, from, note: note || `前置 ${onId}` });
}

export function removeDependency(id, onId, { from = '01' } = {}) {
  const task = replay().find((t) => t.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  if (!(task.blockedBy ?? []).includes(onId)) throw new Error(`${id} 并没有依赖 ${onId}`);
  return appendEvent({ t: Date.now(), id, op: 'dep', mode: 'remove', on: onId, from, note: `摘掉前置 ${onId}` });
}

/** 待解锁：有过前置、现在不挡了、还没通知过的任务（被 done/dropped 解的锁）。 */
export function pendingUnlocks(tasks = replay()) {
  return tasks.filter((t) => (t.blockedBy ?? []).length > 0
    && t.blocked === false
    && !t.unblockedAt
    && t.state !== 'done' && t.state !== 'dropped');
}

/** 标记「这个任务的解锁已经通知过了」，避免每轮重复发信。
 *  UG-011：改写成独立的 `unblocked` 事件——带时间与原因，回放后 unblockedAt / unblockedReason 都有据可查。
 *  仍然只是**追加事实**，不动状态机（旧的 `dep:unblock` 事件照样能回放，向后兼容）。 */
export function markUnblocked(id, { from = 'workdesk', note = '' } = {}) {
  const task = replay().find((t) => t.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  const closed = (task.blockedOn ?? []);
  const reason = String(note ?? '').trim()
    || `前置 ${(task.blockedBy ?? []).join('、')} 已全部闭环（done/dropped）`;
  return appendEvent({
    t: Date.now(), id, op: 'unblocked', from,
    state: task.state,                    // 解锁时的状态（queued 就是「重新可派」）
    wasBlockedOn: (task.blockedBy ?? []), // 原来挡着它的票
    stillOpen: closed,                    // 正常情况下应为空；非空说明还有前置没闭环
    reason: reason.slice(0, 300),
    note: reason.slice(0, 300)
  });
}

/** UG-011：自动解锁巡检——把「前置全部闭环、还没记过解锁」的票逐条落 `unblocked` 事件。
 *  纯本地写事件（零 token），幂等：已解锁过的不会再写。返回本次解锁的票号。 */
export function sweepUnblocks({ from = 'auto', note = '', tasks = null } = {}) {
  const out = [];
  for (const t of pendingUnlocks(tasks ?? replay())) {
    if ((t.blockedOn ?? []).length) continue;   // 双保险：还有前置没闭环就不放
    // 只给「真能派的」写解锁：inbox/proposed 还没审过，doing 已经在干（分册 §6.1 缺口 #3 的正式修法留待下一张单）
    if (t.state !== 'queued') continue;
    out.push(markUnblocked(t.id, { from, note }));
  }
  return out;
}

export function blockedList(tasks = replay()) {
  return tasks.filter((t) => t.blocked);
}

// ── D62：补证据通道（comment，不改状态）──────────────────────────────────────
/** 往台账追加一条评论：状态机不参与、不需要状态迁移。 */
export function commentTask(id, { body = '', from = '01' } = {}) {
  const task = replay().find((t) => t.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  const text = String(body ?? '').trim();
  if (!text) throw new Error('comment 内容不能为空');
  return appendEvent({ t: Date.now(), id, op: 'comment', from, body: text.slice(0, 8000) });
}

// ── D73：派发优先级（四级）与下游统计 ────────────────────────────────────────
/** 谁在等它：返回被本票挡着的票号列表（dependents）。 */
export function dependentsOf(id, tasks = null) {
  const all = tasks ?? replay();
  return all.filter((t) => (t.blockedBy ?? []).includes(id) && t.state !== 'dropped').map((t) => t.id);
}

/** 驳回原因枚举（写死在核心，CLI 与统计共用）。 */
export const REJECT_REASONS = ['missing-type', 'weak-evidence', 'gate-too-strict', 'wrong-formula', 'doc-mismatch', 'other'];

/**
 * 四级排序（D73）。返回带 rank/reason 的候选列表（已排序）。
 *   ① P0：主人指定（ownerAsked）
 *   ② 有下游等着（dependents > 0），下游多的优先、其次下游最早的
 *   ③ 同工号/同功能域有过驳回（返工优先）
 *   ④ 其余 FIFO（order → createdAt → id）
 * 只在 queued 且未被 blocked 的任务里排。
 */
export function rankForDispatch(tasks = null, { worker = null } = {}) {
  const all = tasks ?? replay();
  // 只排「能真派出去」的：queued、没被挡、有单号（D37 闸）
  // 只排「能真派出去」的：queued、没被挡、有单号（D37 闸）、不是夹具单（target=test 派不出去）
  const pool = all.filter((t) => t.state === 'queued' && !t.blocked && String(t.ticket ?? '').trim()
    && String(t.target ?? '') !== 'test' && t.src !== 'fixture'
    && (worker == null || String(t.target ?? '') === String(worker)));
  const rejectedTargets = new Set(all.filter((t) => t.lastRejectReason).map((t) => String(t.target ?? '')));
  const rejectedFeatures = new Set(all.filter((t) => t.lastRejectReason && t.project && t.feature).map((t) => `${t.project}/${t.feature}`));
  const rows = pool.map((t) => {
    const deps = dependentsOf(t.id, all);
    let rank = 4;
    let why = 'FIFO';
    let rankN = 0;
    if (t.ownerAsked) { rank = 1; why = 'P0（主人指定）'; }
    else if (deps.length) {
      rank = 2;
      rankN = deps.length;
      why = `等它的是 ${deps.slice(0, 3).join('、')}${deps.length > 3 ? ' 等' : ''}`;
    } else if (rejectedTargets.has(String(t.target ?? '')) || (t.project && t.feature && rejectedFeatures.has(`${t.project}/${t.feature}`))) {
      rank = 3;
      why = '返工优先（同工号/同功能域有驳回）';
    }
    return { id: t.id, ticket: t.ticket ?? null, target: t.target ?? null, title: t.title, rank, rankN, deps, why, order: t.order ?? 0, createdAt: t.createdAt ?? 0 };
  });
  rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 2 && b.rank === 2) {
      if (b.rankN !== a.rankN) return b.rankN - a.rankN;           // 下游多的先
      const aFirst = all.find((t) => (t.blockedBy ?? []).includes(a.id))?.createdAt ?? 0;
      const bFirst = all.find((t) => (t.blockedBy ?? []).includes(b.id))?.createdAt ?? 0;
      if (aFirst !== bFirst) return aFirst - bFirst;               // 等得久的先
    }
    if (a.order !== b.order) return a.order - b.order;             // 同级 FIFO：手工顺序优先
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return String(a.id).localeCompare(String(b.id));
  });
  return rows.map((r, i) => ({ ...r, position: i + 1 }));
}

/** 返工统计：按驳回原因计数（读 state 事件里的 reason）。 */
export function reworkStats(events = null) {
  const evs = events ?? readEvents();
  const counts = new Map(REJECT_REASONS.map((r) => [r, 0]));
  const byTarget = new Map();
  for (const e of evs) {
    if (e.op !== 'state' || !e.reason) continue;
    const r = String(e.reason);
    counts.set(r, (counts.get(r) ?? 0) + 1);
    const t = String(e.from ?? '—');
    byTarget.set(t, (byTarget.get(t) ?? 0) + 1);
  }
  return { counts: [...counts.entries()].map(([reason, n]) => ({ reason, n })), byTarget: [...byTarget.entries()].map(([by, n]) => ({ by, n })) };
}

// ── D67：功能域 / 项目签收（不改票状态，只记"这块过了"）────────────────────────
/** 某个功能域在台账里的票（按建单时的 project/feature 归属）。 */
export function featureTickets(project, feature, tasks = null) {
  const all = tasks ?? replay();
  return all.filter((t) => t.project === project && t.feature === feature);
}

/** 功能域状态：票完成度 + 未完成的票 + 签收记录。 */
export function featureStatus(project, feature, tasks = null) {
  const all = tasks ?? replay();
  const tickets = featureTickets(project, feature, all);
  const live = tickets.filter((t) => t.state !== 'dropped');
  const pending = live.filter((t) => t.state !== 'done');
  const dropped = tickets.filter((t) => t.state === 'dropped');
  const sign = readSignoffs().features.get(`${project}/${feature}`) ?? null;
  return {
    project, feature,
    total: tickets.length,
    done: live.filter((t) => t.state === 'done').length,
    pending: pending.map((t) => ({ id: t.id, ticket: t.ticket, state: t.state })),
    dropped: dropped.map((t) => ({ id: t.id, ticket: t.ticket })),
    tickets: tickets.map((t) => ({ id: t.id, ticket: t.ticket, state: t.state })),
    signoff: sign
  };
}

/** 项目状态：各功能域签收情况（功能域清单来自 projects.json）。 */
export function projectStatus(projectId, tasks = null) {
  const doc = readJsonSafe(path.join(WORKSPACE, 'state', 'projects.json')) ?? { projects: [] };
  const proj = (doc.projects ?? []).find((p) => p.id === projectId) ?? null;
  const featureIds = (proj?.features ?? []).map((f) => f.id).filter(Boolean);
  const features = featureIds.map((fid) => featureStatus(projectId, fid, tasks));
  const sign = readSignoffs().projects.get(projectId) ?? null;
  return {
    project: projectId,
    name: proj?.name ?? projectId,
    features,
    unsigned: features.filter((f) => !f.signoff).map((f) => f.feature),
    signoff: sign
  };
}

/** 读签收事件（feature/project 各一张表，被撤销的删掉）。 */
export function readSignoffs(events = readEvents()) {
  const features = new Map();
  const projects = new Map();
  for (const e of events) {
    if (e.op === 'feature-approved' && e.project && e.feature) {
      features.set(`${e.project}/${e.feature}`, { by: e.from ?? e.by ?? '', at: e.t ?? null, note: e.note ?? '', revokedAt: null });
    } else if (e.op === 'feature-revoked' && e.project && e.feature) {
      const prev = features.get(`${e.project}/${e.feature}`);
      if (prev) { prev.revokedAt = e.t ?? null; features.delete(`${e.project}/${e.feature}`); }
    } else if (e.op === 'project-approved' && e.project) {
      projects.set(e.project, { by: e.from ?? e.by ?? '', at: e.t ?? null, note: e.note ?? '' });
    } else if (e.op === 'project-revoked' && e.project) {
      projects.delete(e.project);
    }
  }
  return { features, projects };
}

function readJsonSafe(p) {
  try { return readJson(p); } catch { return null; }
}

/** 签收功能域：票必须全部 done（dropped 不算未完成，但会在结论里列出来）。 */
export function approveFeature(project, feature, { from = '01', note = '' } = {}) {
  const st = featureStatus(project, feature);
  if (!st.tickets.length) throw new Error(`${project}/${feature} 名下没有票，无法签收`);
  if (st.pending.length) {
    const list = st.pending.map((t) => `${t.id}(${t.ticket ?? '—'}:${t.state})`).join('、');
    throw new Error(`${project}/${feature} 还有 ${st.pending.length} 张没完成：${list}`);
  }
  const text = String(note ?? '').trim();
  if (!text) throw new Error('签收必须写 --note（验收结论）');
  // 幂等：已经签收且结论一样 → 不重复落事件（返回 changed:false）
  if (st.signoff && String(st.signoff.note) === text) return { op: 'noop', changed: false, signoff: st.signoff };
  return { ...appendEvent({ t: Date.now(), op: 'feature-approved', project, feature, from, note: text.slice(0, 8000) }), changed: true };
}

export function revokeFeature(project, feature, { from = '01', note = '' } = {}) {
  const text = String(note ?? '').trim();
  if (!text) throw new Error('撤销签收必须写 --note（为什么撤销）');
  return appendEvent({ t: Date.now(), op: 'feature-revoked', project, feature, from, note: text.slice(0, 8000) });
}

/** 签收项目：所有功能域都必须已签收。 */
export function approveProject(project, { from = '01', note = '' } = {}) {
  const st = projectStatus(project);
  if (!st.features.length) throw new Error(`项目 ${project} 没有功能域，无法签收`);
  if (st.unsigned.length) throw new Error(`项目 ${project} 还有 ${st.unsigned.length} 个功能域没签收：${st.unsigned.join('、')}`);
  const text = String(note ?? '').trim();
  if (!text) throw new Error('签收必须写 --note（验收结论）');
  return appendEvent({ t: Date.now(), op: 'project-approved', project, from, note: text.slice(0, 8000) });
}

export function revokeProject(project, { from = '01', note = '' } = {}) {
  const text = String(note ?? '').trim();
  if (!text) throw new Error('撤销签收必须写 --note（为什么撤销）');
  return appendEvent({ t: Date.now(), op: 'project-revoked', project, from, note: text.slice(0, 8000) });
}
