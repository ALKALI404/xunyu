#!/usr/bin/env node
// scripts\check-json-bom.mjs —— 扫 state\*.json 与 config\*.json 有没有 BOM（UG-040）
//
// 为什么要它：BOM 是"看不见的错"——文件合法、记事本打开一切正常，
// 但 JSON.parse 直接抛，被 catch 一吞就成了"配置不存在"。今晚优先队列失效就是这么来的。
//
// 用法：
//   node scripts\check-json-bom.mjs           # 只报（退出码 1 = 有 BOM）
//   node scripts\check-json-bom.mjs --fix     # 报并把 BOM 去掉（原地重写，保留其余字节）
//   node scripts\check-json-bom.mjs --json    # 机读
//
// 退出码：0 = 干净 ｜ 1 = 有 BOM（--fix 后为 0）｜ 2 = 用法错误
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasBom, stripBomFile } from './json-io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const TARGETS = [
  path.join(WORKSPACE, 'state'),
  path.join(WORKSPACE, 'config')
];

function collect(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { collect(full, out); continue; }
    if (!ent.isFile() || !/\.json$/i.test(ent.name)) continue;
    out.push(full);
  }
  return out;
}

export function scanBom({ dirs = TARGETS } = {}) {
  const files = [];
  for (const d of dirs) collect(d, files);
  return files.filter((f) => hasBom(f)).map((f) => ({ file: f, rel: path.relative(WORKSPACE, f).replace(/\\/g, '/'), bytes: fs.statSync(f).size }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('用法：node scripts\\check-json-bom.mjs [--fix] [--json]');
    process.exit(0);
  }
  const fix = argv.includes('--fix');
  const json = argv.includes('--json');
  const hits = scanBom();
  const fixed = [];
  if (fix) for (const h of hits) { if (stripBomFile(h.file)) fixed.push(h.rel); }

  if (json) {
    console.log(JSON.stringify({ ok: hits.length === 0, scanned: TARGETS, bom: hits.map((h) => h.rel), fixed }, null, 2));
  } else {
    const scannedCount = (() => { const all = []; for (const d of TARGETS) collect(d, all); return all.length; })();
    console.log(`扫了 ${scannedCount} 个 json（state\\ 与 config\\ 递归）｜带 BOM：${hits.length}`);
    for (const h of hits) console.log(`  ✗ ${h.rel}（${h.bytes} 字节，前 3 字节 EF BB BF）`);
    if (fix && fixed.length) { console.log(`✓ --fix 已去掉 ${fixed.length} 个文件的 BOM`); for (const r of fixed) console.log(`  · ${r}`); }
    else if (hits.length && !fix) console.log('  修复：node scripts\\check-json-bom.mjs --fix');
    if (!hits.length) console.log('  ✓ 干净：所有 json 都不带 BOM');
  }
  process.exit(hits.length && !fix ? 1 : 0);
}
