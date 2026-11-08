#!/usr/bin/env node
// scripts/mistakes-sync.mjs —— 返工错题本：数据层 + 渲染器（UG-036）
//
// 一句话：`reject` 写一条到 state\mistakes.jsonl，`accept/done` 把它标 resolved，
//         渲染器读 jsonl 生成 docs\projects\<项目>-错题本.md（未解决排最前、带 ⚠）。
//
// ═══ 接口契约（改实现前先改这里）═══════════════════════════════════════════
// 数据文件：state\mistakes.jsonl（append-only，一行一条）
//   rework 记录（本单写的）：
//     { ts, project, feature, ticket, attempt, rejector, reason, category, evidence, fix, resolved }
//       ts       本地 ISO（+08:00），**只取 scripts\now.mjs 的输出**，不本地推算
//       attempt  该票第几次被打回（1、2、3…，按文件里同票 rework 记录数 +1）
//       reason   打回者**原话**（逐字入库，不改写、不摘要）
//       category 打回分类（REJECT_REASONS 之一；UI 路径没有分类时记 'other'）
//       evidence 证据指针（默认该票的交付稿；没有就指台账）
//       fix      怎么改（可空）
//       resolved false / true（accept 或 done 时置 true，并补 resolvedAt）
//   历史里还有 `kind:"delivery-failed"` 的记录（派发连续失败，dispatch-core 写的）——
//   **本渲染器不碰它们**（isRework() 会把它们滤掉），它们有自己那条线。
//
// 导出（供 worklist.mjs / workdesk-server.mjs 调用）：
//   recordRework(task, {reason, category, by, evidence, fix}) -> {ok, record, attempt}
//   resolveRework(ticket, {by, file})                        -> {ok, resolved, at}
//   reworkForFeature(records, {project, feature, tickets})   -> {rework, lastReworkAt, lastReason, openMistakes}
//   reworkIndex(records)                                     -> Map<'project/feature', 同上>
//   readMistakes({file})                                     -> [record]
//   syncMistakes({dryRun, only, file, outDir})               -> {ok, wrote[]}
//
// CLI：node scripts\mistakes-sync.mjs [--dry-run] [--json] [--only auto] [--file <jsonl>] [--out <dir>]
// 退出码：0 成功 ｜ 1 写失败 ｜ 2 用法错

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
export const MISTAKES_FILE = path.join(WORKSPACE, 'state', 'mistakes.jsonl');
export const OUT_DIR = path.join(WORKSPACE, 'docs', 'projects');
export const BEGIN = '<!-- mistakes:begin -->';
export const END = '<!-- mistakes:end -->';

/** 时间：只认 scripts\now.mjs（规则：不许手写/本地推算时间） */
export function nowIso() {
  const out = execFileSync(process.execPath, [path.join(WORKSPACE, 'scripts', 'now.mjs')], { encoding: 'utf8' }).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(out)) throw new Error(`scripts\\now.mjs 输出格式不认识：${out}`);
  return out;
}

/** 是不是"返工"记录（派发失败那类不算） */
export function isRework(rec) {
  return Boolean(rec) && String(rec.kind ?? '') !== 'delivery-failed';
}

export function readMistakes({ file = MISTAKES_FILE } = {}) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  raw = raw.replace(/^\uFEFF/, '');   // 文件带 BOM 时，裸 JSON.parse 会炸、首条记录会被静默丢掉（01 验收时抓到的）
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过，不阻塞渲染 */ }
  }
  return out;
}

function fileEol(file) {
  try { return fs.readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n'; } catch { return '\n'; }
}

/** 该票已经返工过几次（rework 记录数） */
function attemptsFor(ticket, records) {
  const key = String(ticket ?? '').trim().toUpperCase();
  return records.filter((r) => isRework(r) && String(r.ticket ?? '').trim().toUpperCase() === key).length;
}

/** 默认证据指针：该票的交付稿；没有就指台账 */
function defaultEvidence(ticket, workspace = WORKSPACE) {
  const key = String(ticket ?? '').trim();
  if (key) {
    try {
      const dir = path.join(workspace, 'records', '交付');
      const hit = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.includes(`-${key}.md`)).sort().pop();
      if (hit) return `records/交付/${hit}`;
    } catch { /* 没交付稿 */ }
  }
  return 'state\\worklist.jsonl';
}

/**
 * 写一条返工记录（只追加）。reason 必须是打回者原话。
 * task 只需要 { ticket, project, feature, target }。
 */
