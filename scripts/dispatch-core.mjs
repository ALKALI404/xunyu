import { readJson } from './json-io.mjs';
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
import { rankForDispatch as rankTasks, dependentsOf as coreDependents } from './worklist-core.mjs';
import { budgetGate, budgetAct } from './budget-gate.mjs';   // UG-026：日预算闸（锁着就不许派）
import { WORKSPACE, replay, setState, appendEvent } from './worklist-core.mjs';
import { checkTicket as prCheckTicket } from './pr-reconcile.mjs';   // UG-068：台账↔项目栏对账闸

const DSH_CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
const DSH_BASE_MOD = 'file:///E:/DSH_workspace/scripts/dsh-base.mjs';

export const CONFIG_FILE = path.join(WORKSPACE, 'state', 'workdesk.config.json');
export const DISPATCH_LOG = path.join(WORKSPACE, 'logs', 'dispatch.jsonl');

// ── UG-039：派发送达确认 ────────────────────────────────────────────────────
// 病根：以前只要 sessions/prompt 没抛异常就置 doing——DSH 可以回 accepted:false（或整条 RPC 失败），
// 票却已经在台账里"已派"，于是空转。契约见 docs\升级\派发送达契约-UG-039.md。
export const DELIVERY_FAILURES = path.join(WORKSPACE, 'state', 'delivery-failures.jsonl');
export const DELIVERY_RETRY = path.join(WORKSPACE, 'state', 'delivery-retry.json');
export const MISTAKES_LOG = path.join(WORKSPACE, 'state', 'mistakes.jsonl');
export const DEFAULT_BACKOFF_MS = [1000, 5000, 30000, 120000, 300000];   // 1s / 5s / 30s / 2min / 5min
export const MAX_ATTEMPTS = 5;

/** 回滚开关：DELIVERY_CONFIRM=0 → 退回"投了就算"（默认开）。 */
export function deliveryConfirmEnabled() {
  return String(process.env.DELIVERY_CONFIRM ?? '1').trim() !== '0';
}

/** 退避表（验收时可用 DELIVERY_BACKOFF_MS=1000,5000,30000 覆盖；生产别改）。 */
export function backoffPlan() {
  const raw = String(process.env.DELIVERY_BACKOFF_MS ?? '').trim();
  if (!raw) return DEFAULT_BACKOFF_MS;
  const arr = raw.split(',').map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return arr.length ? arr : DEFAULT_BACKOFF_MS;
}

function readRetryStore() {
  try {
    const j = readJson(DELIVERY_RETRY);
    if (j && typeof j.tickets === 'object' && j.tickets) return j;
  } catch { /* 没有就是空表 */ }
  return { version: 1, tickets: {} };
}

