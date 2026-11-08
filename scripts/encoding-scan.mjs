#!/usr/bin/env node
// scripts\encoding-scan.mjs —— 扫描目录，判定每个文件该用什么编码读，落成 state\encoding-map.json
// 用法: node scripts\encoding-scan.mjs [--roots E:\DeepFish,E:\DSH_workspace] [--json]
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'E:/DSH_workspace/state/encoding-map.json';
const DEFAULT_ROOTS = [
  'E:/DeepFish/History',
  'E:/DeepFish/Xunyu/memory',
  'E:/DeepFish/avatar/state',
  'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/state',
  'E:/DSH_workspace/state',
  'E:/DSH_workspace/logs',
  'E:/DSH_workspace/docs',
  'E:/DSH_workspace/records',
  'E:/DSH_workspace/scripts',
];

const argv = process.argv.slice(2);
const rootsArg = argv.includes('--roots') ? argv[argv.indexOf('--roots') + 1] : null;
const roots = rootsArg ? rootsArg.split(',').map((s) => s.trim()) : DEFAULT_ROOTS;

const SKIP_DIR = new Set(['node_modules', '.git', 'backup', 'toolchain', '__pycache__', 'window-webview', 'EBWebView', 'leveldb']);
const TEXT_EXT = /\.(json|jsonl|md|mjs|js|ps1|cmd|cs|html|css|txt|log|yaml|yml|csv|vbs|tsv)$/i;

function detect(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8-bom';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  // 合法 UTF-8 判定（采样前 64KB）
  // 整文件解码，避免在 64KB 边界切断多字节字符导致误判
  const sample = buf.length > 8 * 1024 * 1024 ? buf.subarray(0, 8 * 1024 * 1024) : buf;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    // 能严格解码，但若全是 ASCII 也标 utf8（等价）
    return 'utf8';
  } catch { /* 落到下面 */ }
  // 不是 UTF-8：尝试 GBK（浏览器/Node 的 gbk 解码器不一定有，退化为标注）
  try {
    new TextDecoder('gbk', { fatal: true }).decode(sample);
    return 'gbk';
  } catch {
    return 'binary-or-mixed';
  }
}

const map = { generatedAt: new Date().toISOString(), roots, rules: [], byDir: {}, totals: {} };
const dirStats = new Map();
let files = 0;

function walk(p) {
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) walk(full); continue; }
    if (!e.isFile()) continue;
    if (!TEXT_EXT.test(e.name)) continue;
    let buf;
    try { buf = fs.readFileSync(full); } catch { continue; }
    const enc = detect(buf);
    files++;
    map.totals[enc] = (map.totals[enc] || 0) + 1;
    let d = dirStats.get(p);
    if (!d) { d = {}; dirStats.set(p, d); }
    d[enc] = (d[enc] || 0) + 1;
  }
}

for (const r of roots) walk(r);

// 目录级结论：该目录里占多数的编码
for (const [dir, stats] of dirStats) {
  const top = Object.entries(stats).sort((a, b) => b[1] - a[1])[0];
  map.byDir[dir] = { encoding: top[0], files: stats, note: Object.keys(stats).length > 1 ? '混合：见 files 分布' : '' };
}

// 生成"读取规则"（按扩展名 + 目录）
map.rules.push({ match: '*.jsonl (History/**)', encoding: 'utf8', note: '窗口与聊天历史，UTF-8 无 BOM' });
map.rules.push({ match: 'state/**/*.json', encoding: 'utf8-bom-tolerant', note: '部分文件带 BOM，读时 replace(/^\\uFEFF/,"")' });
map.rules.push({ match: '**/*.md,*.mjs,*.ps1', encoding: 'utf8', note: '源码与文档，UTF-8' });
map.rules.push({ match: 'qq-bridge/state/*.log', encoding: 'utf8', note: '桥接日志' });
map.rules.push({ match: '规则：任何文本读取先查本表；不确定就 auto（见 read-text.mjs）', encoding: '-', note: '' });

fs.writeFileSync(OUT, JSON.stringify(map, null, 2));
console.log('扫描完成：', files, '个文本文件');
console.log('编码分布：', Object.entries(map.totals).map(([k, v]) => `${k}=${v}`).join(', '));
const mixed = Object.entries(map.byDir).filter(([, v]) => Object.keys(v.files).length > 1);
console.log('混合编码目录：', mixed.length ? mixed.map(([d]) => d).join(' | ') : '无');
console.log('映射表：', OUT);

