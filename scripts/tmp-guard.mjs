#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts/tmp-guard.mjs —— 临时文件哨兵 + 每日清理（UG-009）
//
// 为什么：D93 治理完 30 分钟内又冒出 .bak-* 与两个未登记 json —— **一次性清理没用，得在写入时拦**。
// 分工：`state-check.mjs`（D93）查「乱没乱」；本脚本拦「别乱写」。
//
// 用法：
//   node scripts\tmp-guard.mjs check <路径>   写前拦：不许写 ⇒ exit 1（带原因）；允许 ⇒ exit 0
//   node scripts\tmp-guard.mjs sweep [--dry]  每日清理：删 tmp\ 下 7 天前的文件（只动 tmp，先列后删，写日志）
//   node scripts\tmp-guard.mjs selftest       自测（造两条正反例 + 两个假文件，跑完清理）
//
// 配置：state\tmp-guard.json（allowedRoots / tempOnlyRoots / ttlDays / logFile …）
// 退出码：check 0/1；sweep 0（有失败才 1）；selftest 0/1。

import fs from 'node:fs';
import path from 'node:path';

const WS = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CFG_FILE = path.join(WS, 'state', 'tmp-guard.json');
const cfg = readJson(CFG_FILE);
const ALLOWED = (cfg.allowedRoots ?? []).map((p) => p.toLowerCase());
const TEMP_ONLY = (cfg.tempOnlyRoots ?? []).map((p) => p.toLowerCase());
const TTL_MS = Number(cfg.ttlDays ?? 7) * 24 * 60 * 60 * 1000;
const SWEEP_ROOT = cfg.sweepRoot ?? path.join(WS, 'tmp');
const LOG = cfg.logFile ?? path.join(WS, 'logs', 'tmp-guard.log');
const TEMP_NAME = new RegExp(cfg.tempNamePattern, 'i');
const TEMP_EXT = new RegExp(cfg.tempExtPattern, 'i');

const under = (p, root) => {
  const a = p.toLowerCase();
  const r = root.toLowerCase();
  return a === r || a.startsWith(r + '\\') || a.startsWith(r + '/');
};
const looksTemp = (name) => TEMP_NAME.test(name) || TEMP_EXT.test(name);

function logLine(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 写前拦：返回 {ok, reasons[]} */
function check(target) {
  const abs = path.resolve(target);
  const name = path.basename(abs);
  const reasons = [];
  const inAllowed = ALLOWED.some((r) => under(abs, r));
  if (!inAllowed) {
    reasons.push(`不在白名单根（${ALLOWED.map((r) => path.basename(r)).join(' / ')}）下：临时/中间文件请落 tmp\\`);
    return { ok: false, abs, reasons };
  }
  const inTemp = under(abs, SWEEP_ROOT) || TEMP_ONLY.some((r) => under(abs, r));
  const inLogs = under(abs, path.join(WS, 'logs'));
  const inBackup = under(abs, path.join(WS, 'backup'));
  const inState = under(abs, path.join(WS, 'state'));
  // tmp\ 随便写（临时文件的正当落点）
  if (inTemp) { reasons.push('在 tmp\\：临时文件正落点'); return { ok: true, abs, reasons }; }
  // logs\ 允许 .log（日志的家）；backup\ 允许 .bak/.old（备份的家）
  if (inLogs) { reasons.push('在 logs\\：日志的正当落点'); return { ok: true, abs, reasons }; }
  if (inBackup) { reasons.push('在 backup\\：备份的正当落点'); return { ok: true, abs, reasons }; }
  // state\ 只放长期文件：临时特征名一律拒（按本单验收：state\\*.tmp → exit 1）
  if (inState && (looksTemp(name) || /\.(tmp|bak|log)$/i.test(name)) && cfg.stateForbidTemp !== false) {
    reasons.push('state\\ 只放长期文件：临时/日志/备份请分别落 tmp\\、logs\\state\\、backup\\state-bak\\');
    return { ok: false, abs, reasons };
  }
  // 其余白名单根（当前只有 state）：临时特征名也不许
  if (looksTemp(name)) {
    reasons.push(`名字像临时文件（${name}）：只在 tmp\\ 放临时文件；state\\ 只放长期文件`);
    return { ok: false, abs, reasons };
  }
  reasons.push('在白名单根且不是临时特征');
  return { ok: true, abs, reasons };
}

function walk(dir, out = [], skip = new Set()) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skip.has(e.name.toLowerCase())) continue;
      walk(p, out, skip);
    } else if (e.isFile()) {
      try { const st = fs.statSync(p); out.push({ p, size: st.size, mtimeMs: st.mtimeMs }); } catch { /* skip */ }
    }
  }
  return out;
}

