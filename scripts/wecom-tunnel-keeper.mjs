#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// 企微反向隧道 keeper（D81，03·维护 2026-10-29）
//
// 背景：企微回调 → nginx(115.191.6.89) → 服务器 127.0.0.1:18788 → SSH 反向隧道 → 本机 8788。
// 隧道以前是「临时起在后台」的 ssh 进程，一断全断、也没人拉。这个 keeper：
//   ① 每 30s 探一次 https://theglobalscm.top/wecom —— 返回 400/403（本地服务在应答）算通；
//      超时 / 5xx / 网络错误判死；
//   ② 判死后先杀残留反向隧道 ssh（避免 remote port forwarding failed），再重新起；
//   ③ 连续断线（10 分钟内第 5 次重启）→ 邮件报本体，并**继续重试、拉长间隔**（60→120→300s），不许 give-up；
//   ④ 日志 logs\wecom-tunnel.log（连/断/重启/邮件），状态 state\wecom-tunnel.json（给工作台/排障读）。
//
// 启动：由 supervisor 托管（开机登录后自动拉起）；不要从会话里手动常驻。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const LOG = path.join(WORKSPACE, 'logs', 'wecom-tunnel.log');
const STATUS = path.join(WORKSPACE, 'state', 'wecom-tunnel.json');
const MAIL = path.join(WORKSPACE, 'scripts', 'mail.mjs');

const PROBE_URL = 'https://theglobalscm.top/wecom';
const PROBE_TIMEOUT_MS = 8000;
const BASE_INTERVAL_MS = 30000;
const CERT_SCRIPT = path.join(WORKSPACE, 'scripts', 'cert-watch.mjs');
const CERT_STATE = path.join(WORKSPACE, 'state', 'cert-watch.json');
const RECON_SCRIPT = path.join(WORKSPACE, 'scripts', 'cost-recon.mjs');
const RECON_STATE = path.join(WORKSPACE, 'state', 'cost-recon.json');
const VM_HEALTH_SCRIPT = path.join(WORKSPACE, 'scripts', 'wecom-vm-health.mjs');
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const SSH_ARGS = [
  '-i', 'C:\\Users\\Xuchi\\.ssh\\id_ed25519',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-N',
  '-R', '127.0.0.1:18788:127.0.0.1:8788',
  'root@115.191.6.89'
];
const TUNNEL_MATCH = '18788:127.0.0.1:8788';

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本地 8788 是否在听：用来区分「隧道断」和「本地服务断」——后者重启隧道没用，等 WeCom watchdog。 */
function localBridgeUp(port = 8788, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => { try { sock.destroy(); } catch { } resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); try { sock.destroy(); } catch { } resolve(true); });
    sock.once('error', () => { clearTimeout(timer); try { sock.destroy(); } catch { } resolve(false); });
  });
}

