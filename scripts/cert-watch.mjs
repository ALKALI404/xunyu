#!/usr/bin/env node
import { readJson as readJsonIo } from './json-io.mjs';
// scripts\cert-watch.mjs —— 证书到期监控 + 续期预演（D88 / W-193，03·维护 2026-10-29）
//
// 背景：theglobalscm.top 的 Let's Encrypt 证书（90 天自动续）是「静默失败」型——
//   证书一过期，企微回调全断，而且没人会提前看见。这个脚本每天跑一次：
//     ① TLS 握手取真实证书 → 剩余天数；< 21 天邮件提醒本体；
//     ② ssh 到服务器跑 `certbot renew --dry-run` → 非 0 立即报警（这是能让回调全断的故障）；
//     ③ 两样都写进 logs\cert-watch.log 与 state\cert-watch.json（给看板/排障读）。
//
// 边界：只读证书、只跑 dry-run（不真续期、不碰 nginx 配置、不改证书路径）。
// 定时：由 supervisor.ps1 每天拉起一次（不要挂会话后台 job，见规则 §一.6）。
//
// 用法：
//   node scripts\cert-watch.mjs                 # 完整体检（TLS + certbot dry-run，约 10–90s）
//   node scripts\cert-watch.mjs --fast          # 只查到期天数（跳过 ssh / dry-run）
//   node scripts\cert-watch.mjs --json          # 机读
//   node scripts\cert-watch.mjs --force-mail    # 忽略当天去重，强制发一次（排障用）
//   node scripts\cert-watch.mjs --no-mail       # 只判不发（演练/自测用）
//
// 退出码：0 正常 / 2 剩余天数 < 21 / 1 续期预演失败或证书取不到
//
// 去重：同一原因同一天只发一封邮件（state\cert-watch.json 的 mailed 记录），避免每日重复轰炸。

import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const LOG = path.join(WORKSPACE, 'logs', 'cert-watch.log');
const STATE = path.join(WORKSPACE, 'state', 'cert-watch.json');
const MAIL = path.join(WORKSPACE, 'scripts', 'mail.mjs');

const DOMAIN = String(process.env.CERT_DOMAIN || 'theglobalscm.top');
const PORT = 443;
const WARN_DAYS = Number(process.env.CERT_WARN_DAYS || 21);   // 可用 CERT_WARN_DAYS 覆盖（自测用）
const TLS_TIMEOUT_MS = 10000;

const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const SSH_KEY = 'C:\\Users\\Xuchi\\.ssh\\id_ed25519';
const SSH_HOST = String(process.env.CERT_SSH_HOST || 'root@115.191.6.89');   // 自测可指向别处
const SSH_OPTS = [
  '-i', SSH_KEY,
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4'
];
// --no-random-sleep-on-renew 是必须的：certbot renew 默认先随机睡 1–8 分钟（实测卡住 6.5 分钟，
// 还留下 lock 让下一次报 "Another instance of Certbot is already running"）。再套 timeout 兜底。
const REMOTE_CMD = 'timeout 120 certbot renew --dry-run -n --no-random-sleep-on-renew 2>&1';
const DRY_RUN_TIMEOUT_MS = 180000;

const nowIso = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('sv-SE');   // sv-SE = YYYY-MM-DD（本地时区）

