#!/usr/bin/env node
// scripts/worklist.mjs —— 任务台账 CLI（工单 D12 §二）。除 `dispatch` 外全部免费。
//
//   node scripts\worklist.mjs list [--by 03] [--state submitted]
//   node scripts\worklist.mjs add --title "…" --target 04 --ticket D13 --note "…"
//   node scripts\worklist.mjs dispatch W-012 [--dry-run]     # ★ 唯一花钱的动作
//   node scripts\worklist.mjs accept   W-012 --note "通过"
//   node scripts\worklist.mjs reject   W-012 --note "缺自测，退回"
//   node scripts\worklist.mjs drop     W-012 --note "不做了"
//   node scripts\worklist.mjs pending | state <id> <state> | show <id> | turns [--json]
//
// 退出码：0 成功 ｜ 1 业务错误 ｜ 2 用法错误 ｜ 3 派发失败（配额用完/目标在跑等）

import fs from 'node:fs';
import {
  readEvents, replay, summary, byTarget, addTask, setState, WORKLIST_FILE,
  submitPlan, reviewPlan, approvePlan, rejectPlan, planSummary, PLAN_STATES,
  addDependency, removeDependency, blockedList
} from './worklist-core.mjs';
import { dispatch as dispatchTask, readConfig, quotaUsed } from './dispatch-core.mjs';

const MAIL_FILE = '<Xunyu根>\\memory\\mail\\mailbox.jsonl';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'list';
const opt = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const pos = (() => {
  const out = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { if (!argv[i].includes('=')) i += 1; continue; }
    out.push(argv[i]);
  }
  return out;
})();

const wid = (s) => {
  let w = 0;
  for (const ch of String(s ?? '')) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return w;
};
const pad = (s, n) => { const t = String(s ?? ''); return wid(t) >= n ? t : t + ' '.repeat(n - wid(t)); };
const when = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-') : '—');

