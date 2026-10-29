#!/usr/bin/env node
// scripts/cost-report.mjs —— 花费日报 / 周报 / 月报（纯本地计算，零 token）
//
// 工单 D34（W-071）。取数直接复用 token-report.mjs 的 collectCost（同一口径：
// 按 (sid, turn) 收敛、cacheHit 取该轮 max、其余累加，计价走 model-prices 含峰谷）。
//
// 用法：
//   node scripts\cost-report.mjs --daily            # 今天（默认）
//   node scripts\cost-report.mjs --weekly           # 本周（周一起）
//   node scripts\cost-report.mjs --monthly          # 本月
//   node scripts\cost-report.mjs --daily --write    # 落盘到 state\reports\
//   node scripts\cost-report.mjs --weekly --json    # 机读
//
// 归属：读 state\attribution.json（00 维护，形状 {sessions:{<sid>:{bucket}}}）；
//       读不到就退回「标题/工作区路径」的内建映射（与 workdesk 花费面板同口径，06 实现）；
//       两边都没有 → 「未登记」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCost, beijingClock, dayStart } from './cost-core.mjs';   // D44：唯一计价函数

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const REPORTS_DIR = path.join(WORKSPACE, 'state', 'reports');
const ATTRIB_FILE = path.join(WORKSPACE, 'state', 'attribution.json');
const DAY_MS = 86400000;

// 四桶：id 与 workdesk 面板一致（workgroup / benti / qq / other）
const BUCKETS = [
  { id: 'workgroup', label: '工作组' },
  { id: 'benti', label: '本体' },
  { id: 'qq', label: 'QQ 通道' },
  { id: 'other', label: '其他' },
  { id: 'unknown', label: '未登记' }
];

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function readAttr() {
  const a = readJson(ATTRIB_FILE, null);
  if (!a || typeof a !== 'object') return null;
  if (!a.sessions || typeof a.sessions !== 'object') return null;
  return a;
}
/** 工作区索引：sessionId → {path,title}（与面板同源：~/.dsh/storages/workspace.json）。 */
function workspaceIndex() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const ws = readJson(path.join(home, '.dsh', 'storages', 'workspace.json'), {});
  const map = new Map();
  for (const [, w] of Object.entries(ws?.tables?.workspaces ?? {})) {
    for (const sid of (w?.sessionIds ?? [])) map.set(String(sid), { path: String(w?.path ?? ''), title: String(w?.title ?? '') });
  }
  return map;
}
/** 内建归属（与 workdesk 面板 §归属分桶 同口径）：标题先于路径。 */
function bucketFor(title, wsPath) {
  const text = String(title ?? '');
  if (/工号\s*[0-9]{2}/.test(text)) return 'workgroup';
  if (/子实体|黑话|QQ/i.test(text)) return 'qq';
  if (/本体/.test(text)) return 'benti';
  const p = String(wsPath ?? '');
  if (/DSH_workspace$/i.test(p)) return 'workgroup';
  if (/DeepFish[\\/]Xunyu$/i.test(p)) return 'benti';
  if (/qq-bridge|DeepFish-sub|slang-/i.test(p)) return 'qq';
  return 'other';
}

// ── 北京时间日历运算（固定 +8，无夏令时，直接按 ms 加减）────────────────────
const bjStartOfDay = (ms) => dayStart(beijingClock(ms).day);
function bjIsoWeekStart(ms) {
  const start = bjStartOfDay(ms);
  const dow = new Date(start + 8 * 3600000).getUTCDay(); // 0=周日
  const back = dow === 0 ? 6 : dow - 1;                  // 周一起
  return start - back * DAY_MS;
}
function bjMonthStart(ms) {
  const day = beijingClock(ms).day;                      // YYYY-MM-DD
  return dayStart(`${day.slice(0, 7)}-01`);
}
function prevMonthStart(ms) {
  const day = beijingClock(ms).day;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return dayStart(`${py}-${String(pm).padStart(2, '0')}-01`);
}
function isoWeekNo(ms) {
  const d = new Date(bjStartOfDay(ms) + 8 * 3600000);
  const day = (d.getUTCDay() + 6) % 7;            // 周一=0
  d.setUTCDate(d.getUTCDate() - day + 3);         // 本周周四
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const ftDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDay + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * DAY_MS));
  return { year: d.getUTCFullYear(), week };
}