export function recordRework(task, { reason, category = 'other', by = '01', evidence = null, fix = null, file = MISTAKES_FILE, workspace = WORKSPACE, when = null } = {}) {
  const text = String(reason ?? '').trim();
  if (!text) return { ok: false, error: 'reason 不能为空：错题本要存打回者原话' };
  const ticket = String(task?.ticket ?? task?.id ?? '').trim();
  if (!ticket) return { ok: false, error: '没有单号：返工记录要有票号' };
  const records = readMistakes({ file });
  const attempt = attemptsFor(ticket, records) + 1;
  const rec = {
    ts: when ?? nowIso(),
    project: task?.project ?? null,
    feature: task?.feature ?? null,
    ticket,
    attempt,
    rejector: String(by ?? '01'),
    reason: text,                                  // 原话，一字不改
    category: String(category ?? 'other'),
    evidence: evidence ? String(evidence) : defaultEvidence(ticket, workspace),
    fix: fix ? String(fix) : '',
    resolved: false
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}${fileEol(file)}`, 'utf8');
  return { ok: true, record: rec, attempt };
}

/**
 * 把该票**最近一条未解决**的 rework 记录标 resolved:true + resolvedAt。
 * 只改这两三个字段，文件里其它行一个字节不动。
 */
export function resolveRework(ticket, { by = '01', file = MISTAKES_FILE, when = null, latestOnly = false } = {}) {
  const key = String(ticket ?? '').trim().toUpperCase();
  if (!key) return { ok: false, error: '没有单号' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, resolved: 0, error: '读不到 mistakes 文件' }; }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);   // 顺手把 BOM 清掉（写回也不带 BOM）
  // 该票所有"未解决"的行号（默认全收口：票过了验收 = 它每一轮返工都算闭环，
  // 否则二次返工的票会永远留一条 ⚠、openMistakes 永不归零；要严格"只解最近一条"传 latestOnly:true）
  const hits = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (!isRework(rec) || rec.resolved) continue;
    if (String(rec.ticket ?? '').trim().toUpperCase() !== key) continue;
    hits.push(i);
    if (latestOnly) break;
  }
  if (!hits.length) return { ok: true, resolved: 0, at: null };
  const at = when ?? nowIso();
  let attempts = [];
  for (const i of hits) {
    const rec = JSON.parse(lines[i]);
    rec.resolved = true;
    rec.resolvedAt = at;
    rec.resolvedBy = String(by ?? '01');
    lines[i] = JSON.stringify(rec);
    attempts.push(rec.attempt);
  }
  fs.writeFileSync(file, lines.join(eol), 'utf8');
  return { ok: true, resolved: hits.length, at, ticket: key, attempt: Math.max(...attempts), attempts };
}

/** 一个 feature 的返工印记（票号命中或 project/feature 命中都算） */
export function reworkForFeature(records, { project = null, feature = null, tickets = [] } = {}) {
  const set = new Set((tickets ?? []).map((t) => String(t).trim().toUpperCase()));
  const rows = records.filter((r) => isRework(r) && (
    (project != null && feature != null && String(r.project) === String(project) && String(r.feature) === String(feature))
    || set.has(String(r.ticket ?? '').trim().toUpperCase())
  ));
  const sorted = rows.slice().sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  const last = sorted[sorted.length - 1] ?? null;
  return {
    rework: rows.length,
    lastReworkAt: last ? String(last.ts) : null,
    lastReason: last ? String(last.reason ?? '') : null,
    openMistakes: rows.filter((r) => !r.resolved).length
  };
}

/** 全量索引：'project/feature' -> 印记 */
export function reworkIndex(records) {
  const map = new Map();
  for (const r of records) {
    if (!isRework(r)) continue;
    if (r.project == null || r.feature == null) continue;
    const k = `${r.project}/${r.feature}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const out = new Map();
  for (const [k, rows] of map) {
    const sorted = rows.slice().sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
    const last = sorted[sorted.length - 1];
    out.set(k, {
      rework: rows.length,
      lastReworkAt: String(last?.ts ?? ''),
      lastReason: String(last?.reason ?? ''),
      openMistakes: rows.filter((r) => !r.resolved).length
    });
  }
  return out;
}

// ── 渲染 ───────────────────────────────────────────────────────────────────
function cell(v, { limit = 400 } = {}) {
  const s = String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : (s || '—');
}