function sweep({ dry = false } = {}) {
  const now = Date.now();
  const skip = new Set((cfg.skipDirs ?? []).map((s) => String(s).toLowerCase()));
  const all = walk(SWEEP_ROOT, [], skip);
  const stale = all.filter((f) => now - f.mtimeMs > TTL_MS).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const fresh = all.length - stale.length;
  console.log(`tmp-guard sweep ${dry ? '[dry] ' : ''}· 根=${SWEEP_ROOT} · 阈值=${cfg.ttlDays} 天`);
  console.log(`扫描 ${all.length} 个文件：过期 ${stale.length}，保留 ${fresh}`);
  for (const f of stale) {
    const days = Math.floor((now - f.mtimeMs) / 86400000);
    console.log(`  ${dry ? '将删' : '删'} ${path.relative(WS, f.p)}（${days} 天，${Math.round(f.size / 1024)} KB）`);
  }
  let deleted = 0;
  let bytes = 0;
  let failed = 0;
  if (!dry) {
    for (const f of stale) {
      try { fs.unlinkSync(f.p); deleted++; bytes += f.size; } catch { failed++; }
    }
  }
  console.log(`结果：删除 ${dry ? 0 : deleted} 个 / ${Math.round(bytes / 1024)} KB，失败 ${failed}，保留 ${fresh}`);
  logLine(`sweep${dry ? '(dry)' : ''} root=${SWEEP_ROOT} scanned=${all.length} stale=${stale.length} deleted=${dry ? 0 : deleted} bytes=${bytes} failed=${failed} kept=${fresh}`);
  return { scanned: all.length, stale: stale.length, deleted: dry ? 0 : deleted, failed, kept: fresh };
}

const [, , cmd, arg] = process.argv;
if (cmd === 'check') {
  if (!arg) { console.log('用法：node scripts\\tmp-guard.mjs check <路径>'); process.exit(2); }
  const r = check(arg);
  console.log(`${r.ok ? '✅ 允许写' : '⛔ 不许写'}：${r.abs}`);
  for (const why of r.reasons) console.log('   · ' + why);
  logLine(`check path=${r.abs} ok=${r.ok}`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'sweep') {
  const r = sweep({ dry: process.argv.includes('--dry') });
  process.exit(r.failed ? 1 : 0);
} else if (cmd === 'selftest') {
  const probeTmp = path.join(SWEEP_ROOT, '_guard_probe.txt');
  const probeState = path.join(WS, 'state', '_guard_probe.tmp');
  fs.mkdirSync(path.dirname(probeTmp), { recursive: true });
  fs.writeFileSync(probeTmp, 'ok', 'utf8');
  fs.writeFileSync(probeState, 'not ok', 'utf8');
  const a = check(probeTmp);
  const b = check(probeState);
  console.log(`V1 tmp 写入 -> ${a.ok ? '允许 ✅' : '拒绝 ⛔'}（期望允许）`);
  console.log(`V2 state\\.tmp 写入 -> ${b.ok ? '允许 ✅' : '拒绝 ⛔'}（期望拒绝）`);
  try { fs.unlinkSync(probeTmp); } catch { /* ignore */ }
  try { fs.unlinkSync(probeState); } catch { /* ignore */ }
  const pass = a.ok && !b.ok;
  console.log(pass ? 'selftest PASS' : 'selftest FAIL');
  logLine(`selftest pass=${pass}`);
  process.exit(pass ? 0 : 1);
} else {
  console.log('用法：\n  node scripts\\tmp-guard.mjs check <路径>\n  node scripts\\tmp-guard.mjs sweep [--dry]\n  node scripts\\tmp-guard.mjs selftest');
  process.exit(2);
}