// ── 组装报告 ────────────────────────────────────────────────────────────────
function pct(part, total) {
  if (!total) return '—';
  return `${((part / total) * 100).toFixed(1)}%`;
}
function money(n) { return `¥${Number(n || 0).toFixed(2)}`; }
function hitRateOf(r) { const d = r.hit + r.miss; return d ? `${((r.hit / d) * 100).toFixed(1)}%` : '—'; }

/**
 * @param {'daily'|'weekly'|'monthly'} kind
 */
export function buildReport(kind = 'daily', { now = Date.now() } = {}) {
  const rangeStart = kind === 'weekly' ? bjIsoWeekStart(now) : (kind === 'monthly' ? bjMonthStart(now) : bjStartOfDay(now));
  const offset = now - rangeStart;
  // 对比期：昨天/上周/上月，取「同一起点到同一时刻偏移」，避免拿半天比整天
  let prevStart;
  let prevLabel;
  if (kind === 'weekly') {
    prevStart = rangeStart - 7 * DAY_MS;
    prevLabel = '上周同期';
  } else if (kind === 'monthly') {
    prevStart = prevMonthStart(rangeStart);
    prevLabel = '上月同期';
  } else {
    prevStart = rangeStart - DAY_MS;
    prevLabel = '昨天同期';
  }
  const prevEnd = Math.min(prevStart + offset, now);

  const cur = collectCost({ from: rangeStart, to: now, by: 'session' });
  const prev = collectCost({ from: prevStart, to: prevEnd, by: 'session' });

  // 归属
  const attr = readAttr();
  const ws = workspaceIndex();
  const bucketOf = (sid) => {
    const mapped = attr?.sessions?.[sid]?.bucket;
    if (mapped) return String(mapped);
    const info = ws.get(String(sid));
    return bucketFor(info?.title ?? '', info?.path ?? '');
  };
  const labelOf = (sid) => {
    const short = String(sid).replace(/^session-/, '').slice(0, 8);
    const info = ws.get(String(sid));
    const t = String(info?.title ?? '').trim();
    if (!t) return short;
    const nice = t.replace(/^鲟鱼工作组/, '').replace(/^鲟鱼[—-]/, '').trim() || t;
    return nice + ' · ' + short;   // 同一工作区会有多个会话，光看标题分不清
  };

  const buckets = new Map(BUCKETS.map((b) => [b.id, { ...b, turns: 0, cost: 0, sessions: new Set() }]));
  for (const s of cur.sessions) {
    const id = bucketOf(s.sid);
    const b = buckets.get(id) ?? buckets.get('unknown');
    b.turns += s.turns;
    b.cost += s.cost;
    b.sessions.add(s.sid);
  }

  const top = cur.sessions
    .slice()
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)
    .map((s) => ({
      sid: s.sid,
      label: labelOf(s.sid),
      bucket: (buckets.get(bucketOf(s.sid)) ?? buckets.get('unknown')).label,
      spanText: s.spanText,
      cost: s.cost,
      share: cur.totals.cost ? s.cost / cur.totals.cost : 0
    }));

  const delta = prev.totals.cost > 0 ? ((cur.totals.cost - prev.totals.cost) / prev.totals.cost) * 100 : null;

  const titles = { daily: '花费日报', weekly: '花费周报', monthly: '花费月报' };
  const headers = {
    daily: `# ${titles.daily} · ${beijingClock(now).day}`,
    weekly: `# ${titles.weekly} · ${(() => { const w = isoWeekNo(rangeStart); return `${w.year} 年第 ${w.week} 周`; })()}`,
    monthly: `# ${titles.monthly} · ${beijingClock(rangeStart).day.slice(0, 7)}`
  };

  const lines = [];
  lines.push(headers[kind]);
  lines.push('');
  lines.push(`> 区间 ${cur.range.fromText} → ${cur.range.toText}（北京时间）　数据源 state\\token-usage.jsonl（${cur.ledger.lines} 行）`);
  lines.push('');
  lines.push('## 一、总量');
  lines.push('');
  lines.push('| 轮数 | 命中 | 未命中 | 输出 | 命中率 | 花费 |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| ${cur.totals.turns} | ${cur.totals.hit.toLocaleString('en-US')} | ${cur.totals.miss.toLocaleString('en-US')} | ${cur.totals.out.toLocaleString('en-US')} | ${hitRateOf(cur.totals)} | ${money(cur.totals.cost)} |`);
  lines.push('');
  lines.push('## 二、按归属分桶');
  lines.push('');
  lines.push('| 归属 | 会话数 | 轮数 | 花费 | 占比 |');
  lines.push('|---|---|---|---|---|');
  for (const b of buckets.values()) {
    if (!b.sessions.size && !b.turns) continue;
    lines.push(`| ${b.label} | ${b.sessions.size} | ${b.turns} | ${money(b.cost)} | ${pct(b.cost, cur.totals.cost)} |`);
  }
  lines.push('');
  lines.push(`> 归属来源：${attr ? 'state\\attribution.json（00 交付）' : '内建映射（attribution.json 未交付，与工作台花费面板同口径）'}`);
  lines.push('');
  lines.push('## 三、按会话 Top 5');
  lines.push('');
  lines.push('| # | 会话 | 归属 | 起止 | 花费 | 占比 |');
  lines.push('|---|---|---|---|---|---|');
  top.forEach((t, i) => lines.push(`| ${i + 1} | ${t.label} | ${t.bucket} | ${t.spanText} | ${money(t.cost)} | ${pct(t.share, 1)} |`));
  if (!top.length) lines.push('| — | （本区间没有账目） |  |  |  |  |');
  lines.push('');
  lines.push('## 四、对比');
  lines.push('');
  const prevText = `${prev.range.fromText} → ${prev.range.toText}`;
  if (delta == null) {
    lines.push(`- ${prevLabel}（${prevText}）**没有账目**，本期 ${money(cur.totals.cost)}，涨跌无从比较。`);
  } else {
    const sign = delta >= 0 ? '+' : '';
    lines.push(`- ${prevLabel} ${money(prev.totals.cost)} → 本期 ${money(cur.totals.cost)}（**${sign}${delta.toFixed(1)}%**）`);
  }
  const topBucket = [...buckets.values()].sort((a, b) => b.cost - a.cost)[0];
  lines.push('');
  lines.push(`**结论**：${titles[kind]} ${cur.range.fromText} → ${cur.range.toText} 共 ${money(cur.totals.cost)}（${cur.totals.turns} 轮 / 命中率 ${hitRateOf(cur.totals)}），最大头是「${topBucket ? topBucket.label : '—'}」${topBucket ? money(topBucket.cost) : ''}${delta == null ? '' : `；比${prevLabel} ${delta >= 0 ? '多' : '少'} ${Math.abs(delta).toFixed(1)}%`}。`);

  const report = {
    ok: true,
    kind,
    generatedAt: now,
    title: headers[kind],
    range: cur.range,
    totals: cur.totals,
    hitRate: hitRateOf(cur.totals),
    buckets: [...buckets.values()].filter((b) => b.sessions.size || b.turns).map((b) => ({ id: b.id, label: b.label, sessions: b.sessions.size, turns: b.turns, cost: b.cost, share: cur.totals.cost ? b.cost / cur.totals.cost : 0 })),
    top,
    compare: { label: prevLabel, range: prev.range, cost: prev.totals.cost, deltaPct: delta },
    attributionSource: attr ? 'state\\attribution.json' : 'builtin',
    markdown: `${lines.join('\n')}\n`
  };
  return report;
}

