// scripts\qq-bridge-watchdog-loop.mjs —— 常驻看门狗（不弹窗）：每 N 秒跑一次单次检查
//
// 为什么单独一个文件：单次检查脚本末尾有 process.exit，直接把 loop 追加在它后面永远跑不到。
// 用这个文件常驻（由 wscript 以隐藏方式启动），每 120 秒 spawn 一次单次检查。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE_DIR = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1';
const SELF = 'E:/DSH_workspace/scripts/qq-bridge-watchdog.mjs';
const LOG = path.join(BRIDGE_DIR, 'state', 'watchdog.log');
const EVERY = Number(process.argv[2] ?? 120);

const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (s) => { const line = `${stamp()} [watchdog-loop] ${s}\n`; try { fs.appendFileSync(LOG, line, 'utf8'); } catch { } };

log(`常驻启动，每 ${EVERY}s 检查一次`);

function once() {
  return new Promise((res) => {
    const c = spawn(process.execPath, [SELF], { stdio: 'ignore', windowsHide: true });
    c.on('exit', (code) => res(code));
    c.on('error', () => res(-1));
  });
}

for (;;) {
  const code = await once();
  if (code !== 0) log(`单次检查退出码 ${code}（0=正常，1=发现问题/已处理）`);
  // 每 30 轮（约 1 小时）留一条心跳，证明它还活着
  if (!globalThis.__beat) globalThis.__beat = 0;
  globalThis.__beat += 1;
  if (globalThis.__beat % 30 === 0) log('心跳：还活着');
  await new Promise((r) => setTimeout(r, EVERY * 1000));
}
