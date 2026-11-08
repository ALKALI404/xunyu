#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts\untracked-watch.mjs —— 改动巡检：**有人在动代码，台账里却没有对应 doing 票**就报（UG-022 / W-262，07）
//
// 为什么要它（任务书 §0.5）：06 在 21:25 改了 window\web\index.html，**没挂单**，
// 事后谁也说不清那次改动属于哪张票。这个脚本把"无单改动"变成 60 秒内可见的事实。
//
// 判据（只在有票时放行，别的都不算理由）：
//   · 受管目录里的文件 mtime 变了；
//   · 而且**没有任何 doing 票**提到这个文件（票标题 / 票 note / 任务书 §边界 里出现路径或"目录/文件名"）；
//   · 同一文件 30 分钟内只报一次。
//
// 两个必须的工程细节：
//   ① **基线**：首次运行只记当前位置，不把"历史上所有改动"一次性刷成告警（state\untracked-baseline.json）；
//   ② **只读**：只 stat + 读台账，不写任何代码文件（任务书 §4 边界）。
//
// 用法：
//   node scripts\untracked-watch.mjs --once            # 跑一轮（CI / 手工）
//   node scripts\untracked-watch.mjs --once --json     # 机读
//   node scripts\untracked-watch.mjs --watch           # 常驻，60 秒一轮
//   node scripts\untracked-watch.mjs --once --dry      # 只算不写（验收用）
//   node scripts\untracked-watch.mjs --reset-baseline  # 重建基线（大改后手动跑一次）
//
// 退出码：0 = 没发现无单改动 ｜ 1 = 发现了（CI 可据此拦）｜ 2 = 用法/环境错误
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from './worklist-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const DEEPFISH = 'E:\\DeepFish';
const STATE_DIR = path.join(WORKSPACE, 'state');
const BASELINE_FILE = path.join(STATE_DIR, 'untracked-baseline.json');
const CHANGES_FILE = path.join(STATE_DIR, 'untracked-changes.jsonl');
const CONFIG_FILE = path.join(STATE_DIR, 'untracked-config.json');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'untracked-watch.log');
const TASKS_DIR = path.join(STATE_DIR, 'tasks');

const DEFAULTS = {
  // 工单 §1.1 列的三个位置：`scripts\` 与 `E:\DSH_workspace\scripts` 按开发文档 §一 是同一处，去重后是 2 个目录
  dirs: ['E:\\DeepFish\\avatar\\window\\web', path.join(WORKSPACE, 'scripts')],
  exts: ['.js', '.mjs', '.cjs', '.ts', '.cs', '.html', '.htm', '.css', '.json', '.ps1', '.cmd', '.bat'],
  ignoreNames: ['node_modules', '.git', 'dist', 'bin', 'obj'],
  // 显式豁免绝对路径（默认空）。注意：**别拿它当"洗白"工具**，只在"这文件本来就不该算代码"时用（如构建产物）
  ignoreFiles: [],
  ignoreFileRe: '(^|/)(\\.|~)|(\\.log|\\.bak|\\.tmp|\\.dbg|\\.old|\\.swp|\\.zip|\\.png|\\.jpg|\\.ico)$',
  dedupMs: 30 * 60 * 1000,
  // 交票宽限：文件改完立刻交票（doing → submitted）是最常见的工作流，
  // 只认 doing 的话，60 秒 tick 必然撞上"刚交完"→ 误报。所以"10 分钟内提交过的票"也算认领。
  graceMs: 10 * 60 * 1000,
  intervalMs: 60 * 1000
};

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

function loadConfig() {
  let user = {};
  try { user = readJson(CONFIG_FILE); } catch { /* 没配置就是默认 */ }
  const cfg = { ...DEFAULTS, ...user };
  cfg.dirs = [...new Set((cfg.dirs ?? []).map((d) => String(d)))];
  return cfg;
}