/** 落盘路径：日报按日、周报按 ISO 周、月报按月。 */
export function reportPath(kind, now = Date.now(), rangeStart = null) {
  const start = rangeStart ?? (kind === 'weekly' ? bjIsoWeekStart(now) : (kind === 'monthly' ? bjMonthStart(now) : bjStartOfDay(now)));
  if (kind === 'weekly') {
    const w = isoWeekNo(start);
    return path.join(REPORTS_DIR, `cost-weekly-${w.year}-W${String(w.week).padStart(2, '0')}.md`);
  }
  if (kind === 'monthly') return path.join(REPORTS_DIR, `cost-monthly-${beijingClock(start).day.slice(0, 7)}.md`);
  return path.join(REPORTS_DIR, `cost-daily-${beijingClock(start).day}.md`);
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(`--${n}`);
  const kind = flag('weekly') ? 'weekly' : (flag('monthly') ? 'monthly' : 'daily');
  const now = Date.now();
  const report = buildReport(kind, { now });
  if (flag('json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(report.markdown);
  }
  if (flag('write')) {
    const p = reportPath(kind, now, report.range.from);
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.writeFileSync(p, report.markdown, 'utf8');
    if (!flag('json')) process.stdout.write(`\n已落盘：${p}\n`);
  }
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
