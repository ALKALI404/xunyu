#!/usr/bin/env node
// scripts\wecom-vm-health.mjs —— 企微 VM 健康探针（WC-005 / W-248，03·维护 2026-10-30）
//
// 回答一个问题：**VM 里的企微现在到底"在不在"？** 四件事：
//   ssh      —— 宿主能不能连进 VM（TCP 22 + 一次成功命令）
//   wxwork   —— WXWork.exe 的 pid
//   window   —— 主窗口 hwnd（0 = 进程在但窗口被销毁/收进托盘，这正是自动化枚举返回 0 的原因）
//   loggedIn —— VM 桌面是否有已登录的交互会话（远程/控制台都算）
//
// 判据（工单 §2）：ssh.ok && pid>0 && hwnd>0 && loggedIn=true → 健康；否则 exit 1，探针不要"猜健康"。
//
// 用法：
//   node scripts\wecom-vm-health.mjs            # 人类可读
//   node scripts\wecom-vm-health.mjs --json     # 机读（给看板/计划任务）
//   node scripts\wecom-vm-health.mjs --ssh-key C:\Users\Xuchi\.ssh\id_ed25519
//
// 环境变量：WECOM_VM_HOST（默认 192.168.123.118）、WECOM_VM_USER（默认 xuchi）、WECOM_VM_SSH_KEY
//
// 出口码：0 健康 / 1 不健康（能连但缺件）/ 2 连不上 / 3 用法错
// 只读：不动 VM 任何东西，不重启企微（重启是 VM 内看护任务的事）。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const STATE = path.join(HERE, '..', 'state', 'wecom-vm-health.json');

const HOST = process.env.WECOM_VM_HOST || '192.168.123.118';
const USER = process.env.WECOM_VM_USER || 'xunyu';
const KEY = process.env.WECOM_VM_SSH_KEY || 'C:\\Users\\Xuchi\\.ssh\\id_ed25519';
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const SSH_TIMEOUT_MS = 15000;
const TCP_TIMEOUT_MS = 3000;

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const keyArgIdx = argv.indexOf('--ssh-key');
const sshKey = keyArgIdx >= 0 ? argv[keyArgIdx + 1] : KEY;

/**
 * 远端要跑的 PowerShell：只读地取「企微进程 + 会话 + 看护任务写的窗口状态」。
 *
 * 为什么 hwnd 不在这里自己枚举：ssh 进 VM 落在 **session 0**，而企微窗口在 **session 2**；
 * session 0 里 EnumWindows 看不到别人的窗口（Get-Process 的 MainWindowHandle 也是 0）。
 * 所以窗口事实只能由**跑在用户会话里**的看护任务写进状态文件，探针读它。
 */
const REMOTE_PS = [
  '$ErrorActionPreference="SilentlyContinue"',
  '$p=@(Get-Process WXWork)',
  '$s=@(quser 2>$null)',
  '$st=$null',
  'try { $st = Get-Content "C:\\xunyu\\wecom-watchdog-status.json" -Raw | ConvertFrom-Json } catch { }',
  '[ordered]@{',
  '  user=$env:USERNAME;',
  '  loggedIn=([bool]($s.Count -gt 1));',
  '  wxworkCount=$p.Count;',
  '  wxworkPids=@($p | ForEach-Object { $_.Id });',
  '  status=$st',
  '} | ConvertTo-Json -Depth 5 -Compress'
].join('\n');

function tcpProbe(port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { }
      resolve({ ok, error: error ?? null });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (error) => finish(false, String(error?.code ?? error?.message ?? error)));
    socket.connect(port, HOST);
  });
}

/** 在 VM 里跑一条只读命令，拿回结构化数据。 */
function sshExec(remoteCommand) {
  return new Promise((resolve) => {
    const args = [
      '-i', sshKey,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=8',
      '-o', 'ServerAliveInterval=5',
      `${USER}@${HOST}`,
      remoteCommand
    ];
    execFile(SSH, args, { encoding: 'utf8', windowsHide: true, timeout: SSH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout ?? '').trim();
      const err = String(stderr ?? '').trim();
      if (error) {
        const code = typeof error.code === 'number' ? error.code : (error.killed ? 'timeout' : String(error.code ?? 'spawn-fail'));
        resolve({ ok: false, code, error: err.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? String(error.message ?? ''), stdout: out });
        return;
      }
      resolve({ ok: true, code: 0, error: '', stdout: out });
    });
  });
}

function parseRemote(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).reverse()
    .find((s) => s.startsWith('{')) ?? '';
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

