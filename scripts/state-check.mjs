#!/usr/bin/env node
// scripts/state-check.mjs —— state 目录体检 + 落盘哨兵（D93）
//
// 为什么：state\ 被当垃圾桶用了（2026-10-29 一天 116 个顶层文件、26 个 .log、5 个 .bak-*）。
// 规矩：state\ 只放 运行时状态 / 台账 / 配置 / 索引。日志进 logs\state\，备份进 backup\state-bak\，
//       临时文件进 tmp\（参考 refs\luanyujia\10-源码\机制小工具\临时路径.mjs 与 临时哨兵.mjs）。
//
// 三种用法：
//   node scripts\state-check.mjs                 体检（文本）
//   node scripts\state-check.mjs --json          体检（机读）
//   node scripts\state-check.mjs --check <路径>  落盘前哨兵：这个路径许不许写（exit 0 合规 / 1 违规）
//
// 体检判据（宁可漏报，不许狼来了）：
//   ⚠ B：state 顶层有 .log / .bak-*；顶层文件 >80；有文件未在 state\_索引.md 登记
//   ⚠ B：登记为「临时=是」的文件超过 7 天还留在 state（该清该归档）
//   ℹ A：索引缺失 / 临时文件计数（信息）
// 只读：不改任何文件、不删、不移动。体检退出码恒 0（判据看 verdict）；--check 才用退出码表达合规。

import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const WORKSPACE = path.resolve(HERE, '..');
const STATE = path.join(WORKSPACE, 'state');
const INDEX = path.join(STATE, '_索引.md');
const TMP_HOME = path.join(WORKSPACE, 'tmp');
const MAX_FILES = 80;
const TEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEMPNAME = /(^|[\\_\-\s.()【】])(temp|tmp|临时|未命名|新建|副本|copy|untitled|scratch|试跑|草稿|draft|probe)([\\_\-\s.()【】\d]|$)/i;

function readIndex() {
  if (!fs.existsSync(INDEX)) return null;
  const text = fs.readFileSync(INDEX, 'utf8');
  const names = new Set();
  const temps = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 7) continue;
    const nameCell = cells[2].replace(/`/g, '');
    if (!nameCell || nameCell === '文件名' || /^---/.test(nameCell)) continue;
    if (!/^[\w.\-一-龥]+$/.test(nameCell)) continue;
    names.add(nameCell);
    const tempCell = cells[6] ?? '';
    if (tempCell.startsWith('是')) temps.set(nameCell, tempCell);
  }
  return { names, temps };
}

function collect() {
  const entries = fs.readdirSync(STATE, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const logs = files.filter((n) => /\.log$/i.test(n));
  const baks = files.filter((n) => /\.bak(?:-|$)|\.bak\d*$/i.test(n));
  const idx = readIndex();
  const unregistered = idx ? files.filter((n) => n !== '_索引.md' && !idx.names.has(n)) : [];
  const tempMarked = idx ? files.filter((n) => idx.temps.has(n)) : [];
  const staleTemp = [];
  for (const n of tempMarked) {
    const cell = idx.temps.get(n) || '';
    if (!/一次性|临时/.test(cell)) continue;
    try {
      const age = Date.now() - fs.statSync(path.join(STATE, n)).mtimeMs;
      if (age > TEMP_TTL_MS) staleTemp.push({ name: n, days: Math.floor(age / 86400000) });
    } catch { /* skip */ }
  }
  const findings = [];
  if (logs.length) findings.push({ level: 'B', what: `state 顶层还有 ${logs.length} 个 .log：${logs.slice(0, 6).join(', ')}${logs.length > 6 ? ' …' : ''}` });
  if (baks.length) findings.push({ level: 'B', what: `state 顶层还有 ${baks.length} 个 .bak-*：${baks.slice(0, 6).join(', ')}${baks.length > 6 ? ' …' : ''}` });
  if (files.length > MAX_FILES) findings.push({ level: 'B', what: `顶层文件 ${files.length} 个 > ${MAX_FILES}（超 ${files.length - MAX_FILES}）` });
  if (!idx) findings.push({ level: 'A', what: 'state\\_索引.md 不存在（无法判断登记覆盖）' });
  else if (unregistered.length) findings.push({ level: 'B', what: `${unregistered.length} 个文件未登记：${unregistered.slice(0, 8).join(', ')}${unregistered.length > 8 ? ' …' : ''}` });
  if (staleTemp.length) findings.push({ level: 'B', what: `${staleTemp.length} 个临时标记文件超 7 天没清：${staleTemp.slice(0, 5).map((x) => x.name + '(' + x.days + 'd)').join(', ')}` });
  const verdict = findings.some((f) => f.level === 'B') ? 'WARN' : findings.length ? 'NOTE' : 'OK';
  return {
    tool: 'state-check', version: '0.2.0', at: new Date().toISOString(),
    state: { path: STATE, topFiles: files.length, dirs: dirs.length, logs: logs.length, baks: baks.length, unregistered: unregistered.length, tempMarked: tempMarked.length, staleTemp: staleTemp.length, indexPresent: Boolean(idx) },
    findings, verdict, unregistered, staleTemp,
  };
}

/** 哨兵：这个路径许不许写（合规=在 state 且已登记；或本来就是允许的运行时文件） */
function sentinel(target) {
  const abs = path.resolve(target);
  const rel = path.relative(STATE, abs);
  const idx = readIndex();
  const reasons = [];
  let ok = false;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    if (abs.toLowerCase().startsWith(TMP_HOME.toLowerCase())) { ok = true; reasons.push('在 tmp\\ —— 临时文件正落点，允许'); }
    else reasons.push('不在 state\\ 也不在 tmp\\：state 只放长期状态，临时文件请落 tmp\\');
  } else {
    const name = path.basename(abs);
    if (idx && idx.names.has(name)) { ok = true; reasons.push('已在 state\\_索引.md 登记'); }
    else if (TEMPNAME.test(name)) reasons.push('名字像临时文件（temp/tmp/临时/副本/draft/probe…）：不该落 state，请落 tmp\\');
    else reasons.push('未在 state\\_索引.md 登记：新增长期文件请先登记，否则按临时文件对待');
    const ext = path.extname(name).toLowerCase();
    if (['.log', '.bak', '.tmp', '.pid'].includes(ext) && ok) reasons.push('注意：该后缀按规矩应进 logs\\state\\ 或 backup\\state-bak\\（pid/lock 除外）');
  }
  return { ok, path: abs, reasons };
}

const argv = process.argv.slice(2);
const ci = argv.indexOf('--check');
if (ci >= 0) {
  const target = argv[ci + 1];
  if (!target) { console.log('用法：node scripts\\state-check.mjs --check <路径>'); process.exit(2); }
  const r = sentinel(target);
  console.log(`${r.ok ? '✅ 允许写' : '⛔ 不该写'}：${r.path}`);
  for (const why of r.reasons) console.log('   · ' + why);
  process.exit(r.ok ? 0 : 1);
}

const r = collect();
if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
else {
  console.log(`state-check ${r.version} · ${r.state.path}`);
  console.log(`顶层文件 ${r.state.topFiles} 个（阈值 ${MAX_FILES}）｜子目录 ${r.state.dirs}｜.log ${r.state.logs}｜.bak-* ${r.state.baks}｜未登记 ${r.state.unregistered}｜临时标记 ${r.state.tempMarked}（超期 ${r.state.staleTemp}）｜索引 ${r.state.indexPresent ? '在' : '缺'}`);
  for (const f of r.findings) console.log(`  [${f.level}] ${f.what}`);
  console.log(`结论: ${r.verdict}`);
}
process.exitCode = 0;