/** 给某人落一封邮件（本地追加，零 token）。 */
function mail(to, body, level = '通知') {
  try {
    const rows = fs.existsSync(MAIL_FILE)
      ? fs.readFileSync(MAIL_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    const seq = (rows.length ? rows[rows.length - 1].seq : 0) + 1;
    fs.mkdirSync('<Xunyu根>\\memory\\mail', { recursive: true });
    fs.appendFileSync(MAIL_FILE, `${JSON.stringify({ seq, t: Date.now(), from: 'worklist', to, level, body })}\n`, 'utf8');
    return seq;
  } catch { return null; }
}

function printTasks(tasks, { showTarget = true } = {}) {
  if (!tasks.length) { console.log('（没有）'); return; }
  console.log(`${pad('票号', 8)}${pad('状态', 11)}${showTarget ? pad('工号', 6) : ''}${pad('单号', 7)}${pad('标题', 40)}来源`);
  for (const t of tasks) {
    const st = t.blocked ? `${t.state}⏸` : t.state;
    const wait = t.blocked ? `  ← 等 ${(t.blockedOn ?? []).join(',')}` : '';
    console.log(`${pad(t.id, 8)}${pad(st, 12)}${showTarget ? pad(t.target ?? '—', 6) : ''}${pad(t.ticket ?? '—', 7)}${pad(String(t.title).slice(0, 38), 40)}${t.src || '—'}${wait}`);
  }
}

try {
  if (cmd === 'list') {
    const by = opt('by');
    const state = opt('state');
    let tasks = replay();
    // D31 夹具隔离：默认看不到 fixture（不给 auto-relay 派、也不混进生产列表），--test 反过来只看夹具
    const showTest = flag('test');
    const fixtures = tasks.filter((t) => t.src === 'fixture');
    tasks = tasks.filter((t) => (showTest ? t.src === 'fixture' : t.src !== 'fixture'));
    if (by) tasks = tasks.filter((t) => String(t.target) === String(by));
    if (state) tasks = tasks.filter((t) => t.state === state);
    if (flag('blocked')) tasks = tasks.filter((t) => t.blocked);
    const all = replay();
    const s = summary(all);
    const cfg = readConfig();
    console.log(`任务 ${tasks.length} 条（库 ${all.length}）｜待审 ${s.pending}／排队 ${s.queued}／在干 ${s.doing}／待验收 ${s.submitted}／完 ${s.done}／弃 ${s.dropped}`);
    console.log(`今日 dispatch 配额：${quotaUsed('dispatch')}/${cfg.dispatchPerDay}　库：${WORKLIST_FILE}\n`);
    if (fixtures.length) console.log(`夹具 ${fixtures.length} 条已隔离（不影响派发；看它们：list --test）\n`);
    if (by || state) printTasks(tasks, { showTarget: !by });
    else {
      for (const g of byTarget(tasks)) {
        const subs = tasks.filter((t) => t.target === g.target && t.state === 'submitted');
        const bits = [];
        if (g.doing.length) bits.push(`在干 ${g.doing.length}`);
        if (g.queue.length) bits.push(`排队 ${g.queue.length}`);
        if (g.pending.length) bits.push(`待审 ${g.pending.length}`);
        if (subs.length) bits.push(`待验收 ${subs.length}`);
        console.log(`\n【${g.target}】${bits.join(' / ') || '空闲'}`);
        for (const t of [...g.doing, ...g.queue, ...g.pending, ...subs]) {
          console.log(`  ${pad(t.id, 8)}${pad(t.state, 11)}${pad(t.ticket ?? '—', 7)}${String(t.title).slice(0, 42)}`);
        }
      }
    }
  } else if (cmd === 'add') {
    const title = opt('title');
    if (!title) { console.error('用法：add --title "…" --target 04 [--ticket D13] [--note "…"]'); process.exit(2); }
    const isTest = flag('test');
    const ev = addTask({
      title,
      target: isTest ? 'test' : opt('target'),
      ticket: opt('ticket') ?? (isTest ? 'FX' : null),
      note: opt('note', '') ?? '',
      src: isTest ? 'fixture' : (opt('src', 'manual') ?? 'manual'),
      from: opt('from', '01') ?? '01',
      state: opt('state', 'queued') ?? 'queued'
    });
    console.log(`✓ 新增 ${ev.id} → ${ev.state}（${isTest ? '夹具隔离：target=test，默认列表不可见' : `工号 ${ev.target ?? '—'}`}${ev.ticket ? `，单号 ${ev.ticket}` : ''}）`);
  } else if (cmd === 'dispatch') {
    const id = pos[0];
    if (!id) { console.error('用法：dispatch <票号> [--dry-run]'); process.exit(2); }
    const res = await dispatchTask(id, { by: opt('from', '01') ?? '01', dryRun: flag('dry-run') });
    if (!res.ok) {
      console.error(`✗ 派发失败 [${res.status} ${res.code}] ${res.detail}`);
      process.exit(res.status === 429 ? 3 : 1);
    }
    if (res.code === 'dry-run') {
      console.log(`（dry-run，不花钱）prompt ${res.promptChars} 字：\n${res.prompt}`);
    } else {
      console.log(`✓ ${id} 已派给工号 ${res.target}：session/prompt 一次（${res.promptChars} 字）→ doing`);
      console.log('  审计：logs\\dispatch.jsonl');
    }
  } else if (cmd === 'accept') {
    const id = pos[0];
    if (!id) { console.error('用法：accept <票号> [--note "通过"]'); process.exit(2); }
    const note = opt('note', '') ?? '验收通过';
    setState(id, 'done', { from: '01', note });
    console.log(`✓ ${id} → done（${note}）`);
  } else if (cmd === 'reject') {
    const id = pos[0];
    if (!id) { console.error('用法：reject <票号> --note "…"'); process.exit(2); }
    const note = opt('note', '') ?? '退回重做';
    const task = replay().find((t) => t.id === id);
    if (!task) { console.error(`✗ 没有任务 ${id}`); process.exit(1); }
    const back = task.state === 'submitted' ? 'doing' : 'dropped';   // §四.5：退回 doing 并通知工号
    setState(id, back, { from: '01', note });
    let seq = null;
    if (back === 'doing' && task.target) {
      seq = mail(`${task.target}`, `【退回】${task.ticket ?? task.id}：${note}\n请按意见改完再交一次（${task.title}）`);
    }
    console.log(`✓ ${id} → ${back}（${note}）${seq ? `；已给工号 ${task.target} 落邮件 seq=${seq}` : ''}`);
  } else if (cmd === 'drop') {
    const id = pos[0];
    if (!id) { console.error('用法：drop <票号> --note "…"'); process.exit(2); }
    setState(id, 'dropped', { from: '01', note: opt('note', '') ?? '不做了' });
    console.log(`✓ ${id} → dropped`);
  } else if (cmd === 'pending') {
    const tasks = replay().filter((t) => t.state === 'inbox' || t.state === 'proposed');
    console.log(`待审 ${tasks.length} 条\n`);
    printTasks(tasks);
  } else if (cmd === 'state') {
    const [id, to] = pos;
    if (!id || !to) { console.error('用法：state <票号> <inbox|proposed|queued|doing|submitted|done|dropped>'); process.exit(2); }
    setState(id, to, { from: opt('from', '01') ?? '01', note: opt('note', '') ?? '' });
    console.log(`✓ ${id} → ${to}`);
  } else if (cmd === 'show') {
    const id = pos[0];
    const evs = readEvents().filter((e) => e.id === id);
    if (!evs.length) { console.error(`没有 ${id}`); process.exit(1); }
    for (const ev of evs) console.log(`${when(ev.t)}  ${pad(ev.op, 8)}${pad(ev.state ?? '', 11)}by ${ev.from}${ev.note ? `  「${ev.note}」` : ''}`);
  } else if (cmd === 'turns') {
    // 零 token 证据：读 sessions/list 投影数轮数；这个调用本身不花钱。
    const { dshApi } = await import('./dispatch-core.mjs');
    const { api, unwrap, url } = await dshApi();
    const items = unwrap(await api.sessions.list({}), 'session.list').items ?? [];
    const rows = items.filter((s) => !s.blank).map((s) => {
      const v = s.projections?.values ?? {};
      return {
        id: String(s.sessionId), short: String(s.sessionId).replace(/^session-/, '').slice(0, 8),
        title: v.title ?? '', running: Boolean(s.running),
        turns: Array.isArray(v.turnOutline) ? v.turnOutline.length : 0,
        lastPromptAt: Number(v.sessionListMetadata?.lastPromptAt ?? 0) || null
      };
    }).sort((a, b) => String(a.title).localeCompare(String(b.title)));
    if (flag('json')) console.log(JSON.stringify({ at: new Date().toISOString(), url, totalTurns: rows.reduce((n, r) => n + r.turns, 0), rows }, null, 2));
    else {
      console.log(`会话 ${rows.length} 个（${url}）  合计已完成 ${rows.reduce((n, r) => n + r.turns, 0)} 轮`);
      for (const r of rows) console.log(`${pad(r.short, 10)}${pad(r.turns, 5)}轮 ${r.running ? '跑着' : '空闲'}  ${r.title}`);
    }
  } else if (cmd === 'dep') {
    // D30：依赖链（B --on A：A 不做完，B 不许派）
    const id = pos[0];
    const by = opt('by', '01') || '01';
    const on = opt('on');
    const off = opt('off');
    if (!id || (!on && !off)) { console.error('用法：dep <票号> --on <前置票号> ｜ dep <票号> --off <前置票号>'); process.exit(2); }
    if (off) {
      removeDependency(id, off, { from: by });
      console.log('✓ ' + id + ' 摘掉前置 ' + off);
    } else {
      addDependency(id, on, { from: by, note: opt('note', '') || '' });
      console.log('✓ ' + id + ' 依赖 ' + on + '（前置没 done/dropped 就不许派）');
    }  } else if (cmd === 'plan-submit' || cmd === 'plan-review' || cmd === 'plan-approve' || cmd === 'plan-reject' || cmd === 'plan-list' || cmd === 'plan-manual') {
    // D28：方案审核状态机。全部免费（只写台账 + 邮件池），不调 DSH。
    const MANUAL_QUEUE = '<工作区>\\state\\plan-manual-queue.jsonl';
    const pushManual = (taskId, note, by) => {
      try {
        fs.mkdirSync('<工作区>\\state', { recursive: true });
        fs.appendFileSync(MANUAL_QUEUE, JSON.stringify({ t: Date.now(), id: taskId, note, by }) + '\n', 'utf8');
      } catch { /* 队列写不了不影响主流程 */ }
    };
    if (cmd === 'plan-list') {
      const tasks = replay().filter((t) => t.type || t.planState);
      const s = planSummary(replay());
      console.log('方案态统计：' + PLAN_STATES.map((k) => `${k} ${s[k]}`).join('／'));
      if (!tasks.length) console.log('\n（还没有方案单：node scripts\\worklist.mjs plan-submit W-xxx --type 方案）');
      for (const t of tasks) {
        console.log(`\n${pad(t.id, 12)}${pad(t.type ?? '—', 6)}${pad(t.planState ?? '—', 8)}${pad(String(t.target ?? '—'), 4)}${String(t.title).slice(0, 40)}`);
        if (t.reviewer) console.log(`           审 ${t.reviewer} @ ${when(t.reviewedAt)}${t.planNote ? ` 「${t.planNote}」` : ''}`);
      }
    } else if (cmd === 'plan-manual') {
      const rows = fs.existsSync(MANUAL_QUEUE)
        ? fs.readFileSync(MANUAL_QUEUE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        : [];
      console.log(`人工待审核箱：${rows.length} 条（${MANUAL_QUEUE}）`);
      for (const r of rows.slice(-20)) console.log(`  ${when(r.t)}  ${pad(r.id, 12)}${r.note}  by ${r.by}`);
    } else if (cmd === 'dep') {
    // D30：依赖链（B --on A：A 不做完，B 不许派）
    const id = pos[0];
    const by = opt('by', '01') || '01';
    const on = opt('on');
    const off = opt('off');
    if (!id || (!on && !off)) { console.error('用法：dep <票号> --on <前置票号> ｜ dep <票号> --off <前置票号>'); process.exit(2); }
    if (off) {
      removeDependency(id, off, { from: by });
      console.log('✓ ' + id + ' 摘掉前置 ' + off);
    } else {
      addDependency(id, on, { from: by, note: opt('note', '') || '' });
      console.log('✓ ' + id + ' 依赖 ' + on + '（前置没 done/dropped 就不许派）');
    }  } else if (cmd === 'plan-submit') {
      const id = pos[0];
      if (!id) { console.error('用法：plan-submit <票号> [--type 方案|实现|修复|文档] [--by 04] [--note "…"]'); process.exit(2); }
      const ev = submitPlan(id, { type: opt('type', '方案') ?? '方案', from: opt('by', null), note: opt('note', '') ?? '' });
      console.log(`✓ ${id} 方案已提交 → 待审（type=${ev.type}，by ${ev.from}）`);
    } else if (cmd === 'plan-review') {
      const id = pos[0];
      const state = opt('state');
      if (!id || !state) { console.error('用法：plan-review <票号> --state 01审中|转05|待人工 [--by 01] [--note "…"]'); process.exit(2); }
      const by = opt('by', '01') ?? '01';
      const ev = reviewPlan(id, { state, by, note: opt('note', '') ?? '' });
      if (state === '待人工') pushManual(id, opt('note', '') || '转人工待审', by);
      console.log(`✓ ${id} 方案态 → ${ev.planState}（by ${by}）`);
    } else if (cmd === 'plan-approve') {
      const id = pos[0];
      if (!id) { console.error('用法：plan-approve <票号> [--by 01] [--note "…"]'); process.exit(2); }
      const by = opt('by', '01') ?? '01';
      const r = approvePlan(id, { by, note: opt('note', '') ?? '' });
      console.log(`✓ ${id} 方案通过（by ${by}）→ 派生 ${r.implId} 进 queued`);
      if (r.derived) console.log(`   ${r.implId}：${r.derived.title}`);
      const seq = mail(String(replay().find((t) => t.id === id)?.target ?? '01'), `【方案通过】${id} 已通过，派生实现单 ${r.implId}（queued）。`);
      if (seq) console.log(`   已给工号落邮件 seq=${seq}`);
    } else if (cmd === 'plan-reject') {
      const id = pos[0];
      if (!id) { console.error('用法：plan-reject <票号> --note "缺X" [--by 01]'); process.exit(2); }
      const by = opt('by', '01') ?? '01';
      const note = opt('note', '') ?? '缺说明';
      const ev = rejectPlan(id, { by, note });
      const task = replay().find((t) => t.id === id);
      const who = String(task?.target ?? '01');
      const s1 = mail(who, `【方案驳回】${id}（${task?.title ?? ''}）：${note}\n改完再交：node scripts\\worklist.mjs plan-submit ${id} --type 方案`);
      const s2 = mail('01', `【方案驳回待人工】${id} 被 ${by} 驳回：${note}（已通知工号 ${who}；进人工待审核箱）`);
      pushManual(id, `驳回：${note}`, by);
      console.log(`✓ ${id} 方案 → 驳回（${note}）`);
      console.log(`   邮件：工号${who} seq=${s1}／01 seq=${s2}`);
      console.log('   已进人工待审核箱（node scripts\\worklist.mjs plan-manual）');
    }
  } else {
    console.error('用法：list | add | dispatch | accept | reject | drop | pending | state | show | turns | plan-submit | plan-review | plan-approve | plan-reject | plan-list | plan-manual');
    process.exit(2);
  }
} catch (error) {
  console.error(`✗ ${error?.message ?? error}`);
  process.exit(1);
}
