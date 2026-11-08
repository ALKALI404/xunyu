// scripts\wecom-ingest-tess.mjs —— 用 Tesseract（本地语言包）做企微入站采集
//
// 为什么另起一个：VM 里的 Windows.Media.Ocr 中文太差（通道→通洹、输入→蝓入）。
// 这里改成"VM 只截图，宿主用 tesseract.js 识别"，同一套气泡拼装（复用 wecom-ingest 的 buildMessages）。
//
// 用法：
//   node scripts\wecom-ingest-tess.mjs              常驻（默认 3s 一轮）
//   node scripts\wecom-ingest-tess.mjs --once       只跑一轮
//
// 依赖：tools\ocr（tesseract.js + lang\chi_sim.traineddata）、ssh 免密到 VM。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildMessages, dedupeVerdict } from './wecom-ingest.mjs';
import { ocrLines } from '../tools/ocr/tess-lines.mjs';

const ROOT = 'E:/DSH_workspace';
const OUT = path.join(ROOT, 'state', 'wecom-chats.jsonl');
const LOG = path.join(ROOT, 'logs', 'wecom-ingest-tess.log');
const PNG = path.join(ROOT, 'tmp', 'wecom-tess-frame.png');
const VM_HOST = process.env.WECOM_VM_HOST || 'xunyu@192.168.123.118';
const VM_PNG = 'C:/xunyu/shots/frame.png';
const KEY = process.env.WECOM_VM_SSH_KEY || 'C:/Users/Xuchi/.ssh/id_ed25519';
const INTERVAL = Number(process.env.WECOM_TESS_INTERVAL_MS || 3000);
const ONCE = process.argv.includes('--once');

function log(s) {
  const line = `${new Date().toISOString()} ${s}`;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { }
  console.log(line);
}

function pullFrame() {
  try {
    execFileSync('scp', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', `${VM_HOST}:${VM_PNG}`, PNG], { stdio: 'ignore', timeout: 20000 });
    vmFailLoggedAt = 0;
    return fs.statSync(PNG).size > 2000;
  } catch (e) {
    // 2026-10-31 00:05（主人打游戏会关 VM）：VM 不通时**别每隔 3 秒刷日志**，
    // 5 分钟最多记一条，且明确写"VM 可能已关闭"，不算故障。
    const now = Date.now();
    if (!vmFailLoggedAt || now - vmFailLoggedAt > 5 * 60 * 1000) {
      vmFailLoggedAt = now;
      log('VM 不可达（可能已关闭/关机），本轮跳过；每 5 分钟最多记一次：' + String(e.message).slice(0, 60));
    }
    return false;
  }
}
let vmFailLoggedAt = 0;

function compactText(s) { return String(s ?? '').replace(/\s+/g, ''); }

function grams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i += 1) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}
function similarity(a, b) {
  const s = compactText(a), t = compactText(b);
  if (!s || !t) return 0;
  if (s === t) return 1;
  const ga = grams(s), gb = grams(t);
  let inter = 0, total = 0;
  for (const [k, v] of ga) { total += v; if (gb.has(k)) inter += Math.min(v, gb.get(k)); }
  for (const v of gb.values()) total += v;
  return total ? (2 * inter) / total : 0;
}

function loadRecent() {
  const out = [];
  try {
    const rows = fs.readFileSync(OUT, 'utf8').split(/\r?\n/).filter(Boolean).slice(-400);
    for (const r of rows) {
      try {
        const o = JSON.parse(r);
        if (o?.text) out.push({ session: o.session, side: o.side, text: o.text, at: Number(o.atMs) || Date.parse(o.at) || 0 });
      } catch { }
    }
  } catch { }
  return out;
}

let cycle = 0;
async function tick() {
  cycle += 1;
  if (!pullFrame()) return;
  const t0 = Date.now();
  const lines = await ocrLines(PNG);
  if (!lines.length) { log(`帧 ${cycle}｜OCR 0 行`); return; }

  const frame = { at: new Date().toISOString(), w: 0, h: 0, lines, hwnd: 0 };
  const { session, messages } = buildMessages(frame);
  if (!messages.length) { log(`帧 ${cycle}｜行 ${lines.length}｜气泡 0`); return; }

  const recent = loadRecent();
  const now = Date.now();
  let added = 0;
  let sideGuarded = 0;
  for (const m of messages) {
    // WC-016（04，2026-10-31）：去重 + 「跨侧守卫」统一走 wecom-ingest 的 dedupeVerdict，
    // 别再各写一份——这条管道原来只判"同侧相似"，自己的气泡被读成 in 时照样入库。
    const verdict = dedupeVerdict(recent, m, session, now);
    if (verdict === 'dup') continue;
    if (verdict === 'side-guard') { sideGuarded += 1; log(`侧守卫：丢一条 in｜${String(m.text).slice(0, 24)}`); continue; }
    const dup = recent.some((p) => p.session === session && p.side === m.side
      && Math.abs(now - p.at) < 30 * 60 * 1000
      && similarity(p.text, m.text) >= 0.82);
    if (dup) continue;
    const rec = {
      at: new Date().toISOString(),
      atMs: now,
      frameAt: frame.at,
      session,
      side: m.side,
      text: m.text,
      fp: crypto.createHash('sha1').update(`${session}|${m.side}|${m.text}`).digest('hex').slice(0, 16),
      y: m.y,
      src: 'tesseract',
    };
    fs.appendFileSync(OUT, `${JSON.stringify(rec)}\n`, 'utf8');
    recent.push({ session, side: m.side, text: m.text, at: now });
    added += 1;
  }
  log(`帧 ${cycle}｜行 ${lines.length}｜气泡 ${messages.length}｜新增 ${added}｜侧守卫丢弃 ${sideGuarded}｜${Date.now() - t0}ms｜会话 ${session}`);
}

if (ONCE) {
  await tick();
  process.exit(0);
} else {
  log(`tesseract 采集启动，间隔 ${INTERVAL}ms`);
  for (;;) {
    try { await tick(); } catch (e) { log('tick 异常：' + String(e.message).slice(0, 100)); }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}
