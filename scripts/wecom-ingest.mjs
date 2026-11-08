#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts\wecom-ingest.mjs —— 企微入站采集（WC-009 / W-255，03·维护 2026-10-30）
//
// 链路：VM 交互会话里的 C:\xunyu\wecom-vm-ingest-agent.ps1（每 2.5s 截窗口 + Windows.Media.Ocr）
//   → 追加 C:\xunyu\ingest-frames.jsonl（一行一帧：ts + 每行文字与 bbox）
//   → 本脚本经 ssh 增量读取 → 把 OCR 行拼成气泡（左 in / 右 out）→ 去重 → 追加 state\wecom-chats.jsonl
//
// 为什么这么绕：ssh 落在 **session 0**，看不到也截不到 session 1 的窗口；截图+OCR 必须由
// 计划任务在交互会话里跑，宿主只能"读它写出来的结果"。这条和 WC-005 的结论一致。
//
// 用法：
//   node scripts\wecom-ingest.mjs                # 常驻，每 3s 拉一次
//   node scripts\wecom-ingest.mjs --once         # 只拉一次（自测/CI）
//   node scripts\wecom-ingest.mjs --once --json  # 打印本批解析结果
//
// 出口码：0 正常 / 1 采集失败（ssh、无帧、解析异常）
// 只读：不注入任何输入（发送是 WC-004 的事）；数据 append-only。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const OUT = path.join(WORKSPACE, 'state', 'wecom-chats.jsonl');
const SEEN = path.join(WORKSPACE, 'state', 'wecom-seen.jsonl');
const OFFSET = path.join(WORKSPACE, 'state', 'wecom-ingest-offset.json');
const LOG = path.join(WORKSPACE, 'logs', 'wecom-ingest.log');
const FRAMES = 'C:\\xunyu\\ingest-frames.jsonl';
const HOST = process.env.WECOM_VM_HOST || '192.168.123.118';
const USER = process.env.WECOM_VM_USER || 'xunyu';
const KEY = process.env.WECOM_VM_SSH_KEY || 'C:\\Users\\Xuchi\\.ssh\\id_ed25519';
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const INTERVAL_MS = Number(process.env.WECOM_INGEST_INTERVAL_MS || 3000);
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

const argv = process.argv.slice(2);
const once = argv.includes('--once');
const asJson = argv.includes('--json');

function log(msg) {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} [ingest] ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { }
  if (!asJson) process.stdout.write(line + '\n');
}

