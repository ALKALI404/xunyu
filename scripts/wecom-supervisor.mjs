// scripts\wecom-supervisor.mjs —— 看住企微通道的三个常驻进程
//   wecom-ingest-tess.mjs（截图→OCR→入库）
//   wecom-dispatch.mjs   （按会话存档 + 索引）
// 任何一个退出就 5 秒后拉起；自己写日志 logs\wecom-supervisor.log
//
// 用法：node scripts\wecom-supervisor.mjs          常驻
//       node scripts\wecom-supervisor.mjs --status 只打印当前状态
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/DSH_workspace';
const LOG = path.join(ROOT, 'logs', 'wecom-supervisor.log');
const NODE = process.execPath;

const TARGETS = [
  { name: 'ingest', script: 'scripts/wecom-ingest-tess.mjs', args: [] },
  { name: 'dispatch', script: 'scripts/wecom-dispatch.mjs', args: ['--watch'] },
];

function log(s) {
  const line = `${new Date().toISOString()} ${s}`;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { }
  console.log(line);
}

const procs = new Map();
let stopping = false;

function start(t) {
  const child = spawn(NODE, [t.script, ...t.args], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  procs.set(t.name, { child, startedAt: Date.now() });
  log(`启动 ${t.name} pid=${child.pid}`);
  child.on('exit', (code, sig) => {
    log(`${t.name} 退出 code=${code} sig=${sig ?? ''}`);
    procs.delete(t.name);
    if (!stopping) setTimeout(() => start(t), 5000);
  });
  child.on('error', (e) => log(`${t.name} 启动失败：${String(e.message).slice(0, 90)}`));
}

if (process.argv.includes('--status')) {
  for (const t of TARGETS) log(`目标 ${t.name} -> ${t.script}`);
  process.exit(0);
}

log('企微通道守护启动');
for (const t of TARGETS) start(t);

process.on('SIGINT', () => { stopping = true; for (const { child } of procs.values()) child.kill(); process.exit(0); });
process.on('SIGTERM', () => { stopping = true; for (const { child } of procs.values()) child.kill(); process.exit(0); });