function log(msg) {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} [cert] ${msg}`;
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { }
  if (!process.argv.includes('--quiet')) process.stdout.write(line + '\n');
}

function readJson(file) {
  try { return readJsonIo(file); } catch { return {}; }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  } catch (error) { log(`写 ${file} 失败：${String(error?.message ?? error).slice(0, 120)}`); }
}

/** ① TLS 握手取真实证书：这是「客户端真会看到的那张」，比读文件/问 nginx 更接近真相。 */
function readCert(host) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let socket;
    try {
      socket = tls.connect({ host, port: PORT, servername: host, timeout: TLS_TIMEOUT_MS }, () => {
        let cert = null;
        try { cert = socket.getPeerCertificate(); } catch { }
        try { socket.end(); } catch { }
        if (!cert || !cert.valid_to) {
          done({ ok: false, error: 'no-peer-cert' });
          return;
        }
        const validTo = new Date(cert.valid_to);
        const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
        const msLeft = validTo.getTime() - Date.now();
        done({
          ok: true,
          validTo: validTo.toISOString(),
          validFrom: validFrom ? validFrom.toISOString() : null,
          daysLeft: Math.floor(msLeft / 86400000),
          hoursLeft: Math.floor(msLeft / 3600000),
          issuer: cert.issuer?.O ?? '',
          cn: cert.subject?.CN ?? '',
          san: String(cert.subjectaltname ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        });
      });
    } catch (error) {
      done({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    socket.once('timeout', () => { try { socket.destroy(); } catch { } done({ ok: false, error: 'timeout' }); });
    socket.once('error', (error) => { done({ ok: false, error: String(error?.code ?? error?.message ?? error) }); });
  });
}

/** ② 远端续期预演：只跑 dry-run（staging），不写证书、不 reload nginx。 */
function dryRunRenew() {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(SSH, [...SSH_OPTS, SSH_HOST, REMOTE_CMD], {
      encoding: 'utf8', windowsHide: true, timeout: DRY_RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024
    }, (error, stdout, stderr) => {
      const raw = `${stdout || ''}${stderr || ''}`;
      const lines = raw.split(/\r?\n/).filter((line) => line.trim());
      const timedOut = Boolean(error && (error.killed || error.signal === 'SIGTERM' || error.code === 124));
      const code = error ? (timedOut ? 'timeout' : (typeof error.code === 'number' ? error.code : String(error.code ?? 'spawn-fail'))) : 0;
      resolve({
        ran: true,
        ok: !error,
        code,
        ms: Date.now() - started,
        tail: lines.slice(-12),
        hints: lines.filter((line) => /fail|error|expire|renew|not due|simulating/i.test(line)).slice(-6)
      });
    });
  });
}

function mailOnce({ reason, subject, body, level, dedup, force, dry }) {
  const prev = readJson(STATE);
  const mailed = prev.mailed && typeof prev.mailed === 'object' ? prev.mailed : {};
  const stamp = mailed[reason];
  if (!force && dedup && stamp === today()) {
    log(`邮件去重：${reason} 今天已发过（${stamp}），跳过`);
    return { sent: false, deduped: true };
  }
  if (dry) {
    log(`--no-mail：本应发邮件「${subject}」`);
    return { sent: false, dryRun: true };
  }
  try {
    execFileSync('node', [MAIL, 'post', '--to', '本体', '--from', 'cert-watch', '--level', level || '通知', '--body', `${subject}\n${body}`], {
      cwd: WORKSPACE, encoding: 'utf8', windowsHide: true, timeout: 20000
    });
    mailed[reason] = today();
    writeJson(STATE, { ...prev, mailed, mailedAt: nowIso() });
    log(`已邮件报本体：${subject}`);
    return { sent: true };
  } catch (error) {
    log(`邮件失败：${String(error?.message ?? error).slice(0, 140)}`);
    return { sent: false, error: String(error?.message ?? error).slice(0, 140) };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法: node scripts\\cert-watch.mjs [--fast] [--json] [--force-mail] [--no-mail] [--quiet]\n');
    return;
  }
  const asJson = argv.includes('--json');
  const fast = argv.includes('--fast');
  const force = argv.includes('--force-mail');
  const noMail = argv.includes('--no-mail');
  const unknown = argv.filter((arg) => !['--json', '--fast', '--force-mail', '--no-mail', '--quiet', '--help', '-h'].includes(arg));
  if (unknown.length) {
    process.stderr.write(`未知参数: ${unknown.join(' ')}\n`);
    process.exitCode = 2;
    return;
  }

  const startedAt = nowIso();
  log(`开始体检：${DOMAIN}:${PORT}${fast ? '（--fast：只查到期天数）' : '（含 certbot dry-run）'}`);

  const cert = await readCert(DOMAIN);
  const renew = fast ? { ran: false, skipped: true } : await dryRunRenew();

  // ── 判定 ────────────────────────────────────────────────────────────────
  const reasons = [];
  let verdict = 'OK';
  let exitCode = 0;

  if (!cert.ok) {
    verdict = 'UNKNOWN';
    exitCode = 1;
    reasons.push('cert-unreachable');
    log(`拿不到证书：${cert.error}`);
  } else if (cert.daysLeft < 0) {
    verdict = 'EXPIRED';
    exitCode = 1;
    reasons.push('cert-expired');
    log(`证书已过期：${cert.validTo}（${cert.daysLeft} 天）`);
  } else if (cert.daysLeft < WARN_DAYS) {
    verdict = 'WARN';
    exitCode = 2;
    reasons.push('cert-expiring');
    log(`证书剩余 ${cert.daysLeft} 天（< ${WARN_DAYS}），valid_to=${cert.validTo}`);
  } else {
    log(`证书剩余 ${cert.daysLeft} 天（valid_to=${cert.validTo}，issuer=${cert.issuer || '?'}）`);
  }

  if (renew.ran && !renew.ok) {
    if (renew.code === 'timeout') {
      // 超时 ≠ 续期失败：可能是服务器/网络慢，单独归为「没验成」，不按故障报警
      if (verdict === 'OK') { verdict = 'UNKNOWN'; exitCode = 1; }
      reasons.push('renew-timeout');
      log(`dry-run 超时（>${Math.round(DRY_RUN_TIMEOUT_MS / 1000)}s），结论按「没验成」处理`);
    } else {
      verdict = 'FAIL';
      exitCode = 1;
      reasons.push('renew-failed');
      log(`dry-run 失败：exit=${renew.code}；末行：${renew.tail.slice(-1)[0] ?? '（无输出）'}`);
    }
  } else if (renew.ran) {
    log(`dry-run 通过（exit=0，${Math.round(renew.ms / 1000)}s）`);
  }

  // ── 发邮件 ──────────────────────────────────────────────────────────────
  const tls = cert.ok ? `${DOMAIN} 证书剩余 ${cert.daysLeft} 天（valid_to ${cert.validTo}）` : `${DOMAIN} 证书取不到（${cert.error}）`;
  const renewLine = renew.ran
    ? (renew.ok ? 'certbot renew --dry-run：通过（exit=0）' : `certbot renew --dry-run：失败（exit=${renew.code}）`)
    : 'certbot renew --dry-run：本次未跑（--fast）';
  const detailBody = [
    tls,
    renewLine,
    renew.tail?.length ? `末几行：\n${renew.tail.slice(-6).join('\n')}` : '',
    `日志：${LOG}`
  ].filter(Boolean).join('\n');

  const mails = [];
  if (reasons.includes('renew-failed')) {
    mails.push(mailOnce({
      reason: 'renew-failed',
      subject: `【证书告警】${DOMAIN} 续期预演失败——企微回调可能全断`,
      body: `${detailBody}\n\n这条不是提醒：dry-run 失败说明自动续期链路已经坏了，90 天一到回调就断。`,
      level: '活', dedup: true, force, dry: noMail
    }));
  }
  if (reasons.includes('cert-expired')) {
    mails.push(mailOnce({
      reason: 'cert-expired',
      subject: `【证书告警】${DOMAIN} 证书已过期`,
      body: detailBody, level: '活', dedup: true, force, dry: noMail
    }));
  }
  if (reasons.includes('cert-expiring')) {
    mails.push(mailOnce({
      reason: 'cert-expiring',
      subject: `【证书提醒】${DOMAIN} 还有 ${cert.daysLeft} 天到期（< ${WARN_DAYS}）`,
      body: `${detailBody}\n\n自动续期若正常，这两天就该续上了；一直不降说明续期没跑成。`,
      level: '通知', dedup: true, force, dry: noMail
    }));
  }
  if (reasons.includes('cert-unreachable') || reasons.includes('renew-timeout')) {
    mails.push(mailOnce({
      reason: reasons.includes('renew-timeout') ? 'renew-timeout' : 'cert-unreachable',
      subject: `【证书检查】${DOMAIN} 这次没验成（${reasons.includes('renew-timeout') ? 'dry-run 超时' : 'TLS 取不到证书'}）`,
      body: detailBody, level: '通知', dedup: true, force, dry: noMail
    }));
  }

  // ── 落状态 ──────────────────────────────────────────────────────────────
  const prev = readJson(STATE);
  const report = {
    ok: verdict === 'OK',
    verdict,
    at: nowIso(),
    startedAt,
    domain: DOMAIN,
    daysLeft: cert.ok ? cert.daysLeft : null,
    validTo: cert.ok ? cert.validTo : null,
    issuer: cert.ok ? cert.issuer : null,
    renew: renew.ran
      ? { ok: renew.ok, code: renew.code, ms: renew.ms, tail: renew.tail?.slice(-6) ?? [] }
      : { ok: null, skipped: true },
    reasons,
    mailed: prev.mailed ?? {},
    mails
  };
  writeJson(STATE, report);

  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`证书 ${DOMAIN}：${cert.ok ? `剩余 ${cert.daysLeft} 天（valid_to ${cert.validTo}）` : `取不到（${cert.error}）`}\n`);
    process.stdout.write(`续期预演：${renew.ran ? (renew.ok ? '通过' : `失败 exit=${renew.code}`) : '未跑'}\n`);
    process.stdout.write(`判定：${verdict}${reasons.length ? `（${reasons.join(',')}）` : ''}\n`);
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  log(`cert-watch 崩了：${String(error?.stack ?? error)}`);
  process.exitCode = 1;
});