/** 用 cmd 的 type 原样吐字节：PowerShell 的 Get-Content 会按 ANSI 解码，中文全成乱码。 */
function pullFrames() {
  try {
    const out = execFileSync(SSH, [
      '-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      `${USER}@${HOST}`, `type ${FRAMES}`
    ], { encoding: 'buffer', timeout: 20000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return out;
  } catch (error) {
    // 文件不存在时 type 会非 0 退出；区分"空/没有"和真错误
    const text = String(error?.stderr ?? '');
    if (/找不到|not find|系统找不到/i.test(text)) return Buffer.alloc(0);
    throw error;
  }
}

function readOffset() {
  try { return Number(readJson(OFFSET).bytes) || 0; } catch { return 0; }
}
function writeOffset(bytes) {
  try { fs.writeFileSync(OFFSET, JSON.stringify({ bytes, at: new Date().toISOString() }) + '\n', 'utf8'); } catch { }
}

/** 中文 OCR 会在字间塞空格（"重 庆 自 成"），归一化时去掉 CJK 之间的空格。 */
function normalizeText(s) {
  return String(s ?? '')
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/(?<=[\u4e00-\u9fff]) (?=[\u4e00-\u9fff])/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── WC-016（2026-10-31）：自纠正去重 ────────────────────────────────────────
// 现场（06 报，15:42–15:44）：同一条自己发的消息被入库 4 次，文字还越滚越长
// （「〖 通道自 W0014 〕 切会」→ 两遍 → 三遍 → 四遍）。两个原因叠在一起：
//   ① 气泡合并容差用的是 fh*0.05（≈90px），而"同一条消息的多个气泡"纵向间距≈85~103px，
//      滚动时一落在 90px 内就把几个气泡并成一个，文字被拼成 N 遍；
//   ② 去重比的是"文本"，可长度闸要求 max ≤ min*2 —— 拼成 2/3/4 遍之后相似度掉到 0.82 以下、
//      长度比又超 2，于是每一遍都当新消息写进去。
// 这里补两件事：**折叠重复片段**（把 X 重复 N 遍还原成 X）＋ **跨侧守卫**（同会话 30 秒内已有
// 相似度 ≥0.82 的 out，就绝不把同文本的 in 再写一遍，不只靠几何判侧）。
const SIDE_GUARD = process.env.WECOM_SIDE_GUARD !== '0';

/** 把「X 重复 N 遍」折叠回 X；顺带剥掉 OCR 粘在气泡左边的头像字（O/〇/0/●）。 */
function collapseRepeats(raw) {
  let s = String(raw ?? '').replace(/^[Oo〇0●•·]+/u, '').trim();
  if (!s) return '';
  // 反复折到稳定：4 遍要先折成 2 遍再折成 1 遍（一次只折一半会留下 2 遍）
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (let n = 2; n <= 8; n += 1) {
      const len = s.length / n;
      if (!Number.isInteger(len) || len < 3) continue;
      const unit = s.slice(0, len);
      if (unit.repeat(n) === s) { s = unit; changed = true; break; }
    }
    if (!changed) break;
  }
  return s;
}

/** 在同一会话内判一条消息该不该丢：'dup' 同上一条同侧、'side-guard' 已有 out 又来个 in、null 放行。 */
function dedupeVerdict(recent, m, session, now) {
  const text = collapseRepeats(m.text);
  for (const p of recent ?? []) {
    if (p.session !== session) continue;
    const age = now - Number(p.at ?? 0);
    const ptext = collapseRepeats(p.text);
    if (!ptext || !text) continue;
    const sim = similarity(ptext, text);
    if (p.side === m.side) {
      // 同侧：原来的 30 分钟窗口 + 长度比闸（折叠后长度比才公平）
      if (age >= 30 * 60 * 1000) continue;
      const la = ptext.replace(/\s+/g, '').length;
      const lb = text.replace(/\s+/g, '').length;
      if (Math.max(la, lb) > Math.max(1, Math.min(la, lb)) * 2) continue;
      if (sim >= 0.82) return 'dup';
    } else if (SIDE_GUARD && m.side === 'in' && p.side === 'out') {
      // 跨侧：30 秒内自己刚发过近似的话 → 这条 in 基本是"自己气泡被读成接收气泡"
      if (age < 30 * 1000 && sim >= 0.82) return 'side-guard';
    }
  }
  return null;
}

/** 当前正在看的会话名：由 state\wecom-current.json 提供（发送/切换会话时写）。 */
function readCurrentConv() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'state', 'wecom-current.json'), 'utf8'));
    const name = String(j.conv ?? '').trim();
    return name || null;
  } catch { return null; }
}

