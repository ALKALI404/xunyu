#!/usr/bin/env node
/**
 * 上下文预算监视（2026-10-27 立，主人点头后归 01 常设）
 *
 * 干什么：读出每个会话的 `contextPressure.pressureTokens`（当前上下文占用量），
 *         超过阈值就**只报数**——不总结、不换代会话、不写别人的东西。
 * 为什么：成本方案 C1–C9 里「>20 万排换代」，但没人天天量；口径写死在脚本里，谁跑都一样。
 *
 * 用法：
 *   node scripts\check-context-budget.mjs [--warn 150000] [--handoff 200000] [--json]
 * 退出码：0 = 无人在警戒线之上；1 = 有人超 warn；2 = 取不到会话列表
 */
const CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const WARN = flag('warn', 150000);
const HANDOFF = flag('handoff', 200000);

// 阈值来源优先级：--warn/--handoff（默认兜底）< state\context-budget.json 的 default
//  < rules（按会话标题正则匹配，换届/换 id 自动生效）< sessions（按 id 精确覆盖）
const BUDGET = (() => {
  try {
    const p = '<工作区>\\state\\context-budget.json';
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) ?? {};
  } catch { return {}; }
})();
const DEFAULT_BUDGET = {
  warn: Number(BUDGET.default?.warn ?? WARN),
  handoff: Number(BUDGET.default?.handoff ?? HANDOFF),
};
const thresholdsFor = (sid, title) => {
  const exact = BUDGET.sessions?.[sid] ?? BUDGET.sessions?.[String(sid).replace(/^session-/, '')];
  if (exact) return { warn: Number(exact.warn ?? DEFAULT_BUDGET.warn), handoff: Number(exact.handoff ?? DEFAULT_BUDGET.handoff) };
  for (const rule of BUDGET.rules ?? []) {
    try {
      if (rule.title && new RegExp(rule.title).test(String(title ?? ''))) {
        return { warn: Number(rule.warn ?? DEFAULT_BUDGET.warn), handoff: Number(rule.handoff ?? DEFAULT_BUDGET.handoff) };
      }
    } catch { /* 正则写坏了就当没这条 */ }
  }
  return DEFAULT_BUDGET;
};
const JSON_OUT = argv.includes('--json');
const SHOW_ARCHIVED = argv.includes('--all');

// 已归档的会话不用再盯（历史包袱会把「警戒」刷成 26 个，报数就没人看了）
const ARCHIVED = (() => {
  try {
    const p = `${process.env.USERPROFILE ?? process.env.HOME}\\.dsh\\storages\\workspace.json`;
    const ws = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return new Set(ws?.global?.archivedSessionIds ?? ws?.archivedSessionIds ?? []);
  } catch { return new Set(); }
})();

const mod = await import(CLIENT);
const { NodeApiClient, unwrap } = mod;
const { resolveDshBase } = await import('file:///E:/DSH_workspace/scripts/dsh-base.mjs');
const { url, source } = resolveDshBase();
const api = new NodeApiClient(url, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });

let items = null;
let listError = null;
try {
  items = unwrap(await api.sessions.list({}), 'session.list').items ?? [];
} catch (e) {
  listError = `取不到会话列表（${url}，来源 ${source}）：${e?.message ?? e}`;
}
if (listError) {
  console.error(listError);
  process.exitCode = 2;
  setTimeout(() => process.exit(2), 800);
} else {

const rows = items
  .filter((s) => !s.blank)
  .filter((s) => SHOW_ARCHIVED || !ARCHIVED.has(String(s.sessionId)))
  .map((s) => {
    const v = s.projections?.values ?? {};
    const p = v.contextPressure ?? {};
    const th = thresholdsFor(s.sessionId, v.title);
    return {
      id: s.sessionId,
      short: String(s.sessionId).replace(/^session-/, '').slice(0, 8),
      title: v.title ?? '(无标题)',
      cwd: s.cwd ?? '',
      running: Boolean(s.running),
      tokens: Number(p.pressureTokens ?? 0),
      projected: Number(p.projectedTokens ?? 0),
      window: Number(p.contextWindow ?? 0),
      warn: th.warn,
      handoff: th.handoff,
    };
  })
  .sort((a, b) => b.tokens - a.tokens);

const hot = rows.filter((r) => r.tokens >= r.warn);

if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), warn: WARN, handoff: HANDOFF, rows, hot: hot.map((r) => r.id) }, null, 2));
} else {
  const pct = (r) => (r.window ? ` (${((r.tokens / r.window) * 100).toFixed(1)}% of window)` : '');
  console.log(`上下文预算 · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
  console.log(`阈值：默认警戒 ${DEFAULT_BUDGET.warn} / 换代 ${DEFAULT_BUDGET.handoff}${(BUDGET.rules ?? []).length ? `　（另有 ${(BUDGET.rules ?? []).length} 条标题规则 + ${Object.keys(BUDGET.sessions ?? {}).length} 个 id 覆盖，见 state\\context-budget.json）` : ''}\n`);
  for (const r of rows.slice(0, 8)) {
    const mark = r.tokens >= r.handoff ? '⇢ 换代' : r.tokens >= r.warn ? '⚠ 警戒' : '·';
    console.log(`${mark} ${r.short} ${String(r.tokens).padStart(7)}  ${r.title}${r.running ? ' [跑着]' : ''}${pct(r)}`);
  }
  if (hot.length) console.log(`\n超警戒 ${hot.length} 个：${hot.map((r) => r.short).join(', ')}`);
  else console.log('\n没人在警戒线之上。');
}

  process.exitCode = hot.length ? 1 : 0;
  setTimeout(() => process.exit(hot.length ? 1 : 0), 800);
}
