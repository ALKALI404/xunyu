// scripts/lib/console-view.mjs —— 诊断/设置/桥接三页的**纯函数**（WS-030 P1）
// 规矩（开发规范 v1）：判定/解析/归一化/排序写纯函数 + 单测；IO 只做薄壳。
// 页面里内联的是本文件的“去 export”副本（见 workdesk-server.mjs 的 inlineLib()），单测 import 的是同一份源码。

/** 自检 9 项 → 托盘三色灯：全好=ok(绿) / 关键挂了=bad(红) / 其余=warn(黄) */
export function rollupChecks(checks) {
  const list = Array.isArray(checks) ? checks : []
  const total = list.length
  const okCount = list.filter((c) => c && c.ok === true).length
  if (!total) return { level: 'bad', label: '没有自检数据', icon: '✖', okCount: 0, total: 0 }
  const criticalDown = list.some((c) => c && c.ok !== true && /^(services|workdesk|supervisor)$/.test(String(c.name || '')))
  const level = okCount === total ? 'ok' : (criticalDown ? 'bad' : 'warn')
  const label = level === 'ok' ? `全好 ${okCount}/${total}` : (level === 'bad' ? `关键挂了 ${okCount}/${total}` : `部分异常 ${okCount}/${total}`)
  const icon = level === 'ok' ? '✔' : (level === 'bad' ? '✖' : '△')
  return { level, label, icon, okCount, total }
}

/** 日志行过滤：关键字（不分大小写）+ 仅异常（error/warn） */
export function filterLogLines(lines, opts) {
  const list = Array.isArray(lines) ? lines : []
  const o = opts || {}
  const kw = String(o.keyword || '').trim().toLowerCase()
  const onlyError = Boolean(o.onlyError)
  const isErr = (l) => {
    const lv = String((l && l.level) || '').toLowerCase()
    if (lv === 'error' || lv === 'warn') return true
    return /error|fail|异常|失败|挂了|连不上|超时|timeout/i.test(String((l && l.text) || ''))
  }
  return list.filter((l) => (!onlyError || isErr(l)) && (!kw || String((l && l.text) || '').toLowerCase().includes(kw)))
}

/** 尾巴：取最后 n 行，并告诉调用方是否被截断（页面据此显示「已截断」） */
export function tailLogLines(lines, n) {
  const list = Array.isArray(lines) ? lines : []
  const want = Number(n)
  const cap = Number.isFinite(want) && want > 0 ? Math.floor(want) : 200
  if (list.length <= cap) return { lines: list.slice(), truncated: false }
  return { lines: list.slice(list.length - cap), truncated: true }
}

/** 掩码：只露头 2 + 尾 3，短串一律全掩（绝不回显明文） */
export function maskToken(secret) {
  const s = String(secret == null ? '' : secret)
  if (!s) return '—'
  if (s.length <= 8) return '…'
  return s.slice(0, 2) + '…' + s.slice(-3)
}

/** 设置表单 → 补丁：空 key 视为「不改」，数字字段转数字，未知字段丢掉 */
export function mergeSettingsPatch(form, current) {
  const f = form && typeof form === 'object' ? form : {}
  const cur = current && typeof current === 'object' ? current : {}
  const out = {}
  const model = {}
  if (f.model && typeof f.model === 'object') {
    for (const k of ['provider', 'baseUrl', 'name']) {
      if (f.model[k] != null && String(f.model[k]).trim() !== '') model[k] = String(f.model[k]).trim()
    }
    const key = String(f.model.key || '').trim()
    if (key) model.key = key            // 空 = 不改（关键：不回显也不清空）
  }
  if (Object.keys(model).length) out.model = model
  const sampling = {}
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v))
  if (f.sampling && typeof f.sampling === 'object') {
    for (const k of ['temperature', 'maxTokens', 'freqPenalty', 'presPenalty', 'timeoutMs']) {
      if (Object.prototype.hasOwnProperty.call(f.sampling, k)) {
        const n = num(f.sampling[k])
        if (n !== null) sampling[k] = n
      }
    }
    if (Object.prototype.hasOwnProperty.call(f.sampling, 'deepThink')) sampling.deepThink = Boolean(f.sampling.deepThink)
  }
  if (Object.keys(sampling).length) out.sampling = sampling
  const bridge = {}
  if (f.bridge && typeof f.bridge === 'object') {
    if (f.bridge.url) bridge.url = String(f.bridge.url).trim()
    const tok = String(f.bridge.token || '').trim()
    if (tok) bridge.token = tok           // 同上：空 = 不改
  }
  if (Object.keys(bridge).length) out.bridge = bridge
  // 兜底：如果什么都没变，返回空对象（调用方据此提示“没有改动”），别拿旧值硬写一遍
  return out
}

/** 桥接开关白名单（与后端 TOGGLE_WHITELIST 一致）：只允许这五个字段过 */
export const BRIDGE_TOGGLE_KEYS = ['sendDelayMs', 'ackMessage', 'questionTimeoutMs', 'allow', 'deny']
export function pickBridgePatch(patch) {
  const p = patch && typeof patch === 'object' ? patch : {}
  const out = {}
  for (const k of BRIDGE_TOGGLE_KEYS) if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k]
  return out
}

/** 桥的状态 → 托盘灯（页面顶部那颗）：离线=红 / 在线但没绑会话=黄 / 都正常=绿 */
export function bridgeLight(st) {
  const s = st && typeof st === 'object' ? st : {}
  if (!s.up) return { level: 'bad', icon: '✖', label: '桥离线' }
  const bound = Number(s.sessionBound || 0)
  if (!bound) return { level: 'warn', icon: '△', label: '在线·未绑会话' }
  return { level: 'ok', icon: '●', label: '在线·已绑 ' + bound }
}

/** 「最后心跳距今」人话化：0–999ms 直接毫秒，秒/分/时逐级 */
export function agoText(ms) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v < 0) return '—'
  if (v < 1000) return Math.round(v) + ' ms'
  if (v < 60000) return Math.round(v / 1000) + ' 秒'
  if (v < 3600000) return Math.round(v / 60000) + ' 分'
  return Math.round(v / 3600000) + ' 小时'
}

/**
 * 端口探活结果 → 'up' | 'down'
 * 为什么不能只看 ok：
 *   - 端口死掉：fetch 立刻 reject（几毫秒，"Failed to fetch"）
 *   - 端口活着但回 401（带 WWW-Authenticate，比如 QQ 桥）：no-cors 的 fetch 会**卡住**直到我们 abort，
 *     既不是 resolve 也不是 reject —— 这恰恰说明"连接被接受了 = 进程活着"。
 * 所以：resolve=up；超时被 abort=up；其余（快速 reject）=down。
 */
export function portStateFromProbe(res, timeoutMs) {
  const r = res && typeof res === 'object' ? res : {}
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 2000
  if (r.ok === true) return 'up'
  const ms = Number(r.ms)
  const byAbort = /abort/i.test(String(r.err || ''))
  if (byAbort && Number.isFinite(ms) && ms >= Math.max(1000, limit * 0.6)) return 'up'
  return 'down'
}
