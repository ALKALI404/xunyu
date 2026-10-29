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
  queued: ['doing', 'dropped'],               // queued→doing 只有派发成功才允许（dispatch-core 里调）
  doing: ['submitted', 'done', 'dropped'],    // submitted = 交付文件被扫到
  submitted: ['done', 'doing', 'dropped'],    // accept→done；reject→退回 doing
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
      type: null, planState: null, reviewer: null, reviewedAt: null, planNote: '',
      blockedBy: [], blocked: false, unblockedAt: null,
      createdAt: ev.t ?? null, updatedAt: ev.t ?? null, order: 0, notes: [], history: []
    };
    if (ev.op === 'add') {
      prev.title = ev.title ?? prev.title;
      prev.ticket = ev.ticket ?? prev.ticket;
      prev.target = ev.target ?? prev.target;
      prev.src = ev.src ?? prev.src;
      prev.by = ev.from ?? prev.by;
      prev.type = ev.type ?? prev.type;
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
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
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
    } else if (ev.op === 'reorder') {
      prev.order = Number(ev.order ?? 0);
    } else if (ev.op === 'drop') {
      prev.state = 'dropped';
      if (ev.note) prev.notes.push({ t: ev.t, by: ev.from ?? '', note: ev.note });
    } else if (ev.op === 'attach') {
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
  return all.sort((a, b) => (a.order - b.order) || ((a.createdAt ?? 0) - (b.createdAt ?? 0)));
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
export function addTask({ title, target = null, ticket = null, note = '', src = 'manual', from = '本体', id = null, state = 'inbox', type = null } = {}) {
  const events = readEvents();
  const taskId = id ?? nextId(events);
  if (events.some((e) => e.id === taskId && e.op === 'add')) {
    throw new Error(`任务 ${taskId} 已存在`);
  }
  return appendEvent({ t: Date.now(), id: taskId, op: 'add', from, state, target, ticket, type, title: String(title ?? '').slice(0, 200), note: String(note ?? '').slice(0, 500), src });
}

/** 改状态（会校验迁移方向）。 */
export function setState(id, state, { from = '01', note = '', target = null } = {}) {
  const events = readEvents();
  const task = replay(events).find((x) => x.id === id);
  if (!task) throw new Error(`没有任务 ${id}`);
  if (!STATES.includes(state)) throw new Error(`状态不合法：${state}`);
  const allowed = TRANSITIONS[task.state] ?? [];
  if (!allowed.includes(state)) {
    throw new Error(`不允许 ${task.state} → ${state}（${id}）`);
  }
  return appendEvent({ t: Date.now(), id, op: 'state', from, state, target: target ?? task.target, note: String(note ?? '').slice(0, 500) });
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

/** 标记「这个任务的解锁已经通知过了」，避免每轮重复发信。 */
export function markUnblocked(id, { from = 'workdesk', note = '' } = {}) {
  return appendEvent({ t: Date.now(), id, op: 'dep', mode: 'unblock', from, note: note || '前置已完成，解锁' });
}

export function blockedList(tasks = replay()) {
  return tasks.filter((t) => t.blocked);
}
