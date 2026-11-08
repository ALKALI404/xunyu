// scripts\self-work-patrol.mjs —— 常驻巡逻：每 10 分钟查一次"本体有没有下场"
// 为什么单独一个：qq-bridge-watchdog-loop 只管桥；这条规矩要独立跑，出事才追得到。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WS = 'E:/DSH_workspace';
const LOG = path.join(WS, 'state', 'self-work-patrol.log');
const EVERY = Number(process.argv[2] || 600);

const log = (s) => {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} [patrol] ${s}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { }
};

log(`启动，每 ${EVERY}s 查一次`);

for (;;) {
  await new Promise((res) => {
    const c = spawn(process.execPath, ['scripts/self-work-guard.mjs'], { cwd: WS, stdio: 'ignore', windowsHide: true });
    c.on('exit', (code) => {
      if (code !== 0) log('发现疑似下场（已写入 state\\self-work-violations.jsonl）');
      res();
    });
    c.on('error', () => res());
  });
  await new Promise((r) => setTimeout(r, EVERY * 1000));
}
