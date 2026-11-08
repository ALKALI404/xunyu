#!/usr/bin/env node
// scripts/check-delivery.mjs —— 交付预检门（D57 建，D70 分级放宽）
//
// 背景：D57 把「修复类必须有 exit 码 + 命令代码块」当成硬性 FAIL，比验收规则还严 →
// 74 份交付里 47 份被拦下，活干完了票却卡在 doing。D70 把门分成两级：
//
//   FAIL（硬性，不许进待验收）：① 前 3 行没有 `类型:`；② 缺四段式小节之一；③ 文件名/目录不合规
//   WARN（软性，仍进待验收，由 01 判）：修复类缺 exit/退出码、缺命令代码块、方案类缺回滚、
//                                      缺「已读规则 vX」确认行（第十节判定 6 说可观察证据即可）
//
// UG-034 追加（FAIL）：类型=实现 且 台账 kind=impl 时，必须 接口 → 模块 → 证据 三段；接口段没写「变更了什么」或「接口未变」也 FAIL。
//                    存量交付（台账没 kind）不追溯；`--no-contract-gate` 可关。

// 用法：
//   node scripts\check-delivery.mjs <文件>
//   node scripts\check-delivery.mjs --all [--json]        # 全量（历史文件也扫）
//   node scripts\check-delivery.mjs <文件> --json
// 退出码：0 = OK 或 WARN（可进待验收）｜1 = FAIL｜2 = 用法错误

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from './worklist-core.mjs';   // UG-034：判 impl 看台账 kind（存量不追溯）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const DELIVERY_DIR = path.join(WORKSPACE, 'records', '交付');
export const TYPES = ['方案', '实现', '修复', '文档'];
// 五段式有两套口语：任务书常写「结论/改了什么/证据/落点/风险」，预检门原用「做到哪/改了什么/怎么验的/卡在哪」。
// 2026-10-29 起：两套都认（同一件事的两种写法），避免口径打架把好交付挡在门外。
const SECTION_ALIASES = [
  ['做到哪', '结论'],
  ['改了什么', '改了什么'],
  ['怎么验的', '证据'],
  ['卡在哪', '风险'],
];
const SECTIONS = SECTION_ALIASES.map((pair) => pair[0]);

/** 从正文抽 ``` 代码块（返回每块的行数组）。 */
function codeBlocks(text) {
  const blocks = [];
  const re = /```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

/** 代码块里有没有"命令"。 */
function looksLikeCommand(block) {
  return block.split(/\r?\n/).some((line) => {
    const s = line.trim().replace(/^[$>]\s*/, '');
    return /^(node|npm|pnpm|npx|git|pwsh|powershell|curl|Invoke-RestMethod|Invoke-WebRequest|Get-|Set-|copy|Copy-Item|scp|python)\b/i.test(s) || /^&\s/.test(s);
  });
}

// ── UG-034：impl 类交付必须「接口 → 模块 → 证据」三段（接口段要显式写变更或"接口未变"）──
// 只管 kind=impl 的票（台账里带 kind 的），存量交付一律不追溯，免得重演 D57「47/74 被挡」。
const IMPL_HEAD_RE = /(^|\n)#{2,4}\s*(.+)/g;

/** 按出现顺序抽出小标题 + 每段的正文 */
function markdownSections(text) {
  const heads = [];
  let m;
  IMPL_HEAD_RE.lastIndex = 0;
  while ((m = IMPL_HEAD_RE.exec(text)) !== null) {
    const headStart = m.index + (m[1] ? m[1].length : 0);
    heads.push({ at: headStart, title: String(m[2] ?? '').trim() });
  }
  return heads.map((h, i) => {
    // body 必须从小标题下面一行开始算，否则「## 接口（定义/变更/版本）」这几个字会被当成"接口段写了变更"
    const lineEnd = text.indexOf('\n', h.at);
    const bodyStart = lineEnd >= 0 ? lineEnd + 1 : h.at + h.title.length;
    const nextAt = i + 1 < heads.length ? heads[i + 1].at : text.length;
    return { title: h.title, body: text.slice(bodyStart, Math.max(bodyStart, nextAt)) };
  });
}

/** 这份交付对应的票是不是 impl（台账 kind） */
function ticketKindOf(file) {
  const base = path.basename(file);
  const m = /^\d{2}-\d{8}-(.+)\.md$/.exec(base);
  if (!m) return null;
  const ticket = m[1];
  try {
    const hit = replay().find((t) => String(t.ticket ?? '').toUpperCase() === ticket.toUpperCase());
    return hit ? String(hit.kind ?? '') || null : null;
  } catch { return null; }
}

/** 三段检查：返回 fails[]（空 = 通过） */
function checkImplThreeParts(text) {
  const fails = [];
  const secs = markdownSections(text);
  const idx = (kw) => secs.findIndex((s) => s.title.includes(kw));
  const iIface = idx('接口');
  const iMod = idx('模块');
  const iEv = idx('证据');
  const missing = [];
  if (iIface < 0) missing.push('接口');
  if (iMod < 0) missing.push('模块');
  if (iEv < 0) missing.push('证据');
  if (missing.length) {
    fails.push(`impl 交付缺小标题：${missing.join('、')}（必须是 接口 → 模块 → 证据 三段）`);
    return fails;
  }
  if (!(iIface < iMod && iMod < iEv)) {
    fails.push(`impl 交付三段顺序不对（现在 接口#${iIface + 1} / 模块#${iMod + 1} / 证据#${iEv + 1}，要求 接口 → 模块 → 证据）`);
  }
  const ifaceBody = secs[iIface].body;
  const saysUnchanged = /接口未变|接口没有变/.test(ifaceBody);
  const saysChanged = /(变更|新增|修改|删除|废弃|改名|改签名|加字段|去字段)/.test(ifaceBody);
  if (!saysUnchanged && !saysChanged) {
    fails.push('接口段没写"变更了什么接口"或"接口未变"（允许不变，但必须显式写一句）');
  }
  return fails;
}

