#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts\read-text.mjs —— 按 state\encoding-map.json 的规则读取文本，统一输出 UTF-8
// 用法: node scripts\read-text.mjs <文件路径> [--head N] [--tail N] [--json]
import fs from 'node:fs';
import path from 'node:path';

const MAP_FILE = 'E:/DSH_workspace/state/encoding-map.json';
const target = process.argv[2];
if (!target) { console.error('用法: node scripts\\read-text.mjs <文件> [--head N]'); process.exit(2); }

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const head = argOf('--head', 0), tail = argOf('--tail', 0);

let map = null;
try { map = readJson(MAP_FILE); } catch { /* 没有表也能跑 */ }

function guessByDir(file) {
  if (!map) return null;
  const dir = path.dirname(file);
  const key = Object.keys(map.byDir).find((d) => path.resolve(d) === path.resolve(dir));
  if (!key) return null;
  const enc = map.byDir[key].encoding;
  return enc === 'utf8-bom' ? 'utf8' : enc;
}

// 优先级：BOM 实测 > 目录结论 > UTF-8 试探 > GBK
function readSmart(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf8-bom', by: 'bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf16le', by: 'bom' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8', by: 'probe' };
  } catch { /* 继续 */ }
  const dirGuess = guessByDir(file);
  if (dirGuess === 'gbk') {
    try { return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk', by: 'map' }; } catch { /* 继续 */ }
  }
  return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk', by: 'fallback' };
}

if (!fs.existsSync(target)) { console.error('文件不存在:', target); process.exit(1); }
const { text, encoding, by } = readSmart(target);
let lines = text.split(/\r?\n/);
if (head > 0) lines = lines.slice(0, head);
if (tail > 0) lines = lines.slice(-tail);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ file: target, encoding, detectedBy: by, lines: lines.length }, null, 2));
  process.exit(0);
}
console.log(`# ${target}  [编码=${encoding} 判定=${by} 行数=${lines.length}]`);
console.log(lines.join('\n'));