/** 把一帧的 OCR 行拼成气泡：按 y 聚行、按 x 判左右。 */
function buildMessages(frame) {
  const lines = (frame.lines ?? [])
    .map((l) => ({ ...l, t: normalizeText(l.t) }))
    .filter((l) => l.t && l.t.length > 0);
  if (!lines.length) return { session: null, messages: [] };

  // 2026-10-30 自适应：VM 代理已"裁消息区 + 3x 放大"，坐标与旧版(整窗 1x)完全不同。
  // 全部阈值按帧宽高比例算，换分辨率/缩放都不用改代码。
  // 注意：frame.w/h 是**窗口尺寸**（未放大），而 lines 坐标是**裁剪+3x 放大后**的；
  // 二者不同尺度，必须用 lines 自身的最大坐标当帧尺寸，否则边界会把整帧行都过滤掉（22:17 踩过）。
  const fw = Math.max(...lines.map((l) => l.x + l.w), 1);
  const fh = Math.max(...lines.map((l) => l.y + l.h), 1);

  // 会话名：**裁剪后帧里没有标题**（22:17 踩过：全被标成时间行「21:47」）
  // 优先用外部传入的会话名（state\wecom-current.json，由发送/切换会话时写入），
  // 没有才退回帧内最宽行（可能是时间行——仅作兜底）。
  const headerMaxY = fh * 0.06;
  // 2026-10-30 22:59 修：优先用**帧内标题条**（顶部已一起截图），
  // 取不到才用配置里的会话名——否则切到群聊时，群消息会被记到上一个会话名下。
  let session = null;
  {
    // 标题条：贴顶(y 很小) + 靠左(x 很小)。之前只按"最宽"选，会把消息行当成会话名
    // （22:59 出现过「企微·蝓入框坐标」这种把消息当会话名的废会话）。
    const cands = lines.filter((l) => l.y <= fh * 0.045 && l.x <= fw * 0.25 && l.t.length >= 2);
    cands.sort((a, b) => (a.y - b.y) || (b.w - a.w));
    session = cands.length ? cands[0].t : null;
  }
  if (!session) session = readCurrentConv();
  // 2026-10-30 23:41（主人：还是有两个许驰）：OCR 会多识别出一个空格，
  // 「许驰 (service)」与「许驰(service)」会被当成两个会话。归一化规则写在这里，别靠人记。
  if (session) session = normalizeConvName(session);

  // 裁剪后整帧就是消息区：左右边界几乎全宽
  // 裁剪后整帧就是消息区：左右边界放到全宽（之前 0.02 把小 x 的对方气泡切掉了）
  const chatLeft = 0, chatRight = fw;
  const center = fw / 2;
  const isTimeLabel = (l) => {
    const t = l.t;
    if (/^(星期|昨天|前天|今天)?\s*\d{0,2}[:：]\d{2}$/.test(t)) return true;
    if (/^\d{1,2}月\d{1,2}日/.test(t)) return true;
    // OCR 常把「昨天 0:34」识成「刂天 0 34」这种：短、居中、几乎只有数字/符号
    const compact = t.replace(/\s+/g, '');
    const nearCenter = Math.abs((l.x + l.w / 2) - center) < 90;
    return nearCenter && l.w < 130 && /^[\d:：\-—/℃刂天昨前今星期\s]+$/.test(compact);
  };

  const body = lines.filter((l) => l.x >= chatLeft && l.x <= chatRight && l.y > headerMaxY && !isTimeLabel(l))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const bubbles = [];
  let cur = null;
  for (const l of body) {
    // 2026-10-30 修：同一条消息被 OCR 拆成多行时按"行高"合并（3x 放大后行距约 60~80px）
    // WC-016 修：原来容差是 fh*0.05（≈90px），会把**同一条消息的多个气泡**也并成一个，
    // 文字被拼成两遍三遍四遍。改成按**行高**算（同一气泡内的相邻行距 = 0，不同气泡间距 ≥ 一个行高），
    // 并保留一个 6px 下限防止 OCR 抖动。
    const lineH = (l.h ?? 20);
    // 1.35×行高：同一条消息换行后的行距通常是 1.0~1.3 个行高，能并回去；
    // 而"同一条消息的两个气泡"间距实测 ≈103px（行高 41），远大于 1.35×41≈55，不会被并。
    const yTol = Math.max(6, Math.min(lineH * 1.35, fh * 0.05));
    const xTol = Math.max(60, fw * 0.10);
    if (cur && Math.abs(l.y - cur.y2) <= yTol && Math.abs(l.x - cur.x) <= xTol) {
      cur.lines.push(l.t);
      cur.x = Math.min(cur.x, l.x);
      cur.x2 = Math.max(cur.x2, l.x + l.w);
      cur.y2 = l.y + l.h;
    } else {
      cur = { lines: [l.t], x: l.x, x2: l.x + l.w, y: l.y, y2: l.y + l.h };
      bubbles.push(cur);
    }
  }

  const messages = bubbles
    // 过滤噪音：纯头像圆圈(O)、纯时间行、少于 2 个字的碎片
    .filter((b) => {
      const tx = b.lines.join('').replace(/\s+/g, '');
      if (tx.length < 2) return false;
      if (/^[Oo0·。、，,]+$/.test(tx)) return false;
      if (/^(星期|昨天|前天|今天)?\d{0,2}[:：]\d{2}$/.test(tx)) return false;
      return true;
    })
    .map((b) => {
      // 2026-10-30 修：裁剪+3x 后同一坐标系里"中心线"不可靠，
      // 改成看**右边缘贴近度**：贴右边(>62%)是我发的(out)，否则是对方(in)。
      const rightEdge = b.x2 / fw;
      return {
        side: rightEdge > 0.62 ? 'out' : 'in',
        text: b.lines.join(''),
        x: b.x, y: b.y, w: b.x2 - b.x
      };
    });
  return { session, messages };
}