async function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法: node scripts\\wecom-vm-health.mjs [--json] [--ssh-key <path>]\n');
    return;
  }
  const startedAt = Date.now();
  const tcp = await tcpProbe(22);
  const result = {
    tool: 'wecom-vm-health',
    version: '1.0.0',
    at: new Date().toISOString(),
    host: HOST,
    ssh: { ok: false, tcp: tcp.ok, tcpError: tcp.error, code: null, error: '' },
    wxwork: { pid: null, count: 0, pids: [] },
    window: { hwnd: null, title: '' },
    loggedIn: null,
    ok: false,
    ms: 0,
    detail: ''
  };

  if (!tcp.ok) {
    result.detail = `VM 22 端口不通（${tcp.error ?? 'closed'}）：VM 没起 / 网络不通`;
    result.ms = Date.now() - startedAt;
    emit(result, asJson);
    process.exitCode = 2;
    return;
  }

  // 用 -EncodedCommand 传多行 PowerShell：直接塞 "powershell -Command \"...\"" 会被 ssh/cmd 的
  // 换行与 $ 展开搞坏（实测远端只返回报错，解析不到 JSON）。
  const encoded = Buffer.from(REMOTE_PS, 'utf16le').toString('base64');
  const run = await sshExec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`);
  result.ssh.ok = run.ok;
  result.ssh.code = run.code;
  result.ssh.error = run.error;

  if (run.ok) {
    const data = parseRemote(run.stdout);
    if (!data) {
      result.ssh.ok = false;
      result.ssh.error = '远端没返回 JSON（PowerShell 版本或权限问题？）';
    } else {
      result.wxwork.count = Number(data.wxworkCount ?? 0);
      result.wxwork.pids = Array.isArray(data.wxworkPids) ? data.wxworkPids.map(Number) : [];
      result.wxwork.pid = result.wxwork.pids[0] ?? null;
      result.loggedIn = data.loggedIn === true;
      result.user = data.user ?? null;
      const st = data.status ?? null;
      const stAt = st?.at ? Date.parse(st.at) : NaN;
      const stAgeMs = Number.isFinite(stAt) ? Date.now() - stAt : null;
      result.watchdog = st
        ? { at: st.at, ageMs: stAgeMs, action: st.action ?? '', sessionId: st.sessionId ?? null, hwnd: Number(st.hwnd ?? 0) }
        : null;
      const fresh = Boolean(st) && Number.isFinite(stAgeMs) && stAgeMs <= 180000;   // 看护 60s 一跳，3 分钟内算新鲜
      result.window.hwnd = fresh ? Number(st.hwnd ?? 0) : 0;
      result.window.title = fresh ? String(st.title ?? '') : '';
      result.window.visible = fresh ? st.visible !== false : null;
      result.window.fresh = fresh;
      if (!st) result.window.note = '看护任务还没写过状态（C:\\xunyu\\wecom-watchdog-status.json 不存在）';
      else if (!fresh) result.window.note = `看护状态过期 ${Math.round(Number(stAgeMs) / 1000)}s（看护任务没在跑？）`;
    }
  }

  result.ok = Boolean(result.ssh.ok && result.wxwork.pid && result.window.hwnd && result.loggedIn && result.window.visible !== false);
  // 工单要的最小形状（04 的发送器只认这四个键）
  result.summary = {
    ssh: Boolean(result.ssh.ok),
    wxworkPid: result.wxwork.pid ?? null,
    windowHwnd: result.window.hwnd ?? null,
    loggedIn: result.loggedIn === true
  };
  if (!result.ok) {
    const missing = [];
    if (!result.ssh.ok) missing.push(`ssh 不通（${result.ssh.code}：${result.ssh.error || 'auth/连接失败'}）`);
    if (result.ssh.ok && !result.wxwork.pid) missing.push('WXWork.exe 不在');
    if (result.ssh.ok && result.wxwork.pid && !result.window.hwnd) missing.push('企微主窗口 hwnd=0（被收进托盘/销毁）');
    if (result.ssh.ok && result.window.hwnd && result.window.visible === false) missing.push('主窗口 hwnd 在但 visible=false（收进托盘，自动化枚举会返回 0）');
    if (result.ssh.ok && result.loggedIn === false) missing.push('VM 桌面没有已登录会话');
    result.detail = missing.join('；');
  } else {
    result.detail = `pid=${result.wxwork.pid} hwnd=${result.window.hwnd} 窗口="${result.window.title}"`;
  }
  result.ms = Date.now() - startedAt;
  emit(result, asJson);
  process.exitCode = result.ok ? 0 : (result.ssh.ok ? 1 : 2);
}

function emit(result, json) {
  // 落一份状态给 supervisor / 看板读（每次运行都覆盖；失败也要落，别让面板看到旧的成功）
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, `${JSON.stringify(result)}\n`, 'utf8');
  } catch { }
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const line = [
    `VM ${result.host}`,
    `ssh=${result.ssh.ok ? 'ok' : `FAIL(${result.ssh.error || result.ssh.code})`}`,
    `wxwork=${result.wxwork.pid ?? '—'}`,
    `hwnd=${result.window.hwnd ?? '—'}`,
    `loggedIn=${result.loggedIn === null ? '?' : result.loggedIn}`,
    `→ ${result.ok ? 'OK' : 'NOT-OK'}`
  ].join('  ');
  process.stdout.write(`${line}\n`);
  if (result.summary) {
    process.stdout.write(`  ${JSON.stringify(result.summary)}\n`);
  }
  if (result.detail) process.stdout.write(`  ${result.detail}\n`);
}

main().catch((error) => {
  process.stderr.write(`wecom-vm-health 崩了：${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