function writeRetryStore(store) {
  fs.mkdirSync(path.dirname(DELIVERY_RETRY), { recursive: true });
  fs.writeFileSync(DELIVERY_RETRY, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function appendJsonl(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch { /* 记不下来也不能让派发崩 */ }
}

/** 一次失败 = 一行 delivery-failures.jsonl。 */
function recordFailure({ ticket, target, attempt, code, error }) {
  const rec = { ts: Date.now(), ticket: ticket ?? null, target: target ?? null, attempt: Number(attempt ?? 0), code: String(code ?? 'unknown'), error: String(error ?? '').slice(0, 300) };
  appendJsonl(DELIVERY_FAILURES, rec);
  return rec;
}

/** 连续 5 次失败 → 错题本（state\mistakes.jsonl）。 */
function recordMistake({ task, attempt, code, error }) {
  const rec = {
    ts: new Date().toISOString(), kind: 'delivery-failed',
    project: task.project ?? null, feature: task.feature ?? null,
    ticket: task.ticket ?? task.id, taskId: task.id, target: task.target ?? null,
    attempt, code, error: String(error ?? '').slice(0, 300),
    reason: `派发连续 ${attempt} 次未被接受（${code}）：工人根本没收到 prompt，票一直留在 queued`,
    evidence: 'state\\delivery-failures.jsonl + logs\\dispatch.jsonl',
    fix: '换正确会话 id / 确认目标会话没归档，再 node scripts\\worklist.mjs retry',
    resolved: false
  };
  appendJsonl(MISTAKES_LOG, rec);
  return rec;
}

/** 记一次失败并排下一次重试；返回累计次数。 */
function bumpRetry(task, { code, error }) {
  const store = readRetryStore();
  const key = task.id;
  const prev = store.tickets[key] ?? { ticket: task.ticket ?? null, target: task.target ?? null, attempts: 0, firstAt: Date.now() };
  const attempts = Number(prev.attempts ?? 0) + 1;
  const backoff = backoffPlan();
  // attempts=1（首次）失败 → 等 backoff[0]；attempts=n → 等 backoff[n-1]（超过表长就取最后一个）
  const waitMs = attempts <= MAX_ATTEMPTS ? backoff[Math.min(attempts - 1, backoff.length - 1)] : 0;
  const escalated = attempts >= MAX_ATTEMPTS;
  store.tickets[key] = {
    id: key, ticket: task.ticket ?? null, target: task.target ?? null,
    attempts, firstAt: Number(prev.firstAt ?? Date.now()), updatedAt: Date.now(),
    nextAt: escalated ? 0 : Date.now() + waitMs, lastError: String(error ?? '').slice(0, 300),
    lastCode: String(code ?? 'unknown'), escalated
  };
  writeRetryStore(store);
  recordFailure({ ticket: task.ticket ?? task.id, target: task.target, attempt: attempts, code, error });
  if (escalated) recordMistake({ task, attempt: attempts, code, error });
  return attempts;
}

/** 从重试表里摘掉（送达了）。 */
export function clearRetry(taskId) {
  const store = readRetryStore();
  if (!store.tickets[taskId]) return false;
  delete store.tickets[taskId];
  writeRetryStore(store);
  return true;
}

/** 未送达清单（含还在重试的；escalated=true 表示已放弃）。 */
export function listUndelivered() {
  const store = readRetryStore();
  return Object.values(store.tickets ?? {})
    .map((t) => ({
      id: t.id, ticket: t.ticket ?? null, target: t.target ?? null,
      attempts: Number(t.attempts ?? 0), error: t.lastError ?? null, code: t.lastCode ?? null,
      nextAt: Number(t.nextAt ?? 0), nextAtText: Number(t.nextAt ?? 0) ? new Date(Number(t.nextAt)).toLocaleString('zh-CN', { hour12: false }) : null,
      escalated: Boolean(t.escalated), firstAt: Number(t.firstAt ?? 0)
    }))
    .sort((a, b) => Number(a.firstAt ?? 0) - Number(b.firstAt ?? 0));
}

/** 看板口径：{delivered, undelivered[], retrying[]}。 */
export function deliveryStatus() {
  const rows = listUndelivered();
  let delivered = 0;
  try { delivered = replay().filter((t) => Boolean(t.deliveredAt) && t.state !== 'dropped').length; } catch { delivered = 0; }
  return {
    delivered,
    undelivered: rows,
    retrying: rows.filter((r) => !r.escalated && r.attempts < MAX_ATTEMPTS)
  };
}

/**
 * 投一次 prompt 并**判定送达**（唯一判据：result.ok === true 且 value.accepted === true）。
 * 只发一次，不做状态变更——状态变更由调用方在 delivered===true 时做。
 */
export async function attemptPrompt({ sessionId, prompt, api = null }) {
  const t0 = Date.now();
  let client = api;
  if (!client) {
    try { ({ api: client } = await dshApi()); }
    catch (error) { return { delivered: false, code: 'dsh-unreachable', error: String(error?.message ?? error).slice(0, 200), ms: Date.now() - t0 }; }
  }
  let res;
  try {
    res = await client.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
  } catch (error) {
    return { delivered: false, code: 'rpc-throw', error: String(error?.message ?? error).slice(0, 200), ms: Date.now() - t0 };
  }
  const result = res?.result ?? res ?? {};
  if (result.ok !== true) {
    const err = result.error ?? {};
    return { delivered: false, code: 'rpc-error', error: `${err.code ?? 'unknown'}: ${err.message ?? 'result.ok=false'}`.slice(0, 200), ms: Date.now() - t0, result };
  }
  const value = result.value ?? {};
  if (value.accepted === true) return { delivered: true, code: 'accepted', error: null, ms: Date.now() - t0, result };
  return {
    delivered: false, code: 'rejected',
    error: `accepted=${String(value.accepted)}${value.reason ? ` reason=${String(value.reason).slice(0, 80)}` : ''}`.slice(0, 200),
    ms: Date.now() - t0, result
  };
}

const DEFAULT_CONFIG = {
  dispatchPerDay: 20,
  preemptPerDay: 5,              // v2 才会用
  preemptEnabled: false,
  scanIntervalMs: 10000,         // §四.1：10 秒扫一次交付目录
  note: 'D12 v1 配额与开关；preemptEnabled 保留给 v2'
};

/** D80：读演练开关（state\drill.json）。过期或次数用完即视为没开。 */
export function readDrill() {
  try {
    const j = readJson(path.join(WORKSPACE, 'state', 'drill.json'));
    if (!j || !j.ticket) return null;
    if (Number(j.until ?? 0) && Date.now() > Number(j.until)) return null;   // 自动解除
    if (Number(j.left ?? 0) <= 0) return null;
    return j;
  } catch { return null; }
}

/** D80：消费一次演练次数。只有 ticket 匹配才扣（其他票不受影响）。 */
export function consumeDrill(ticket) {
  const j = readDrill();
  if (!j) return null;
  if (String(j.ticket).toUpperCase() !== String(ticket).toUpperCase()) return null;
  j.count = Number(j.count ?? 0) + 1;
  j.left = Math.max(0, Number(j.left ?? 0) - 1);
  try {
    fs.writeFileSync(path.join(WORKSPACE, 'state', 'drill.json'), JSON.stringify(j, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
  return { used: j.count, times: Number(j.times ?? 0), left: j.left, until: Number(j.until ?? 0) };
}

// ── D92 负载闸（B3）─────────────────────────────────────────────────────────
// 数据源与 check-context-budget.mjs 一致：直接用 sessions.list 的 projections.contextPressure，
// 不再另写一套口径。阈值来自 state\context-budget.json 的 rules[].title 匹配（与那个脚本同规则）。
const BUDGET_FILE = path.join(WORKSPACE, 'state', 'context-budget.json');
const SIM_FILE = path.join(WORKSPACE, 'state', 'context-sim.json');   // 测试用：{ "04": 690000 }，仅 XUNYU_GATE_SIM=1 时生效

function budgetThresholds(title) {
  try {
    const doc = readJson(BUDGET_FILE);
    for (const r of (doc.rules ?? [])) {
      if (r?.title && String(title ?? '').includes(String(r.title))) {
        return { warn: Number(r.warn ?? 800000), handoff: Number(r.handoff ?? 950000) };
      }
    }
    const d = doc.default ?? {};
    return { warn: Number(d.warn ?? 800000), handoff: Number(d.handoff ?? 950000) };
  } catch {
    return { warn: 800000, handoff: 950000 };
  }
}

/** 取某工号当前上下文占用（与 contextPressure 同源；找不到会话返回 null）。 */
export function pressureOf(session, agentNo) {
  let tokens = Number(session?.projections?.values?.contextPressure?.pressureTokens ?? 0);
  if (process.env.XUNYU_GATE_SIM === '1') {
    try {
      const sim = readJson(SIM_FILE);
      const key = String(agentNo ?? '').replace(/^0+/, '');
      if (sim && sim[key] != null) tokens = Number(sim[key]);
      else if (sim && sim[String(agentNo)] != null) tokens = Number(sim[String(agentNo)]);
    } catch { /* 没有模拟文件就不模拟 */ }
  }
  return tokens;
}

/**
 * 负载闸：≥ handoff−50000 → 拒派（先换代）；≥ 90%·handoff → 只允许 force。
 * 环境变量 XUNYU_GATE=off 可整闸旁路（回滚开关）。
 */
export function loadGate({ agentNo, title, tokens, force = false }) {
  if (String(process.env.XUNYU_GATE ?? '').toLowerCase() === 'off') return { ok: true, skipped: 'gate-off' };
  if (!Number.isFinite(Number(tokens)) || Number(tokens) <= 0) {
    // 参考实现（refs/luanyujia/负载闸.mjs）的原则：**量不了 ≠ 可以派**（那边是 exit 3，不是 0）。
    // 我们这里读不到 pressureTokens 同样按"别派"处理，但要能 --force 放行（人判断目标其实空闲）。
    if (force) return { ok: true, level: 'unknown-forced', tokens: null, handoff: null, detail: '压力读不到，按 --force 放行（审计留痕）' };
    return { ok: false, code: 'load-unknown', level: 'unknown', tokens: null, handoff: null,
      detail: '读不到目标工号的上下文占用（contextPressure 缺失）：按"量不了≠可派"处理，先确认会话投影或加 --force' };
  }
  const th = budgetThresholds(title);
  const hardLine = th.handoff - 50000;
  const highLine = Math.round(th.handoff * 0.9);
  if (tokens >= hardLine) {
    return {
      ok: false, code: 'load-gate', level: 'handoff', tokens, handoff: th.handoff, hardLine,
      detail: `工号 ${agentNo} 上下文 ${tokens.toLocaleString('en-US')} ≥ 换代线−5万（${th.handoff.toLocaleString('en-US')}−50,000=${hardLine.toLocaleString('en-US')}）：先换代再派（handoff.mjs prepare/new）`
    };
  }
  if (tokens >= highLine && !force) {
    return {
      ok: false, code: 'load-gate', level: 'high', tokens, handoff: th.handoff, highLine,
      detail: `工号 ${agentNo} 上下文 ${tokens.toLocaleString('en-US')} ≥ 90%（${highLine.toLocaleString('en-US')}）：只允许 --force 派，且会记审计`
    };
  }
  return { ok: true, level: tokens >= highLine ? 'high-forced' : 'normal', tokens, handoff: th.handoff, highLine };
}

/**
 * UG-018：**唯一入口**的负载闸判定——给定工号，自己去找会话、量压力、过闸。
 * dispatch 和 claim（工号自领）都调这个函数，阈值只有 loadGate 里那一份，不许各写一套。
 * @param {string} agentNo 目标工号（'04' / 4 都行）
 * @param {{force?:boolean, session?:object}} opts  session 可传入已有会话对象，省一次 sessions/list
 * @returns {Promise<{ok:boolean, code?:string, level?:string, tokens:number|null, handoff:number|null, detail?:string, sessionId:string|null, title:string}>}
 */
export async function evaluateLoadGate(agentNo, { force = false, session = null } = {}) {
  let sess = session;
  let sessionsError = null;
  if (!sess) {
    try {
      const { api, unwrap } = await dshApi();
      const items = await listSessions(api, unwrap);
      sess = pickAgent(items, agentNo);
    } catch (error) {
      sessionsError = String(error?.message ?? error).slice(0, 120);
    }
  }
  const title = String(sess?.projections?.values?.title ?? '');
  const tokens = sess ? pressureOf(sess, agentNo) : 0;
  const gate = loadGate({ agentNo, title, tokens, force });
  const sessionId = sess?.sessionId ? String(sess.sessionId) : null;
  if (!sess && sessionsError && gate.ok) {
    // 连会话都读不到就不许放行（"量不了≠可领"），除非显式 force（loadGate 已按 unknown-forced 放行）
    return { ...gate, ok: false, code: gate.code ?? 'load-unknown', sessionId: null, title, detail: `读不到工号 ${agentNo} 的会话（sessions/list：${sessionsError}）：先确认会话在不在` };
  }
  return { ...gate, sessionId, title };
}

export function readConfig() {  try {
    const cfg = readJson(CONFIG_FILE);
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

/** 交付要求那一段（固定文本，别每次不一样）。UG-014：交付回执统一叫「五段式」。 */
export function deliveryDemand(agent, ticket) {
  const file = `records\\交付\\${agent}-${stamp8()}-${ticket || 'TBD'}.md`;
  return `交付：${file}，五段式（结论 / 证据 / 改了什么 / 落点 / 风险与没做的），完成后把路径报 01。`;
}

// ── D31 / UG-014：派单前置校验（任务书「五要素」）─────────────────────────────
// 为什么要有：只发一句标题就派单，目标工号拿不到上下文，做出来的东西和派单意图对不上。
// 术语（UG-014 定死，见规则「术语表」）：
//   任务书 = 五要素（做什么 / 预期结果 / 可验方式 / 边界 / 回滚）
//   派单消息 = 四件套（现象 / 依据 / 怎么验 / 回一句）
//   交付回执 = 五段式（结论 / 证据 / 改了什么 / 落点 / 风险与没做的）
// 兼容存量：UG-014（2026-10-29 20:00）之前建的单按老四要素（做什么/验收/边界/回滚）过，**不追溯**。
const TASKS_DIR = 'E:\\DSH_workspace\\state\\tasks';
/** 五要素生效时刻：台账 createdAt 早于它的任务按老四要素校验（= UG-014 落盘这一刻，之前建的全是存量）。 */
export const FIVE_ELEMENTS_SINCE = Date.parse('2026-10-29T19:58:00+08:00');
const BOOK_ELEMENTS_V2 = [
  { key: '做什么', re: /做什么|要做什么|目标|任务书|需求|要什么|一、\s*要/ },
  { key: '预期结果', re: /预期结果|期望结果|做成什么样|完成标准|交付什么样|成功的样子/ },
  { key: '可验方式', re: /可验方式|怎么验|验证方式|验证方法|什么算过|通过标准|验收/ },
  { key: '边界', re: /边界|不做|不碰|范围|限制/ },
  { key: '回滚', re: /回滚|rollback|备份|恢复|还原/i }
];
/** 老四要素：只给存量单用，新单不许再照着写（"验收"一项放宽到也认"可验方式/怎么验"，让新式任务书在存量口径下也能过）。 */
const BOOK_ELEMENTS_V1 = [
  { key: '做什么', re: /做什么|要做什么|目标|任务书|需求|要什么|一、\s*要/ },
  { key: '验收', re: /验收|什么算过|通过标准|可验方式|怎么验|验证方式/ },
  { key: '边界', re: /边界|不做|不碰|范围|限制/ },
  { key: '回滚', re: /回滚|rollback|备份|恢复|还原/i }
];

// ═══ UG-031 派发 v2：优先名单 + 解锁树 ═══════════════════════════════════
// 规则文档：docs\规则-派发v2-优先名单与解锁树.md（2026-10-30 02:55 主人定）
//
// 契约（dispatch / claim / autoRelay 三处共用，也是 GET /api/priority 的数据源）：
//   priorityState({ tasks?, file? }) -> {
//     active:boolean,                  // 窗口是否生效（名单非空且还有未完成票）
//     reason:'no-file'|'bad-json'|'inactive-flag'|'empty'|'empty-after-expand'|'all-closed'|'active'|'error',
//     title, raw:[...原样条目], expanded:[单号(大写)], unknown:[展开不到的条目],
//     ready:[可派叶子单号], blocked:[{ticket, missing:[依赖单号]}],
//     counts:{total,done,dropped,open,missing},
//     error:null|{code:'priority-cycle'|'priority-dangling', detail}
//   }
//   evaluatePriority(ticket, { tasks?, file? }) -> { ok, priority:boolean|null, window, code?, detail?, fix? }
//     · 窗口没开 → ok:true, priority:null（完全走旧规则）
//     · 窗口开着 → 名单内 ok:true / priority:true；名单外 ok:false code='out-of-priority'
//     · 名单图坏了（成环/悬空依赖）→ ok:false code='priority-cycle'|'priority-dangling'，**全部停止派发**
//   数据：state\priority-list.json（条目支持 单号 / project:xxx / feature:xxx）
//   测试口：XUNYU_PRIORITY_FILE 可指向别的名单文件（不污染真名单）
const PRIORITY_FILE = path.join(WORKSPACE, 'state', 'priority-list.json');

export function priorityFilePath() {
  return process.env.XUNYU_PRIORITY_FILE || PRIORITY_FILE;
}

function readProjectsDocForPriority() {
  try { return readJson(path.join(WORKSPACE, 'state', 'projects.json')); } catch { return null; }
}

/** 把名单条目展开成单号集合：单号 / project:xxx / feature:xxx */
function expandPriorityList(raw, doc) {
  const set = new Set();
  const unknown = [];
  for (const item of raw) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    const low = s.toLowerCase();
    if (low.startsWith('project:')) {
      const id = s.slice(8).trim().toLowerCase();
      const p = (doc?.projects ?? []).find((x) => String(x.id).toLowerCase() === id);
      if (!p) { unknown.push(s); continue; }
      for (const f of p.features ?? []) for (const t of f.tickets ?? []) set.add(String(t).trim().toUpperCase());
    } else if (low.startsWith('feature:')) {
      const id = s.slice(8).trim().toLowerCase();
      let hit = false;
      for (const p of doc?.projects ?? []) {
        for (const f of p.features ?? []) {
          if (String(f.id).toLowerCase() !== id) continue;
          hit = true;
          for (const t of f.tickets ?? []) set.add(String(t).trim().toUpperCase());
        }
      }
      if (!hit) unknown.push(s);
    } else {
      set.add(s.toUpperCase());
    }
  }
  return { set, unknown };
}

const PRIORITY_STATE_ORDER = ['doing', 'submitted', 'queued', 'done', 'dropped'];

/** 名单 + 台账 → 窗口状态（只读，不写任何文件） */
export function priorityState({ tasks = null, file = null } = {}) {
  const f = file ?? priorityFilePath();
  const fileExists = fs.existsSync(f);
  const base = {
    active: false, reason: 'no-file', title: null, file,
    raw: [], expanded: [], unknown: [], ready: [], blocked: [],
    counts: { total: 0, done: 0, dropped: 0, open: 0, missing: 0 }, error: null
  };
  if (!fileExists) return base;
  let doc;
  try { doc = readJson(f); }
  catch (e) { return { ...base, reason: 'bad-json', error: { code: 'priority-bad-json', detail: `${f} 解析失败：${e?.message ?? e}` } }; }

  const raw = Array.isArray(doc.tickets) ? doc.tickets.map(String) : [];
  const titled = doc.title ?? doc.reason ?? null;
  if (doc.active === false) return { ...base, reason: 'inactive-flag', title: titled, raw };
  if (!raw.length) return { ...base, reason: 'empty', title: titled, raw };

  const { set, unknown } = expandPriorityList(raw, readProjectsDocForPriority());
  if (!set.size) return { ...base, reason: 'empty-after-expand', title: titled, raw, unknown };

  const all = tasks ?? replay();
  const byTicket = new Map();
  const byId = new Map();
  for (const t of all) {
    byId.set(String(t.id), t);
    const k = String(t.ticket ?? '').trim().toUpperCase();
    if (!k) continue;
    if (!byTicket.has(k)) byTicket.set(k, []);
    byTicket.get(k).push(t);
  }
  const stateOf = (tk) => {
    const arr = byTicket.get(String(tk).trim().toUpperCase()) ?? [];
    if (!arr.length) return 'missing';
    const s = new Set(arr.map((x) => x.state));
    for (const o of PRIORITY_STATE_ORDER) if (s.has(o)) return o;
    return 'unknown';
  };

  let done = 0; let dropped = 0; let open = 0; let missing = 0;
  for (const tk of set) {
    const st = stateOf(tk);
    if (st === 'done') done += 1;
    else if (st === 'dropped') dropped += 1;
    else if (st === 'missing') missing += 1;
    else open += 1;
  }
  const counts = { total: set.size, done, dropped, open, missing };

  // 依赖图体检：成环 / 悬空（只在名单里未完成的票上起步，足够且不误伤名单外）
  const cyc = [];
  const dangling = [];
  const color = new Map();
  const visit = (id, path) => {
    const c = color.get(id) ?? 0;
    if (c === 1) { cyc.push(`${[...path, id].join(' → ')}`); return; }
    if (c === 2) return;
    color.set(id, 1);
    const t = byId.get(id);
    if (!t) { color.set(id, 2); return; }
    for (const dep of (t.blockedBy ?? [])) {
      const did = String(dep);
      if (!byId.has(did)) { dangling.push(`${t.ticket ?? id} 依赖 ${did}（台账里没有）`); continue; }
      if (byId.get(did)?.state === 'dropped') { dangling.push(`${t.ticket ?? id} 依赖 ${byId.get(did)?.ticket ?? did}（已作废）`); continue; }
      visit(did, [...path, id]);
    }
    color.set(id, 2);
  };
  for (const tk of set) {
    const st = stateOf(tk);
    if (st === 'done' || st === 'dropped' || st === 'missing') continue;
    for (const row of byTicket.get(tk) ?? []) visit(String(row.id), []);
  }
  if (cyc.length || dangling.length) {
    return {
      ...base, active: true, reason: 'error', title: titled, raw, expanded: [...set], unknown, counts,
      error: cyc.length
        ? { code: 'priority-cycle', detail: `优先名单里依赖成环：${cyc.slice(0, 3).join('；')}` }
        : { code: 'priority-dangling', detail: `优先名单里有悬空依赖：${dangling.slice(0, 3).join('；')}` }
    };
  }
  if (open === 0 && missing === 0) return { ...base, active: false, reason: 'all-closed', title: titled, raw, expanded: [...set], unknown, counts };

  const ready = [];
  const blocked = [];
  for (const tk of set) {
    const st = stateOf(tk);
    if (st === 'done' || st === 'dropped' || st === 'missing') continue;
    const rows = byTicket.get(tk) ?? [];
    const free = rows.find((x) => x.state === 'queued' && !x.blocked);
    if (free) { ready.push(tk); continue; }
    const bl = rows.find((x) => x.state === 'queued' && x.blocked);
    if (bl) {
      blocked.push({
        ticket: tk,
        missing: (bl.blockedOn ?? []).map((id) => byId.get(String(id))?.ticket ?? String(id))
      });
    }
  }
  ready.sort();
  return { ...base, active: true, reason: 'active', title: titled, raw, expanded: [...set], unknown, ready, blocked, counts };
}

/** 三处拦截共用的判定：这张票现在能不能派/能不能领 */
export function evaluatePriority(ticket, { tasks = null, file = null } = {}) {
  const win = priorityState({ tasks, file });
  const tk = String(ticket ?? '').trim().toUpperCase();
  if (win.error) {
    return {
      ok: false, priority: null, window: win, code: win.error.code,
      detail: `优先名单图有问题，全部停止派发：${win.error.detail}`,
      fix: '修 state\\priority-list.json 或台账依赖（成环/指向不存在的前置），再派'
    };
  }
  if (!win.active) return { ok: true, priority: null, window: win };
  if (!tk || !win.expanded.includes(tk)) {
    const sample = win.expanded.slice(0, 5).join('、');
    return {
      ok: false, priority: true, window: win, code: 'out-of-priority',
      detail: `${tk || '(无单号)'} 不在优先名单（${win.expanded.length} 张：${sample}${win.expanded.length > 5 ? ' …' : ''}）——优先窗口开着，名单外一律不派`,
      fix: '要么把这张票加进 state\\priority-list.json，要么等名单内全部完成（窗口会自动回落）'
    };
  }
  return { ok: true, priority: true, window: win };
}

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

/**
 * 校验任务书要素（UG-014：新单五要素 / 存量单四要素）。
 * 返回 {ok, path, missing[], chars, reason, elements}。
 * @param {string} ticket 单号
 * @param {{createdAt?: number}} [opts] createdAt 早于 FIVE_ELEMENTS_SINCE → 按老四要素（兼容存量，不追溯）
 */
export function validateTaskBook(ticket, { createdAt } = {}) {
  const legacy = Number.isFinite(Number(createdAt)) && Number(createdAt) > 0 && Number(createdAt) < FIVE_ELEMENTS_SINCE;
  const expected = legacy ? BOOK_ELEMENTS_V1 : BOOK_ELEMENTS_V2;
  const elements = legacy ? '四要素（存量任务书）' : '五要素';
  const file = findTaskBook(ticket);
  if (!file) return { ok: false, path: null, missing: expected.map((x) => x.key), chars: 0, reason: 'not-found', elements };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return { ok: false, path: file, missing: expected.map((x) => x.key), chars: 0, reason: 'unreadable', elements }; }
  const missing = expected.filter((el) => !el.re.test(text)).map((el) => el.key);
  return { ok: missing.length === 0, path: file, missing, chars: text.length, reason: missing.length ? 'missing-elements' : 'ok', elements };
}

// ═══ UG-034 接口优先闸门：impl 类票"没接口不派" ═════════════════════════════
// 契约：checkContractGate(task) -> { ok:true, contract, project, feature, book }
//                                | { ok:false, code, detail, fix }
//   code: 'no-contract-section'（任务书没 `## 接口契约`）
//         'no-contract-field'（项目栏 feature.contract 空，或票没贴进项目栏）
//         'no-projects'（projects.json 读不到）
// 关闭：dispatch(id, { contractGate:false })｜CLI `--no-contract-gate`
// 不装进 dispatchOne：重试的是"已经过了这道闸的票"，不重复卡。
const PROJECTS_JSON = path.join(WORKSPACE, 'state', 'projects.json');

function readProjectsForGate() {
  try { return readJson(PROJECTS_JSON); } catch { return null; }
}

/** 定位 feature：先按 (project, feature)，再按单号在 tickets[] 里找（两处都认，票贴哪都能核到） */
export function findProjectFeature(doc, task) {
  if (!doc || !Array.isArray(doc.projects)) return null;
  if (task.project && task.feature) {
    const p = doc.projects.find((x) => String(x.id) === String(task.project));
    const f = (p?.features ?? []).find((x) => String(x.id) === String(task.feature));
    if (f) return { project: p, feature: f };
  }
  const tk = String(task.ticket ?? '').trim().toUpperCase();
  if (!tk) return null;
  for (const p of doc.projects) {
    for (const f of p.features ?? []) {
      if ((f.tickets ?? []).some((x) => String(x).trim().toUpperCase() === tk)) return { project: p, feature: f };
    }
  }
  return null;
}

/** 接口契约闸：任务书要有 `## 接口契约`，项目栏要有 contract（验收：①） */
export function checkContractGate(task) {
  const bookPath = findTaskBook(task.ticket || task.id);
  if (!bookPath) {
    return {
      ok: false, code: 'no-contract-section',
      detail: `找不到任务书（${task.ticket || task.id}），没法核接口契约`,
      fix: '先写任务书，并在里面加 `## 接口契约`（输入/输出 schema 或函数签名或 HTTP 路由）'
    };
  }
  let text = '';
  try { text = fs.readFileSync(bookPath, 'utf8').replace(/^\uFEFF/, ''); } catch { text = ''; }
  const hasSection = /^#{2,4}\s*接口契约/m.test(text);
  if (!hasSection) {
    return {
      ok: false, code: 'no-contract-section',
      detail: `任务书 ${path.basename(bookPath)} 里没有「## 接口契约」小节`,
      fix: '在任务书里补 `## 接口契约`：写清输入/输出 schema，或函数签名，或 HTTP 路由'
    };
  }
  // 标题在 ≠ 写了接口：把该小节正文抽出来，去掉「（待填：…）」占位后至少要有 15 字有效内容
  const secStart = text.search(/^#{2,4}\s*接口契约/m);
  let secBody = '';
  if (secStart >= 0) {
    const rest = text.slice(secStart);
    const afterHead = rest.indexOf('\n');
    const bodyText = afterHead >= 0 ? rest.slice(afterHead + 1) : '';
    const nextHead = bodyText.search(/^#{2,4}\s/m);
    secBody = nextHead >= 0 ? bodyText.slice(0, nextHead) : bodyText;
  }
  // 占位是「（待填：…）」括号块，可能跨行——按括号进出把它整段剔掉，否则第二行会冒充"有效内容"
  const realLines = (() => {
    const out = [];
    let inPlaceholder = false;
    for (const raw of secBody.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      if (inPlaceholder) { if (l.includes('）')) inPlaceholder = false; continue; }
      if (l.includes('（待填')) { if (!l.includes('）')) inPlaceholder = true; continue; }
      out.push(l);
    }
    return out;
  })();
  if (realLines.join('').length < 15) {
    return {
      ok: false, code: 'no-contract-section',
      detail: `任务书 ${path.basename(bookPath)} 的「## 接口契约」还是空的/只有占位（有效内容 ${realLines.join('').length} 字）`,
      fix: '把接口契约写实：输入/输出 schema、函数签名、或 HTTP 路由（代码块/表都行，至少 15 字有效内容）；接口真不动就明写「接口未变」'
    };
  }
  const doc = readProjectsForGate();
  if (!doc) {
    return { ok: false, code: 'no-projects', detail: 'state\\projects.json 读不到，无法核对 feature.contract', fix: '确认项目栏文件可读（05 维护），或先贴项目表' };
  }
  const hit = findProjectFeature(doc, task);
  if (!hit) {
    return {
      ok: false, code: 'no-contract-field',
      detail: `${task.ticket || task.id} 在项目栏里查不到所属 feature（project/feature=${task.project ?? '—'}/${task.feature ?? '—'}）`,
      fix: '先把它贴进项目栏（feature.tickets 里加单号，并写 contract），再派'
    };
  }
  const contract = String(hit.feature.contract ?? '').trim();
  if (!contract) {
    return {
      ok: false, code: 'no-contract-field',
      detail: `项目栏 ${hit.project.id}/${hit.feature.id} 的 contract 是空的`,
      fix: `给 ${hit.project.id}/${hit.feature.id} 补 contract（形如 auto.exe.* / workdesk.api.*）`
    };
  }
  return { ok: true, contract, project: hit.project.id, feature: hit.feature.id, book: path.basename(bookPath) };
}

/**
 * 三段式 prompt：票号 / 任务书路径 / 交付要求（D12+D31 的原口径）。
 *
 * UG-041（2026-10-30）：**瘦身到 ≤600 字符**。主人原话「现在派发任务的上下文为什么这么长，以前那种简单的呢」。
 * 以前为什么长：①这里把 note 全文塞进「要求：」那段（note 动辄上千字）；②relay04 把任务书正文
 * `book.slice(0, 6000)` 内嵌进 prompt。两处叠加，一条派单 1–3k 字符，白烧 token。
 * 现在：note 只留首 60 字当提示，全文在任务书里——**prompt 只负责「喊人起来 + 告诉他看哪」**。
 * 回滚：`PROMPT_TEMPLATE=long` 恢复旧行为（note 全文、不截断）。
 */
export const PROMPT_MAX = 600;
export const PROMPT_OVERFLOW_MARK = '…（详见任务书）';

/** 超长截断：保留头部到 max（给 overflow 标记留位置），返回是否截断与原始长度。 */
export function clampPrompt(s, max = PROMPT_MAX) {
  const text = String(s ?? '');
  if (text.length <= max) return { text, truncated: false, originalLen: text.length };
  const keep = Math.max(0, max - PROMPT_OVERFLOW_MARK.length);
  return { text: text.slice(0, keep) + PROMPT_OVERFLOW_MARK, truncated: true, originalLen: text.length };
}

export function buildDispatchPrompt(task, book = null) {
  const ticket = task.ticket || task.id;
  const goal = String(task.title ?? '').trim();
  // 回放里 task.note 不一定有值（add 的备注落在 notes[] 里），两处都认
  const requirement = String(task.note ?? '').trim()
    || String((task.notes ?? []).find((n) => n && n.note && !/^前置 |^交付 |^delivery:/.test(n.note))?.note ?? '').trim();

  const long = String(process.env.PROMPT_TEMPLATE ?? '').toLowerCase() === 'long';
  if (long) {
    // 回滚口径：旧版长 prompt（不截断、note 全文）
    return [
      `【派单 ${ticket}${ticket === task.id ? '' : ` · ${task.id}`}】${goal}`,
      book?.ok ? `任务书：${book.path}（已校验${book.elements ?? '五要素'}：${(book.elements ?? '').includes('四要素') ? '做什么/验收/边界/回滚（存量单）' : '做什么/预期结果/可验方式/边界/回滚'}）` : '',
      requirement ? `要求：${requirement}` : '',
      deliveryDemand(task.target, ticket)
    ].filter(Boolean).join('\n');
  }

  const noteBrief = requirement
    ? (requirement.length > 60 ? `${requirement.slice(0, 60)}…` : requirement)
    : '';
  const lines = [
    `【派单 ${ticket}】${goal.slice(0, 40)}`,
    book?.ok ? `任务书：${book.path}` : '',
    noteBrief ? `要求：${noteBrief}` : '',
    deliveryDemand(task.target, ticket)
  ].filter(Boolean);
  return clampPrompt(lines.join('\n'), PROMPT_MAX).text;
}

// ── UG-072：找工号对应的会话时，排除"已归档"的会话 ─────────────────────────
// 背景（01 建单，UG-071 根因）：05 有两条同名会话——在役的 e7cd1559（81,287）与已归档的
// 9fff8142（724,230），老实现只做「!blank + 标题正则 + updatedAt 降序取第一条」，
// 两条 updatedAt 撞在同一秒，排序取到的是已归档那条 → 看门狗拿 724,230 算 load-gate
// → 误判 409 并开出误换代票。
// 现在的选择顺序：① 名册 active 精确匹配（且该 id 不在归档集合里）→ ② 标题正则 **过滤归档**
// → ③ updatedAt 更晚优先。函数签名不变（前两个参数照旧），第三个是给测试用的可选注入。
export const ARCHIVED_SESSIONS_FILE = path.join(
  process.env.USERPROFILE ?? 'C:\\Users\\Xuchi', '.dsh', 'storages', 'workspace.json'
);
export const ROSTER_FILE = path.join(WORKSPACE, 'state', 'roster.json');
const GUARD_TTL_MS = 5000;
let _guardCache = { at: 0, archived: null, active: null };

/** 读归档集合 + 名册 active 映射（只读；5 秒缓存，别每次派单都读 300 条 JSON）。 */
export function readSessionGuards({ ttl = GUARD_TTL_MS, archivedFile = ARCHIVED_SESSIONS_FILE, rosterFile = ROSTER_FILE } = {}) {
  const now = Date.now();
  if (_guardCache.at && now - _guardCache.at < ttl && _guardCache.archived && _guardCache.active) return _guardCache;
  let archived = new Set();
  const active = new Map();
  try {
    const w = readJson(archivedFile);
    const list = w?.global?.archivedSessionIds ?? w?.archivedSessionIds ?? [];
    if (Array.isArray(list)) archived = new Set(list.map((x) => String(x)));
  } catch { /* 读不到就当没归档（退回老行为，不阻塞派单） */ }
  try {
    const r = readJson(rosterFile);
    const act = Array.isArray(r?.active) ? r.active : Object.values(r?.active ?? {});
    for (const x of act) if (x?.id && x?.sessionId) active.set(String(x.id), String(x.sessionId));
  } catch { /* 同上 */ }
  _guardCache = { at: now, archived, active };
  return _guardCache;
}

/**
 * 找工号对应的会话：①名册 active 优先（且未归档）②标题正则且不含归档 ③最晚动过的。
 * @param {Array} sessions DSH sessions.list 的 items
 * @param {string|number} target 工号（00/05/…；'本' 走名册匹配）
 * @param {{archived?:Set<string>, active?:Map<string,string>}} [opts] 测试注入用
 */
export function pickAgent(sessions, target, opts = {}) {
  let archived = opts.archived;
  let active = opts.active;
  if (!archived || !active) {
    const g = readSessionGuards();
    archived = archived ?? g.archived;
    active = active ?? g.active;
  }
  const items = (sessions ?? []).filter((s) => !s.blank);

  // ① 名册说谁在役就用谁——但名册自己也可能过期，指向一条已归档的会话时不认
  const want = active?.get(String(target));
  if (want && !archived.has(want)) {
    const hit = items.find((s) => String(s.sessionId) === want);
    if (hit) return hit;
  }

  // ② 兜底：标题里带「工号 NN」，**必须**排除归档集合（UG-072 判据②卡的就是这一句）
  const re = new RegExp(`工号\\s*0*${Number(target)}\\b`);
  const hits = items.filter((s) => re.test(String(s.projections?.values?.title ?? ''))
    && !archived.has(String(s.sessionId)));
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
export async function dispatch(taskId, { by = '01', dryRun = false, force = false, sessionId: sessionIdOverride = null, contractGate = true } = {}) {
  const t0 = Date.now();
  const tasks = replay();
  const task = tasks.find((x) => x.id === taskId);
  const SKIP_LOG = path.join(WORKSPACE, 'state', 'dispatch-skipped.jsonl');
  const skipRecord = (rec) => {
    try {
      fs.mkdirSync(path.dirname(SKIP_LOG), { recursive: true });
      fs.appendFileSync(SKIP_LOG, JSON.stringify(rec) + '\n', 'utf8');
    } catch { /* ignore */ }
  };
  let prioFlag = null;   // UG-031：这次派发是否落在优先窗口内（写进审计）
  const fail = (status, code, detail, extra = {}) => {
    const rec = writeAudit({ t: t0, op: 'dispatch', by, id: taskId, ticket: task?.ticket ?? null, target: task?.target ?? null, ok: false, status, code, detail, priority: prioFlag, ...extra, ms: Date.now() - t0 });
    return { ok: false, status, code, detail, audit: rec };
  };

  if (!task) return fail(404, 'no-task', `没有任务 ${taskId}`);
  // UG-031：优先窗口判定（dispatch / claim / autoRelay 共用同一个函数）
  const prio = evaluatePriority(task?.ticket, { tasks });
  prioFlag = prio.priority;


  // D80 演练注入：命中的票在「派发阶段」强制失败（不真派），次数用完/超时自动失效
  const drillHit = consumeDrill(String(task.ticket ?? ''));
  if (drillHit) {
    writeAudit({ t: t0, op: 'drill', by, id: taskId, ticket: task.ticket ?? null, target: task.target ?? null, ok: false, code: 'drill-fail', detail: `演练：第 ${drillHit.used}/${drillHit.times} 次强制失败（剩 ${drillHit.left}）`, ms: 0 });
    return fail(409, 'drill-fail', `演练中：${task.ticket} 被强制失败第 ${drillHit.used}/${drillHit.times} 次（剩 ${drillHit.left} 次；${new Date(drillHit.until).toLocaleTimeString('zh-CN', { hour12: false })} 自动解除）`);
  }

  // ①b D37 守卫：没有单号的任务不许派（先补号再派）
  if (!String(task.ticket ?? '').trim()) {
    return fail(409, 'no-ticket', `${taskId} 没有单号（ticket 为空）：先补号再派（看清单：node scripts\\worklist-migrate-tickets.mjs）`);
  }

  // ②b' UG-068：台账 ↔ 项目栏对账闸（**按这张票判**，PR_RECONCILE=0 关）。
  // 放在优先窗口之前：对账是"数据对不对"的问题，跟名单窗口无关——对不上就先修，别让它换个 409 名字继续挡人。
  if (String(process.env.PR_RECONCILE ?? '1').trim() !== '0') {
    const pr = prCheckTicket(task.ticket || task.id);
    if (!pr.ok) {
      return fail(409, 'pr-mismatch', `${taskId}（${task.ticket}）台账与项目栏对不上 [${pr.kind}]：${pr.detail}`);
    }
  }

  // ②c UG-031 优先窗口：窗口开着时名单外一律不派；名单图坏了（成环/悬空）全停
  if (!prio.ok) {
    return fail(409, prio.code, `${prio.detail}${prio.fix ? `｜怎么解决：${prio.fix}` : ''}`, { priority: prio.priority });
  }
  // ②d UG-026 日预算闸：到 hard 阈值自动锁，锁着就不许派（BUDGET_ENFORCE=0 可关）
  {
    // 到阈值时自己上锁：不依赖"谁去记得跑一下脚本"
    const bg = budgetAct({ quiet: true }).gate;
    if (bg.locked) {
      return fail(409, 'budget-locked', `今日已花 ¥${bg.spent.toFixed(2)}（soft ¥${bg.soft} / hard ¥${bg.hard}）：日预算闸已锁，停派——${bg.lock?.reason ?? bg.reason}｜要放行：node scripts\\budget-unlock.mjs --reason "为什么还能花"`, { budget: { spent: bg.spent, soft: bg.soft, hard: bg.hard } });
    }
  }

  // D58 守卫：一个工号同时只该有 1 张 doing（一人一双手）；要叠单必须显式 force
  if (!force && task.target) {
    const others = replay().filter((t) => t.state === 'doing' && String(t.target) === String(task.target) && t.id !== task.id);
    if (others.length) {
      const ids = others.map((t) => `${t.id}(${t.ticket ?? '—'})`).join('、');
      return fail(409, 'worker-has-doing', `工号 ${task.target} 已经有 ${others.length} 张在做：${ids}。要叠单请加 --force（会记审计）`);
    }
  }  // ② 状态必须是 queued（submitted/done/dropped/doing 都不许重派）
  if (task.state !== 'queued') return fail(409, 'not-queued', `${taskId} 当前是 ${task.state}，只有 queued 能派`);
  // ②b 依赖链（UG-011）：前置没闭环（done/dropped）就一律不派 —— code=blocked-by，detail 带票号与单号
  if (task.blocked) {
    const waiting = (task.blockedOn ?? []).map((depId) => {
      const dep = tasks.find((t) => t.id === depId);
      return dep ? `${depId}(${dep.ticket ?? '—'}:${dep.state})` : `${depId}(不在台账)`;
    });
    return fail(409, 'blocked-by', `${taskId} 被前置挡着：${waiting.join('、')}——前置 done/dropped 之前不许派`);
  }
  if (!task.target) return fail(400, 'no-target', `${taskId} 没有目标工号`);
  // ③ 任务书校验（D31）：没有书、或书里缺四要素 → 不派，别让人凭一句标题瞎做
  const book = validateTaskBook(task.ticket || task.id, { createdAt: task.createdAt });
  if (!book.ok) {
    const why = book.reason === 'not-found'
      ? `state\\tasks\\ 下找不到「${task.ticket || task.id}」的任务书`
      : `任务书 ${path.basename(book.path)} 缺要素：${book.missing.join('、')}`;
    return fail(409, 'undefined-task', `${taskId} 没有合格的任务书（${why}）`);
  }
  // ③b UG-034 接口优先闸门：impl 类票没接口契约就不派（CLI --no-contract-gate 可关）
  if (contractGate && String(task.kind ?? '').toLowerCase() === 'impl') {
    const cg = checkContractGate(task);
    if (!cg.ok) {
      return fail(409, 'no-contract', `${taskId}（${task.ticket ?? '—'}）接口优先闸门：${cg.detail}｜怎么解决：${cg.fix}`);
    }
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
  if (!session && !sessionIdOverride) return fail(404, 'no-agent', `没有工号 ${task.target} 的会话`);
  // D92 负载闸：≥ handoff−5万 → 拒派先换代；≥ 90% → 只允许 --force（force 写审计）
  // UG-018：抽成 evaluateLoadGate()，claim 走同一个函数（阈值只此一份）
  // UG-039 排障口：显式 --session-id 时跳过负载闸/忙碌检查（验收要能构造 accepted=false）
  const gate = sessionIdOverride
    ? { ok: true, tokens: null, handoff: null, level: 'session-override' }
    : await evaluateLoadGate(task.target, { force, session });
  const pressureTokens = gate.tokens;
  if (!gate.ok) {
    skipRecord({ t: Date.now(), id: taskId, ticket: task.ticket ?? null, target: task.target, by, code: gate.code, level: gate.level, pressure: gate.tokens, handoff: gate.handoff, detail: gate.detail });
    return fail(409, gate.code, gate.detail, { pressure: gate.tokens, handoff: gate.handoff, level: gate.level });
  }

  if (!sessionIdOverride && session.running === true) {
    return fail(409, 'target-busy', `工号 ${task.target} 正在跑（${String(session.projections?.values?.workingActivity?.line ?? '').slice(0, 60)}），不硬塞`);
  }

  const prompt = buildDispatchPrompt(task, book);
  const promptChars = prompt.length;
  // UG-041：审计里单独记 promptLen，超 600 打 warn——prompt-lint 与看板都靠这两个字段
  const promptLen = promptChars;
  const promptWarn = promptLen > PROMPT_MAX ? { warn: 'prompt-too-long' } : {};
  const startedAt = Date.now();
  const sessionId = String(sessionIdOverride ?? session.sessionId);

  // UG-039：**送达才叫派**。accepted !== true → 票留在 queued、进重试，绝不置 doing。
  const attempt = await attemptPrompt({ sessionId, prompt });
  if (!attempt.delivered && deliveryConfirmEnabled()) {
    const attempts = bumpRetry(task, { code: attempt.code, error: attempt.error });
    const rec = writeAudit({
      t: startedAt, op: 'dispatch', by, id: taskId, ticket: task.ticket ?? null, target: task.target,
      sessionId, promptChars, promptLen, ...promptWarn, ok: false, status: 502, code: 'not-delivered', priority: prioFlag,
      error: attempt.error, attempts, detail: `未送达（${attempt.code}）：票留在 queued，已排第 ${attempts} 次重试`,
      pressure: pressureTokens, handoff: gate.handoff, forced: Boolean(force), ms: Date.now() - startedAt
    });
    return {
      ok: false, status: 502, code: 'not-delivered', delivered: false, attempts,
      detail: `未送达（${attempt.code}）：${attempt.error}｜票仍在 queued，重试 ${attempts}/${MAX_ATTEMPTS}`,
      taskId, target: task.target, sessionId, audit: rec
    };
  }

  // 送到（或 DELIVERY_CONFIRM=0 的旧口径）：这时才动状态。
  const ev = setState(taskId, 'doing', {
    from: by,
    note: attempt.delivered
      ? `已派给工号 ${task.target}（送达确认 accepted=true，prompt ${promptChars} 字）`
      : `已投给工号 ${task.target}（prompt ${promptChars} 字；DELIVERY_CONFIRM=0，未校验 accepted）`
  });
  // UG-007/UG-039：deliveredAt 必须**后写**——setState(doing) 会把它归零
  if (attempt.delivered) {
    try { appendEvent({ t: Date.now(), id: taskId, op: 'accepted', from: 'dispatch', note: 'prompt accepted=true（送达确认）' }); } catch { /* ignore */ }
    clearRetry(taskId);
  }
  const rec = writeAudit({
    t: startedAt, op: 'dispatch', by, id: taskId, ticket: task.ticket ?? null, target: task.target,
    sessionId, promptChars, promptLen, ...promptWarn, priority: prioFlag, ok: true, status: 200, code: attempt.delivered ? 'dispatched' : 'dispatched-unconfirmed',
    delivered: attempt.delivered, pressure: pressureTokens, handoff: gate.handoff, forced: Boolean(force),
    detail: attempt.delivered ? 'session/prompt 已被接受（accepted=true）' : 'session/prompt 已投（未校验 accepted，DELIVERY_CONFIRM=0）',
    ms: Date.now() - startedAt
  });
  // D92 · B2 投递确认：记一笔，等对方侧有动作（10 分钟没动会重投/上报）
  try {
    const { addPending } = await import('./delivery-check.mjs');
    addPending({ kind: 'dispatch', to: task.target, taskId, ticket: task.ticket ?? null, note: 'pressure=' + pressureTokens + ', promptChars=' + promptChars });
  } catch { /* 记录失败不影响派发 */ }
  return { ok: true, status: 200, code: 'dispatched', delivered: attempt.delivered, attempts: 1, detail: '送达确认通过（accepted=true）', taskId, target: task.target, sessionId, promptChars, event: ev, audit: rec };
}

// ── UG-039：契约口 dispatchOne / 重试驱动 ─────────────────────────────────
/**
 * 契约：`dispatchOne(ticketId) -> { delivered, attempts, lastError? }`
 * 做**一次**投递尝试并把结果落到台账/重试表；票在送达前一直留在 queued。
 */
export async function dispatchOne(taskId, { by = 'retry', sessionId = null } = {}) {
  const tasks = replay();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return { delivered: false, attempts: 0, lastError: `没有任务 ${taskId}` };
  const prevAttempts = Number(listUndelivered().find((x) => x.id === taskId)?.attempts ?? 0);
  if (task.state !== 'queued') {
    return { delivered: false, attempts: prevAttempts, lastError: `state=${task.state}，只有 queued 能派`, code: 'not-queued' };
  }
  const book = validateTaskBook(task.ticket || task.id, { createdAt: task.createdAt });
  const prompt = buildDispatchPrompt(task, book.ok ? book : null);

  let sid = sessionId;
  if (!sid) {
    try {
      const { api, unwrap } = await dshApi();
      const sessions = await listSessions(api, unwrap);
      const s = pickAgent(sessions, task.target);
      if (!s) {
        const attempts = bumpRetry(task, { code: 'no-agent', error: `没有工号 ${task.target} 的会话` });
        return { delivered: false, attempts, lastError: `没有工号 ${task.target} 的会话`, code: 'no-agent' };
      }
      sid = String(s.sessionId);
    } catch (error) {
      const msg = `读会话投影失败：${String(error?.message ?? error).slice(0, 120)}`;
      const attempts = bumpRetry(task, { code: 'dsh-unreachable', error: msg });
      return { delivered: false, attempts, lastError: msg, code: 'dsh-unreachable' };
    }
  }

  const t0 = Date.now();
  // UG-041：dispatchOne 是 auto-relay 走的路径，**长度字段必须跟 dispatch() 一致**——
  // 01 驳回时点名 W-261（auto-relay 派成功）那行只有 promptChars、没有 promptLen，
  // 就是因为这里漏写：判据「贴 2 行」才贴不出来。
  const promptLen = prompt.length;
  const promptWarn = promptLen > PROMPT_MAX ? { warn: 'prompt-too-long' } : {};
  const attempt = await attemptPrompt({ sessionId: sid, prompt });
  if (!attempt.delivered) {
    const attempts = bumpRetry(task, { code: attempt.code, error: attempt.error });
    writeAudit({ t: t0, op: 'dispatch', by, id: taskId, ticket: task.ticket ?? null, target: task.target, sessionId: sid, promptChars: promptLen, promptLen, ...promptWarn, ok: false, status: 502, code: 'not-delivered', error: attempt.error, attempts, detail: `未送达（${attempt.code}），第 ${attempts} 次`, ms: Date.now() - t0 });
    return { delivered: false, attempts, lastError: `${attempt.code}: ${attempt.error}`, code: attempt.code, escalated: attempts >= MAX_ATTEMPTS };
  }

  const ev = setState(taskId, 'doing', { from: by, note: `已派给工号 ${task.target}（送达确认 accepted=true，prompt ${prompt.length} 字）` });
  try { appendEvent({ t: Date.now(), id: taskId, op: 'accepted', from: 'dispatch', note: 'prompt accepted=true（送达确认）' }); } catch { /* ignore */ }
  clearRetry(taskId);
  writeAudit({ t: t0, op: 'dispatch', by, id: taskId, ticket: task.ticket ?? null, target: task.target, sessionId: sid, promptChars: promptLen, promptLen, ...promptWarn, ok: true, status: 200, code: 'dispatched', delivered: true, detail: '送达确认通过（accepted=true）', ms: Date.now() - t0 });
  return { delivered: true, attempts: prevAttempts + 1, lastError: null, event: ev, sessionId: sid };
}

/** 跑一轮到期的重试（守护 5 秒一调 / 手工 `worklist.mjs retry`）。 */
export async function processDueRetries({ limit = 5, now: at = Date.now() } = {}) {
  const due = listUndelivered().filter((r) => !r.escalated && Number(r.nextAt ?? 0) > 0 && Number(r.nextAt) <= at);
  const results = [];
  for (const r of due.slice(0, limit)) {
    try { results.push({ id: r.id, ticket: r.ticket, ...(await dispatchOne(r.id, { by: 'retry' })) }); }
    catch (error) { results.push({ id: r.id, ticket: r.ticket, delivered: false, attempts: r.attempts, lastError: String(error?.message ?? error) }); }
  }
  return results;
}