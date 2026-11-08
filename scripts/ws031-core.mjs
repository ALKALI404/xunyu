#!/usr/bin/env node
/**
 * scripts/ws031-core.mjs —— WS-031 的纯函数层（零 IO、零 import）
 *
 * 开发规范 v1（2026-11-07）：判定 / 解析 / 归一化 / 排序一律纯函数 + 单测，
 * 落盘与 HTTP 只做薄壳。所以「日志行怎么读成 {at,level,text}」「配置补丁合不合法」
 * 「序号怎么算」全在这里；`routes\console.mjs`、`routes\settings.mjs` 只负责读写文件、
 * 发请求、拼响应体。
 *
 * 单测：node --test scripts\test-ws031-core.mjs
 */

export const LINE_MAX = 500;
export const ERR_RE = /(error|err|exception|失败|报错|❌|⚠|超时|timeout|ECONN|EADDR|crash)/i;

/** 令牌/Key 的展示形态：**永远只有掩码**，短的干脆全遮 */
export function maskSecret(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (s.length <= 8) return '••••';
  if (/^sk-/i.test(s)) return `sk-…${s.slice(-4)}`;
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/** 单行截断（契约：≤ 500 字）。正好等于上限不算截断。 */
export function clipLine(text, max = LINE_MAX) {
  const s = String(text ?? '');
  const n = Math.max(1, Number(max) || LINE_MAX);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 日志级别判定：只看关键词（`.err.log` 那种「整份都是错」的判定在 isErrorLogName） */
export function levelOf(text) {
  return ERR_RE.test(String(text ?? '')) ? 'error' : 'info';
}

/** `*.err.log` / `errors.jsonl` 本身就是错误日志，不指望每行都写 "error" */
export function isErrorLogName(name) {
  return /\.err\.log$|errors\.jsonl$/i.test(String(name ?? ''));
}

/**
 * 行内时间戳解析：认得 `2026-11-07 14:11:56`、`14:11:56`、`[14:11:56]`。
 * 只有时分秒时，日期从 fallbackMs（文件 mtime）里取。认不出就返回 fallbackMs。
 */
export function parseClock(text, fallbackMs = 0) {
  const s = String(text ?? '');
  const iso = /^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  if (iso) {
    const t = Date.parse(`${iso[1]}T${iso[2]}`);
    if (Number.isFinite(t)) return t;
  }
  const hms = /^\[?(\d{2}):(\d{2}):(\d{2})\]?/.exec(s);
  if (hms) {
    const d = new Date(Number(fallbackMs) || 0);
    d.setHours(Number(hms[1]), Number(hms[2]), Number(hms[3]), 0);
    const t = d.getTime();
    if (Number.isFinite(t)) return t;
  }
  return Number(fallbackMs) || 0;
}

/**
 * 一行原始日志 → {at, level, text, src}。
 * .jsonl 行（supervisor 事件流那类）在这里压成人话；`forceLevel` 用于整份都是错误的日志。
 */
export function formatEntry(text, { atMs = 0, src = '', forceLevel = null } = {}) {
  const raw = String(text ?? '');
  let out = raw;
  let at = parseClock(raw, atMs);
  if (/^\s*\{/.test(out)) {
    try {
      const o = JSON.parse(out);
      if (o && typeof o === 'object') {
        if (Number.isFinite(Number(o.at))) at = Number(o.at);
        const who = o.id ?? o.svc ?? o.src ?? '';
        const what = o.action ?? o.level ?? '';
        const why = o.detail ?? o.text ?? o.error ?? '';
        out = `${who}${who && (what || why) ? ' ' : ''}${what}${what && why ? '：' : ''}${why}`.trim() || out;
      }
    } catch { /* 不是完整 JSON 就原样 */ }
  }
  return { at, level: forceLevel ?? levelOf(out), text: clipLine(out), src };
}

/**
 * 相邻同文折叠：桥在死循环里能把一行刷两万次，不折叠尾巴等于没读。
 * 返回 {rows, deduped}——`repeat` 是如实计数，不是丢行。
 */
export function collapseRepeats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) {
    const prev = out[out.length - 1];
    if (prev && prev.text === row.text && prev.level === row.level && prev.src === row.src) {
      prev.repeat = (prev.repeat ?? 1) + 1;
      prev.atLast = row.at;
      continue;
    }
    out.push({ ...row });
  }
  return { rows: out, deduped: list.length - out.length };
}

/**
 * 日志增量序号：时间戳 × 1000 + 行内序号。
 * 跨文件可比（不同文件各自从 0 编号会让 `after` 串台），同一毫秒内的行靠 idx 保序。
 */
export function seqOf(atMs, idx = 0) {
  const at = Number(atMs);
  const base = Number.isFinite(at) ? Math.round(at) : 0;
  const i = Math.abs(Number(idx) || 0) % 1000;
  return base * 1000 + i;
}

/** 出接口 / 进日志前统一抹一遍：明文 key 与 token 一律不许活着出去 */
export function sanitizeLogText(text) {
  return String(text ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…<masked>')
    .replace(/((?:access_|console_|agent_)?token["'\s:=]+)([A-Za-z0-9_-]{16,})/gi, '$1<masked>');
}

const SAMPLING_RULES = {
  temperature: [0, 2],
  maxTokens: [1, 200000],
  freqPenalty: [-2, 2],
  presPenalty: [-2, 2],
  timeoutMs: [1000, 3600000],
};
export const SAMPLING_KEYS = ['temperature', 'maxTokens', 'freqPenalty', 'presPenalty', 'timeoutMs', 'deepThink'];

export function numIn(value, min, max) {
  // 注意：Number('') === 0、Number(null) === 0、Number(true) === 1 —— 这些都得当非法，
  // 不然「传空字符串」会被悄悄当成 0 写进配置（单测就是这么揪出来的）。
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * 采样参数补丁：**纯函数**，给「当前值 + 补丁」，返回「新值 + 真正改了什么 + 为什么没改」。
 * 越界不改（只记 warning），不抛错——调用方决定回 400 还是 200。
 */
export function validateSamplingPatch(cur, patch) {
  const sampling = {};
  for (const k of SAMPLING_KEYS) sampling[k] = cur && cur[k] != null ? cur[k] : null;
  const applied = [];
  const warnings = [];
  if (!patch || typeof patch !== 'object') return { sampling, applied, warnings };
  for (const [k, [min, max]] of Object.entries(SAMPLING_RULES)) {
    if (!(k in patch)) continue;
    const n = numIn(patch[k], min, max);
    if (n === null) { warnings.push(`sampling.${k} 不合法（要 ${min}~${max}），未改`); continue; }
    if (sampling[k] === n) continue;
    sampling[k] = n;
    applied.push(`sampling.${k}`);
  }
  if ('deepThink' in patch) {
    if (typeof patch.deepThink !== 'boolean') warnings.push('sampling.deepThink 要布尔值，未改');
    else if (sampling.deepThink !== patch.deepThink) { sampling.deepThink = patch.deepThink; applied.push('sampling.deepThink'); }
  }
  return { sampling, applied, warnings };
}

/**
 * 模型补丁：映射到桥 `config.dsh.*`。
 * 红线：**`key` 传空字符串 = 不改**；只回掩码；形态不对的 key 拒收（不静默写脏）。
 */
export function validateModelPatch(curDsh, patch) {
  const dsh = { ...(curDsh ?? {}) };
  const applied = [];
  const warnings = [];
  if (!patch || typeof patch !== 'object') return { dsh, applied, warnings };
  const map = { provider: 'provider', baseUrl: 'baseUrl', name: 'model' };
  for (const [k, field] of Object.entries(map)) {
    if (!(k in patch)) continue;
    const v = String(patch[k] ?? '').trim();
    if (!v) { warnings.push(`model.${k} 为空，未改`); continue; }
    if (v.length > 200) { warnings.push(`model.${k} 太长，未改`); continue; }
    if (dsh[field] === v) continue;
    dsh[field] = v;
    applied.push(`model.${k}`);
  }
  if ('key' in patch) {
    const key = String(patch.key ?? '').trim();
    if (!key) warnings.push('model.key 为空，未改（红线：空字符串 = 不改）');
    else if (key.length < 16 || /\s/.test(key)) warnings.push('model.key 形态不像 Key（长度 <16 或有空格），未改');
    else if (dsh.authToken !== key) { dsh.authToken = key; applied.push('model.key'); }
  }
  return { dsh, applied, warnings };
}

/** 桥控制台令牌：只收 ≥24 位可见 ASCII；空串 = 不改 */
export function validateBridgeToken(token) {
  const t = String(token ?? '').trim();
  if (!t) return { ok: false, warning: 'bridge.token 为空，未改（红线：空字符串 = 不改）' };
  if (t.length < 24 || !/^[\x21-\x7e]+$/.test(t)) return { ok: false, warning: 'bridge.token 形态不合法（要 ≥24 位可见 ASCII），未改' };
  return { ok: true, value: t };
}

export const TOGGLE_WHITELIST = ['sendDelayMs', 'ackMessage', 'questionTimeoutMs', 'allow', 'deny'];

/**
 * toggle 白名单与取值校验：**纯函数**，返回 {ok,value} 或 {ok:false,status,error}。
 * 非白名单字段一律 403（红线 1）；取值不对 400，并说清要什么。
 */
export function validateToggle(key, value) {
  const k = String(key ?? '').trim();
  if (!TOGGLE_WHITELIST.includes(k)) {
    return { ok: false, status: 403, error: `只允许改这五个字段：${TOGGLE_WHITELIST.join(' / ')}`, denied: k || null };
  }
  if (k === 'sendDelayMs') {
    const n = numIn(value, 0, 60000);
    if (n === null) return { ok: false, status: 400, error: 'sendDelayMs 要 0~60000 的数字' };
    return { ok: true, value: n };
  }
  if (k === 'questionTimeoutMs') {
    const n = numIn(value, 1000, 600000);
    if (n === null) return { ok: false, status: 400, error: 'questionTimeoutMs 要 1000~600000 的数字' };
    return { ok: true, value: n };
  }
  if (k === 'ackMessage') {
    if (typeof value !== 'string' || value.length > 200) return { ok: false, status: 400, error: 'ackMessage 要 ≤200 字的字符串' };
    return { ok: true, value };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, status: 400, error: `${k} 要对象 {private:[], groups:[]}` };
  }
  const norm = { private: [], groups: [] };
  for (const f of ['private', 'groups']) {
    const arr = value[f];
    if (arr == null) continue;
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string' && typeof x !== 'number')) {
      return { ok: false, status: 400, error: `${k}.${f} 要字符串数组` };
    }
    norm[f] = arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 200);
  }
  return { ok: true, value: norm };
}
