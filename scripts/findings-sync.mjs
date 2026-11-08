#!/usr/bin/env node
// scripts/findings-sync.mjs —— 结论自动落库（WC-013）：findings-*.jsonl → projects.json + 项目文档
//
// 背景：主人「这种事情做成自动化程序独立运行不占上下文啊」——记录类的事不派 LLM 工人，脚本 + 结构化数据。
//
// ═══ 接口契约（改实现前先改这里）═══════════════════════════════════════════
// 输入：state\findings-*.jsonl（append-only，一行一条）
//   { ts, project, feature, kind, text, src }
//   kind ∈ boundary | demo | credential | pitfall | risk | decision
//   坏行（JSON 坏 / 缺 project / 缺 text）→ 跳过并计数，不中断
// 输出：
//   ① state\projects.json 里对应项目对象加 `findings: [...]`（ts 倒序、最多 20 条、text+project 去重）
//   ② docs\projects\<doc>（取项目对象里的 doc 字段）的「结论与边界」小节里，
//      在 <!-- findings:begin --> 与 <!-- findings:end --> 之间渲染一张表（**只改这一段**）
//   ③ 改盘前备份：state\projects.json.bak-<YYYYMMDD-HHmmss>、文档旁边 .bak-<同上>（各留最近 3 份）
//   ④ 写盘后立刻重新 JSON.parse 校验；失败 → 用备份还原并 exit 1（不留半截文件）
// 命令：node scripts\findings-sync.mjs [--dry-run] [--json] [--dir <state目录>]
// 退出码：0 成功（含"无变化"）｜1 校验失败并已回滚｜2 用法/找不到 projects.json
// 幂等：连跑两次，第二次 added=0、不改任何文件。
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const STATE_DIR = path.join(WORKSPACE, 'state');
const PROJECTS = path.join(STATE_DIR, 'projects.json');
const BEGIN = '<!-- findings:begin -->';
const END = '<!-- findings:end -->';
const MAX_PER_PROJECT = 20;
const KEEP_BACKUPS = 3;
const KINDS = ['boundary', 'demo', 'credential', 'pitfall', 'risk', 'decision'];

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const asJson = argv.includes('--json');
const opt = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const stateDir = path.resolve(opt('dir', STATE_DIR));

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/** 时间戳：只认 scripts\now.mjs（规则：不许手写/本地推算） */
function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ── 1) 读所有 findings-*.jsonl ────────────────────────────────────────────
function readFindings() {
  const files = fs.existsSync(stateDir)
    ? fs.readdirSync(stateDir).filter((f) => /^findings-.*\.jsonl$/i.test(f)).sort()
    : [];
  const rows = [];
  const bad = [];
  for (const f of files) {
    const full = path.join(stateDir, f);
    let raw = '';
    try { raw = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''); } catch { continue; }
    raw.split(/\r?\n/).forEach((line, i) => {
      const s = line.trim();
      if (!s) return;
      let rec;
      try { rec = JSON.parse(s); } catch { bad.push({ file: f, line: i + 1, why: 'JSON 解析失败' }); return; }
      if (!rec || typeof rec !== 'object') { bad.push({ file: f, line: i + 1, why: '不是对象' }); return; }
      if (!String(rec.project ?? '').trim()) { bad.push({ file: f, line: i + 1, why: '缺 project' }); return; }
      if (!String(rec.text ?? '').trim()) { bad.push({ file: f, line: i + 1, why: '缺 text' }); return; }
      const kind = String(rec.kind ?? '').trim();
      if (kind && !KINDS.includes(kind)) bad.push({ file: f, line: i + 1, why: `kind 不在枚举里（${kind}），仍收` });
      rows.push({
        ts: String(rec.ts ?? ''),
        project: String(rec.project).trim(),
        feature: rec.feature == null ? null : String(rec.feature),
        kind: kind || null,
        text: String(rec.text).trim(),
        src: rec.src == null ? null : String(rec.src),
        file: f
      });
    });
  }
  return { files, rows, bad };
}

