#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts/acceptance-watch.mjs —— 验收「清点与超时」提醒（UG-005 / W-207）
//
// ⚠ UG-016（2026-10-29）起：**唤醒与链路推进搬去 `lane-runner.mjs`**，这里不再自己投 prompt。
//   本文件只剩「留痕邮件」这一摊：≥2 张摘要、单张挂满 4 小时报本体、12:30/18:30 清点、0 张不发。
//   每轮末尾调一次 `tickLane()`，于是**现有的 5 分钟计划任务就同时驱动了执行器**（一套，不做两套）。
//
// 为什么还要它：任务书要「邮件留痕 + 定时清点」；链路执行器负责「叫醒 + 推进 + 两端上报」。分工清楚，互不重复。
//
// 用法：
//   node scripts\acceptance-watch.mjs --once
//   node scripts\acceptance-watch.mjs --watch          # 每 60 秒一轮
//   node scripts\acceptance-watch.mjs --once --json    # 机读
//   node scripts\acceptance-watch.mjs --once --dry     # 只算不发（连 lane 也只看不投）
//   node scripts\acceptance-watch.mjs --once --no-lane # 只做清点，不驱动链路执行器
//   node scripts\acceptance-watch.mjs --once --to 04   # 清点邮件发谁（默认 01）
//
// 测试加速：XUNYU_ACCEPT_ESCALATE_MS（默认 4h）、XUNYU_ACCEPT_COOLDOWN_MS（默认 5min）、XUNYU_ACCEPT_NOMAIL=1

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replay } from './worklist-core.mjs';
import { tickLane, wakeAgent, deliveryPathOf, ACCEPTOR, OWNER } from './lane-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const STATE = path.join(WORKSPACE, 'state', 'acceptance-watch.json');
const MAIL_BOX = 'E:/DeepFish/Xunyu/memory/mail';
const MAIL_FILE = path.join(MAIL_BOX, 'mailbox.jsonl');

const ESCALATE_MS = Number(process.env.XUNYU_ACCEPT_ESCALATE_MS ?? 4 * 3600 * 1000);
const COOLDOWN_MS = Number(process.env.XUNYU_ACCEPT_COOLDOWN_MS ?? 5 * 60 * 1000);
const SLOTS = ['12:30', '18:30'];
/** 「同项目验收优先」提示（UG-015 §2.1 要求，邮件里带）。 */
const HINT = '同项目/同功能域的票放在一起验（按台账的 project/feature），先验早交的。';

/** 保险 / 学习区是独立项目，走独立验收，不经 01（主人 2026-11-06 18:05 定）。 */
const INDEPENDENT_PROJECTS = new Set(['insurance', 'study']);
function isIndependentProject(t) {
  const prj = String(t?.project ?? '');
  if (INDEPENDENT_PROJECTS.has(prj)) return true;
  // project 缺失时才用票号兜底，避免误伤别的项目
  return prj === '' && /^(IN|ST)-/i.test(String(t?.ticket ?? ''));
}

