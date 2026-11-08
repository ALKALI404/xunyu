#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts/worklist.mjs —— 任务台账 CLI（工单 D12 §二）。除 `dispatch` 外全部免费。
//
//   node scripts\worklist.mjs list [--by 03] [--state submitted]
//   node scripts\worklist.mjs add --title "…" --target 04 --ticket D13 --note "…"
//   node scripts\worklist.mjs dispatch W-012 [--dry-run]     # ★ 唯一花钱的动作
//   node scripts\worklist.mjs accept   W-012 --note "通过"
//   node scripts\worklist.mjs reject   W-012 --note "缺自测，退回"
//   node scripts\worklist.mjs drop     W-012 --note "不做了"
//   node scripts\worklist.mjs pending | state <id> <state> | show <id> | turns [--json]
//   node scripts\worklist.mjs queue [--json] [--limit 10]      # UG-084：交付队列（未取，按到达顺序）
//   node scripts\worklist.mjs queue --take <票号>              # UG-084：01 一次取一张（幂等）
//   node scripts\worklist.mjs next --owner 04        # UG-033：项目栏里「下一张该干的票」（只读）
//
// 退出码：0 成功 ｜ 1 业务错误 ｜ 2 用法错误 ｜ 3 派发失败（配额用完/目标在跑等）

import fs from 'node:fs';
import {
  readEvents, replay, summary, byTarget, addTask, setState, appendEvent, WORKLIST_FILE,
  submitPlan, reviewPlan, approvePlan, rejectPlan, planSummary, PLAN_STATES, NOTE_LIMIT, NOTE_FILE_LIMIT, commentTask, rankForDispatch, reworkStats, dependentsOf, REJECT_REASONS,
  approveFeature, revokeFeature, approveProject, revokeProject, projectStatus, readSignoffs,
  addDependency, removeDependency, blockedList, sweepUnblocks,
  unackedList, ackDispatch, unackMs, humanMs
} from './worklist-core.mjs';
import { dispatch as dispatchTask, readConfig, quotaUsed, evaluateLoadGate, writeAudit, findTaskBook, validateTaskBook, listUndelivered, processDueRetries, MAX_ATTEMPTS } from './dispatch-core.mjs';
import { evaluatePriority, priorityState } from './dispatch-core.mjs';   // UG-031：优先名单拦截与可观测
import { recordRework, resolveRework, syncMistakes } from './mistakes-sync.mjs';   // UG-036：返工错题本
import { enqueueDelivery, pendingEntries, takeEntry, deliveryPathOf, QUEUE_FILE } from './delivery-queue.mjs';   // UG-084：交付即通知队列

// ═══════════════════════════════════════════════════════════════════════════
// UG-033 接口契约 · 项目栏是唯一派单源（规则 §32）——改实现前先改这段契约
//   pickNextByOwner(ownerId) -> {
//     ticket: 单号|null, reason: 'ok'|'owner-busy'|'no-candidate'|'all-blocked'|'no-projects',
//     id: 台账票号, project, feature, priority, title, taskState, detail }
//       顺序：priority(P0→P1→P2，缺省按 P2) → blockedByDomain 已清 → owner 空闲（手上无 doing）
//             → 该域里有 queued、未挡、指派给本人（或未指派）的票
//   assertInProject(ticket) -> { ok:true, project, feature }
//                            | { ok:false, code:'not-in-project'|'feature-mismatch', ... }
//   done 回写：appendProgressNote(票号) 往 feature.note 追加 "[YYYY-MM-DD HH:mm] XX-001 done"
//             时间只认 scripts\now.mjs 的输出（不许手写、不许本地推算）
//   投影（workdesk-server.mjs）：每个 feature 带 projection:{total,done,doing,queued,blocked,
//             currentTicket,lastProgress}——运行时算，不写回文件
//   测试口：XUNYU_PROJECTS_FILE 可指向别的 projects.json（不污染真项目栏）
// ═══════════════════════════════════════════════════════════════════════════
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKSPACE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };
const priRank = (p) => PRIORITY_RANK[String(p ?? '').toUpperCase()] ?? 2;   // 缺 priority 按 P2，不抢 P0
const TICKET_ACTIVE = ['doing', 'submitted', 'queued', 'done', 'dropped'];
const isClosedTicket = (s) => s === 'done' || s === 'dropped';

function projectsFilePath() {
  return process.env.XUNYU_PROJECTS_FILE || path.join(WORKSPACE_DIR, 'state', 'projects.json');
}

/** 读项目栏。读不到就返回 doc:null —— 调用方必须当成"没有项目栏"，不许瞎派。 */
function readProjectsFile() {
  const file = projectsFilePath();
  try {
    return { file, doc: readJson(file), error: null };
  } catch (e) {
    return { file, doc: null, error: e?.message ?? String(e) };
  }
}

/** 单号(大写) → 台账里「最活跃」那条的状态摘要 */
function ticketDigest(tasks) {
  const m = new Map();
  for (const t of tasks) {
    const k = String(t.ticket ?? '').trim().toUpperCase();
    if (!k) continue;
    const rank = TICKET_ACTIVE.indexOf(t.state);
    const row = {
      ticket: t.ticket, id: t.id, state: t.state, target: t.target ?? null,
      blocked: t.blocked === true, blockedOn: t.blockedOn ?? [],
      title: t.title ?? '', src: t.src ?? '', updatedAt: t.updatedAt ?? null
    };
    const cur = m.get(k);
    if (!cur) { m.set(k, row); continue; }
    const curRank = TICKET_ACTIVE.indexOf(cur.state);
    if (rank >= 0 && (curRank < 0 || rank < curRank)) m.set(k, { ...row, title: row.title || cur.title });
  }
  return m;
}

/** 项目栏里某个"功能域 id"（blockedByDomain 指的是 feature.id）的状态 */
function domainStatus(domainId, ctx) {
  const d = ctx.byDomain.get(String(domainId));
  if (!d) return { ok: false, why: `${domainId} 在项目栏里不存在（依赖写错或未登记）` };
  const open = (d.tickets ?? []).filter((tk) => {
    const st = ctx.digest.get(String(tk).trim().toUpperCase());
    return !st || !isClosedTicket(st.state);      // 台账查不到也算没清（fail-closed）
  });
  return open.length
    ? { ok: false, why: `${domainId} 还有 ${open.slice(0, 5).join('、')} 没完` }
    : { ok: true };
}

/** 建索引：单号 → 归属，功能域 id → 域 */
function projectIndex(doc) {
  const byTicket = new Map();
  const byDomain = new Map();
  for (const p of doc.projects ?? []) {
    for (const f of p.features ?? []) {
      const slot = { project: p.id, feature: f.id, owner: f.owner != null ? String(f.owner) : null, priority: f.priority ?? null };
      if (!byDomain.has(String(f.id))) byDomain.set(String(f.id), { project: p.id, feature: f.id, owner: slot.owner, tickets: f.tickets ?? [] });
      for (const tk of f.tickets ?? []) byTicket.set(String(tk).trim().toUpperCase(), slot);
    }
  }
  return { byTicket, byDomain };
}

/** 契约①：按 优先级 → 依赖域已清 → owner 空闲 选下一张票（只读） */
function pickNextByOwner(ownerId, { doc: docIn = null, tasks = null } = {}) {
  const owner = String(ownerId ?? '').trim();
  const all = tasks ?? replay();
  let doc = docIn;
  let file = '(注入)';
  let error = null;
  if (!doc) { const r = readProjectsFile(); doc = r.doc; file = r.file; error = r.error; }
  if (!doc || !Array.isArray(doc.projects)) return { ticket: null, reason: 'no-projects', detail: `${file} 读不到或没有 projects[]：${error ?? ''}` };

  const idx = projectIndex(doc);
  const ctx = { digest: ticketDigest(all), byDomain: idx.byDomain };

  // ① owner 空闲：同一工号手上不许叠活（功能域清单「并行规则」第 1 条）
  const busy = all.find((t) => String(t.target ?? '') === owner && t.state === 'doing');
  if (busy) return { ticket: null, reason: 'owner-busy', detail: `工号 ${owner} 手上的 ${busy.ticket ?? busy.id} 还在 doing，先落这一张` };

  // ② 候选功能域：owner 匹配、还有未完成票
  const candidates = [];
  for (const p of doc.projects ?? []) {
    for (const f of p.features ?? []) {
      if (String(f.owner ?? '') !== owner) continue;
      const open = (f.tickets ?? []).map((tk) => ({ tk, st: ctx.digest.get(String(tk).trim().toUpperCase()) }))
        .filter((x) => !x.st || !isClosedTicket(x.st.state));
      if (!open.length) continue;
      candidates.push({
        project: p.id, feature: f.id, priority: f.priority ?? null, rank: priRank(f.priority),
        open, blockedByDomain: f.blockedByDomain ?? []
      });
    }
  }
  if (!candidates.length) return { ticket: null, reason: 'no-candidate', detail: `项目栏里没有 owner=${owner} 的未完成功能域` };
  candidates.sort((a, b) => a.rank - b.rank
    || String(a.project).localeCompare(String(b.project))
    || String(a.feature).localeCompare(String(b.feature)));

  // ③ 按优先级依次：域被挡就跳到下一个域（不把整条链锁死）
  const blockedNotes = [];
  for (const c of candidates) {
    const blocked = (c.blockedByDomain ?? []).map((d) => ({ d, r: domainStatus(d, ctx) })).filter((x) => !x.r.ok);
    if (blocked.length) { blockedNotes.push(`${c.project}/${c.feature}：${blocked.map((x) => x.r.why).join('；')}`); continue; }
    for (const x of c.open) {
      if (!x.st) continue;                                    // 单号在台账查不到：数据错，不派
      if (x.st.state !== 'queued') continue;                  // 只有 queued 能派
      if (x.st.src === 'fixture' || String(x.st.target ?? '') === 'test') continue;
      if (x.st.target != null && String(x.st.target) !== owner) continue;   // 已指派给别人
      if (x.st.blocked) continue;                             // blockedBy 前置没清
      return {
        ticket: x.st.ticket, id: x.st.id, project: c.project, feature: c.feature,
        priority: c.priority ?? 'P2', title: x.st.title, taskState: x.st.state,
        reason: 'ok', detail: `${c.priority ?? 'P2'} · 依赖域已清 · 工号 ${owner} 空闲`
      };
    }
  }
  return {
    ticket: null,
    reason: blockedNotes.length ? 'all-blocked' : 'no-candidate',
    detail: blockedNotes.length ? blockedNotes.join(' ｜ ') : `owner=${owner} 的域里没有能派的 queued 票（都还在 doing/submitted 或已指派别人）`
  };
}

