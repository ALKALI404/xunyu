#!/usr/bin/env node
/**
 * peek —— 工具输出的「先落盘、只取一片」通道（2026-10-27 立）
 *
 * 为什么：上下文解剖实测（本体 d8fd2fbd，6 轮 104 步）里，工具返回占 32.3%、
 *         而且一旦进上下文就永久留着、每一步都重发。主人 2026-10-27 定：
 *         修工具返回，思考等级不降（上下文长了靠缓存命中对冲）。
 *
 * 用法：
 *   node scripts\peek.mjs --run "<shell 命令>" [--grep <正则>] [--head N] [--tail N] [--max 4000]
 *   node scripts\peek.mjs --file <路径>        [--grep <正则>] [--head N] [--tail N] [--max 4000]
 *
 * 行为：命令输出**整份落盘**到 tmp\peek-<时间戳>.log（可复查），终端只打印
 *       「命中行 / 头 N 行 / 尾 N 行」，并在末尾告诉你全文有几行、在哪。
 *
 * 退出码：透传被包装命令的退出码（0/1/…），便于 && 串联。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const val = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const RUN = val('run');
const FILE = val('file');
const GREP = val('grep');
const HEAD = val('head') != null ? Number(val('head')) : null;
const TAIL = val('tail') != null ? Number(val('tail')) : null;
const MAX = Number(val('max', 4000));

if (!RUN && !FILE) {
  console.log('用法：node scripts\\peek.mjs --run "<命令>" [--grep 正则] [--head N] [--tail N] [--max 字符数]');
  console.log('      node scripts\\peek.mjs --file <路径>   [--grep 正则] [--head N] [--tail N]');
  process.exit(2);
}

const ROOT = path.resolve(process.env.PEEK_ROOT ?? process.cwd(), 'tmp');
fs.mkdirSync(ROOT, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
const dump = path.join(ROOT, `peek-${stamp}.log`);

let text = '';
let code = 0;
if (RUN) {
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  // Windows 上 spawnSync(shell:true) 走的是 cmd.exe，PowerShell 语法（| Where-Object、$_）直接炸。
  // 本机也没有 pwsh 7（`where pwsh` 为空，DSH 宿主跑的是 Windows PowerShell 5.1），所以直指 powershell.exe，
  // 并在命令前把控制台输出编码钉成 UTF-8，否则中文会乱码。
  const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${RUN}`;
  let r;
  if (process.platform === 'win32' && fs.existsSync(PS)) {
    r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], opts);
  } else if (process.platform === 'win32') {
    r = spawnSync(RUN, { ...opts, shell: true });
  } else {
    r = spawnSync('/bin/sh', ['-c', RUN], opts);
  }
  text = `${r.stdout ?? ''}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}`;
  code = r.status ?? 0;
  fs.writeFileSync(dump, text, 'utf8');
} else {
  text = fs.readFileSync(FILE, 'utf8');
  fs.writeFileSync(dump, text, 'utf8');
}

const all = text.split(/\r?\n/);
let picked = all.map((line, i) => ({ line, i }));
if (GREP) {
  const re = new RegExp(GREP, 'i');
  picked = picked.filter((x) => re.test(x.line));
}
if (HEAD != null) picked = picked.slice(0, HEAD);
else if (TAIL != null) picked = picked.slice(-TAIL);
else if (!GREP) picked = picked.slice(0, 60); // 没给任何选择：默认头 60 行，不喂整份

let out = picked.map((x) => x.line).join('\n');
if (out.length > MAX) out = out.slice(0, MAX) + `\n…（截断，原 ${out.length} 字符，见落盘）`;
console.log(out);
console.log(`\n── peek ── 全文 ${all.length} 行 / ${text.length} 字符${GREP ? ` · 命中 ${picked.length} 行（grep=${GREP}）` : ''} → ${dump}`);
process.exit(code);