function tableOf(rows) {
  const head = '| 时间 | 票号 | 第几次 | 原因（打回原话） | 证据 | 怎么改 | 状态 |\n|---|---|---|---|---|---|---|\n';
  const body = rows.map((r) => `| ${cell(r.ts, { limit: 40 })} | ${cell(r.ticket, { limit: 40 })} | ${cell(r.attempt, { limit: 8 })} | ${cell(r.reason)} | ${cell(r.evidence, { limit: 200 })} | ${cell(r.fix, { limit: 300 })} | ${r.resolved ? '✅ 已解决' : '⚠ 未解决'} |`).join('\n');
  return head + body;
}

/** 生成某个项目的错题本正文（markers 之间那段） */
export function renderProjectBody(projectId, records) {
  const rows = records.filter((r) => isRework(r) && String(r.project ?? '') === String(projectId));
  const open = rows.filter((r) => !r.resolved).sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  const closed = rows.filter((r) => r.resolved).sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  const parts = [];
  parts.push(`## ⚠ 未解决（${open.length}）`);
  parts.push('');
  parts.push(open.length ? tableOf(open) : '_没有未解决的返工。_');
  parts.push('');
  parts.push(`## ✅ 已解决（${closed.length}）`);
  parts.push('');
  parts.push(closed.length ? tableOf(closed) : '_还没有已解决的返工。_');
  return parts.join('\n');
}

const ORDER = ['ts', 'project', 'feature', 'ticket', 'attempt', 'rejector', 'reason', 'evidence', 'fix', 'resolved'];

/** 全部项目重新渲染（markers 外的人工内容保留） */
export function syncMistakes({ dryRun = false, only = null, file = MISTAKES_FILE, outDir = OUT_DIR, when = null } = {}) {
  const records = readMistakes({ file });
  const projects = [...new Set(records.filter(isRework).map((r) => String(r.project ?? '')).filter(Boolean))];
  const targets = only ? projects.filter((p) => p === String(only)) : projects;
  const generatedAt = when ?? nowIso();
  const wrote = [];
  if (!targets.length) return { ok: true, wrote, note: only ? `没有项目 ${only} 的返工记录` : '还没有任何返工记录，什么都没写' };
  fs.mkdirSync(outDir, { recursive: true });
  for (const project of targets) {
    const outFile = path.join(outDir, `${project}-错题本.md`);
    const body = renderProjectBody(project, records);
    let prev = '';
    try { prev = fs.readFileSync(outFile, 'utf8'); } catch { prev = ''; }
    const header = [
      `# ${project} · 错题本`,
      '',
      '> 由 `scripts\\mistakes-sync.mjs` 从 `state\\mistakes.jsonl` 自动生成——**人手改会被下一轮覆盖**（要改就改 jsonl，别改这里）。',
      '> 未解决的排最前；**⚠ 未解决** 是还没通过验收的返工。',
      `> 生成时间：${generatedAt}`,
      ''
    ].join('\n');
    let next;
    if (prev.includes(BEGIN) && prev.includes(END)) {
      // 头部保留（可能在 markers 前有人加备注），但"生成时间"这一行必须刷新，否则永远停在第一次
      const head = prev.slice(0, prev.indexOf(BEGIN))
        .replace(/^> 生成时间：.*$/m, `> 生成时间：${generatedAt}`);
      const tail = prev.slice(prev.indexOf(END) + END.length);
      next = `${head}${BEGIN}\n\n${body}\n\n${END}${tail}`;
    } else {
      next = `${header}\n${BEGIN}\n\n${body}\n\n${END}\n`;
    }
    const changed = next !== prev;
    if (!dryRun && changed) fs.writeFileSync(outFile, next, 'utf8');
    wrote.push({ project, file: path.relative(WORKSPACE, outFile), entries: records.filter((r) => isRework(r) && String(r.project) === project).length, changed });
  }
  return { ok: true, wrote, generatedAt };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const json = argv.includes('--json');
  const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const r = syncMistakes({ dryRun, only: opt('only'), file: opt('file', MISTAKES_FILE), outDir: opt('out', OUT_DIR) });
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (!r.wrote.length) process.stdout.write(`${r.note ?? '没有要写的'}\n`);
  else {
    process.stdout.write(`${dryRun ? '将生成' : '已生成'} ${r.wrote.length} 份错题本：\n`);
    for (const w of r.wrote) process.stdout.write(`  ${w.file}（${w.entries} 条）${w.changed ? '' : ' · 无变化'}\n`);
  }
  process.exitCode = r.ok ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
