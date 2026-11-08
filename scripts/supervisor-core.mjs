#!/usr/bin/env node
/**
 * scripts/supervisor-core.mjs —— 统一守护的**纯逻辑**（WS-016）
 *
 * 为什么单独一层：巡检/拉起/退避/配额这些东西一旦和"真的 spawn 进程"搅在一起，
 * 就只能靠真机杀进程来验，慢且不稳。这里全部做成纯函数：
 *   - `backoffFor(n)`                退避阶梯
 *   - `restartBudget(events, id)`    一小时配额
 *   - `decideActions(...)`           这一拍该干什么（不碰 IO）
 * 真机副作用全在 supervisor.mjs 里，测试只打这些公开函数。
 */
import fs from 'node:fs';

export const HOUR_MS = 60 * 60 * 1000;
/** 退避阶梯：5s / 15s / 60s，之后封顶 60s（无限拉只会刷日志，不会更快好） */
export const BACKOFF_STEPS = [5000, 15000, 60000];
/** 一小时最多重启几次（超过就告警、不再硬拉） */
export const MAX_RESTARTS_PER_HOUR = 5;
/** 连续几次拉起失败后转告警（对齐退避阶梯的长度：3 次都失败就别再试同一轮） */
export const ALERT_AFTER_ATTEMPTS = 3;

/** 第 n 次失败后的等待：n 非法按 1 算，取得阶梯末档封顶。 */
export function backoffFor(attempt) {
  const n = Number(attempt);
  const i = (!Number.isFinite(n) || n < 1 ? 1 : Math.floor(n)) - 1;
  return BACKOFF_STEPS[Math.min(i, BACKOFF_STEPS.length - 1)];
}

/**
 * 读并校验注册表（`tools\services.json`）。**写错就炸**，不许带病上岗：
 *   - 必须是 { services: [...] }
 *   - id 必须唯一（两个同名服务会抢同一份状态/锁）
 *   - cmd 必须是非空数组（字符串会被当文件名整段传进去，跑不起来还难查）
 *   - port 必须是 1–65535 的整数
 *   - deps 只能指向注册表里存在的 id（否则拓扑排序会静默丢边）
 *   - restart.maxPerHour 若给，必须是正数
 * 抛的错都带「哪条服务/哪个字段」，方便对着日志改。
 */
export function loadRegistry(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`注册表不是合法 JSON（${file}）：${e.message}`); }
  const list = Array.isArray(doc?.services) ? doc.services : null;
  if (!list) throw new Error('注册表缺 services 数组');
  const seen = new Set();
  for (const [i, s] of list.entries()) {
    const where = `services[${i}]${s?.id ? `（${s.id}）` : ''}`;
    if (!s || typeof s !== 'object') throw new Error(`${where} 不是对象`);
    if (!s.id || typeof s.id !== 'string') throw new Error(`${where} 缺 id`);
    if (seen.has(s.id)) throw new Error(`${where} id 重复：${s.id}（两个同名服务会抢同一份状态）`);
    seen.add(s.id);
    if (!Array.isArray(s.cmd) || s.cmd.length === 0) throw new Error(`${where} 的 cmd 必须是非空数组（例如 ["node","x.mjs"]）`);
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${where} 的端口不是 1–65535 的整数：${s.port}`);
    if (s.restart?.maxPerHour != null && !(Number(s.restart.maxPerHour) > 0)) throw new Error(`${where} 的 restart.maxPerHour 必须是正数`);
  }
  for (const [i, s] of list.entries()) {
    for (const dep of s.deps ?? []) {
      if (!seen.has(String(dep))) throw new Error(`services[${i}]（${s.id}）的依赖不存在：${dep}`);
    }
  }
  return { ...doc, services: list };
}

/**
 * 这一拍该干什么。**纯函数**：状态与历史都由调用方喂，方便测试与回放。
 *
 * @param services  注册表数组（services.json 里的 services）
 * @param states    { [id]: { up: boolean } } —— 上一步探活结果
 * @param events    历史事件（至少含 {id, action:'start', at}）
 * @param failures  { [id]: number } —— 该服务当前"连续拉起失败"次数
 * @param now       本拍时间戳
 * @returns [{ id, action:'start'|'skip'|'alert', reason, detail? }]，**start 按依赖拓扑排序**
 *
 * 判定顺序（先否决、后动作）：健康 → 不动；配额满 → alert；连败到顶 → alert；
 * 退避没到 → skip；否则 start。这样"超限"永远优先于"再拉一次"。
 */
export function decideActions({ services = [], states = {}, events = [], failures = {}, now = Date.now() } = {}) {
  const down = services.filter((s) => !states?.[s.id]?.up);
  const out = [];
  const starts = new Set();

  for (const svc of down) {
    const id = String(svc.id);
    const maxPerHour = Number(svc?.restart?.maxPerHour ?? MAX_RESTARTS_PER_HOUR);
    const used = restartBudget(events, id, { now });
    if (used >= maxPerHour) {
      out.push({ id, action: 'alert', reason: `超过 ${maxPerHour} 次/小时`, detail: `${id} 一小时内已拉起 ${used} 次，超过上限（${maxPerHour} 次/小时），停止硬拉，等人工看` });
      continue;
    }
    const fails = Number(failures?.[id] ?? 0);
    if (fails >= ALERT_AFTER_ATTEMPTS) {
      out.push({ id, action: 'alert', reason: `连续 ${fails} 次拉起失败`, detail: `${id} 连续 ${fails} 次拉不起来，转告警（不再自动重试）` });
      continue;
    }
    const last = [...events].reverse().find((e) => String(e?.id) === id && String(e?.action) === 'start');
    const wait = backoffFor(fails + 1);
    if (last && Number.isFinite(Number(last.at)) && now - Number(last.at) < wait) {
      out.push({ id, action: 'skip', reason: `退避中（还差 ${Math.ceil((wait - (now - Number(last.at))) / 1000)}s）` });
      continue;
    }
    starts.add(id);
    out.push({ id, action: 'start', reason: '探活失败', detail: `${id} 没起（探活失败），按第 ${fails + 1} 次尝试拉起` });
  }

  // 依赖拓扑：能拉的一起拉时，被依赖的排前面（relay 依赖 bridge → 先 bridge）
  if (starts.size > 1) {
    const byId = new Map(services.map((s) => [String(s.id), s]));
    const ordered = [];
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id) || !starts.has(id)) return;
      seen.add(id);
      for (const dep of byId.get(id)?.deps ?? []) visit(String(dep));
      ordered.push(id);
    };
    for (const id of starts) visit(id);
    const pos = new Map(ordered.map((id, i) => [id, i]));
    out.sort((a, b) => {
      const pa = a.action === 'start' ? pos.get(a.id) ?? 1e9 : 1e9;
      const pb = b.action === 'start' ? pos.get(b.id) ?? 1e9 : 1e9;
      return pa - pb;
    });
  }
  return out;
}

/**
 * 一小时窗口内该服务被"重启/拉起"了几次。
 * 只数 action==='start'（拉起动作本身）；alert/skip 不算，别的服务不算，窗口外的老事件不算。
 */
export function restartBudget(events, id, { now = Date.now(), windowMs = HOUR_MS } = {}) {
  if (!Array.isArray(events) || !id) return 0;
  const from = now - windowMs;
  let n = 0;
  for (const e of events) {
    if (!e || String(e.id) !== String(id)) continue;
    if (String(e.action) !== 'start') continue;
    const at = Number(e.at);
    if (!Number.isFinite(at) || at < from) continue;
    n += 1;
  }
  return n;
}

