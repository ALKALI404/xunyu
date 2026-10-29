// scripts/dispatch-core.mjs —— 派发（D12：全系统**唯一**花钱的动作），以及配额/审计。
//
// 规矩（工单 D12 §三、§七）：
//   · 只允许「任务 state=queued **且** 目标 running=false」；在跑的工号一律拒绝；
//   · 只发**一次** session/prompt，内容固定三段：票号 / 一句话目标 / 交付要求；
//   · 成功 → queued→doing；失败/超时 → 状态不变（别把任务做成「已派其实没派」）；
//   · 配额 20/日（state\workdesk.config.json），超了 429；**每次尝试都写 logs\dispatch.jsonl**。
//
// CLI 与 workdesk 服务共用这一份，避免两套派发逻辑。

import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE, replay, setState } from './worklist-core.mjs';

const DSH_CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
const DSH_BASE_MOD = 'file:///E:/DSH_workspace/scripts/dsh-base.mjs';

export const CONFIG_FILE = path.join(WORKSPACE, 'state', 'workdesk.config.json');
export const DISPATCH_LOG = path.join(WORKSPACE, 'logs', 'dispatch.jsonl');

const DEFAULT_CONFIG = {
  dispatchPerDay: 20,
  preemptPerDay: 5,              // v2 才会用
  preemptEnabled: false,
  scanIntervalMs: 10000,         // §四.1：10 秒扫一次交付目录
  note: 'D12 v1 配额与开关；preemptEnabled 保留给 v2'
};

export function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { ...DEFAULT_CONFIG, ...cfg };
  } catch {
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    } catch { /* 写不了就用默认值 */ }
    return { ...DEFAULT_CONFIG };
  }
}
export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