/** 契约②：票必须在项目栏里；台账归属与项目栏打架也算不一致 */
function assertInProject(ticket) {
  const key = String(ticket ?? '').trim().toUpperCase();
  if (!key) return { ok: false, code: 'not-in-project', ticket: null, detail: '没有单号，无法核对项目栏' };
  const { file, doc, error } = readProjectsFile();
  if (!doc || !Array.isArray(doc.projects)) return { ok: false, code: 'not-in-project', ticket: key, detail: `${file} 读不到：${error ?? ''}` };
  const slot = projectIndex(doc).byTicket.get(key);
  if (!slot) return { ok: false, code: 'not-in-project', ticket: key, detail: `${key} 不在 state\\projects.json 的任何 feature.tickets 里` };
  const task = replay().find((t) => String(t.ticket ?? '').trim().toUpperCase() === key);
  const ledger = task && task.project && task.feature ? `${task.project}/${task.feature}` : null;
  if (ledger && ledger !== `${slot.project}/${slot.feature}`) {
    return { ok: false, code: 'feature-mismatch', ticket: key, ledger, projects: `${slot.project}/${slot.feature}`, project: slot.project, feature: slot.feature };
  }
  return { ok: true, project: slot.project, feature: slot.feature };
}

/** 时间戳：只认 scripts\now.mjs 的输出，本文件不自己算时间 */
function nowStamp() {
  const out = execFileSync(process.execPath, [path.join(WORKSPACE_DIR, 'scripts', 'now.mjs')], { encoding: 'utf8' }).trim();
  const m = out.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) throw new Error(`scripts\\now.mjs 输出格式不认识：${out}`);
  return `[${m[1]} ${m[2]}]`;
}

/** 票 done 后：feature.note 追加一行进度（脚本生成） */
function appendProgressNote(taskId) {
  const task = replay().find((t) => t.id === taskId);
  if (!task) return { ok: false, reason: 'no-task' };
  const ticket = String(task.ticket ?? '').trim();
  const { file, doc, error } = readProjectsFile();
  if (!doc || !Array.isArray(doc.projects)) return { ok: false, reason: 'no-projects', detail: error };
  const slot = ticket ? projectIndex(doc).byTicket.get(ticket.toUpperCase()) : null;
  const projectId = slot?.project ?? task.project;
  const featureId = slot?.feature ?? task.feature;
  if (!projectId || !featureId) return { ok: false, reason: 'not-in-project' };
  const proj = (doc.projects ?? []).find((p) => String(p.id) === String(projectId));
  const feat = (proj?.features ?? []).find((f) => String(f.id) === String(featureId));
  if (!feat) return { ok: false, reason: 'not-in-project', detail: `${projectId}/${featureId} 在项目栏里找不到` };
  let line;
  try { line = `${nowStamp()} ${ticket || task.id} done`; } catch (e) { return { ok: false, reason: 'now-failed', detail: e.message }; }
  const note = String(feat.note ?? '');
  if (note.split('\n').some((l) => l.trim() === line)) return { ok: true, changed: false, line, project: projectId, feature: featureId };
  feat.note = note ? `${note}\n${line}` : line;
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return { ok: true, changed: true, line, project: projectId, feature: featureId, file };
}

/** done 回写 + 一行提示（失败只警告，不影响 done 本身） */
function noteDoneToProjects(taskId, label = '') {
  try {
    const r = appendProgressNote(taskId);
    if (r.ok && r.changed) console.log(`  项目栏回写：${r.project}/${r.feature} note += 「${r.line}」`);
    else if (r.ok && !r.changed) console.log('  项目栏回写：这一行已经有了（跳过重复）');
    else console.log(`  ⚠ 项目栏回写跳过 [${r.reason}]${r.detail ? `：${r.detail}` : ''}${label ? `（${label}）` : ''}`);
    return r;
  } catch (e) {
    console.log(`  ⚠ 项目栏回写失败：${e?.message ?? e}`);
    return { ok: false, reason: 'exception', detail: e?.message ?? String(e) };
  }
}
const MAIL_FILE = 'E:\\DeepFish\\Xunyu\\memory\\mail\\mailbox.jsonl';

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
    fs.mkdirSync('E:\\DeepFish\\Xunyu\\memory\\mail', { recursive: true });
    fs.appendFileSync(MAIL_FILE, `${JSON.stringify({ seq, t: Date.now(), from: 'worklist', to, level, body })}\n`, 'utf8');
    return seq;
  } catch { return null; }
}

/**
 * 读备注：优先 --note-file（避免 shell 截断/转义），否则 --note。
 * 内联超 NOTE_LIMIT 会**明确警告**并截断（D62：以前是静默截断）。
 */
function noteText(dflt = '') {
  const file = opt('note-file');
  if (file) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`✗ 读不到 --note-file：${file}（${e?.message ?? e}）`); process.exit(2); }
    if (raw.length > NOTE_FILE_LIMIT) {
      console.error(`⚠ note-file 超 ${NOTE_FILE_LIMIT} 字，已截断（长度 ${raw.length}）`);
      raw = raw.slice(0, NOTE_FILE_LIMIT);
    }
    return raw.trim();
  }
  const inline = String(opt('note', dflt) ?? '');
  if (inline.length > NOTE_LIMIT) {
    console.error(`⚠ note 超 ${NOTE_LIMIT} 字，已截断（建议用 --note-file 传长文本）`);
    return inline.slice(0, NOTE_LIMIT);
  }
  return inline;
}
/** 读 projects.json（05 维护的项目/功能域定义）。 */
function projectsDoc() {
  try { return readJson('E:\\DSH_workspace\\state\\projects.json'); } catch { return null; }
}

/** D66：建单必须归属项目/功能域（夹具单豁免，归 test/test）。 */
function resolveAttribution() {
  if (flag('test')) return { project: 'test', feature: 'test' };
  const doc = projectsDoc();
  if (!doc || !Array.isArray(doc.projects)) { console.error('✗ 读不到 state\\projects.json，无法校验项目归属'); process.exit(2); }
  const fail = (msg) => { console.error(msg); process.exit(2); };
  const pid = String(opt('project', '') ?? '').trim();
  const fid = String(opt('feature', '') ?? '').trim();
  const pids = doc.projects.map((x) => x.id).join(', ');
  if (!pid) fail(`✗ 缺 --project：建单必须归属项目。可选：${pids}`);
  const proj = doc.projects.find((x) => x.id === pid);
  if (!proj) fail(`✗ 项目不存在：${pid}。可选：${pids}`);
  const fids = (proj.features ?? []).map((x) => x.id).filter(Boolean).join(', ');
  if (!fid) fail(`✗ 缺 --feature：项目 ${pid} 的功能域。可选：${fids || '（该项目暂无功能域）'}`);
  if ((proj.features ?? []).length && !proj.features.some((x) => x.id === fid)) {
    fail(`✗ 功能域不存在：${fid}。项目 ${pid} 可选：${fids}`);
  }
  return { project: pid, feature: fid };
}
/**
 * UG-023：开单查重用的标题相似度。
 * 口径：去空白/标点/符号 + 小写化 → 取字符 2-gram 集合 → **Dice 系数** 2·|交集|/(|A|+|B|)。
 * 为什么用 Dice 不用 Jaccard：中文短标题长度常不对称（「企微结论入项目清单」vs
 * 「企微结论进项目清单与项目文档」），Jaccard 会被长度差拖到 0.5 以下，真重复反而漏掉。
 */