function fingerprint(session, m) {
  return crypto.createHash('sha1').update(`${session ?? ''}|${m.side}|${m.text}`).digest('hex').slice(0, 16);
}

/** 字符二元组 Dice 相似度：OCR 每帧会把同一句话识成略有出入的版本，靠"文本指纹"去重不够。 */
function similarity(a, b) {
  const s = String(a ?? ''), t = String(b ?? '');
  if (!s || !t) return 0;
  if (s === t) return 1;
  const grams = (x) => {
    const g = new Map();
    const clean = x.replace(/\s+/g, '');
    for (let i = 0; i < clean.length - 1; i += 1) {
      const k = clean.slice(i, i + 2);
      g.set(k, (g.get(k) ?? 0) + 1);
    }
    return g;
  };
  const ga = grams(s), gb = grams(t);
  let inter = 0, total = 0;
  for (const [k, v] of ga) { total += v; if (gb.has(k)) inter += Math.min(v, gb.get(k)); }
  for (const v of gb.values()) total += v;
  return total ? (2 * inter) / total : 0;
}

function loadSeen() {
  const seen = new Map();
  const recent = [];
  try {
    const lines = fs.readFileSync(SEEN, 'utf8').split(/\r?\n/).filter(Boolean).slice(-4000);
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (r?.fp) seen.set(r.fp, Number(r.at) || 0);
        if (r?.text) recent.push({ text: r.text, side: r.side ?? '', session: r.session ?? '', at: Number(r.at) || 0 });
      } catch { }
    }
  } catch { }
  return { seen, recent };
}

