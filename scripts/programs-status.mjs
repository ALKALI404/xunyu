// scripts\programs-status.mjs —— 每个 .mjs 是"干什么的"和"有没有生效"
//
// 回答两个问题：
//   ① 它负责什么？—— 取文件头注释的第一行"用途"
//   ② 它生效了吗？—— 四类证据：进程在跑 / 被别的脚本 import / 有日志活动 / 能独立跑
//
// 用法：
//   node scripts\programs-status.mjs           打印表
//   node scripts\programs-status.mjs --json    机器可读
//   node scripts\programs-status.mjs --md docs\程序清单-生效状态.md   写文档
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORKSPACE = 'E:/DSH_workspace';
const SCRIPTS = path.join(WORKSPACE, 'scripts');
const LOGS = path.join(WORKSPACE, 'logs');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const mdOut = argv[argv.indexOf('--md') + 1];

const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));

// 1) 逐个取"用途"（文件头注释里第一行有内容的）
function purpose(file) {
  const txt = fs.readFileSync(path.join(SCRIPTS, file), 'utf8').slice(0, 1200);
  const lines = txt.split(/\r?\n/);
  for (const ln of lines) {
    const m = ln.match(/^\s*\/\/\s*(?:scripts[\\/])?[\w.-]*\.mjs\s*[—-]+\s*(.+)$/);
    if (m) return m[1].trim();
    const m2 = ln.match(/^\s*\/\/\s*[—-]{0,2}\s*(?:scripts|这个脚本|用途)[:：]?\s*(.+)$/);
    if (m2 && m2[1].length > 4) return m2[1].trim();
  }
  const first = lines.find((l) => /^\s*\/\//.test(l) && l.replace(/^\s*\/\/\s*/, '').length > 6);
  return first ? first.replace(/^\s*\/\/\s*/, '').trim().slice(0, 80) : '(无说明)';
}

// 2) 被谁 import
const importers = new Map();
for (const f of files) {
  const txt = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
  for (const m of txt.matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) {
    const target = m[1];
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target).add(f);
  }
}

// 3) 哪些进程在跑
// 2026-11-01：wmic 在 Win11 上常被移除 → 改用 PowerShell 取命令行（失败就当作"无进程证据"）
let procLines = '';
try {
  procLines = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', timeout: 25000 });
} catch { procLines = ''; }

// 4) 日志活动
function logAge(file) {
  const base = file.replace(/\.mjs$/, '');
  const cands = [path.join(LOGS, base + '.log'), path.join(LOGS, base.replace(/-/g, '') + '.log')];
  let best = null;
  for (const c of cands) { try { const t = fs.statSync(c).mtimeMs; if (!best || t > best) best = t; } catch { } }
  return best;
}

const rows = [];
for (const f of files) {
  const base = f.replace(/\.mjs$/, '');
  const running = procLines.includes(base + '.mjs');
  const importersList = [...(importers.get(f) ?? [])];
  const age = logAge(f);
  const logMin = age ? Math.round((Date.now() - age) / 60000) : null;

  let kind = '单独工具';
  if (running) kind = '常驻/在跑';
  else if (importersList.length) kind = '被引用（模块）';
  else if (logMin != null) kind = '曾运行（有日志）';

  // 有 shebang 且没被 import ⇒ 是给人敲的 CLI，不是"没接线"
  const isCli = /^#!\/usr\/bin\/env node/.test(fs.readFileSync(path.join(SCRIPTS, f), 'utf8').slice(0, 60));
  let status = '❓未接线';
  if (running) status = '🟢 在跑';
  else if (importersList.length) status = '🔵 被 import（生效）';
  else if (isCli) status = logMin != null && logMin < 60 * 24 ? '⚙️ CLI（近期跑过）' : '⚙️ CLI（需手动跑）';
  else if (logMin != null) status = '🟡 近期跑过';
  else if (logMin != null) status = '⚪ 久未运行';

  rows.push({ file: f, purpose: purpose(f), kind, status, running, importers: importersList, logMin, sizeKB: Number((fs.statSync(path.join(SCRIPTS, f)).size / 1024).toFixed(1)) });
}

rows.sort((a, b) => a.status.localeCompare(b.status) || b.sizeKB - a.sizeKB);

if (asJson) {
  console.log(JSON.stringify({ at: new Date().toISOString(), total: rows.length, rows }, null, 1));
} else {
  const counts = rows.reduce((m, r) => (m[r.status] = (m[r.status] ?? 0) + 1, m), {});
  console.log(`== 程序清单：${rows.length} 个 .mjs ==\n`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}  ${v}`);
  console.log('');
  for (const r of rows) {
    const ev = r.running ? '进程在跑' : r.importers.length ? '被 ' + r.importers.slice(0, 2).join(',') + ' 引用' : r.logMin != null ? `${r.logMin} 分钟前有日志` : '无运行证据';
    console.log(`${r.status.padEnd(18)} ${r.file.padEnd(30)} ${r.purpose.slice(0, 42).padEnd(44)} ${ev}`);
  }
}

if (mdOut) {
  const lines = [`# 程序清单 · 生效状态`, '', `> 生成于 ${new Date().toISOString()}｜共 ${rows.length} 个 .mjs`, '',
    '| 状态 | 程序 | 负责什么 | 生效证据 |', '|---|---|---|---|'];
  for (const r of rows) {
    const ev = r.running ? '进程在跑' : r.importers.length ? '被 `' + r.importers.slice(0, 2).join('`、`') + '` 引用' : r.logMin != null ? `${r.logMin} 分钟前日志` : '无';
    lines.push(`| ${r.status} | \`${r.file}\` | ${r.purpose.replace(/\|/g, '/')} | ${ev} |`);
  }
  fs.mkdirSync(path.dirname(path.resolve(mdOut)), { recursive: true });
  fs.writeFileSync(mdOut, lines.join('\n') + '\n', 'utf8');
  console.log('\n文档 →', mdOut);
}