// ── 扫描：只 stat，不读内容 ────────────────────────────────────────────────
function walk(dir, cfg, out, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = norm(full);
    if (ent.isDirectory()) {
      if (cfg.ignoreNames.includes(ent.name)) continue;
      walk(full, cfg, out, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    if (new RegExp(cfg.ignoreFileRe, 'i').test(rel)) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (cfg.exts.length && !cfg.exts.includes(ext)) continue;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    out.set(full, { mtimeMs: Math.round(st.mtimeMs), size: st.size, at: st.mtime });
  }
}

function scanAll(cfg) {
  const map = new Map();
  const skip = new Set((cfg.ignoreFiles ?? []).map((x) => norm(x)));
  for (const dir of cfg.dirs) {
    if (fs.existsSync(dir)) walk(dir, cfg, map);
  }
  if (skip.size) for (const k of [...map.keys()]) if (skip.has(norm(k))) map.delete(k);
  return map;
}

// ── 基线 ──────────────────────────────────────────────────────────────────
function loadBaseline() {
  try {
    const doc = readJson(BASELINE_FILE);
    return { at: Number(doc.at ?? 0), files: doc.files ?? {} };
  } catch {
    return null;
  }
}

function saveBaseline(files) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const doc = { version: 1, at: now(), atText: new Date().toLocaleString('zh-CN', { hour12: false }), files };
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(doc)}\n`, 'utf8');
  return doc;
}

// ── 台账：哪些 doing 票"认领"了这个文件 ────────────────────────────────────
function doingTickets() {
  try { return replay().filter((t) => t.state === 'doing'); } catch { return []; }
}

function taskText(task) {
  const parts = [task.title, task.note, task.ticket, task.feature];
  for (const name of [`${task.ticket ?? ''}.md`, `${task.id ?? ''}.md`]) {
    if (!name || name === '.md') continue;
    const fp = path.join(TASKS_DIR, name);
    try { if (fs.existsSync(fp)) parts.push(fs.readFileSync(fp, 'utf8')); } catch { /* ignore */ }
  }
  return norm(parts.filter(Boolean).join('\n'));
}

/**
 * "认领"文本：只看**票的标题/note** + **任务书里的 §边界（能碰哪些文件）那一节**。
 * 为什么不能读整本任务书：验收条款里也常写路径（本单原文就有「改 web/index.html 的时间戳」），
 * 那是测试说明，不是认领；全本扫描会把该文件永久"洗白"。
 */
function claimText(task) {
  const parts = [task.title, task.note];
  for (const name of [`${task.ticket ?? ''}.md`, `${task.id ?? ''}.md`]) {
    if (!name || name === '.md') continue;
    const fp = path.join(TASKS_DIR, name);
    let raw = null;
    try { if (fs.existsSync(fp)) raw = fs.readFileSync(fp, 'utf8'); } catch { /* ignore */ }
    if (!raw) continue;
    const sec = extractSection(raw, ['边界', '能碰', '允许改']);
    if (sec) parts.push(sec);
  }
  // 去掉否定子句：「只改 X，不动别处」要留下 X，不能因为"不动"整行作废
  const NEG = /(不改|不许|不碰|不动|禁止|不得|勿改|别改|不属|越界)/;
  const kept = [];
  for (const line of norm(parts.filter(Boolean).join('\n')).split(/\r?\n/)) {
    for (const clause of line.split(/[，,；;、|]/)) {
      const c = clause.trim();
      if (c && !NEG.test(c)) kept.push(c);
    }
  }
  return kept.join('\n');
}

/** 从任务书里抽出某一节（标题命中关键词，到下一个标题为止）。 */
function extractSection(raw, keywords) {
  const lines = String(raw).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^#{1,6}\s*(.+)$/.exec(lines[i].trim());
    if (m && keywords.some((k) => m[1].includes(k))) { start = i + 1; break; }
    // 也支持没有标题、直接写「能碰哪些文件：」的写法
    if (keywords.some((k) => lines[i].includes(k)) && /[:：]/.test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) return null;
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i].trim())) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** 这个文件被某张 doing 票认领了吗？返回那张票或 null。 */
function coveredBy(file, texts) {
  const candidates = pathCandidates(file);
  for (const { task, text } of texts) {
    for (const c of candidates) {
      if (c.length >= 6 && text.includes(c)) return task;   // 太短的片段容易误匹配（如 "a.js"）
    }
  }
  return null;
}

/** 判定某个文件时用哪些"字样"算认领：绝对路径 / 相对工作区 / 相对 DeepFish / "目录/文件名"。 */
function pathCandidates(file) {
  const abs = norm(file);
  const relW = norm(path.relative(WORKSPACE, file));
  const relD = norm(path.relative(DEEPFISH, file));
  const withDir = norm(`${path.basename(path.dirname(file))}/${path.basename(file)}`);
  return [...new Set([abs, relW, relD, withDir])].filter((x) => x && !x.startsWith('..'));
}

/** 最近一张"提到这个文件"的票（任何状态，用来给出 lastTicket 提示）。 */
function lastTicketFor(file, all) {
  const texts = all.map((task) => ({ task, text: taskText(task) }));
  const hit = coveredBy(file, texts);
  if (hit) return hit;
  let best = null;
  const abs = norm(file);
  const base = norm(path.basename(file));
  const parent = norm(path.basename(path.dirname(file)));
  for (const { task, text } of texts) {
    const mentions = text.includes(abs) || (base.length >= 8 && text.includes(base) && text.includes(parent));
    if (!mentions) continue;
    if (!best || (Number(task.updatedAt ?? task.createdAt ?? 0) > Number(best.updatedAt ?? best.createdAt ?? 0))) best = task;
  }
  return best;
}

// ── 去重：读历史尾部，同文件 30 分钟内只报一次 ──────────────────────────────
function recentReports(dedupMs) {
  const map = new Map();
  let raw = '';
  try { raw = fs.readFileSync(CHANGES_FILE, 'utf8'); } catch { return map; }
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-500);
  const since = now() - dedupMs;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const f = row?.file;
    if (!f) continue;
    const ts = Number(row.ts ?? 0);
    if (ts && ts < since) continue;
    const prev = map.get(norm(f)) ?? 0;
    if (ts > prev) map.set(norm(f), ts);
  }
  return map;
}

/** 给人看的相对路径：在工作区名下就相对工作区，否则相对 DeepFish；都不会出现 `../`。 */
function relOf(file) {
  const w = path.relative(WORKSPACE, file);
  if (w && !w.startsWith('..')) return w.replace(/\\/g, '/');
  const d = path.relative(DEEPFISH, file);
  if (d && !d.startsWith('..')) return d.replace(/\\/g, '/');
  return file.replace(/\\/g, '/');
}

function suggestFor(file, ticket) {
  const rel = relOf(file);
  if (ticket) {
    return `最近提到它的是 ${ticket.ticket ?? ticket.id}（${ticket.state}，${ticket.target ?? '—'}）。`
      + `如果这次改动属于那张票，把它改回 doing 再改（任务书 §边界 写清 ${rel}）；`
      + `如果只该是本票收尾的顺手改动，也要在票里留一句，别让改动无主。`;
  }
  return `没有任何票提到 ${rel}。要么挂一张 doing 票并在任务书 §边界 写清它，要么确认这是误改并回滚。`;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
function runOnce({ dry = false, reset = false, verbose = true } = {}) {
  const cfg = loadConfig();
  const scan = scanAll(cfg);
  const current = {};
  for (const [f, meta] of scan) current[f] = meta.mtimeMs;

  let baseline = reset ? null : loadBaseline();
  let bootstrapped = false;
  if (!baseline) {
    if (!dry) saveBaseline(current);
    bootstrapped = true;
    baseline = { at: now(), files: current };
    if (verbose) {
      console.log(`[untracked] 建立基线：${Object.keys(current).length} 个文件（第一次跑不报警，避免把历史改动一次性刷屏）`);
    }
    return { ok: true, bootstrapped, scanned: Object.keys(current).length, changed: 0, reported: [], skippedDedup: 0, dry };
  }

  // 变了的文件：mtime 变了 / 新增
  const changed = [];
  for (const [f, mtime] of Object.entries(current)) {
    const prev = baseline.files?.[f];
    if (prev == null || Number(prev) !== Number(mtime)) changed.push({ file: f, mtime });
  }
  // 删掉的也记一笔（不是本单判据，但删代码同样该有票）
  const removed = Object.keys(baseline.files ?? {}).filter((f) => !(f in current));

  const all = (() => { try { return replay(); } catch { return []; } })();
  // 认领池 = doing 票 + 10 分钟内提交过的票（改完就交是最常见流程，只认 doing 会误报）
  const grace = Number(cfg.graceMs ?? DEFAULTS.graceMs);
  const doing = all.filter((t) => t.state === 'doing'
    || (t.state === 'submitted' && now() - Number(t.updatedAt ?? t.submittedAt ?? 0) <= grace));
  const doingTexts = doing.map((task) => ({ task, text: claimText(task) }));
  const dedup = recentReports(cfg.dedupMs);

  const rows = [];
  let skipped = 0;
  for (const c of changed) {
    const cover = coveredBy(c.file, doingTexts);
    if (cover) continue;                                     // 有 doing 票认领 → 不报
    if (dedup.has(norm(c.file))) { skipped += 1; continue; }  // 30 分钟内报过 → 不重复
    const last = lastTicketFor(c.file, all);
    rows.push({
      ts: now(),
      at: iso(now()),
      file: c.file,
      rel: relOf(c.file),
      mtime: c.mtime,
      mtimeText: new Date(c.mtime).toLocaleString('zh-CN', { hour12: false }),
      lastTicket: last ? { id: last.id, ticket: last.ticket ?? null, state: last.state, target: last.target ?? null } : null,
      suggestion: suggestFor(c.file, last),
      doingCount: doing.length
    });
  }

  if (!dry) {
    if (rows.length) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(CHANGES_FILE, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    }
    saveBaseline(current);   // 扫描过就推进基线：同一个 mtime 不再重复触发
  }

  const summary = {
    ok: true,
    at: iso(now()),
    scanned: Object.keys(current).length,
    changed: changed.length,
    reported: rows,
    removed: removed.length,
    skippedDedup: skipped,
    doingTickets: doing.length,
    dry
  };

  if (verbose) {
    console.log(`[untracked] ${iso(now())} 扫描 ${summary.scanned} 个文件｜mtime 变化 ${changed.length}｜无单改动 ${rows.length}｜去重跳过 ${skipped}｜认领池 ${doing.length}（doing + 10 分钟内 submitted）`);
    for (const r of rows) {
      console.log(`  ✗ ${r.rel}  (mtime ${r.mtimeText})`);
      console.log(`     最近票：${r.lastTicket ? `${r.lastTicket.ticket ?? r.lastTicket.id}（${r.lastTicket.state}）` : '无'}`);
      console.log(`     建议：${r.suggestion}`);
    }
  }
  return summary;
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--explain')) {
    const target = argv[argv.indexOf('--explain') + 1];
    if (!target) { console.error('用法：--explain <文件绝对路径>'); process.exit(2); }
    const file = path.resolve(target);
    const cands = pathCandidates(file);
    console.log(`文件：${file}`);
    console.log(`用作匹配的字样：${cands.join(' ｜ ')}`);
    const all = (() => { try { return replay(); } catch { return []; } })();
    const cfg = loadConfig();
    const grace = Number(cfg.graceMs ?? DEFAULTS.graceMs);
    const pool = all.filter((t) => t.state === 'doing'
      || (t.state === 'submitted' && now() - Number(t.updatedAt ?? t.submittedAt ?? 0) <= grace));
    if (!pool.length) console.log('（认领池为空：没有 doing 票，也没有 10 分钟内提交的票）');
    for (const t of pool) {
      const hits = [];
      for (const name of [`${t.ticket ?? ''}.md`, `${t.id ?? ''}.md`]) {
        const fp = path.join(TASKS_DIR, name);
        if (!fs.existsSync(fp)) continue;
        const sec = extractSection(fs.readFileSync(fp, 'utf8'), ['边界', '能碰', '允许改']);
        const text = norm(sec ?? '');
        for (const c of cands) if (c.length >= 6 && text.includes(c)) hits.push(`任务书「边界」命中 ${c}`);
      }
      const claim = norm([t.title, t.note].filter(Boolean).join('\n'));
      for (const c of cands) if (c.length >= 6 && claim.includes(c)) hits.push(`票标题/note 命中 ${c}`);
      console.log(`  ${t.state === 'doing' ? 'doing' : t.state} ${t.id} ${t.ticket ?? ''} ${t.target ?? ''} → ${hits.length ? hits.join('；') : '没有认领这个文件'}`);
    }
    process.exit(0);
  }

  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('用法：node scripts\\untracked-watch.mjs --once [--json] [--dry] ｜ --watch ｜ --reset-baseline');
    process.exit(0);
  }
  if (argv.includes('--reset-baseline')) {
    const cfg = loadConfig();
    const scan = scanAll(cfg);
    const current = {};
    for (const [f, meta] of scan) current[f] = meta.mtimeMs;
    const doc = saveBaseline(current);
    console.log(`[untracked] 基线已重建：${Object.keys(current).length} 个文件 @ ${doc.atText}`);
    process.exit(0);
  }

  const json = argv.includes('--json');
  const dry = argv.includes('--dry');

  if (argv.includes('--watch')) {
    const cfg = loadConfig();
    console.log(`[untracked] --watch 启动：每 ${Math.round(cfg.intervalMs / 1000)}s 一轮，目录 ${cfg.dirs.join(' , ')}`);
    const tick = () => {
      try {
        const s = runOnce({ dry: false, verbose: true });
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, `${iso(now())} scanned=${s.scanned} changed=${s.changed} reported=${s.reported.length} skipped=${s.skippedDedup}\n`, 'utf8');
      } catch (e) {
        console.error(`[untracked] 本轮异常：${e.message}`);
      }
    };
    tick();
    setInterval(tick, cfg.intervalMs);
  } else {
    const s = runOnce({ dry, verbose: !json });
    if (json) console.log(JSON.stringify(s, null, 2));
    process.exit(s.reported.length ? 1 : 0);
  }
}

export { runOnce, scanAll, coveredBy, loadConfig };