const pad2 = (n) => String(n).padStart(2, '0');
export function dayStr(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function stamp8(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

export function readAudit() {
  try {
    return fs.readFileSync(DISPATCH_LOG, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
export function writeAudit(rec) {
  fs.mkdirSync(path.dirname(DISPATCH_LOG), { recursive: true });
  fs.appendFileSync(DISPATCH_LOG, `${JSON.stringify(rec)}\n`, 'utf8');
  return rec;
}
/** 今日已用配额（只数成功的）。 */
export function quotaUsed(op = 'dispatch') {
  const today = dayStr();
  return readAudit().filter((r) => r.op === op && r.ok === true && dayStr(r.t) === today).length;
}

/** 交付要求那一段（固定文本，别每次不一样）。 */
export function deliveryDemand(agent, ticket) {
  const file = `records\\交付\\${agent}-${stamp8()}-${ticket || 'TBD'}.md`;
  return `交付：${file}，四段式（做到哪 / 改了什么 / 怎么验的 / 卡在哪），完成后把路径报 01。`;
}

// ── D31：派单前置校验（任务书四要素）────────────────────────────────────────
// 为什么要有：只发一句标题就派单，目标工号拿不到上下文，做出来的东西和派单意图对不上。
// 规矩：派单前必须能在 state\tasks\ 找到「单号」对应的任务书，且书里四要素齐全；
//       缺任一项 → 409 undefined-task，**不派**。
const TASKS_DIR = '<工作区>\\state\\tasks';
const BOOK_ELEMENTS = [
  { key: '做什么', re: /做什么|要做什么|目标|任务书|需求|要什么|一、\s*要/ },
  { key: '验收', re: /验收|什么算过|通过标准/ },
  { key: '边界', re: /边界|不做|不碰|范围|限制/ },
  { key: '回滚', re: /回滚|rollback|备份|恢复|还原/i }
];

/** 找任务书：state\tasks\ 下文件名以单号开头（`<单号>.md` 或 `<单号>-…`）。 */
export function findTaskBook(ticket) {
  const key = String(ticket ?? '').trim();
  if (!key) return null;
  let files = [];
  try { files = fs.readdirSync(TASKS_DIR).filter((f) => f.toLowerCase().endsWith('.md')); } catch { return null; }
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}([-_.].*)?\\.md$`, 'i');
  const hits = files.filter((f) => re.test(f));
  if (!hits.length) return null;
  // 精确同名优先，其次最短（D31.md > D31-xx-long.md）
  hits.sort((a, b) => a.length - b.length);
  return path.join(TASKS_DIR, hits[0]);
}

/** 校验任务书四要素。返回 {ok, path, missing[], chars}。 */
export function validateTaskBook(ticket) {
  const file = findTaskBook(ticket);
  if (!file) return { ok: false, path: null, missing: BOOK_ELEMENTS.map((x) => x.key), chars: 0, reason: 'not-found' };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return { ok: false, path: file, missing: BOOK_ELEMENTS.map((x) => x.key), chars: 0, reason: 'unreadable' }; }
  const missing = BOOK_ELEMENTS.filter((el) => !el.re.test(text)).map((el) => el.key);
  return { ok: missing.length === 0, path: file, missing, chars: text.length, reason: missing.length ? 'missing-elements' : 'ok' };
}

/** 三段式 prompt：票号 / 一句话目标 / 交付要求（D31 起再加任务书路径与 note 全文）。 */
export function buildDispatchPrompt(task, book = null) {
  const ticket = task.ticket || task.id;
  const goal = String(task.title ?? '').trim();
  // 回放里 task.note 不一定有值（add 的备注落在 notes[] 里），两处都认，保证「要求」段一定带原文
  const requirement = String(task.note ?? '').trim()
    || String((task.notes ?? []).find((n) => n && n.note && !/^前置 |^交付 |^delivery:/.test(n.note))?.note ?? '').trim();
  const lines = [
    `【派单 ${ticket}${ticket === task.id ? '' : ` · ${task.id}`}】${goal}`,
    book?.ok ? `任务书：${book.path}（已校验四要素：做什么/验收/边界/回滚）` : '',
    requirement ? `要求：${requirement}` : '',
    deliveryDemand(task.target, ticket)
  ].filter(Boolean);
  return lines.join('\n');
}

/** 找工号对应的会话（标题里带「工号NN」；多个取最近有动静的）。 */
export function pickAgent(sessions, target) {
  const re = new RegExp(`工号\\s*0*${Number(target)}\\b`);
  const hits = sessions.filter((s) => !s.blank && re.test(String(s.projections?.values?.title ?? '')));
  if (!hits.length) return null;
  return hits.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0];
}

export async function dshApi() {
  const [{ NodeApiClient, unwrap }, { resolveDshBase }] = await Promise.all([import(DSH_CLIENT), import(DSH_BASE_MOD)]);
  const { url, source } = resolveDshBase();
  const api = new NodeApiClient(url, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });
  return { api, unwrap, url, source };
}

async function listSessions(api, unwrap) {
  const res = await Promise.race([
    api.sessions.list({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('sessions/list 超时')), 3000))
  ]);
  return unwrap(res, 'session.list').items ?? [];
}

/**
 * 派发一条任务。**这是唯一会花钱的函数。**
 * @returns {Promise<{ok:boolean, status:number, code:string, detail:string, task?:object, agent?:object, promptChars?:number}>}
 */
export async function dispatch(taskId, { by = '01', dryRun = false } = {}) {
  const t0 = Date.now();
  const tasks = replay();
  const task = tasks.find((x) => x.id === taskId);
  const fail = (status, code, detail) => {
    const rec = writeAudit({ t: t0, op: 'dispatch', by, id: taskId, ticket: task?.ticket ?? null, target: task?.target ?? null, ok: false, status, code, detail, ms: Date.now() - t0 });
    return { ok: false, status, code, detail, audit: rec };
  };

  if (!task) return fail(404, 'no-task', `没有任务 ${taskId}`);
  // ② 状态必须是 queued（submitted/done/dropped/doing 都不许重派）
  if (task.state !== 'queued') return fail(409, 'not-queued', `${taskId} 当前是 ${task.state}，只有 queued 能派`);
  // ②b 依赖链：前置没完成就一律不派（D30 的「只做派发闸」）
  if (task.blocked) {
    return fail(409, 'blocked', `${taskId} 被前置任务挡着：${(task.blockedOn ?? []).join('、')} 还没完成`);
  }
  if (!task.target) return fail(400, 'no-target', `${taskId} 没有目标工号`);
  // ③ 任务书校验（D31）：没有书、或书里缺四要素 → 不派，别让人凭一句标题瞎做
  const book = validateTaskBook(task.ticket || task.id);
  if (!book.ok) {
    const why = book.reason === 'not-found'
      ? `state\\tasks\\ 下找不到「${task.ticket || task.id}」的任务书`
      : `任务书 ${path.basename(book.path)} 缺要素：${book.missing.join('、')}`;
    return fail(409, 'undefined-task', `${taskId} 没有合格的任务书（${why}）`);
  }
  if (dryRun) {
    const prompt = buildDispatchPrompt(task, book);
    return { ok: true, status: 200, code: 'dry-run', detail: '只算不派', promptChars: prompt.length, prompt, book };
  }

  const cfg = readConfig();
  const used = quotaUsed('dispatch');
  if (used >= Number(cfg.dispatchPerDay)) {
    return fail(429, 'quota-exceeded', `今日配额 ${used}/${cfg.dispatchPerDay} 已用完`);
  }

  let api;
  let unwrap;
  let sessions;
  try {
    ({ api, unwrap } = await dshApi());
    sessions = await listSessions(api, unwrap);
  } catch (error) {
    return fail(502, 'dsh-unreachable', `读会话投影失败：${String(error?.message ?? error).slice(0, 120)}`);
  }

  const session = pickAgent(sessions, task.target);
  if (!session) return fail(404, 'no-agent', `没有工号 ${task.target} 的会话`);
  if (session.running === true) {
    return fail(409, 'target-busy', `工号 ${task.target} 正在跑（${String(session.projections?.values?.workingActivity?.line ?? '').slice(0, 60)}），不硬塞`);
  }

  const prompt = buildDispatchPrompt(task, book);
  const promptChars = prompt.length;
  const startedAt = Date.now();
  try {
    await api.sessions.prompt({ sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
  } catch (error) {
    return fail(502, 'prompt-failed', `session/prompt 失败：${String(error?.message ?? error).slice(0, 160)}`);
  }
  // 只有 prompt 成功才改状态（失败/超时状态不变）
  const ev = setState(taskId, 'doing', { from: by, note: `已派给工号 ${task.target}（prompt ${promptChars} 字）` });
  const rec = writeAudit({
    t: startedAt, op: 'dispatch', by, id: taskId, ticket: task.ticket ?? null, target: task.target,
    sessionId: String(session.sessionId), promptChars, ok: true, status: 200, code: 'dispatched',
    detail: 'session/prompt 已投（mode=queue）', ms: Date.now() - startedAt
  });
  return { ok: true, status: 200, code: 'dispatched', detail: '已投一次 session/prompt', taskId, target: task.target, promptChars, event: ev, audit: rec };
}