/**
 * 检查一份交付文件，返回 {ok, level:'OK'|'WARN'|'FAIL', type, fails[], warns[]}
 * ok = 能不能进待验收（FAIL 才 false）。
 */
export function checkDelivery(file, { contractGate = true, kind = null } = {}) {
  const fails = [];
  const warns = [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return { ok: false, level: 'FAIL', type: null, fails: ['读不到文件'], warns: [] };
  }
  const base = path.basename(file);
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, 3).join('\n');

  // ③ 文件名（硬性）：<工号>-<YYYYMMDD>-<单号>.md
  if (!/^\d{2}-\d{8}-[A-Za-z0-9._-]+\.md$/.test(base)) {
    fails.push(`文件名不是 <工号>-<YYYYMMDD>-<单号>.md（当前 ${base}）`);
  }

  // ① 类型行（硬性）
  const typeMatch = /类型\s*[:：]\s*\**\s*(方案|实现|修复|文档)/.exec(head);
  const type = typeMatch ? typeMatch[1] : null;
  if (!type) fails.push('前 3 行缺「类型: 方案|实现|修复|文档」');

  // ② 四段式（硬性）
  for (const pair of SECTION_ALIASES) { if (!pair.some((name) => text.includes(name))) fails.push(`缺小节「${pair[0]}」（或写作「${pair[1]}」）`); }

  // 软性项：只提示，不拦
  const blocks = codeBlocks(text);
  if (type === '修复') {
    if (!/exit|退出码/i.test(text)) warns.push('修复类没写 exit/退出码（有截图/日志/200/mtime 等可观察证据即可）');
    if (!blocks.some(looksLikeCommand)) warns.push('修复类没有"命令"代码块（可贴截图/日志代替）');
  }
  if (type === '方案' && !/回滚/.test(text)) warns.push('方案类没写「回滚」（有回滚路径说明即可）');
  if (!/已读规则\s*v?\d/i.test(text)) warns.push('没有「已读规则 vX」确认行');

  // UG-034：impl 类交付必须 接口 → 模块 → 证据 三段，且接口段要显式写「变更」或「接口未变」
  const implKind = kind ?? ticketKindOf(file);
  if (contractGate && implKind === 'impl') fails.push(...checkImplThreeParts(text));

  const level = fails.length ? 'FAIL' : (warns.length ? 'WARN' : 'OK');
  return { ok: fails.length === 0, level, type, fails, warns };
}

function rel(p) {
  try { return path.relative(WORKSPACE, p); } catch { return p; }
}

function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const newOnly = argv.includes('--new-only');      // D70：只看最近改动过的交付（扫描器就是按这个口径报警）
  const json = argv.includes('--json');
  const target = argv.find((a) => !a.startsWith('--'));

  if (!all && !newOnly && !target) {
    process.stderr.write('用法：node scripts\\check-delivery.mjs <交付文件> ｜ --all [--json]\n');
    process.exitCode = 2;
    return;
  }

  let files;
  if (newOnly) {
    const since = Date.now() - 30 * 60000;   // 最近 30 分钟改过的
    files = fs.readdirSync(DELIVERY_DIR).filter((f) => f.endsWith('.md'))
      .map((f) => path.join(DELIVERY_DIR, f))
      .filter((f) => { try { return fs.statSync(f).mtimeMs >= since; } catch { return false; } })
      .sort();
  } else if (all) {
    files = fs.readdirSync(DELIVERY_DIR).filter((f) => f.endsWith('.md')).map((f) => path.join(DELIVERY_DIR, f)).sort();
  } else {
    files = [path.resolve(target)];
  }

  const contractGate = !argv.includes('--no-contract-gate');
  const results = files.map((f) => ({ ...checkDelivery(f, { contractGate }), rel: rel(f) }));
  const fails = results.filter((r) => r.level === 'FAIL');
  const warns = results.filter((r) => r.level === 'WARN');

  if (json) {
    process.stdout.write(`${JSON.stringify({ total: results.length, ok: results.length - fails.length, fail: fails.length, warn: warns.length, results }, null, 2)}\n`);
  } else if (!all && !newOnly) {
    const r = results[0];
    if (r.level === 'FAIL') process.stdout.write(`FAIL: ${r.fails.join('；')}\n  ${r.rel}\n`);
    else if (r.level === 'WARN') process.stdout.write(`WARN: ${r.warns.join('；')}\n  ${r.rel}（类型: ${r.type}，仍可进待验收，由 01 判）\n`);
    else process.stdout.write(`OK  ${r.rel}（类型: ${r.type}）\n`);
  } else {
    process.stdout.write(`交付预检：共 ${results.length} 份｜FAIL ${fails.length}｜WARN ${warns.length}｜OK ${results.length - fails.length - warns.length}\n`);
    for (const r of fails) process.stdout.write(`  ✗ FAIL ${r.rel}：${r.fails.join('；')}\n`);
    if (warns.length) process.stdout.write(`  （另有 ${warns.length} 份只是 WARN，不挡待验收）\n`);
  }
  process.exitCode = fails.length ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