function log(msg) {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} [tunnel] ${msg}`;
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { }
  process.stdout.write(line + '\n');
}

function writeStatus(patch = {}) {
  let prev = {};
  try { prev = readJson(STATUS); } catch { }
  const next = { ...prev, ...patch, at: nowIso() };
  try { fs.mkdirSync(path.dirname(STATUS), { recursive: true }); fs.writeFileSync(STATUS, JSON.stringify(next) + '\n', 'utf8'); } catch { }
}

/** 探针：200–499 都算「有应答」（企微回调没带 echostr 时 nginx/本地会回 400）。 */
async function probe() {
  try {
    const res = await fetch(PROBE_URL, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const status = res.status;
    const up = status >= 200 && status < 500;
    // detail 保持 ASCII：state\wecom-tunnel.json 可能被 PowerShell 5.1 按 ANSI 读，中文会把它读坏。
    return { up, status, detail: `HTTP ${status}` };
  } catch (error) {
    const name = String(error?.name ?? 'ERR');
    return { up: false, status: 0, detail: `ERR ${name === 'TimeoutError' ? 'timeout' : name}` };
  }
}

/** 找残留的反向隧道 ssh 进程（只认带 -R 18788:127.0.0.1:8788 的，不碰别的 ssh）。 */
function findTunnelPids() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | "
    + `Where-Object { $_.CommandLine -match '${TUNNEL_MATCH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' } | `
    + 'ForEach-Object { $_.ProcessId }';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 8000
    });
    return out.split(/\s+/).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
  } catch (error) {
    log(`查隧道进程失败：${String(error?.message ?? error).slice(0, 120)}`);
    return [];
  }
}

function killTunnelPids() {
  const pids = findTunnelPids();
  if (!pids.length) return 0;
  for (const pid of pids) {
    try { process.kill(pid); log(`杀掉残留隧道 pid=${pid}`); } catch { }
  }
  return pids.length;
}

let child = null;
function startTunnel() {
  killTunnelPids();
  try {
    child = spawn(SSH, SSH_ARGS, { windowsHide: true, stdio: 'ignore' });
    child.on('exit', (code, sig) => log(`ssh 退出 code=${code} sig=${sig ?? '-'}`));
    log(`起隧道 pid=${child.pid}（-R 18788 → 8788 → root@115.191.6.89）`);
    return child.pid;
  } catch (error) {
    log(`起隧道失败：${String(error?.message ?? error).slice(0, 160)}`);
    return 0;
  }
}

function sendMail(subject, body) {
  try {
    execFileSync('node', [MAIL, 'post', '--to', '本体', '--from', 'wecom-tunnel', '--body', `${subject}\n${body}`], {
      cwd: WORKSPACE, encoding: 'utf8', windowsHide: true, timeout: 15000
    });
    log(`已邮件报本体：${subject}`);
    return true;
  } catch (error) {
    log(`邮件失败：${String(error?.message ?? error).slice(0, 120)}`);
    return false;
  }
}

const restarts = [];   // 最近 10 分钟内的重启时刻
let mailedForWindow = false;
let lastFailMailAt = 0;   // D88：重启后仍不通的报丧去重（30 分钟最多一封）
let certSpawnDay = '';    // D88：本进程今天拉起过 cert-watch 就不再拉
let reconSpawnDay = '';   // WS-007：同上，花费对账（12:00 之后）
let lastVmHealthAt = 0;   // WC-005：企微 VM 健康探针，5 分钟一次
let intervalMs = BASE_INTERVAL_MS;
let wasUp = null;

/** D88：每天一次的证书体检——今天还没跑过就拉起 cert-watch（一次性进程，不占探测循环）。 */
function maybeCertCheck() {
  const day = new Date().toLocaleDateString('sv-SE');
  if (certSpawnDay === day) return;
  let lastDay = '';
  try {
    const st = readJson(CERT_STATE);
    if (st?.at) lastDay = new Date(st.at).toLocaleDateString('sv-SE');
  } catch { }
  if (lastDay === day) { certSpawnDay = day; return; }
  try {
    if (!fs.existsSync(CERT_SCRIPT)) { log('证书体检：找不到 cert-watch.mjs，跳过'); return; }
    certSpawnDay = day;
    const proc = spawn('node', [CERT_SCRIPT], { windowsHide: true, stdio: 'ignore' });
    proc.on('error', (error) => log(`证书体检拉起失败：${String(error?.message ?? error)}`));
    log(`证书体检：已拉起 cert-watch（每日一次，pid=${proc.pid ?? '?'}）`);
  } catch (error) {
    log(`证书体检拉起失败：${String(error?.message ?? error).slice(0, 120)}`);
  }
}

/** WS-007：每天 12:00 之后跑一次「昨天全天」的花费三方对账（FAIL 时 cost-recon 自己报本体）。 */
function maybeCostRecon() {
  if (new Date().getHours() < 12) return;
  const day = new Date().toLocaleDateString('sv-SE');
  if (reconSpawnDay === day) return;
  let lastDay = '';
  try {
    const st = readJson(RECON_STATE);
    if (st?.at) lastDay = new Date(st.at).toLocaleDateString('sv-SE');
  } catch { }
  if (lastDay === day) { reconSpawnDay = day; return; }
  try {
    if (!fs.existsSync(RECON_SCRIPT)) { log('花费对账：找不到 cost-recon.mjs，跳过'); return; }
    reconSpawnDay = day;
    const proc = spawn('node', [RECON_SCRIPT, '--day', 'yesterday', '--notify'], { windowsHide: true, stdio: 'ignore' });
    proc.on('error', (error) => log(`花费对账拉起失败：${String(error?.message ?? error)}`));
    log(`花费对账：已拉起 cost-recon --day yesterday（每日 12:00 后，pid=${proc.pid ?? '?'}）`);
  } catch (error) {
    log(`花费对账拉起失败：${String(error?.message ?? error).slice(0, 120)}`);
  }
}

function pruneRestarts() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  while (restarts.length && restarts[0] < cutoff) restarts.shift();
  if (!restarts.length) mailedForWindow = false;
}

function computeInterval() {
  pruneRestarts();
  const n = restarts.length;
  if (n >= 8) return 300000;
  if (n >= 6) return 120000;
  if (n >= 5) return 60000;
  return BASE_INTERVAL_MS;
}

/** 2026-10-29（03）：8788 没了就把它拉起来——隧道救不了「宿主本身不在」。
 *  以前这里只写一行日志就去等 WeCom watchdog；但那个 watchdog 20:43 自己死了、也不在启动项里，
 *  结果 21:09 重启后 8788 一直没人起，隧道只能报 local-8788-down。 */
const WECOM_ROOT = 'E:\\DSH-WeCom\\bridge';
const WECOM_SERVER = path.join(WECOM_ROOT, 'src', 'server.mjs');
let lastWecomStartAt = 0;
function ensureWeComBridge() {
  if (Date.now() - lastWecomStartAt < 60000) return;   // 60 秒冷却，别和 supervisor 抢着起
  try {
    if (!fs.existsSync(WECOM_SERVER)) { log('企微桥：找不到 E:\\DSH-WeCom\\bridge\\src\\server.mjs，跳过'); return; }
    lastWecomStartAt = Date.now();
    const logDir = path.join(WECOM_ROOT, 'logs');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch { }
    const out = fs.openSync(path.join(logDir, 'server.out.log'), 'a');
    const err = fs.openSync(path.join(logDir, 'server.err.log'), 'a');
    const proc = spawn('node', ['src\\server.mjs'], { cwd: WECOM_ROOT, windowsHide: true, stdio: ['ignore', out, err] });
    proc.on('error', (error) => log(`企微桥拉起失败：${String(error?.message ?? error)}`));
    log(`企微桥 8788 不在听 → 已拉起 server.mjs（pid=${proc.pid ?? '?'}）`);
  } catch (error) {
    log(`企微桥拉起失败：${String(error?.message ?? error).slice(0, 120)}`);
  }
}

/** WC-005：每 5 分钟跑一次企微 VM 健康探针（探针自己写 state\wecom-vm-health.json，并给出口码）。 */
function maybeVmHealth() {
  if (Date.now() - lastVmHealthAt < 5 * 60 * 1000) return;
  lastVmHealthAt = Date.now();
  try {
    if (!fs.existsSync(VM_HEALTH_SCRIPT)) return;
    const proc = spawn('node', [VM_HEALTH_SCRIPT], { windowsHide: true, stdio: 'ignore' });
    proc.on('error', (error) => log(`VM 健康探针拉起失败：${String(error?.message ?? error)}`));
  } catch (error) {
    log(`VM 健康探针拉起失败：${String(error?.message ?? error).slice(0, 120)}`);
  }
}

async function recover(reason) {
  log(`判死（${reason}）→ 重启隧道`);
  // 一轮内重试 3 次：刚杀的 ssh 会让服务器端 18788 短暂占着，新 ssh -R 可能 ExitOnForwardFailure 直接退；
  // 隔 2 秒再起一般就成功（以前一轮只试一次，最坏要等 30–60 秒后的下一轮，实测有 62 秒的复原）。
  let ok = false;
  let usedPid = 0;
  let last = { up: false, detail: 'not-tried' };
  for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
    usedPid = startTunnel();
    await sleep(3000);
    last = await probe();
    if (last.up) { ok = true; log(`隧道恢复（第 ${attempt} 次拉起，pid=${usedPid || '?'}，${last.detail}）`); break; }
    log(`第 ${attempt} 次拉起未通（${last.detail}）`);
    if (attempt < 3) { killTunnelPids(); await sleep(2000); }
  }
  const at = Date.now();
  restarts.push(at);
  pruneRestarts();
  if (ok) {
    wasUp = true;
    writeStatus({ ok: true, sshPid: usedPid || null, lastOkAt: nowIso(), detail: last.detail, restartsIn10m: restarts.length });
  } else {
    log('本轮 3 次都没通，交给下一轮（不 give-up）');
    wasUp = false;
    writeStatus({ ok: false, sshPid: usedPid || null, lastFailAt: nowIso(), detail: last.detail, restartsIn10m: restarts.length });
    // D88：重启了还是不通 → 「不是偶发掉线」了，报本体一次（30 分钟去重，不狂发）。
    if (Date.now() - lastFailMailAt > 30 * 60 * 1000) {
      lastFailMailAt = Date.now();
      sendMail(
        '【企微隧道】重启隧道后仍不通',
        `探针 ${last.detail}；一轮内起了 3 次都没通（服务器端 18788 / 本地 8788 可能真出问题）。`
        + `keeper 会继续按退避间隔重试（不会 give-up），人工可看 logs\\wecom-tunnel.log。`
      );
    }
  }
  if (restarts.length === 5 && !mailedForWindow) {
    mailedForWindow = true;
    const seq = sendMail(
      '【企微隧道】10 分钟内第 5 次断线重启',
      `最近一次：${last.detail}；间隔已拉长到 ${Math.round(computeInterval() / 1000)}s，仍会继续重试（不会 give-up）。日志：${LOG}`
    );
    writeStatus({ mailed: seq, mailedAt: nowIso() });
  }
  intervalMs = computeInterval();
  log(`下次探测间隔 ${Math.round(intervalMs / 1000)}s（10 分钟内重启 ${restarts.length} 次）`);
}

async function main() {
  // 单实例锁：supervisor 判活偶发 WMI 延迟会再起一个，两个 keeper 会互相抢着重启隧道。
  const lock = path.join(WORKSPACE, 'state', 'wecom-tunnel-keeper.pid');
  try {
    const other = Number(fs.readFileSync(lock, 'utf8').trim());
    if (other > 0 && other !== process.pid) {
      try { process.kill(other, 0); log(`已有 keeper pid=${other} 在跑，本实例退出`); process.exit(0); } catch { }
    }
  } catch { }
  try { fs.writeFileSync(lock, String(process.pid), 'utf8'); } catch { }
  process.on('exit', () => {
    try { if (Number(fs.readFileSync(lock, 'utf8').trim()) === process.pid) fs.unlinkSync(lock); } catch { }
  });

  log(`keeper 启动 pid=${process.pid}；探针 ${PROBE_URL}；基础间隔 ${BASE_INTERVAL_MS / 1000}s`);
  writeStatus({ keeperPid: process.pid, startedAt: nowIso(), ok: null, intervalMs });
  maybeCertCheck();
  maybeCostRecon();
  maybeVmHealth();
  for (;;) {
    const p = await probe();
    if (p.up) {
      if (wasUp !== true) log(`探针通（${p.detail}）`);
      wasUp = true;
      writeStatus({ ok: true, lastProbeAt: nowIso(), detail: p.detail, intervalMs, restartsIn10m: restarts.length, keeperPid: process.pid });
    } else {
      if (wasUp !== false) log(`探针不通（${p.detail}）`);
      wasUp = false;
      const local = await localBridgeUp();
      if (!local) {
        // 本地 8788 都不在听：重启隧道没用（那是宿主自己的事）——先把它拉起来，下一轮再看。
        log('探针不通且本地 8788 不在听 → 拉起企微桥，等它回来（不重启隧道）');
        ensureWeComBridge();
        writeStatus({ ok: false, local8788: false, lastProbeAt: nowIso(), detail: `${p.detail} local-8788-down`, intervalMs, keeperPid: process.pid });
      } else {
        writeStatus({ ok: false, local8788: true, lastProbeAt: nowIso(), detail: p.detail, intervalMs, keeperPid: process.pid });
        await recover(p.detail);
      }
    }
    maybeCertCheck();
    maybeCostRecon();
    maybeVmHealth();
    await sleep(intervalMs);
  }
}

process.on('SIGINT', () => { log('keeper 收到 SIGINT，退出（隧道留着给下一个 keeper 接管）'); process.exit(0); });
process.on('SIGTERM', () => { log('keeper 收到 SIGTERM，退出（隧道留着）'); process.exit(0); });

main().catch((error) => { log(`keeper 崩了：${String(error?.stack ?? error)}`); process.exit(1); });