function readState() {
  try { return readJson(STATE) ?? {}; } catch { return {}; }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
}
function lastMailSeq() {
  try {
    const lines = fs.readFileSync(MAIL_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.length ? Number(JSON.parse(lines[lines.length - 1]).seq) || 0 : 0;
  } catch { return 0; }
}
function postMail(to, body, level = '通知') {
  if (process.env.XUNYU_ACCEPT_NOMAIL === '1') return null;   // 测试/演练：只走逻辑不寄信
  try {
    execFileSync(process.execPath, [path.join(WORKSPACE, 'scripts', 'mail.mjs'), 'post', '--to', to, '--from', 'acceptance-watch', '--body', body, ...(level === '活' ? ['--level', '活'] : [])], { stdio: 'ignore' });
    return lastMailSeq();
  } catch { return null; }
}

/** 当前待验收清单（按提交时间从早到晚）。 */
export function submittedList() {
  const tasks = replay().filter((t) => t.state === 'submitted' && !isIndependentProject(t));
  return tasks
    .map((t) => ({ id: t.id, ticket: t.ticket ?? t.id, target: t.target ?? '—', title: String(t.title ?? '').slice(0, 40), submittedAt: Number(t.submittedAt ?? 0) }))
    .sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
}

// ── UG-021：验收自动升级（唤醒 01 / 超时上报本体）────────────────────────────
// 背景：主人「01 又没验收，这种也写进程序功能里自动叫他」。
//   lane-runner 已经在**交付时**叫过 01 一次；本层补的是**"叫了没人动"之后的升级**，并且不重复刷屏。
//
// 契约：
//   nudgeAcceptance({ now, dry, minutesSinceSubmit, rowsIn, wakeFn, mailFn, to })
//     -> { ok, disabled?, nudged, escalated, deduped, actions:[...] }
//   pendingList() -> [{ ticket, id, submittedAt, nudgeCount, lastNudgeAt, escalated }]
//
// 规则（minutesSinceSubmit 只用于 `--simulate` 把"年龄"往前推，不改台账的 submittedAt）：
//   L1 首次发现 → 补唤 01 一次，**仅当 01 已经 ≥10 分钟没被叫过**（lane 交付时叫过了，不许重复刷屏）
//   L2 ≥30 分钟未处置 → 再唤 01 一次 + cc 本体（邮件）
//   L3 ≥90 分钟仍未处置 → 不再唤 01，**上报本体 + 标红 escalated**（进 /api/acceptance/pending）
// 去重：同一张单**同一 (级别, submittedAt)** 只做一次；票被驳回重交（submittedAt 变）会重新计。
// 失败静默：wake 失败只记账不抛（下轮重试），绝不打断扫描循环。
// 关闸：`NUDGE_ENABLED=0` → 完全退回旧行为（只发邮件、不唤醒）。
const NUDGE_LOG = path.join(WORKSPACE, 'state', 'acceptance-nudge.jsonl');
const L2_MS = Number(process.env.XUNYU_ACCEPT_L2_MS ?? 30 * 60 * 1000);
const L3_MS = Number(process.env.XUNYU_ACCEPT_L3_MS ?? 90 * 60 * 1000);
const LANE_QUIET_MS = Number(process.env.XUNYU_ACCEPT_LANE_QUIET_MS ?? 10 * 60 * 1000);
// 退避：失败一次等 base，再失败翻倍，封顶 5 分钟（测试设 XUNYU_NUDGE_BACKOFF_MS=0 立刻重试）
const NUDGE_BACKOFF_MS = Number(process.env.XUNYU_NUDGE_BACKOFF_MS ?? 60 * 1000);
const NUDGE_BACKOFF_CAP_MS = Number(process.env.XUNYU_NUDGE_BACKOFF_CAP_MS ?? 5 * 60 * 1000);
const nudgeEnabled = () => String(process.env.NUDGE_ENABLED ?? '1') !== '0';

function readNudgeLog() {
  try {
    return fs.readFileSync(NUDGE_LOG, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function appendNudge(rec) {
  try {
    fs.mkdirSync(path.dirname(NUDGE_LOG), { recursive: true });
    fs.appendFileSync(NUDGE_LOG, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch { /* 记不下来也不能让扫描崩 */ }
}

/** 最后一次"真的把 01 叫醒"的时间（读 lane 的日志；失败唤醒不算） */
function lastLaneWakeAt() {
  const file = path.join(WORKSPACE, 'logs', 'lane.jsonl');
  let tail = '';
  try {
    const raw = fs.readFileSync(file, 'utf8');
    tail = raw.slice(-40000);
  } catch { return 0; }
  let last = 0;
  for (const line of tail.split(/\r?\n/)) {
    if (!line.includes('"wake"')) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.op === 'wake' && rec.ok === true && rec.to === '01') last = Math.max(last, Number(rec.at ?? rec.t ?? 0));
    } catch { /* 坏行跳过 */ }
  }
  return last;
}

/** 待验收清单 + 催办计数（给 GET /api/acceptance/pending 用） */
export function pendingList(rows = null) {
  const list = rows ?? submittedList();
  const log = readNudgeLog();
  return list.map((r) => {
    const mine = log.filter((x) => String(x.id) === String(r.id));
    const last = mine.reduce((mx, x) => Math.max(mx, Number(x.at ?? 0)), 0);
    return {
      id: r.id, ticket: r.ticket, target: r.target, title: r.title,
      submittedAt: r.submittedAt,
      ageMin: r.submittedAt ? Math.round((Date.now() - r.submittedAt) / 60000) : null,
      nudgeCount: mine.filter((x) => x.channel === 'prompt').length,
      lastNudgeAt: last || null,
      escalated: mine.some((x) => x.escalated === true || x.level === 3)
    };
  });
}

/**
 * 跑一轮升级。只读台账 + 追加 nudge 日志；**不改任何票的状态**（验收权只归 01/本体）。
 */
export async function nudgeAcceptance({
  now = Date.now(), dry = false, minutesSinceSubmit = 0, rowsIn = null,
  wakeFn = null, mailFn = null, to = ACCEPTOR, quiet = true
} = {}) {
  if (!nudgeEnabled()) return { ok: true, disabled: true, nudged: 0, escalated: 0, deduped: 0, actions: [] };
  const rows = rowsIn ?? submittedList();
  const actions = [];
  if (!rows.length) return { ok: true, nudged: 0, escalated: 0, deduped: 0, actions };

  const log = readNudgeLog();
  // 「已送达」才占坑：失败（target-busy 等）不占，下一轮继续试——忙的时候正是最需要叫醒的时候
const keyOf = (r, level) => `${r.id}|${level}|${r.submittedAt ?? 0}`;
const deliveredKeys = new Set(log.filter((x) => x.channel === 'prompt' && x.ok === true).map((x) => `${x.id}|${x.level}|${x.submittedAt ?? 0}`));
const escalatedKeys = new Set(log.filter((x) => x.channel === 'mail' && x.escalated === true).map((x) => `${x.id}|${x.level}|${x.submittedAt ?? 0}`));
const attempts = new Map();   // key -> { n, lastAt }
for (const x of log) {
  if (x.channel !== 'prompt') continue;
  const k = `${x.id}|${x.level}|${x.submittedAt ?? 0}`;
  const a = attempts.get(k) ?? { n: 0, lastAt: 0 };
  attempts.set(k, { n: a.n + 1, lastAt: Math.max(a.lastAt, Number(x.at ?? 0)) });
}
  const laneLast = minutesSinceSubmit > 0 ? 0 : lastLaneWakeAt();

  const byLevel = new Map();   // level -> rows[]
  let deduped = 0;
  for (const r of rows) {
    if (!r.submittedAt) continue;
    const ageMs = (now - Number(r.submittedAt)) + minutesSinceSubmit * 60000;
    const level = ageMs >= L3_MS ? 3 : (ageMs >= L2_MS ? 2 : 1);
    const k = keyOf(r, level);
if (deliveredKeys.has(k)) { deduped += 1; continue; }
    if (level === 3 && escalatedKeys.has(k)) { deduped += 1; continue; }   // 上报本体也一天一次，别每轮发
const prev = attempts.get(k);
if (prev && NUDGE_BACKOFF_MS > 0) {
  const wait = Math.min(NUDGE_BACKOFF_MS * (2 ** Math.max(0, prev.n - 1)), NUDGE_BACKOFF_CAP_MS);
  if (now - prev.lastAt < wait) { deduped += 1; continue; }
}
    if (level === 1) {
      // L1：lane 最近 10 分钟内叫过 01 → 不重复叫，只记一笔"已由 lane 覆盖"
      if (laneLast && now - laneLast < LANE_QUIET_MS) {
        if (!attempts.has(`lane|${r.id}|${r.submittedAt}`)) {
          appendNudge({ at: now, id: r.id, ticket: r.ticket, level: 1, ageMin: Math.round(ageMs / 60000), channel: 'lane', ok: true, skipped: 'lane 刚叫过 01', submittedAt: r.submittedAt });
        }
        deduped += 1;
        continue;
      }
    }
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(r);
  }

  let nudged = 0;
  let escalated = 0;
  for (const level of [...byLevel.keys()].sort()) {
    const group = byLevel.get(level);
    const fmt = (r) => `${r.ticket}(${r.target}) 挂了 ${Math.round(((now - Number(r.submittedAt)) + minutesSinceSubmit * 60000) / 60000)} 分钟：${String(r.title ?? '').slice(0, 40)}`;
    const lines = group.map(fmt).join('\n');
    const delivery = group.map((r) => `  ${r.ticket} → ${deliveryPathOf(r.ticket) ?? '（交付稿没找到）'}`).join('\n');

    if (level === 3) {
      // 90 分钟：不再叫 01，直接上报本体 + 标红
      const text = `【验收卡死·${Math.round(L3_MS / 60000)} 分钟】${group.length} 张挂太久没人验，已标红并转交本体裁决：\n${lines}\n交付：\n${delivery}\n（要么派专人验，要么驳回重做；不自动验收）`;
      const seq = dry ? null : (mailFn ?? postMail)(OWNER, text, '告警');
      for (const r of group) {
        escalated += 1;
        if (!dry) appendNudge({ at: now, id: r.id, ticket: r.ticket, level: 3, ageMin: Math.round(((now - Number(r.submittedAt)) + minutesSinceSubmit * 60000) / 60000), channel: 'mail', ok: Boolean(seq), mailSeq: seq, escalated: true, submittedAt: r.submittedAt });
      }
      actions.push({ level: 3, type: 'escalate', n: group.length, ids: group.map((r) => r.id), mailSeq: seq });
      continue;
    }

    // L1 / L2：真去叫 01
    const head = level === 2
      ? `【验收超时·${Math.round(L2_MS / 60000)} 分钟】${group.length} 张提交后没人验（副本已给本体）：`
      : `【催验收】${group.length} 张还在等你验：`;
    const text = `${head}\n${lines}\n交付：\n${delivery}\n${HINT}\n验收：node scripts\\worklist.mjs accept <票号> --note "通过"｜驳回：reject <票号> --reason <分类> --note "原话"`;
    let wake = { ok: false, code: 'dry' };
    if (!dry) {
      try { wake = await (wakeFn ?? wakeAgent)(to, text, { now }); }
      catch (e) { wake = { ok: false, code: 'wake-threw', detail: String(e?.message ?? e) }; }   // 失败静默
    }
    let seq = null;
    if (level === 2 && wake.ok) {
      // 只有真的把 01 叫醒了才 cc 本体；叫不醒就走重试，别拿邮件刷屏
      try { seq = dry ? null : (mailFn ?? postMail)(OWNER, `【验收超时 cc 本体】${group.length} 张已挂 ${Math.round(L2_MS / 60000)} 分钟：\n${lines}\n已再次唤醒 01（accepted=true）`, '通知'); }
      catch { seq = null; }
    }
    for (const r of group) {
      if (wake.ok) nudged += 1;
      if (!dry) appendNudge({
        at: now, id: r.id, ticket: r.ticket, level,
        ageMin: Math.round(((now - Number(r.submittedAt)) + minutesSinceSubmit * 60000) / 60000),
        channel: 'prompt', ok: Boolean(wake.ok), accepted: Boolean(wake.accepted), code: wake.code ?? null,
        sessionId: wake.sessionId ?? null, chars: text.length, mailSeq: seq, submittedAt: r.submittedAt
      });
    }
    actions.push({ level, type: wake.ok ? 'nudge' : 'nudge-failed', n: group.length, ids: group.map((r) => r.id), code: wake.code ?? (wake.ok ? 'accepted' : 'failed'), sessionId: wake.sessionId ?? null, mailSeq: seq });
  }
  return { ok: true, nudged, escalated, deduped, actions, dry };
}

const fmtList = (rows) => rows.map((r) => `${r.ticket}(${r.target})`).join(' / ');

/**
 * 跑一轮清点（不发 prompt；唤醒/推进交给 lane-runner）。
 * 返回 { at, count, actions:[...], lane:[...] }
 * 选项：to（收件人，默认 01）、lane（是否驱动执行器，默认 true）、laneFn（测试注入）
 */
export async function tickWatch({ now = Date.now(), dry = false, state = null, to = '01', lane = true, laneFn = null, simulateMinutes = 0, nudge = true, rowsIn = null, persist = true, quiet = false } = {}) {
  const s = state ?? readState();
  const rows = rowsIn ?? submittedList();
  const actions = [];
  const ids = rows.map((r) => r.id).join(',');
  const day = new Date(now).toLocaleDateString('sv-SE');   // YYYY-MM-DD（本地）
  s.daily = s.daily ?? {};
  s.daily[day] = s.daily[day] ?? {};

  // ① 摘要催：≥2 张、清单变了、且过了冷却（**只发邮件留痕**，叫醒是 lane 的事）
  if (rows.length >= 2) {
    const last = s.lastSummary ?? null;
    const changed = !last || last.ids !== ids;
    const cooled = !last || now - Number(last.at ?? 0) >= COOLDOWN_MS;
    if (changed && cooled) {
      const text = `【待验收】${rows.length} 张：${fmtList(rows)}\n${HINT}\n验收：node scripts\\worklist.mjs accept <票号> --note "结论"`;
      const seq = dry ? null : postMail(to, text);
      if (!dry) { s.lastSummary = { at: now, ids, count: rows.length, mailSeq: seq }; }
      actions.push({ type: 'summary', count: rows.length, ids, mailSeq: seq });
    }
  }

  // ② 单张挂满阈值 → 报本体（一封列齐）
  s.escalated = s.escalated ?? {};
  const overdue = rows.filter((r) => r.submittedAt && now - r.submittedAt >= ESCALATE_MS && !s.escalated[r.id]);
  if (overdue.length) {
    const lines = overdue.map((r) => `${r.ticket}(${r.target}) 已挂 ${Math.round((now - r.submittedAt) / 60000)} 分钟：${r.title}`).join('\n');
    const text = `【验收超时】${overdue.length} 张挂了超过 ${Math.round(ESCALATE_MS / 60000)} 分钟没人验：\n${lines}`;
    const seq = dry ? null : postMail('00', text);
    if (!dry) for (const r of overdue) s.escalated[r.id] = { at: now, mailSeq: seq };
    actions.push({ type: 'escalate', n: overdue.length, ids: overdue.map((r) => r.id), mailSeq: seq });
  }

  // ③ 12:30 / 18:30 点名推清单（0 张不发）
  const hhmm = new Date(now).toTimeString().slice(0, 5);
  const hh = Number(hhmm.slice(0, 2));
  const mm = Number(hhmm.slice(3, 5));
  for (const slot of SLOTS) {
    const [sh, sm] = slot.split(':').map(Number);
    const inWindow = hh * 60 + mm >= sh * 60 + sm && hh * 60 + mm < sh * 60 + sm + 5;
    if (!inWindow) continue;
    if (s.daily[day][slot]) continue;
    if (!rows.length) { if (!dry) s.daily[day][slot] = { at: now, skipped: 'empty' }; actions.push({ type: 'slot-empty', slot }); continue; }
    const text = `【待验收·${slot} 清点】当前 ${rows.length} 张：${fmtList(rows)}\n${HINT}\n读到 0 张才算清完`;
    const seq = dry ? null : postMail(to, text);
    if (!dry) s.daily[day][slot] = { at: now, count: rows.length, mailSeq: seq };
    actions.push({ type: 'slot', slot, count: rows.length, mailSeq: seq });
  }

  // ④ 清到 0：清掉摘要/超时记忆
  if (!rows.length) {
    if (s.lastSummary) { s.lastSummary = null; actions.push({ type: 'reset' }); }
    s.escalated = {};
  }

  if (!dry && persist) writeState(s);

  // ⑤ 驱动链路执行器（唤醒 01 / 推进下游 / 两端上报）
  let laneOut = null;
  if (lane) {
    try {
      laneOut = await (laneFn ?? tickLane)({ now, dry, persist: !dry, quiet });
      for (const a of laneOut?.actions ?? []) actions.push({ type: 'lane', ...a });
    } catch (error) {
      actions.push({ type: 'lane-error', detail: String(error?.message ?? error).slice(0, 200) });
    }
  }
  // ⑥ UG-021：验收升级（叫 01 / 超时上报本体）——出任何问题都不许影响清点
  let nudgeOut = null;
  if (nudge) {
    try {
      nudgeOut = await nudgeAcceptance({ now, dry, rowsIn: rows, minutesSinceSubmit: simulateMinutes });
      for (const a of nudgeOut.actions ?? []) actions.push({ type: 'nudge', ...a });
    } catch (error) {
      actions.push({ type: 'nudge-error', detail: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return { at: now, count: rows.length, rows, actions, lane: laneOut?.actions ?? [], nudge: nudgeOut, dry };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const dry = argv.includes('--dry');
  const watch = argv.includes('--watch');
  const lane = !argv.includes('--no-lane');
  const ti = argv.indexOf('--to');
  const to = ti >= 0 && argv[ti + 1] ? String(argv[ti + 1]) : '01';
  let inFlight = false;
  const runOnce = async () => {
    // UG-021：--simulate <分钟> 只跑升级链路（把"已挂时间"往前推，不等真 30/90 分钟）
    const simIdx = argv.indexOf('--simulate');
    if (simIdx >= 0) {
      const min = Number(argv[simIdx + 1] ?? 30) || 30;
      const r = await nudgeAcceptance({ dry, minutesSinceSubmit: min });
      if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
      console.log(`（模拟：把每张票的"已挂时间"往前推 ${min} 分钟）`);
      if (r.disabled) console.log('NUDGE_ENABLED=0，升级链路关着');
      console.log(`升级结果：唤醒 ${r.nudged} 张 / 上报本体 ${r.escalated} 张 / 去重跳过 ${r.deduped} 条`);
      for (const a of r.actions ?? []) {
        if (a.type === 'nudge') console.log(`→ L${a.level} 唤醒 01：${a.n} 张（accepted，session ${String(a.sessionId ?? '').slice(0, 20)}…）`);
        if (a.type === 'nudge-failed') console.log(`→ L${a.level} 唤醒失败（${a.code}）：${a.n} 张，已记账等下一轮`);
        if (a.type === 'escalate') console.log(`→ L3 上报本体：${a.n} 张（邮件 #${a.mailSeq ?? 'dry'}），已标红 escalated`);
      }
      return r;
    }
    const r = await tickWatch({ dry, to, lane, quiet: json });
    if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
    if (!r.count) console.log(`清点：待验收 0 张（不发任何提醒）`);
    else if (!r.actions.length) console.log(`清点：待验收 ${r.count} 张，本轮无动作（冷却中/未到点）`);
    for (const a of r.actions) {
      if (a.type === 'summary') console.log(`→ 摘要催 ${to}：${a.count} 张（邮件 #${a.mailSeq ?? 'dry'}）`);
      if (a.type === 'escalate') console.log(`→ 报本体：${a.n} 张超时（邮件 #${a.mailSeq ?? 'dry'}）`);
      if (a.type === 'slot') console.log(`→ ${a.slot} 清点：${a.count} 张（邮件 #${a.mailSeq ?? 'dry'}）`);
      if (a.type === 'slot-empty') console.log(`→ ${a.slot} 清点：0 张，不发`);
      if (a.type === 'reset') console.log('→ 待验收清空，重置提醒记忆');
      if (a.type === 'lane-error') console.log(`✗ 执行器异常：${a.detail}`);
      if (a.type === 'nudge') console.log(`→ L${a.level} 唤醒 01：${a.n} 张（${a.code ?? ''}）`);
      if (a.type === 'nudge-failed') console.log(`→ L${a.level} 唤醒失败 ${a.code}：${a.n} 张（已记账，下轮重试）`);
      if (a.type === 'nudge-error') console.log(`✗ 升级层异常：${a.detail}`);
    }
    return r;
  };
  // --watch 时不叠轮
  const run = async () => {
    if (inFlight) return null;
    inFlight = true;
    try { return await runOnce(); } finally { inFlight = false; }
  };
  if (watch) {
    console.log(`清点在跑：每 60 秒一轮（摘要 ≥2 张 / 超时 ${ESCALATE_MS / 60000} 分 / 点名 ${SLOTS.join('、')} / 链路执行器 ${lane ? '开' : '关'}）`);
    run();
    setInterval(run, 60000);
  } else {
    run().then(() => { process.exitCode = 0; });
  }
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