/** 按 project 分组：ts 倒序、text+project 去重、最多 20 */
function groupByProject(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.project)) map.set(r.project, new Map());
    const bucket = map.get(r.project);
    const key = r.text;
    const prev = bucket.get(key);
    // 同 project+text 视为一条：保留 ts 更新的那条（并列时保留先出现的，保证幂等）
    if (!prev || String(r.ts) > String(prev.ts)) bucket.set(key, r);
  }
  const out = new Map();
  for (const [project, bucket] of map) {
    const list = [...bucket.values()]
      .sort((a, b) => (String(b.ts).localeCompare(String(a.ts))) || a.text.localeCompare(b.text))
      .slice(0, MAX_PER_PROJECT)
      .map((r) => ({ ts: r.ts, project: r.project, feature: r.feature, kind: r.kind, text: r.text, src: r.src }));
    out.set(project, list);
  }
  return out;
}

// ── 2) 渲染 markdown ──────────────────────────────────────────────────────
function cell(v, max = 400) {
  const s = String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function renderBlock(project, list) {
  const lines = [];
  lines.push(`> 自动同步（\`scripts\\findings-sync.mjs\`）：源 \`state\\findings-*.jsonl\`，**这一段别手改**（改了下一轮就覆盖）。`);
  lines.push(`> 项目 \`${project}\`｜共 ${list.length} 条（最多 20 条，按时间倒序）`);
  lines.push('');
  if (!list.length) {
    lines.push('_（还没有结论记录）_');
    return lines.join('\n');
  }
  lines.push('| 时间 | 功能域 | 类 | 结论 | 出处 |');
  lines.push('|---|---|---|---|---|');
  for (const r of list) {
    const when = String(r.ts ?? '').replace('T', ' ').slice(0, 16);
    lines.push(`| ${cell(when, 20)} | ${cell(r.feature ?? '—', 40)} | ${cell(r.kind ?? '—', 20)} | ${cell(r.text)} | ${cell(r.src ?? '—', 120)} |`);
  }
  return lines.join('\n');
}

/** 把块写进文档：有标记就只换标记之间；没有就找「结论与边界」小节末尾插一遍；再没有就末尾加一节 */
function patchDoc(text, project, list) {
  const block = `${BEGIN}\n\n${renderBlock(project, list)}\n\n${END}`;
  if (text.includes(BEGIN) && text.includes(END)) {
    const head = text.slice(0, text.indexOf(BEGIN));
    const tail = text.slice(text.indexOf(END) + END.length);
    return `${head}${block}${tail}`;
  }
  const lines = text.split(/\r?\n/);
  const headIdx = lines.findIndex((l) => /^#{1,4}\s/.test(l) && l.includes('结论与边界'));
  if (headIdx >= 0) {
    const level = (lines[headIdx].match(/^#+/)[0] ?? '#').length;
    let endIdx = lines.length;
    for (let i = headIdx + 1; i < lines.length; i += 1) {
      const m = lines[i].match(/^(#+)\s/);
      if (m && m[1].length <= level) { endIdx = i; break; }
    }
    const before = lines.slice(0, endIdx);
    while (before.length && before[before.length - 1].trim() === '') before.pop();
    const after = lines.slice(endIdx);
    return [...before, '', block, '', ...after].join('\n');
  }
  const trimmed = text.replace(/\s+$/, '');
  return `${trimmed}\n\n## 结论与边界\n\n${block}\n`;
}

// ── 3) 备份与清理 ─────────────────────────────────────────────────────────
function backup(file, ts) {
  const out = `${file}.bak-${ts}`;
  try { fs.copyFileSync(file, out); } catch { return null; }
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    // 只清理**我这个脚本产的**备份（.bak-YYYYMMDD-HHmmss）；别人留的 .bak-mistake-* / .bak-p039-* 一律不碰
    const mine = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak-\\d{8}-\\d{6}$`);
    const olds = fs.readdirSync(dir).filter((f) => mine.test(f)).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* 清理失败不影响主流程 */ }
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────
function main() {
  const doc = readJsonFile(PROJECTS);
  if (!doc || !Array.isArray(doc.projects)) {
    process.stderr.write(`✗ 读不到 ${PROJECTS}（或没有 projects[]）\n`);
    process.exitCode = 2;
    return;
  }
  const { files, rows, bad } = readFindings();
  if (!files.length) {
    const out = { ok: true, dryRun, files: [], added: 0, skipped: 0, changed: [], note: '没有 findings-*.jsonl' };
    process.stdout.write(asJson ? `${JSON.stringify(out, null, 2)}\n` : '没有 findings-*.jsonl，什么都没做\n');
    return;
  }
  const grouped = groupByProject(rows);
  const ts = nowStamp();

  const changedProjects = [];
  const skippedProjects = [];
  const docPlans = [];

  for (const [project, list] of grouped) {
    const pr = doc.projects.find((p) => String(p.id) === project);
    if (!pr) { skippedProjects.push({ project, count: list.length, why: 'projects.json 里没有这个项目' }); continue; }
    const before = JSON.stringify(Array.isArray(pr.findings) ? pr.findings : null);
    const after = JSON.stringify(list);
    if (before !== after) { changedProjects.push({ project, count: list.length, added: list.length }); pr.findings = list; }
  }

  // 文档：每个"有新 findings 的项目"都渲染（内容没变就不写）
  for (const [project, list] of grouped) {
    const pr = doc.projects.find((p) => String(p.id) === project);
    if (!pr || !pr.doc) continue;
    const docPath = path.resolve(WORKSPACE, String(pr.doc));
    if (!fs.existsSync(docPath)) { skippedProjects.push({ project, count: list.length, why: `文档不存在：${pr.doc}` }); continue; }
    const before = fs.readFileSync(docPath, 'utf8').replace(/^\uFEFF/, '');
    const after = patchDoc(before, project, list);
    if (after !== before) docPlans.push({ project, docPath, before, after });
  }

  const totalAdded = changedProjects.reduce((n, c) => n + c.count, 0);
  const summary = {
    ok: true, dryRun, files, rows: rows.length,
    added: totalAdded,
    skipped: bad.length + skippedProjects.length,
    changed: changedProjects.map((c) => ({ project: c.project, findings: c.count })),
    docsToWrite: docPlans.map((d) => path.relative(WORKSPACE, d.docPath)),
    badLines: bad.slice(0, 10),
    skippedProjects
  };

  if (asJson) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    const where = changedProjects.length ? changedProjects.map((c) => `${c.project}(${c.count} 条)`).join(' / ') : '无';
    process.stdout.write(`${dryRun ? '将新增' : '本次处理'} ${totalAdded} 条到 ${where}\n`);
    if (docPlans.length) process.stdout.write(`  文档${dryRun ? '将更新' : '已更新'}：${summary.docsToWrite.join('、')}\n`);
    if (skippedProjects.length) for (const s of skippedProjects) process.stdout.write(`  ⚠ 跳过 ${s.project}：${s.why}\n`);
    if (bad.length) process.stdout.write(`  ⚠ 坏行 ${bad.length} 条（前 ${Math.min(3, bad.length)} 条：${bad.slice(0, 3).map((b) => `${b.file}:${b.line} ${b.why}`).join('；')}）\n`);
  }

  if (dryRun) return;
  if (!changedProjects.length && !docPlans.length) return;   // 幂等：没变化就一个字节都不动

  // ── 写盘（先备份，再写，写后校验，失败回滚）──
  const backups = [];
  try {
    if (changedProjects.length) {
      const bp = backup(PROJECTS, ts);
      if (bp) backups.push({ file: PROJECTS, bak: bp });
      fs.writeFileSync(PROJECTS, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      if (!readJsonFile(PROJECTS)) throw new Error('projects.json 写完解析失败');
    }
    for (const plan of docPlans) {
      const bp = backup(plan.docPath, ts);
      if (bp) backups.push({ file: plan.docPath, bak: bp });
      fs.writeFileSync(plan.docPath, plan.after, 'utf8');
    }
  } catch (e) {
    for (const b of backups.reverse()) { try { fs.copyFileSync(b.bak, b.file); } catch { /* ignore */ } }
    process.stderr.write(`✗ 写盘失败，已用备份还原：${e?.message ?? e}\n`);
    process.exitCode = 1;
    return;
  }
  if (!asJson) process.stdout.write(`✓ 已落库（备份 ${backups.length} 份，保留最近 ${KEEP_BACKUPS} 份）\n`);
}

main();