function runCycle(state) {
  const started = Date.now();
  const buf = pullFrames();
  const prev = readOffset();
  if (!buf.length) { log('无帧文件（VM 里 agent 没跑？）'); return { ok: false, added: 0, frames: 0 }; }
  if (buf.length < prev) { state.offset = 0; writeOffset(0); }
  const start = Math.max(0, Math.min(state.offset, buf.length));
  const chunk = buf.slice(start).toString('utf8');
  writeOffset(buf.length);

  const frames = [];
  // 2026-10-30 修：只读"新增帧"会永久丢掉被误杀的消息（去重误判之后再无机会）。
  // 每轮都重扫最后 25 帧，靠去重（已收紧到 0.82 + 长度比闸）保证不重复入库。
  const WINDOW_FRAMES = 25;
  const allLines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  const tailText = allLines.slice(-WINDOW_FRAMES).join('\n');
  for (const line of (tailText + '\n' + chunk).split(/\r?\n/)) {
    const s = line.replace(/^\uFEFF/, '').trim();
    if (!s.startsWith('{')) continue;
    try { frames.push(JSON.parse(s)); } catch { }
  }
  if (!frames.length) { log(`无新帧（offset=${start}/${buf.length}）`); return { ok: true, added: 0, frames: 0 }; }

  const now = Date.now();
  let added = 0;
  let sideGuarded = 0;
  const batch = [];
  for (const frame of frames) {
    const { session, messages } = buildMessages(frame);
    if (!messages.length) continue;                       // 空帧（窗口被挡/切走）不动基线
    // 增量判定（2026-10-30 02:xx 修）：只看"上一帧"会被 OCR 抖动骗——同一屏每帧识出的字略变，
    // 相似度掉到 0.8 以下就当成新消息，实测 2 分钟把库刷到 1000+ 行。
    // 现在三重闸：① 和最近 30 分钟**所有**见过的气泡比（阈值降到 0.55）② 位置必须在上一帧底部附近
    // ③ 同一 session 内才算重复。
    const recent = state.recent ?? [];
    const bottom = state.bottomY ?? 0;
    for (const m of messages) {
      // WC-016：同侧去重 + 跨侧守卫（见 dedupeVerdict 注释）
      const verdict = dedupeVerdict(recent, m, session, now);
      if (verdict === 'dup') continue;
      if (verdict === 'side-guard') {
        sideGuarded += 1;
        log(`侧守卫：丢一条 in（同会话 30s 内已有近似 out）｜${String(m.text).slice(0, 24)}`);
        continue;
      }
      // 2026-10-30 修：滚动窗口重扫时，"底部"会随帧高度变化，
      // 旧的 bottomY（可能是另一屏的坐标）会把新消息全挡掉。改成用**本帧最大 y** 判底部。
      const frameBottom = Math.max(...messages.map((x) => x.y + (x.h ?? 0)), 0);
      const isAtBottom = m.y >= frameBottom * 0.55;
      if (!isAtBottom) continue;
      const fp = fingerprint(session, m);
      const rec = {
        at: new Date().toISOString(),
        frameAt: frame.at ?? null,
        session,
        side: m.side,
        text: m.text,
        fp,
        y: m.y,
        hwnd: frame.hwnd ?? null
      };
      fs.appendFileSync(OUT, `${JSON.stringify(rec)}\n`, 'utf8');
      fs.appendFileSync(SEEN, `${JSON.stringify({ fp, at: now, session, side: m.side, text: m.text })}\n`, 'utf8');
      recent.push({ text: m.text, side: m.side, session, at: now });
      batch.push(rec);
      added += 1;
    }
    if (recent.length > 2000) recent.splice(0, recent.length - 2000);
    state.recent = recent;
    state.bottomY = messages.reduce((max, m) => Math.max(max, m.y), bottom || 0);
  }
  const ms = Date.now() - started;
  log(`帧 ${frames.length}｜新增 ${added}｜侧守卫丢弃 ${sideGuarded}｜${ms}ms`);
  if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, frames: frames.length, added, sideGuarded, ms, batch }, null, 2)}\n`);
  return { ok: true, added, sideGuarded, frames: frames.length };
}

function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法: node scripts\\wecom-ingest.mjs [--once] [--json]\n');
    return;
  }
  const loaded = loadSeen();
  const state = { offset: readOffset(), seen: loaded, recent: loaded.recent ?? [], bottomY: 0 };
  if (argv.includes('--from-now')) {
    // 从"此刻"开始：跳过 VM 里已有的历史帧（冷启动不该把 10 分钟前那屏当新消息回放）
    try { state.offset = pullFrames().length; writeOffset(state.offset); log(`--from-now：从 offset=${state.offset} 开始`); } catch { }
  }
  if (once) {
    const r = runCycle(state);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  log(`start interval=${INTERVAL_MS}ms out=${OUT}`);
  const minutesIdx = argv.indexOf('--minutes');
  const minutes = minutesIdx >= 0 ? Number(argv[minutesIdx + 1]) : 0;
  if (minutes > 0) {
    log(`将运行 ${minutes} 分钟后自动退出（稳定性自测）`);
    setTimeout(() => { log(`运行 ${minutes} 分钟到点退出`); process.exit(0); }, minutes * 60000);
  }
  const tick = () => {
    try { runCycle(state); } catch (error) { log(`cycle error: ${String(error?.message ?? error).slice(0, 160)}`); }
    setTimeout(tick, INTERVAL_MS);
  };
  setTimeout(tick, 0);
}

// WC-016：这里原来是裸 `main()`——只要有人 `import`（`wecom-ingest-tess.mjs` 就 import 了 buildMessages），
// 就会在 import 期间跑一整轮 ssh 采集，把测试卡死。改成"直接运行时才跑"。
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();

/** 会话名归一化：去掉括号前的空格、折叠连续空格、统一全角括号（OCR 常见抖动）。 */
function normalizeConvName(s) {
  return String(s ?? '')
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/\s+(?=\()/g, '')
    .replace(/(?<=\))\s+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export { buildMessages, dedupeVerdict, collapseRepeats };