function dupNormalize(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
function dupBigrams(s) {
  const n = dupNormalize(s);
  const out = new Set();
  if (n.length === 1) out.add(n);
  for (let i = 0; i + 1 < n.length; i += 1) out.add(n.slice(i, i + 2));
  return out;
}
function titleSimilarity(a, b) {
  const A = dupBigrams(a);
  const B = dupBigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}
const DUP_STATES = ['queued', 'doing', 'submitted'];   // 未完成 = 还会有人去做
const DUP_THRESHOLD = 0.8;                              // UG-023 定的线

/**
 * UG-027：按 `state\tasks\_自动模板.md` 生成任务书骨架。
 * 为什么要有：审计 #3/#10——任务书缺「回滚」/缺「做什么」，dispatch 两次被 409 `undefined-task` 挡。
 * 根因不是人粗心，是「从零写七个小节」这件事本身容易漏；改成**生成骨架 → 只填内容**，模板天生过 gate。
 * 回滚口径：删掉模板文件即回到「手工写任务书」（add 只打一行提示，不报错）。
 */
const TASK_TEMPLATE = 'E:\\DSH_workspace\\state\\tasks\\_自动模板.md';
function writeTaskBookSkeleton({ ticket, title, target, project, feature }) {
  try {
    if (!fs.existsSync(TASK_TEMPLATE)) return { ok: false, error: '模板不存在（state\\tasks\\_自动模板.md）' };
    const out = `E:\\DSH_workspace\\state\\tasks\\${ticket}.md`;
    if (fs.existsSync(out)) return { ok: false, error: `任务书已存在，不覆盖：${out}`, existing: true };
    const tpl = fs.readFileSync(TASK_TEMPLATE, 'utf8').replace(/^\uFEFF/, '');
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    const body = tpl
      .replaceAll('{{TICKET}}', String(ticket))
      .replaceAll('{{TITLE}}', String(title ?? '').trim() || '（标题待补）')
      .replaceAll('{{TARGET}}', String(target ?? '').trim() || '（未指定）')
      .replaceAll('{{PROJECT}}', `${project ?? '—'}/${feature ?? '—'}`)
      .replaceAll('{{CREATED}}', stamp);
    fs.writeFileSync(out, body, 'utf8');
    return { ok: true, path: out, bytes: Buffer.byteLength(body, 'utf8') };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}


// WG-904：`depMap` 曾被定义在 `list` 分支里却给 `pending` 分支用（跨分支借作用域变量 → `pending` 直接 ReferenceError）。
// 现在**谁用谁算**：真要下游计数就调 depMapOf()，不再从别的分支的局部变量借。
function depMapOf(tasks) {
  const m = new Map();
  for (const t of tasks) for (const dep of (t.blockedBy ?? [])) {
    if (!m.has(dep)) m.set(dep, []);
    m.get(dep).push(t.id);
  }
  return m;
}

function printTasks(tasks, { showTarget = true } = {}) {
  if (!tasks.length) { console.log('（没有）'); return; }
  console.log(`${pad('票号', 8)}${pad('状态', 11)}${showTarget ? pad('工号', 6) : ''}${pad('单号', 7)}${pad('项目/功能', 20)}${pad('挡着', 18)}${pad('标题', 30)}来源`);
  for (const t of tasks) {
    const st = t.blocked ? `${t.state}⏸` : t.state;
    const wait = t.blocked ? `  ← 等 ${(t.blockedOn ?? []).join(',')}` : '';
    const attr = `${t.project ?? '—'}/${t.feature ?? '—'}`;
    // UG-011：「挡着」列 = blockedBy 里**还没闭环**的票号；全部闭环 → 「—」
    const blockers = (t.blockedOn ?? []);
    const depCol = blockers.length ? blockers.join(',') : '—';
    console.log(`${pad(t.id, 8)}${pad(st, 12)}${showTarget ? pad(t.target ?? '—', 6) : ''}${pad(t.ticket ?? '—', 7)}${pad(attr, 20)}${pad(depCol, 18)}${pad(String(t.title).slice(0, 28), 30)}${t.src || '—'}${wait}`);
  }
}

/**
 * UG-011：一张票闭环后巡检解锁，并通知目标工号。
 * why CLI 侧：workdesk 的 HTTP 路径本来就自己扫（sweepUnlocks），两边共用 core 的 sweepUnblocks；
 * 谁把前置关掉、谁负责发这封「可以派了」，这样不会出现「解锁了但没人知道」。
 */
function afterClose(by, note = '') {
  try {
    const evs = sweepUnblocks({ from: by, note });
    for (const e of evs) {
      const t = replay().find((x) => x.id === e.id) ?? {};
      const seq = t.target && t.target !== 'test'
        ? mail(String(t.target), `【解锁】${t.ticket ?? e.id}「${t.title}」的前置 ${(e.wasBlockedOn ?? []).join('、')} 已全部闭环，现在可以派了。`)
        : null;
      console.log(`  ↑ 解锁 ${e.id}${seq ? `（已给工号 ${t.target} 落邮件 seq=${seq}）` : ''}`);
    }
    return evs;
  } catch { return []; }
}

try {
  if (cmd === 'list') {
    if (flag('projects')) {
      const doc = readJson('E:\\DSH_workspace\\state\\projects.json');
      const only = opt('project', null);
      for (const p of doc.projects ?? []) {
        if (only && p.id !== only) continue;
        const st = projectStatus(p.id);
        const mark = st.signoff ? `已签收 by ${st.signoff.by} at ${when(st.signoff.at)}` : '未签收';
        console.log(`${p.id}  ${p.name ?? ''}  功能域 ${st.features.length}｜项目${mark}`);
        for (const f of st.features) {
          const doneText = `票 ${f.done}/${f.total} done${f.dropped.length ? `（弃 ${f.dropped.length}）` : ''}`;
          const sign = f.signoff ? `已签收 by ${f.signoff.by} at ${when(f.signoff.at)}` : '未签收';
          const pend = f.pending.length ? `  未完成 ${f.pending.map((t) => t.id).join(',')}` : '';
          console.log(`  ${pad(f.feature, 16)}${pad(doneText, 26)}${sign}${pend}`);
        }
      }
      process.exit(0);
    }
    const detailId = opt('detail');
    if (detailId) {
      const evs = readEvents().filter((e) => e.id === detailId);
      if (!evs.length) { console.error(`没有任务 ${detailId}`); process.exit(1); }
      const task = replay().find((t) => t.id === detailId) ?? {};
      console.log(`${detailId}  状态 ${task.state ?? '?'}  单号 ${task.ticket ?? '—'}  工号 ${task.target ?? '—'}`);
      console.log(String(task.title ?? '').slice(0, 100));
      console.log('');
      console.log('时间                 事件       谁      摘要');
      for (const e of evs) {
        const body = String(e.body ?? e.note ?? '').replace(/\s+/g, ' ');
        const brief = body.length > 60 ? `${body.slice(0, 60)}…（${body.length} 字）` : body;
        console.log(`${when(e.t)}  ${pad(e.op, 11)}${pad(e.from ?? '—', 8)}${brief}`);
      }
      const cs = task.comments ?? [];
      if (cs.length) {
        console.log('');
        console.log(`评论（comment）${cs.length} 条全文：`);
        cs.forEach((c, i) => {
          console.log(`--- #${i + 1} ${c.by} @ ${when(c.t)}（${c.body.length} 字）`);
          console.log(c.body);
        });
      }
      console.log('');
      console.log(`评论 comment ${cs.length} 条；备注 note ${(task.notes ?? []).length} 条；状态 ${task.state ?? '?'}`);
      // D73 埋点②：工时（doing → submitted）
      if (task.startedAt) {
        if (task.submittedAt) {
          const mins = Math.round((task.submittedAt - task.startedAt) / 60000);
          const hh = Math.floor(mins / 60);
          const mm = mins % 60;
          console.log(`工时：开工 ${when(task.startedAt)} → 交付 ${when(task.submittedAt)}，耗时 ${hh ? `${hh} 小时 ` : ''}${mm} 分（${mins} 分钟）`);
        } else {
          console.log(`工时：开工 ${when(task.startedAt)}（还没交付）`);
        }
      }
      if (task.ownerAsked) console.log('标记：P0（主人指定）');
      const deps = dependentsOf(task.id, replay());
      if (deps.length) console.log(`挡着：${deps.length} 张（${deps.slice(0, 5).join('、')}${deps.length > 5 ? ' …' : ''}）`);
      process.exit(0);
    }
    if (flag('rework-stats')) {
      const st = reworkStats();
      console.log('返工统计（按驳回原因）：');
      for (const r of st.counts) console.log('  ' + String(r.reason).padEnd(16) + String(r.n));
      if (st.byTarget.length) { console.log('按驳回人：'); for (const r of st.byTarget) console.log('  ' + String(r.by).padEnd(8) + String(r.n)); }
    }
    const by = opt('by');
    const state = opt('state');
    let tasks = replay();
    const allTasks = tasks;
    // D77：按单号前缀筛（list --prefix WS）
    // D78：按单号精确查；命中多张时打重号警示
    const ticketFilter = opt('ticket', null);
    if (ticketFilter) {
      const want = String(ticketFilter).toUpperCase();
      const all = replay();
      const hit = all.filter((t) => String(t.ticket ?? '').toUpperCase() === want);
      const alias = (() => { try { return readJson('E:\\DSH_workspace\\state\\ticket-aliases.json'); } catch { return {}; } })();
      if (hit.length > 1) {
        console.log(`⚠ 重号：${hit.map((t) => `${t.id}(${t.state})`).join(' / ')}　共 ${hit.length} 张；已闭环的保留原号，未闭环的应重编（audit --duplicates --fix）`);
      }
      if (alias[want]) {
        console.log(`别名：${alias[want].map((a) => `${a.id} → ${a.newTicket}（${a.note}）`).join('；')}`);
      }
      tasks = hit;
    }
    const prefixFilter = opt('prefix', null);
    if (prefixFilter) {
      const pre = String(prefixFilter).toUpperCase().replace(/-$/, '');
      tasks = tasks.filter((t) => String(t.ticket ?? '').toUpperCase().startsWith(`${pre}-`) || String(t.ticket ?? '').toUpperCase() === pre);
    }
    // D31 夹具隔离：默认看不到 fixture（不给 auto-relay 派、也不混进生产列表），--test 反过来只看夹具
    const showTest = flag('test');
    const fixtures = tasks.filter((t) => t.src === 'fixture');
    tasks = tasks.filter((t) => (showTest ? t.src === 'fixture' : t.src !== 'fixture'));
    if (by) tasks = tasks.filter((t) => String(t.target) === String(by));
    if (state) tasks = tasks.filter((t) => t.state === state);
    if (flag('blocked')) tasks = tasks.filter((t) => t.blocked);
    // UG-007：未回执清单（派生态，不是台账里的状态；夹具隔离同 list 口径）
    if (flag('unacked')) {
      const limitMs = unackMs();
      const all = replay();
      const rows = unackedList(tasks);
      const s2 = summary(all);
      console.log(`未回执 ${rows.length} 张（判据：已投 — 无 accepted 回执 — 超 ${Math.round(limitMs / 60000)} 分钟；只在内存里算，台账状态没变）`);
      if (!rows.length) console.log('（没有）');
      else {
        console.log(`${pad('票号', 8)}${pad('工号', 6)}${pad('单号', 8)}${pad('派了多久', 12)}${pad('派出时间', 22)}标题`);
        for (const t of rows) {
          console.log(`${pad(t.id, 8)}${pad(t.target ?? '—', 6)}${pad(t.ticket ?? '—', 8)}${pad(t.ackWaitedText ?? '—', 12)}${pad(when(t.dispatchedAt), 22)}${String(t.title).slice(0, 36)}`);
        }
      }
      console.log(`（库 ${all.length} 张 / 在干 ${s2.doing} 张；阈值可用 XUNYU_UNACK_MS 覆盖，当前 ${limitMs}ms）`);
      process.exit(0);
    }
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
        // D58：一个工号有多张 doing 是台账失真，明确标出来
        if (g.doing.length) bits.push(`在干 ${g.doing.length}${g.doing.length > 1 ? ' ⚠ 多张在做' : ''}`);
        if (g.queue.length) bits.push(`排队 ${g.queue.length}`);
        if (g.pending.length) bits.push(`待审 ${g.pending.length}`);
        if (subs.length) bits.push(`待验收 ${subs.length}`);
        console.log(`\n【${g.target}】${bits.join(' / ') || '空闲'}`);
        for (const t of [...g.doing, ...g.queue, ...g.pending, ...subs]) {
          console.log(`  ${pad(t.id, 8)}${pad(t.state, 11)}${pad(t.ticket ?? '—', 7)}${String(t.title).slice(0, 42)}`);
        }
      }
    }
  } else if (cmd === 'audit') {
    // D78：历史重号治理。审计只读；--fix 只重编**未闭环**的重号票（已闭环的号一律不动）
    const ALIAS_FILE = 'E:\\DSH_workspace\\state\\ticket-aliases.json';
    const CLOSED = new Set(['done', 'dropped']);
    const tasks = replay();
    const byTicket = new Map();
    for (const t of tasks) {
      const k = String(t.ticket ?? '').trim();
      if (!k) continue;
      if (!byTicket.has(k)) byTicket.set(k, []);
      byTicket.get(k).push(t);
    }
    const dups = [...byTicket.entries()].filter(([, v]) => v.length > 1).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const rows = dups.map(([ticket, list]) => ({
      ticket,
      occupiers: list.map((t) => ({ id: t.id, state: t.state, target: t.target ?? null, title: String(t.title ?? '').slice(0, 40) })),
      open: list.filter((t) => !CLOSED.has(t.state))
    }));
    const fix = flag('fix');
    if (flag('json') && !fix) { console.log(JSON.stringify({ total: rows.length, rows }, null, 2)); process.exit(0); }
    console.log(`重号审计：${rows.length} 组`);
    for (const r of rows) {
      const open = r.open.length;
      console.log(`\n${r.ticket}  ${open ? `⚠ 未闭环 ${open} 张（应重编）` : '已闭环（保持原号，仅标记）'}`);
      for (const o of r.occupiers) console.log(`  ${pad(o.id, 8)}${pad(o.state, 11)}${pad(o.target ?? '—', 5)}${o.title}`);
    }
    if (!fix) {
      if (rows.some((r) => r.open.length)) console.log('\n（加 --fix 把未闭环的自动重编成新规则号；已闭环的一律不动）');
      process.exit(0);
    }
    // 重编：按前缀发新号（沿用 ticketPrefix → 内置表）
    const builtin = { workdesk: 'WS', avatar: 'AV', 'pain-heal': 'PN', bridge: 'BG', memory: 'MEM', workgroup: 'WG', wecom: 'WC' };
    const doc = projectsDoc();
    const prefixOf = (t) => {
      const proj = (doc?.projects ?? []).find((p) => p.id === t.project);
      const base = String(t.ticket ?? '').split('-')[0].toUpperCase();
      if (proj) return String(proj.ticketPrefix ?? builtin[proj.id] ?? base).toUpperCase();
      return /^[A-Z]{1,3}$/.test(base) ? base : 'OT';
    };
    let aliases = {};
    try { aliases = readJson(ALIAS_FILE); } catch { aliases = {}; }
    let changed = 0;
    for (const r of rows) {
      if (!r.open.length) continue;
      for (const t of r.open) {
        // 夹具单（target=test / src=fixture）不进重编：FX 是 --test 的约定号，改了会破夹具隔离
        if (String(t.target ?? '') === 'test' || t.src === 'fixture') {
          console.log(`  跳过 ${t.id}（${r.ticket}）：夹具单，FX 是 --test 的约定号`);
          continue;
        }
        const prefix = prefixOf(t);
        const re = new RegExp(`^${prefix}-(\\d+)$`, 'i');
        let max = 0;
        for (const x of replay()) {
          const m = re.exec(String(x.ticket ?? ''));
          if (m) max = Math.max(max, Number(m[1]));
        }
        const next = `${prefix}-${String(max + 1).padStart(3, '0')}`;
        const others = r.occupiers.filter((o) => o.id !== t.id).map((o) => o.id).join('/');
        const note = `重编自 ${r.ticket}（原与 ${others} 重号）`;
        // 直接落事件：重编只改号、不迁移状态（setState 会拒绝 queued→queued）
        appendEvent({ t: Date.now(), id: t.id, op: 'state', from: 'worklist', state: t.state, note, ticket: next });
        if (!aliases[r.ticket]) aliases[r.ticket] = [];
        aliases[r.ticket].push({ id: t.id, newTicket: next, note, at: new Date().toISOString() });
        changed += 1;
        console.log(`  ✓ ${t.id}：${r.ticket} → ${next}（${note}）`);
      }
    }
    if (changed) {
      fs.writeFileSync(ALIAS_FILE, `${JSON.stringify(aliases, null, 2)}\n`, 'utf8');
      console.log(`\n别名表已写：${ALIAS_FILE}（${changed} 条重编）`);
    } else console.log('\n没有需要重编的票（未闭环重号为空，或全是夹具单）');
  } else if (cmd === 'new') {
  } else if (cmd === 'new') {
    // D77：按项目前缀自动发号（WS-001 / AV-001 …），序号用最大已有号+1，**用完不回收**
    const ref = opt('project', null);
    if (!ref) { console.error('用法：new --project <项目id或前缀> [--title "…"] [--target 04] [--feature <域>]'); process.exit(2); }
    const doc = projectsDoc();
    const builtin = { workdesk: 'WS', avatar: 'AV', 'pain-heal': 'PN', bridge: 'BG', memory: 'MEM', workgroup: 'WG', wecom: 'WC' };
    const proj = (doc?.projects ?? []).find((p) => p.id === ref || String(p.ticketPrefix ?? '') === ref || String(p.ticketPrefix ?? '').toLowerCase() === String(ref).toLowerCase())
      ?? (doc?.projects ?? []).find((p) => builtin[p.id] === String(ref).toUpperCase());
    if (!proj) {
      console.error(`✗ 认不出项目：${ref}。可选：${(doc?.projects ?? []).map((p) => `${p.id}(${p.ticketPrefix ?? builtin[p.id] ?? '?'})`).join(', ')}`);
      process.exit(2);
    }
    const prefix = String(proj.ticketPrefix ?? builtin[proj.id] ?? proj.id.toUpperCase().slice(0, 3)).toUpperCase();
    // 序号：扫台账里所有 PREFIX-数字 的票（含 done/dropped，号不回收）
    let max = 0;
    const re = new RegExp(`^${prefix}-(\\d+)$`, 'i');
    for (const t of replay()) {
      const m = re.exec(String(t.ticket ?? ''));
      if (m) max = Math.max(max, Number(m[1]));
    }
    const ticket = `${prefix}-${String(max + 1).padStart(3, '0')}`;
    const title = opt('title', null);
    const note = noteText('');
    const ev = addTask({
      title: title ?? `${proj.name ?? proj.id}（${ticket}）`,
      target: opt('target', null) ?? null,
      ticket,
      project: proj.id,
      feature: opt('feature', null) ?? null,
      note,
      src: 'manual'
    });
    console.log(`✓ 发号 ${ticket} → ${ev.id}（项目 ${proj.id}${ev.feature ? `/${ev.feature}` : ''}，前缀 ${prefix}，下一个 ${prefix}-${String(max + 2).padStart(3, '0')}）`);
  } else if (cmd === 'add') {
    const title = opt('title');
    if (!title) { console.error('用法：add --title "…" --target 04 [--ticket D13] [--note "…"]'); process.exit(2); }
    const isTest = flag('test');
    // 发号规则（2026-10-29 主人要求落实）：单号跟项目走 <前缀>-<三位序号>，由脚本发，人工不许起号
    const builtinPrefix = { workdesk: 'WS', avatar: 'AV', 'pain-heal': 'PN', bridge: 'BG', memory: 'MEM', workgroup: 'WG', wecom: 'WC' };
    const pdoc = projectsDoc();
    const projectRef = opt('project', null);
    const resolveProj = (ref) => {
      if (!ref) return null;
      const list = pdoc?.projects ?? [];
      return list.find((x) => x.id === ref
        || String(x.ticketPrefix ?? '') === ref
        || String(x.ticketPrefix ?? '').toLowerCase() === String(ref).toLowerCase())
        ?? list.find((x) => builtinPrefix[x.id] === String(ref).toUpperCase())
        ?? null;
    };
    const allocTicket = (proj) => {
      const prefix = String(proj.ticketPrefix ?? builtinPrefix[proj.id] ?? proj.id.toUpperCase().slice(0, 3)).toUpperCase();
      let max = 0;
const rr = new RegExp('^' + prefix + '-(\\d+)' + '$', 'i');
      for (const t of replay()) {
        const mm = rr.exec(String(t.ticket ?? ''));
        if (mm) max = Math.max(max, Number(mm[1]));
      }
      try {
        const al = readJson('E:/DSH_workspace/state/ticket-aliases.json');
        for (const v of Object.values(al.aliases ?? {})) {
          const mm2 = rr.exec(String(v?.new ?? ''));
          if (mm2) max = Math.max(max, Number(mm2[1]));
        }
        for (const k of Object.keys(al.retired ?? {})) {
          const mm3 = rr.exec(String(k));
          if (mm3) max = Math.max(max, Number(mm3[1]));
        }
      } catch {}
      return { prefix, ticket: prefix + '-' + String(max + 1).padStart(3, '0') };
    };

    let ticket = isTest ? 'FX' : opt('ticket', null);
    let autoProject = null;
    if (!isTest && !String(ticket ?? '').trim()) {
      const proj = resolveProj(projectRef);
      if (!proj) {
        console.error('✗ 建单必须给项目（--project <项目id|前缀>）：单号由脚本按前缀发；也可显式 --ticket <前缀>-<序号>');
        console.error('  可选项目：' + ((pdoc?.projects ?? []).map((x) => x.id + '(' + (x.ticketPrefix ?? builtinPrefix[x.id] ?? '?') + ')').join(', ')));
        process.exit(2);
      }
      const a = allocTicket(proj);
      ticket = a.ticket;
      autoProject = proj.id;
      console.log('· 自动发号：' + ticket + '（项目 ' + proj.id + '，前缀 ' + a.prefix + '）');
    }
    if (!isTest && autoProject === null) {
      const ok = /^[A-Z]{2,4}-\d{3,}$/.test(String(ticket).trim());
      if (!ok) {
        console.error('✗ 单号格式不合规：' + ticket + '。规则是 <项目前缀>-<三位序号>（例：WS-004 / WG-012），D 开头的号不再接受');
        console.error('  省事做法：去掉 --ticket，改给 --project，脚本按前缀自动发号');
        process.exit(2);
      }
    }
    // D70：单号查重——同一个 ticket 不许两张活票（D67 撞号就是这么来的）
    if (!isTest) {
      const dup = replay().filter((t) => String(t.ticket ?? '') === String(ticket) && t.state !== 'dropped');
      if (dup.length) {
        console.error(`✗ 单号 ${ticket} 已被占用：${dup.map((t) => `${t.id}（${t.state}，${t.target ?? '—'}）`).join('、')}；换一个号，或先 drop/关掉占用者`);
        process.exit(2);
      }
    }    const attr = resolveAttribution();
    // UG-023：开单查重——同 project+feature 内标题近似的**未完成**票一律先拦；--force-dup 带理由才放行
    let dupForced = null;
    if (!isTest && !flag('no-dup-check')) {
      const peers = replay().filter((t) => t.project === attr.project
        && t.feature === attr.feature
        && DUP_STATES.includes(t.state));
      const scored = peers
        .map((t) => ({ t, s: titleSimilarity(title, t.title) }))
        .filter((x) => x.s >= DUP_THRESHOLD)
        .sort((a, b) => b.s - a.s);
      if (scored.length) {
        const top = scored[0];
        const reason = String(opt('dup-reason', '') ?? '').trim();
        if (!flag('force-dup')) {
          console.error(`✗ 疑似重复开单：同 ${attr.project}/${attr.feature} 已有 ${scored.length} 张近似未完成票（标题相似度 ≥${Math.round(DUP_THRESHOLD * 100)}%）`);
          for (const x of scored.slice(0, 3)) {
            console.error(`   ${x.t.id}（${x.t.state}${x.t.ticket ? `，${x.t.ticket}` : ''}，${x.t.target ?? '—'}）「${x.t.title}」  相似度 ${Math.round(x.s * 100)}%`);
          }
          console.error('   要么接着做原票（comment / claim），要么加 --force-dup --dup-reason "为什么非开新单不可"（进审计）');
          process.exit(2);
        }
        if (!reason) {
          console.error('✗ --force-dup 必须带理由：--dup-reason "…"（进审计）；没有理由就是重复开单');
          process.exit(2);
        }
        dupForced = { top, reason, scored };
        console.error(`⚠ 强制重开（最相似 ${Math.round(top.s * 100)}%，原票 ${top.t.id}）：${reason}`);
      }
    }
    // UG-027：任务书骨架自动生成——工人只填内容，不再因为缺「回滚/做什么」被 gate 挡
    if (!isTest && !flag('no-template')) {
      const gen = writeTaskBookSkeleton({
        ticket, title,
        target: opt('target'), project: attr.project, feature: attr.feature
      });
      if (gen.ok) {
        const chk = validateTaskBook(ticket, { createdAt: Date.now() });
        console.log(`· 任务书骨架已生成：state\\tasks\\${ticket}.md（${gen.bytes} B）`);
        console.log(chk.ok
          ? `  五要素自检通过（gate ok；${chk.chars} 字，正文只有「待填」提示，不填也能过）`
          : `  ⚠ 模板自检未通过：缺 ${chk.missing.join('、')}——模板有问题，修 state\\tasks\\_自动模板.md`);
      } else if (gen.existing) {
        console.log(`· 任务书已存在，不覆盖：state\\tasks\\${ticket}.md`);
      } else {
        console.log(`  ⚠ 任务书骨架没生成：${gen.error}（不影响建单）`);
      }
    }
    const ev = addTask({
      title,
      target: isTest ? 'test' : opt('target'),
      ticket,
      project: attr.project,
      feature: attr.feature,
      kind: opt('kind', 'impl') ?? 'impl',   // UG-034：默认 impl → 没接口契约不许派（--kind plan|doc|ops 可豁免）
      ownerAsked: flag('owner-asked'),
      note: noteText(''),
      src: isTest ? 'fixture' : (opt('src', 'manual') ?? 'manual'),
      from: opt('from', '01') ?? '01',
      state: opt('state', 'queued') ?? 'queued'
    });
    console.log(`✓ 新增 ${ev.id} → ${ev.state}（${isTest ? '夹具隔离：target=test，默认列表不可见' : `工号 ${ev.target ?? '—'}`}${ev.ticket ? `，单号 ${ev.ticket}` : ''}）`);
    // UG-023：强制重开必须留痕（审计 + 票上一条 comment），否则事后没人知道为什么多了一张
    if (dupForced) {
      const by = opt('from', '01') ?? '01';
      const why = `强制重开（与 ${dupForced.top.t.id}「${dupForced.top.t.title}」相似度 ${Math.round(dupForced.top.s * 100)}%）：${dupForced.reason}`;
      writeAudit({
        t: Date.now(), op: 'add-dup-forced', via: 'state', by,
        id: ev.id, ticket: ev.ticket ?? null, title,
        dupOf: dupForced.top.t.id, dupTicket: dupForced.top.t.ticket ?? null,
        similarity: Number(dupForced.top.s.toFixed(3)), reason: dupForced.reason, ok: true
      });
      appendEvent({ id: ev.id, op: 'comment', from: by, body: why });
      console.log(`  已记审计：logs\\dispatch.jsonl（op=add-dup-forced）+ 票上一条 comment`);
    }
  } else if (cmd === 'dispatch') {
    // UG-033：不给票号时从项目栏取票（priority → 依赖域已清 → owner 空闲）；散票先拒再花钱
    const explicit = pos[0] ?? null;
    const ownerOpt = opt('owner', null) ?? opt('target', null);
    let id = explicit;
    let picked = null;
    if (!id) {
      if (!ownerOpt) {
        console.error('用法：dispatch <票号> [--dry-run] [--force] [--session-id <会话id>]');
        console.error('      dispatch --owner 04          # 从项目栏挑下一张该干的票（UG-033）');
        process.exit(2);
      }
      picked = pickNextByOwner(ownerOpt);
      if (!picked.ticket) {
        console.error(`✗ 项目栏里没有可派的票 [409 ${picked.reason}] owner=${ownerOpt}${picked.detail ? `｜${picked.detail}` : ''}`);
        process.exit(1);
      }
      id = picked.id;
      console.log(`○ 项目栏挑票：${picked.ticket}（${picked.project}/${picked.feature} · ${picked.priority}）`);
    }
    {
      const taskForGate = replay().find((t) => t.id === id);
      const ticketForGate = picked?.ticket ?? taskForGate?.ticket ?? '';
      // 无单号的票由 D37 闸在后面拦；有单号就必须在项目栏里（规则 §32 散单不派）
      if (String(ticketForGate).trim()) {
        const pj = assertInProject(ticketForGate);
        const bypass = flag('allow-out-of-project');
        if (!pj.ok && !bypass) {
          const detail = pj.code === 'feature-mismatch'
            ? `${id}（${pj.ticket}）台账归属 ${pj.ledger} 与项目栏 ${pj.projects} 不一致——先把项目栏贴对，别硬派`
            : `${id}（${pj.ticket}）在 state\\projects.json 里查不到（散票）——先贴项目表再派（规则 §32）；确需强派加 --allow-out-of-project（记审计）`;
          console.error(`✗ 派发失败 [409 ${pj.code}] ${detail}`);
          try { writeAudit({ t: Date.now(), op: 'dispatch-refused', by: opt('from', '01') ?? '01', id, ticket: ticketForGate, code: pj.code, ok: false, status: 409 }); } catch { /* ignore */ }
          process.exit(1);
        }
        if (!pj.ok && bypass) {
          try { writeAudit({ t: Date.now(), op: 'dispatch-refused', by: opt('from', '01') ?? '01', id, ticket: ticketForGate, code: pj.code, ok: false, status: 409, bypassed: true }); } catch { /* ignore */ }
          console.error(`⚠ 强派散票 ${pj.ticket}（--allow-out-of-project，已记审计）`);
        }
      }
    }
    const res = await dispatchTask(id, {
      by: opt('from', '01') ?? '01',
      dryRun: flag('dry-run'),
      force: flag('force'),
      sessionId: opt('session-id', null),   // UG-039 验收/排障口：显式指定会话，用来复现 accepted=false
      contractGate: !flag('no-contract-gate')   // UG-034：impl 类票没接口契约不派（--no-contract-gate 关闭）
    });
    if (!res.ok) {
      // UG-039：未送达 != 派发失败。票还在 queued，已排重试，退出码单独给 4
      if (res.code === 'not-delivered') {
        console.error(`✗ 未送达 [${res.code}] ${res.detail}`);
        console.error(`  ${id} 仍在 queued（没有假装已派）；未送达清单：node scripts\\worklist.mjs undelivered`);
        // 不在这里硬退：dsh-client 的 socket 还在收尾，process.exit 会让 libuv 断言崩（实测 0xC0000409）
        process.exitCode = 4;
      } else {
        console.error(`✗ 派发失败 [${res.status} ${res.code}] ${res.detail}`);
        process.exit(res.status === 429 ? 3 : 1);
      }
    } else if (res.code === 'dry-run') {
      console.log(`（dry-run，不花钱）prompt ${res.promptChars} 字：\n${res.prompt}`);
      // UG-007：dry-run 没真投，只把"派完会看到的那个数"预览一下
      console.log(`○ 投递未发生（dry-run）· 未回执清单：${unackedList().length} 张`);
    } else {
      console.log(`✓ ${id} 已派给工号 ${res.target}：accepted=true（${res.promptChars} 字）→ doing`);
      console.log('  审计：logs\\dispatch.jsonl');
      // UG-007：派完之后立刻告诉人「这一票还在等人回执」，以及当前一共几张
      const n = unackedList().length;
      console.log(`✓ 投递 accepted=true · 未回执清单：${n} 张（已送达、等它开工）`);
    }
  } else if (cmd === 'next') {
    // UG-033：只读——打印「下一张该干的票」，不派、不写台账
    const owner = opt('owner', null) ?? opt('by', null);
    if (!owner) { console.error('用法：next --owner 04 [--json]'); process.exit(2); }
    const r = pickNextByOwner(owner);
    if (flag('json')) console.log(JSON.stringify(r, null, 2));
    else if (r.ticket) {
      console.log(`下一张（工号 ${owner}）：${r.ticket}  ${r.priority}  ${r.project}/${r.feature}`);
      console.log(`  ${r.title ?? ''}`);
      console.log(`  台账 ${r.id}（${r.taskState}）｜${r.detail ?? ''}`);
    } else {
      console.log(`没有可派给工号 ${owner} 的票 [${r.reason}]${r.detail ? `｜${r.detail}` : ''}`);
    }
    process.exit(r.ticket ? 0 : 1);
  } else if (cmd === 'undelivered') {
    // UG-039：派了但没送到（accepted !== true），票还在 queued
    const rows = listUndelivered();
    if (flag('json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(rows.length ? 1 : 0); }
    if (!rows.length) { console.log('未送达：0 张（所有派发都确认送达了）'); process.exit(0); }
    console.log(`未送达 ${rows.length} 张（判据：sessions/prompt 没回 accepted=true；票仍在 queued）\n`);
    const pad = (s, n) => String(s ?? '').padEnd(n);
    console.log(`${pad('票号', 8)}${pad('单号', 9)}${pad('工号', 5)}${pad('次数', 5)}${pad('下次重试', 21)}${pad('状态', 10)}原因`);
    for (const r of rows) {
      const state = r.escalated ? '已放弃' : `${r.attempts}/${MAX_ATTEMPTS} 重试中`;
      console.log(`${pad(r.id, 8)}${pad(r.ticket ?? '—', 9)}${pad(r.target ?? '—', 5)}${pad(r.attempts, 5)}${pad(r.nextAtText ?? '—', 21)}${pad(state, 10)}${r.error ?? ''}`);
    }
    console.log(`\n再试一次：node scripts\\worklist.mjs retry    ｜  看板：GET /api/dispatch/status`);
    process.exit(1);
  } else if (cmd === 'retry') {
    // UG-039：跑一轮到期的重试（守护每 5 秒也会跑，这里给手工用）
    const due = await processDueRetries({ limit: Number(opt('limit', 5)) });
    if (!due.length) console.log('没有到期的重试（未送达清单里没有该重试的票）');
    else {
      for (const r of due) {
        console.log(r.delivered
          ? `✓ ${r.id} 重试送达 → doing（第 ${r.attempts} 次）`
          : `✗ ${r.id} 仍未送达（第 ${r.attempts} 次）：${r.lastError ?? ''}`);
      }
    }
    process.exit(due.some((r) => r.delivered) ? 0 : 0);
  } else if (cmd === 'accept') {
    const id = pos[0];
    if (!id) { console.error('用法：accept <票号> [--note "通过"]'); process.exit(2); }
    const note = noteText('验收通过');
    setState(id, 'done', { from: '01', note });
    console.log(`✓ ${id} → done（${note}）`);
    afterClose('01', `${id} 已 done`);
    noteDoneToProjects(id, 'accept');
    if (!flag('no-mistakes')) {
      // UG-036：票闭环了 → 该票最近一条返工记录标 resolved（错题本里去掉 ⚠）
      try {
        const t = replay().find((x) => x.id === id);
        const who = typeof by !== 'undefined' ? by : '01';
        const rr = resolveRework(String(t?.ticket ?? id), { by: who });
        if (rr.resolved) {
          console.log(`  错题本：${t?.ticket ?? id} 第 ${rr.attempt} 次返工已标 resolved（${rr.at}）`);
          const sy = syncMistakes({ only: t?.project ?? undefined });
          if (sy.wrote?.length) console.log(`  错题本已渲染：${sy.wrote.map((w) => w.file).join('、')}`);
        }
      } catch (e) { console.error(`  ⚠ 错题本 resolved 没写成：${e?.message ?? e}`); }
    }
  } else if (cmd === 'reject') {
    // UG-036：--reason 必填（返工分类，进统计）；--note 必填（打回原话，逐字进项目错题本）
    const id = pos[0];
    if (!id) {
      console.error('用法：reject <票号> --reason <' + REJECT_REASONS.join('|') + '> --note "打回原话" [--fix "怎么改"] [--evidence <证据指针>] [--no-mistakes]');
      process.exit(2);
    }
    const task = replay().find((t) => t.id === id);
    if (!task) { console.error(`✗ 没有任务 ${id}`); process.exit(1); }
    const noMistakes = flag('no-mistakes');
    const reason = opt('reason', null);
    if (!reason) {
      console.error(`✗ reject 必须带 --reason（返工分类）：${REJECT_REASONS.join(' / ')}`);
      console.error('  打回原话放 --note，会进 docs\\projects\\<项目>-错题本.md；真要跳过错题本加 --no-mistakes（--reason 仍必填）。');
      process.exit(2);
    }
    if (!REJECT_REASONS.includes(String(reason))) {
      console.error(`✗ --reason 只能是：${REJECT_REASONS.join(' / ')}`);
      process.exit(2);
    }
    const note = noteText('');
    if (!noMistakes && !String(note).trim()) {
      console.error('✗ reject 必须带 --note：错题本要存"打回原话"，不许摘要掉细节（如：--note "证据重复：两套关闭态是默认态拷贝"）');
      console.error('  确实不想记这一条，加 --no-mistakes（--reason 仍必填）。');
      process.exit(2);
    }
    // D58：reject 回 queued（不是 doing），重派交给自动接力；非 submitted 的一律作废
    const back = (task.state === 'submitted' || task.state === 'doing') ? 'queued' : 'dropped';
    setState(id, back, { from: '01', note, reason: String(reason) });
    if (back === 'dropped') afterClose('01', `${id} 被驳回归为 dropped`);
    if (!noMistakes) {
      const mr = recordRework(task, {
        reason: note, category: String(reason), by: opt('from', '01') ?? '01',
        evidence: opt('evidence', null), fix: opt('fix', null)
      });
      if (mr.ok) {
        console.log(`  错题本：${mr.record.project ?? '—'}/${mr.record.feature ?? '—'} 第 ${mr.attempt} 次返工（${mr.record.ticket}）→ state\\mistakes.jsonl`);
        try {
          const sy = syncMistakes({ only: mr.record.project ?? undefined });
          if (sy.wrote?.length) console.log(`  错题本已渲染：${sy.wrote.map((w) => w.file).join('、')}`);
        } catch (e) { console.error(`  ⚠ 错题本渲染失败：${e?.message ?? e}`); }
      } else {
        console.error(`  ⚠ 错题本没写成：${mr.error}`);
      }
    }
    let seq = null;
    if (back === 'queued' && task.target) {
      seq = mail(`${task.target}`, `【退回】${task.ticket ?? task.id}：${note}\n请按意见改完再交一次（${task.title}）`);
    }
    console.log(`✓ ${id} → ${back}（${note}）${seq ? `；已给工号 ${task.target} 落邮件 seq=${seq}` : ''}`);
  } else if (cmd === 'drop') {
    const id = pos[0];
    if (!id) { console.error('用法：drop <票号> --note "…"'); process.exit(2); }
    setState(id, 'dropped', { from: '01', note: noteText('不做了') });
    console.log(`✓ ${id} → dropped`);
    afterClose('01', `${id} 已 dropped`);
  } else if (cmd === 'pending') {
    const tasks = replay().filter((t) => t.state === 'inbox' || t.state === 'proposed');
    console.log(`待审 ${tasks.length} 条\n`);
    printTasks(tasks);
  } else if (cmd === 'claim') {
    // UG-018：工号自领（queued → doing）。**与 dispatch 共用同一道负载闸**（evaluateLoadGate），
    // 自领不再是绕过闸门的旁路（旧 06 就在 683,800 这么领走了票）。
    const id = pos[0];
    const by = String(opt('by', null) ?? opt('from', null) ?? '').trim();
    const force = flag('force');
    if (!id || !by) { console.error('用法：claim <票号> --by <工号> [--force]'); process.exit(2); }
    const norm = (x) => String(x ?? '').replace(/^0+(?=\d)/, '');
    const task = replay().find((t) => t.id === id);
    const audit = (rec) => {
      try { writeAudit({ t: Date.now(), op: 'claim', via: 'claim', by, id, ticket: task?.ticket ?? null, target: task?.target ?? null, ...rec }); } catch { /* 审计写不了不影响判定 */ }
    };
    const die = (status, code, detail) => {
      audit({ ok: false, status, code, forced: force });
      console.error(`✗ 领活失败 [${status} ${code}] ${detail}`);
      process.exit(1);
    };
    if (!task) die(404, 'no-task', `没有任务 ${id}`);
    if (norm(task.target) !== norm(by)) die(403, 'not-yours', `${id} 派给的是工号 ${task.target ?? '—'}，不是 ${by}`);
    if (task.state !== 'queued') die(409, 'not-queued', `${id} 当前是 ${task.state}，只有 queued 能自领`);
    if (task.blocked) die(409, 'blocked-by', `${id} 被前置挡着：${(task.blockedOn ?? []).join('、')}——前置 done/dropped 之前不许领`);
    // UG-031：优先窗口内，名单外的票不许自领（和 dispatch 同一道闸）
    {
      const prio = evaluatePriority(task.ticket, { tasks: replay() });
      if (!prio.ok) die(409, prio.code, `${prio.detail}${prio.fix ? `｜${prio.fix}` : ''}`);
    }
    const gate = await evaluateLoadGate(by, { force });
    if (!gate.ok) {
      audit({ ok: false, status: 409, code: gate.code, level: gate.level, pressure: gate.tokens, handoff: gate.handoff, forced: force });
      // 文案与 dispatch 完全一致：同一份 gate.detail
      console.error(`✗ 领活失败 [409 ${gate.code}] ${gate.detail}`);
      process.exit(1);
    }
    setState(id, 'doing', { from: by, note: `自领（负载闸 ${gate.level}${force ? '，--force' : ''}）` });
    audit({ ok: true, status: 200, code: force ? 'load-gate-force' : 'claimed', level: gate.level, pressure: gate.tokens, handoff: gate.handoff, forced: force, sessionId: gate.sessionId });
    console.log(`✓ ${id}（${task.ticket ?? '—'}）已自领 → doing｜负载闸 ${gate.level}${gate.tokens ? `（${Number(gate.tokens).toLocaleString('en-US')}）` : ''}${force ? '｜--force 已记审计（logs\\dispatch.jsonl code=load-gate-force）' : ''}`);
  } else if (cmd === 'state') {
    const [id, to] = pos;
    if (!id || !to) { console.error('用法：state <票号> <inbox|proposed|queued|doing|submitted|done|dropped> [--force]'); process.exit(2); }
    const by = opt('from', '01') ?? '01';
    // UG-018：进 doing 也是一次"领活"，同一道闸（`state` 曾是自领绕过闸的另一个口子）
    if (to === 'doing') {
      const task = replay().find((t) => t.id === id);
      const who = String(opt('by', null) ?? task?.target ?? by);
      const gate = await evaluateLoadGate(who, { force: flag('force') });
      if (!gate.ok) {
        try { writeAudit({ t: Date.now(), op: 'claim', via: 'state', by: who, id, ticket: task?.ticket ?? null, ok: false, status: 409, code: gate.code, level: gate.level, pressure: gate.tokens, handoff: gate.handoff, forced: flag('force') }); } catch { /* ignore */ }
        console.error(`✗ 改状态失败 [409 ${gate.code}] ${gate.detail}`);
        process.exit(1);
      }
      if (flag('force')) {
        try { writeAudit({ t: Date.now(), op: 'claim', via: 'state', by: who, id, ticket: task?.ticket ?? null, ok: true, status: 200, code: 'load-gate-force', level: gate.level, pressure: gate.tokens, handoff: gate.handoff, forced: true }); } catch { /* ignore */ }
      }
    }
    setState(id, to, { from: by, note: noteText('') });
    console.log(`✓ ${id} → ${to}`);
    // UG-084「交付即通知」：交活成功后台账多一行，01 读队列即可，不再 Start-Sleep 轮询。
    // 顺序是硬的——**先落状态，再写队列**；队列失败只警告，绝不把已成功的 state 变成失败。
    if (to === 'submitted') {
      try {
        const t = replay().find((x) => x.id === id);
        const rawNote = noteText('');
        const q = enqueueDelivery({
          ticket: t?.ticket ?? id,
          id,
          by: t?.target ?? by,
          delivery: opt('delivery', null) ?? deliveryPathOf(rawNote),
          note: rawNote,
        });
        if (q.ok) console.log(`  已入交付队列：${q.row.ticket}（${QUEUE_FILE.replace(/^.*?state/, 'state')}）`);
        else console.warn(`  ⚠ 交付队列没写成（不影响状态）：${q.error}`);
      } catch (e) {
        console.warn(`  ⚠ 交付队列没写成（不影响状态）：${e?.message ?? e}`);
      }
    }
    if (to === 'done' || to === 'dropped') afterClose(by, `${id} 已 ${to}`);
    if (to === 'done') {
        noteDoneToProjects(id, 'state');
      if (!flag('no-mistakes')) {
        // UG-036：票闭环了 → 该票最近一条返工记录标 resolved（错题本里去掉 ⚠）
        try {
          const t = replay().find((x) => x.id === id);
          const who = typeof by !== 'undefined' ? by : '01';
          const rr = resolveRework(String(t?.ticket ?? id), { by: who });
          if (rr.resolved) {
            console.log(`  错题本：${t?.ticket ?? id} 第 ${rr.attempt} 次返工已标 resolved（${rr.at}）`);
            const sy = syncMistakes({ only: t?.project ?? undefined });
            if (sy.wrote?.length) console.log(`  错题本已渲染：${sy.wrote.map((w) => w.file).join('、')}`);
          }
        } catch (e) { console.error(`  ⚠ 错题本 resolved 没写成：${e?.message ?? e}`); }
      }
    }
  } else if (cmd === 'queue') {
    // UG-084：交付队列。01 只读这里、一次取一张；队列空就退出（不常驻、不轮询）。
    const takeId = opt('take', null);
    const limit = Number(opt('limit', '10')) || 10;
    if (takeId) {
      const r = takeEntry(takeId, { by: opt('from', '01') ?? '01' });
      if (!r.ok) {
        if (r.code === 'not-found') { console.error(`✗ ${r.detail}`); process.exit(1); }
        console.error(`✗ 取走失败：${r.detail}`);
        process.exit(1);
      }
      const e = r.entry;
      if (r.alreadyTaken) {
        console.log(`· ${e.ticket} 已被取走（${e.takenAt ? new Date(Number(e.takenAt)).toLocaleString('zh-CN', { hour12: false }) : '早先'}${e.takenBy ? ` by ${e.takenBy}` : ''}）`);
        if (flag('json')) console.log(JSON.stringify({ ticket: e.ticket, alreadyTaken: true, entry: e }, null, 2));
        process.exit(0);
      }
      console.log(`✓ 已取：${e.ticket}（${e.id ?? '—'}，by=${e.by ?? '—'}）`);
      console.log(`  交付：${e.delivery || '（备注里没有现成路径，去 records\\交付 找）'}`);
      if (e.note) console.log(`  备注：${e.note}`);
      if (flag('json')) console.log(JSON.stringify({ ticket: e.ticket, alreadyTaken: false, entry: e }, null, 2));
      process.exit(0);
    }
    const list = pendingEntries({ limit });
    if (flag('json')) { console.log(JSON.stringify({ pending: list.length, entries: list }, null, 2)); process.exit(0); }
    if (!list.length) { console.log('交付队列：空（没有待收的票）'); process.exit(0); }
    console.log(`交付队列：未取 ${list.length} 条（按到达顺序，--take <票号> 取一张）`);
    for (const [i, e] of list.entries()) {
      const when = e.t ? new Date(Number(e.t)).toLocaleTimeString('zh-CN', { hour12: false }) : '??';
      console.log(`  ${i + 1}. ${when}  ${String(e.ticket).padEnd(8)} ${String(e.id ?? '—').padEnd(7)} by=${String(e.by ?? '—').padEnd(3)} ${e.delivery || '（无路径）'}`);
      if (e.note && e.note !== e.delivery) console.log(`       备注：${e.note.slice(0, 100)}`);
    }
  } else if (cmd === 'priority') {
    // UG-031：只读——打印优先窗口状态（与 GET /api/priority 同源）
    const st = priorityState();
    if (flag('json')) { console.log(JSON.stringify(st, null, 2)); process.exit(0); }
    if (st.error) { console.error(`✗ 优先名单图有问题 [${st.error.code}] ${st.error.detail}`); }
    console.log(`优先窗口：${st.active ? '开' : '关'}（${st.reason}）${st.title ? `｜${st.title}` : ''}`);
    if (st.expanded.length) console.log(`  名单 ${st.counts.total} 张：完 ${st.counts.done}／弃 ${st.counts.dropped}／未完成 ${st.counts.open}${st.counts.missing ? `／查无 ${st.counts.missing}` : ''}`);
    if (st.unknown?.length) console.log(`  ⚠ 展开不到：${st.unknown.join('、')}`);
    if (st.ready.length) console.log(`  可派叶子：${st.ready.join('、')}`);
    if (st.blocked.length) for (const b of st.blocked) console.log(`  被前置挡着：${b.ticket} 缺 ${b.missing.join('、')}`);
    process.exit(st.error ? 1 : 0);
  } else if (cmd === 'ack') {
  } else if (cmd === 'ack') {
    // UG-007：记一次「对方回执了」（accepted 事件）。只追加事实，不改状态；记完就不在未回执清单里
    const id = pos[0];
    if (!id) { console.error('用法：ack <票号> [--by 06] [--note "开工了"]'); process.exit(2); }
    const by = opt('by', null) ?? opt('from', '01') ?? '01';
    try {
      ackDispatch(id, { from: by, note: noteText('') });
      console.log(`✓ ${id} 回执已记（accepted by ${by}）· 不在未回执清单里了 · 当前未回执 ${unackedList().length} 张`);
    } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
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
    // UG-011：依赖链（B --on A：A 不做完，B 不许派）；--on 支持逗号一次挂多条
    const id = pos[0];
    const by = opt('by', '01') || '01';
    const on = opt('on');
    const off = opt('off');
    if (!id || (!on && !off)) { console.error('用法：dep <票号> --on <前置票号[,票号…]> ｜ dep <票号> --off <前置票号[,票号…]>'); process.exit(2); }
    const splitIds = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (off) {
      for (const o of splitIds(off)) removeDependency(id, o, { from: by });
      console.log('✓ ' + id + ' 摘掉前置 ' + splitIds(off).join('、'));
    } else {
      const added = [];
      for (const o of splitIds(on)) {
        try {
          addDependency(id, o, { from: by, note: noteText('') });
          added.push(o);
        } catch (e) {
          console.error(`✗ ${e.message}`);
          if (added.length) console.error(`   已写入的：${added.join('、')}（其余没写）`);
          process.exit(1);
        }
      }
      const t = replay().find((x) => x.id === id) ?? {};
      console.log(`✓ ${id} 依赖 ${added.join('、')}`);
      console.log(t.blocked
        ? `  挡着：${(t.blockedOn ?? []).join('、')}（未 done/dropped 前 dispatch 会被 409 blocked-by 拒）`
        : '  前置已全部闭环，现在就能派');
    }
  } else if (cmd === 'unblock-sweep') {
    // UG-011：手动巡检一次自动解锁（平时由 accept/drop/state 与 workdesk 巡检触发）；只写事件 + 发解锁信
    const by = opt('by', 'unblock-sweep') || 'unblock-sweep';
    const evs = afterClose(by, noteText(''));
    console.log(evs.length ? `✓ 解锁 ${evs.length} 张：${evs.map((e) => e.id).join('、')}` : '（没有待解锁的票）');
  } else if (cmd === 'approve-feature' || cmd === 'approve-project') {
    // D67：签收事件（不改票状态，只记"这块过了"）；--revoke 撤销并留痕
    const project = opt('project', null);
    const feature = opt('feature', null);
    const isFeature = cmd === 'approve-feature';
    const revoke = flag('revoke');
    const note = noteText('');
    const by = opt('by', '01') ?? '01';
    if (!project) { console.error(`用法：${cmd} --project <id>${isFeature ? ' --feature <id>' : ''} --note "验收结论" [--revoke]`); process.exit(2); }
    if (isFeature && !feature) { console.error('用法：approve-feature --project <id> --feature <id> --note "…"'); process.exit(2); }
    try {
      if (isFeature) {
        const ev = revoke
          ? revokeFeature(project, feature, { from: by, note })
          : approveFeature(project, feature, { from: by, note });
        console.log(ev?.op === 'noop' ? `= ${project}/${feature} 已签收且结论未变（幂等，无变化）` : (revoke ? `✓ ${project}/${feature} 已撤销签收（留痕）` : `✓ ${project}/${feature} 已签收（by ${by}）`));
      } else {
        const ev = revoke
          ? revokeProject(project, { from: by, note })
          : approveProject(project, { from: by, note });
        console.log(revoke ? `✓ 项目 ${project} 已撤销签收（留痕）` : `✓ 项目 ${project} 已签收（by ${by}）`);
        void ev;
      }
    } catch (error) {
      console.error(`✗ ${error?.message ?? error}`);
      process.exit(1);
    }
  } else if (cmd === 'next') {
    // D73：按四级规则给出「下一该派谁」
    const worker = opt('worker', null);
    const rows = rankForDispatch(null, { worker });
    if (flag('json')) { console.log(JSON.stringify({ worker: worker ?? 'any', rows }, null, 2)); process.exit(0); }
    if (!rows.length) { console.log(`（没有可派的票${worker ? `（工号 ${worker}）` : ''}）`); process.exit(0); }
    console.log(`下一该派（${worker ? `工号 ${worker}` : '不限工号'}）：`);
    for (const r of rows) {
      const tag = r.rank === 1 ? 'P0' : (r.rank === 2 ? '②等它' : (r.rank === 3 ? '③返工' : '④FIFO'));
      console.log(`  ${String(r.position).padStart(2)}. ${pad(r.id, 8)}${pad(tag, 8)}${pad(r.ticket ?? '—', 8)}工号 ${pad(r.target ?? '—', 3)}｜${r.why}`);
      console.log(`      ${String(r.title).slice(0, 60)}`);
    }  } else if (cmd === 'comment') {
    // D62：补证据通道——只追加一条 comment，不改状态（done 的票也能补）
    const id = pos[0];
    if (!id) { console.error('用法：comment <票号> --body "…" ｜ --body-file <路径>'); process.exit(2); }
    let body = opt('body', null);
    const bodyFile = opt('body-file');
    if (bodyFile) {
      try { body = fs.readFileSync(bodyFile, 'utf8'); } catch (e) { console.error(`✗ 读不到 --body-file：${bodyFile}`); process.exit(2); }
    }
    if (!body) { console.error('用法：comment <票号> --body "…" ｜ --body-file <路径>'); process.exit(2); }
    const by = opt('by', '01') ?? '01';
    const ev = commentTask(id, { body, from: by });
    console.log(`✓ ${id} 已追加 comment（${String(ev.body).length} 字，by ${by}；状态不变）`);  } else if (cmd === 'plan-submit' || cmd === 'plan-review' || cmd === 'plan-approve' || cmd === 'plan-reject' || cmd === 'plan-list' || cmd === 'plan-manual') {
    // D28：方案审核状态机。全部免费（只写台账 + 邮件池），不调 DSH。
    const MANUAL_QUEUE = 'E:\\DSH_workspace\\state\\plan-manual-queue.jsonl';
    const pushManual = (taskId, note, by) => {
      try {
        fs.mkdirSync('E:\\DSH_workspace\\state', { recursive: true });
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
      addDependency(id, on, { from: by, note: noteText('') });
      console.log('✓ ' + id + ' 依赖 ' + on + '（前置没 done/dropped 就不许派）');
    }  } else if (cmd === 'plan-submit') {
      const id = pos[0];
      if (!id) { console.error('用法：plan-submit <票号> [--type 方案|实现|修复|文档] [--by 04] [--note "…"]'); process.exit(2); }
      const ev = submitPlan(id, { type: opt('type', '方案') ?? '方案', from: opt('by', null), note: noteText('') });
      console.log(`✓ ${id} 方案已提交 → 待审（type=${ev.type}，by ${ev.from}）`);
    } else if (cmd === 'plan-review') {
      const id = pos[0];
      const state = opt('state');
      if (!id || !state) { console.error('用法：plan-review <票号> --state 01审中|转05|待人工 [--by 01] [--note "…"]'); process.exit(2); }
      const by = opt('by', '01') ?? '01';
      const ev = reviewPlan(id, { state, by, note: noteText('') });
      if (state === '待人工') pushManual(id, noteText('转人工待审'), by);
      console.log(`✓ ${id} 方案态 → ${ev.planState}（by ${by}）`);
    } else if (cmd === 'plan-approve') {
      const id = pos[0];
      if (!id) { console.error('用法：plan-approve <票号> [--by 01] [--note "…"]'); process.exit(2); }
      const by = opt('by', '01') ?? '01';
      const r = approvePlan(id, { by, note: noteText('') });
      console.log(`✓ ${id} 方案通过（by ${by}）→ 派生 ${r.implId} 进 queued`);
      if (r.derived) console.log(`   ${r.implId}：${r.derived.title}`);
      const seq = mail(String(replay().find((t) => t.id === id)?.target ?? '01'), `【方案通过】${id} 已通过，派生实现单 ${r.implId}（queued）。`);
      if (seq) console.log(`   已给工号落邮件 seq=${seq}`);
    } else if (cmd === 'plan-reject') {
      const id = pos[0];
      if (!id) { console.error('用法：plan-reject <票号> --note "缺X" [--by 01]'); process.exit(2); }
      const by = opt('by', '01') ?? '01';
      const note = noteText('缺说明');
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
    console.error('用法：list [--detail W-xxx] | add | dispatch | claim | accept | reject | drop | comment | pending | state | show | turns | dep | unblock-sweep | plan-submit | plan-review | plan-approve | plan-reject | plan-list | plan-manual');
    process.exit(2);
  }
} catch (error) {
  console.error(`✗ ${error?.message ?? error}`);
  process.exit(1);
}
