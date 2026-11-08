#!/usr/bin/env node
// 派单 prompt 长度检查（UG-041 / W-304）
// 为什么要有：主人问「现在派发任务的上下文为什么这么长」——整治之后必须有哨兵，
//   否则过两周又被 note 全文悄悄撑回去，而长度不进任何看板。
//
// 口径（01 驳回后修正的两点）：
//   ① 长度一律取 `promptLen ?? promptChars`——**老记录常常只有 promptChars**，不能整批当"无长度"跳过；
//   ② 默认扫**全量**（不是最近 200 条），并说清「能算的 / 无任何长度字段的」各多少条；
//   ③ 老实交代盲区：`logs\dispatch.jsonl` 只记 worklist / dispatchOne 两条路径的 prompt；
//      relay04 自己拼的 prompt 走 `sessions.prompt`，**从来不入审计**——历史上长度失控却查不到，根因就在这。
//
// 用法：
//   node scripts\prompt-lint.mjs            全量扫，列 promptLen>600 的派单
//   node scripts\prompt-lint.mjs --days 3   只看最近 3 天
//   node scripts\prompt-lint.mjs --limit 200  只看最近 200 条（调试用）
//   node scripts\prompt-lint.mjs --json     机器读
//   node scripts\prompt-lint.mjs --show-max  顺带打出最长的 5 条（不超长也看得到分布）
// 退出码：0 = 没有超长；1 = 有超长（可当闸门）；2 = 日志读不到

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(HERE, '..');
const LOG = path.join(WS, 'logs', 'dispatch.jsonl');
export const PROMPT_MAX = 600;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const argOf = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 ? argv[i + 1] : d;
};

/** 一条审计记录的 prompt 长度：promptLen 优先，其次 promptChars（老记录只有它）；都没有 → null。 */
export function promptLenOf(rec) {
  const v = rec?.promptLen ?? rec?.promptChars;
  return Number.isFinite(Number(v)) && v !== null && String(v).trim() !== '' ? Number(v) : null;
}

export function readAuditRows(file = LOG) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  return raw.split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * 统计 + 挑超长。`rows` 传数组即可做单测（不读文件）。
 * 返回 { total, measured, onlyChars, unknown, max, top[], long[] }；读不到文件返回 null。
 */
export function findLongPrompts({ rows = null, days = null, limit = null } = {}) {
  const recs = rows ?? readAuditRows();
  if (!recs) return null;
  let list = recs.filter((r) => r.op === 'dispatch' || r.op === 'dispatch-refused');
  if (days) {
    const since = Date.now() - Number(days) * 86400000;
    list = list.filter((r) => Number(r.t) >= since);
  }
  if (limit) list = list.slice(-Number(limit));

  const scored = list.map((r) => ({ r, len: promptLenOf(r), onlyChars: r.promptLen == null && r.promptChars != null }));
  const measured = scored.filter((x) => x.len !== null);
  const unknown = scored.length - measured.length;
  const sorted = [...measured].sort((a, b) => b.len - a.len);
  return {
    total: scored.length,
    measured: measured.length,
    onlyChars: scored.filter((x) => x.onlyChars).length,
    unknown,
    max: sorted.length ? sorted[0].len : 0,
    top: sorted.slice(0, 5),
    long: sorted.filter((x) => x.len > PROMPT_MAX)
  };
}

const isMain = (() => {
  try { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();

if (isMain) {
  if (!fs.existsSync(LOG)) { console.error(`✗ 读不到审计：${LOG}`); process.exit(2); }
  const res = findLongPrompts({ days: argOf('days', null), limit: argOf('limit', null) });
  if (!res) { console.error(`✗ 读不到审计：${LOG}`); process.exit(2); }

  const fmt = (r) => {
    const at = new Date(Number(r.t)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    return `${String(promptLenOf(r)).padStart(5)} 字符  ${at}  ${r.id ?? '—'}  ${r.ticket ?? '（无单号）'}  → 工号 ${r.target ?? '—'}  ${r.code ?? ''}${r.warn ? `  [${r.warn}]` : ''}${r.promptLen == null && r.promptChars != null ? '  （只有 promptChars）' : ''}`;
  };

  if (has('json')) {
    console.log(JSON.stringify({
      max: PROMPT_MAX, total: res.total, measured: res.measured, onlyChars: res.onlyChars,
      withoutAnyLen: res.unknown, longest: res.max, longCount: res.long.length,
      long: res.long.map(({ r, len }) => ({
        t: r.t, id: r.id ?? null, ticket: r.ticket ?? null, target: r.target ?? null,
        promptLen: len, code: r.code ?? null, by: r.by ?? null
      }))
    }, null, 1));
    process.exit(res.long.length ? 1 : 0);
  }

  console.log(`派单 prompt 长度检查（阈值 ${PROMPT_MAX}）`);
  console.log(`扫了 ${res.total} 条 dispatch 记录：能算长度 ${res.measured} 条（其中只有 promptChars 的老记录 ${res.onlyChars} 条）／无任何长度字段 ${res.unknown} 条`);
  console.log(`最长一条 ${res.max} 字符`);
  console.log('盲区：relay04 自拼的 prompt 走 sessions.prompt，不入 dispatch.jsonl——历史上的长度失控在这一侧，审计里查不到。');

  if (has('show-max') && res.top.length) {
    console.log(`\n最长 5 条：`);
    for (const { r } of res.top) console.log(`  ${fmt(r)}`);
  }

  if (!res.long.length) {
    console.log(`\n✓ 没有超长派单（全部可算的都在 ${PROMPT_MAX} 以内；最长 ${res.max}）`);
    process.exit(0);
  }
  console.log(`\n✗ 超长 ${res.long.length} 条（长→短）：`);
  for (const { r } of res.long) console.log(`  ${fmt(r)}`);
  process.exit(1);
}
