// scripts\qq-bridge-watchdog.mjs —— 桥的看门狗：3100 不通就把它拉起来
//
// 为什么需要：2026-11-03 22:21 桥被"硬杀"（走不到 exit 钩子，bridge-crash.log 没记录），
// 之后三条 QQ 通道全哑。与其等下一次，不如每 2 分钟自检一次。
//
// 用法：
//   node scripts\qq-bridge-watchdog.mjs            检查一次，必要时拉起
//   node scripts\qq-bridge-watchdog.mjs --status   只看状态
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

const BRIDGE_DIR = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1';
const LOG = path.join(BRIDGE_DIR, 'state', 'watchdog.log');
const PORT = 3100;

const statusOnly = process.argv.includes('--status');
const log = (s) => {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} [watchdog] ${s}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { }
  process.stdout.write(line);
};

const isUp = () => new Promise((res) => {
  const s = net.connect({ port: PORT, host: '127.0.0.1' }, () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  s.setTimeout(1500, () => { s.destroy(); res(false); });
});

// 桥自己会写 lock；如果 3100 不通但还有 bridge.js 进程，先别急着重启（可能在启动中）
function bridgeProcs() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"],
      { encoding: 'utf8', timeout: 15000 });
    return out.split(/\r?\n/).filter((l) => l.includes('bridge.js')).map((l) => l.split('|')[0]);
  } catch { return []; }
}

const up = await isUp();
const procs = bridgeProcs();

if (statusOnly) {
  log(`3100=${up ? '在听' : '不通'}；bridge 进程=${procs.length ? procs.join(',') : '无'}`);
  process.exit(up ? 0 : 1);
}

if (up) {
  if (procs.length === 0) log('⚠ 3100 在听但没找到 bridge.js 进程（可能是别的进程占端口）');
  process.exit(0);
}

if (procs.length > 0) {
  log(`3100 不通，但已有 bridge 进程 ${procs.join(',')}——可能正在启动，这次不动`);
  process.exit(0);
}

log('3100 不通且没有 bridge 进程 → 拉起');
try { fs.unlinkSync(path.join(BRIDGE_DIR, 'state', 'bridge.lock')); } catch { }

const child = spawn(process.execPath, ['src/bridge.js'], {
  cwd: BRIDGE_DIR,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
log(`已拉起 pid=${child.pid}`);

// 给它 15 秒，再看端口
await new Promise((r) => setTimeout(r, 15000));
const ok = await isUp();
log(ok ? '✅ 拉起成功，3100 在听' : '❌ 拉起后 3100 仍不通，需要人看');
process.exit(ok ? 0 : 1);

// ── --loop 常驻模式（2026-11-04 新增）─────────────────────────────
// 为什么：用计划任务每 2 分钟拉起一次 node，会在桌面闪 CMD 窗口。
// 改成一个常驻进程自己 sleep，桌面一次窗口都不弹。
if (process.argv.includes('--loop')) {
  const every = Number(process.argv[process.argv.indexOf('--loop') + 1]) || 120;
  log(`常驻模式启动：每 ${every} 秒检查一次（不弹窗）`);
  for (;;) {
    const up = await isUp();
    if (!up) {
      const procs = bridgeProcs();
      if (procs.length === 0) {
        log('3100 不通且没有 bridge 进程 → 拉起');
        try { fs.unlinkSync(path.join(BRIDGE_DIR, 'state', 'bridge.lock')); } catch { }
        const child = spawn(process.execPath, ['src/bridge.js'], { cwd: BRIDGE_DIR, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        log(`已拉起 pid=${child.pid}`);
        await new Promise((r) => setTimeout(r, 15000));
        log((await isUp()) ? '✅ 拉起成功' : '❌ 拉起后仍不通');
      }
    }
    await new Promise((r) => setTimeout(r, every * 1000));
  }
}