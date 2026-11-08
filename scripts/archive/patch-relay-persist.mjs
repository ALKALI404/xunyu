// relay：窗口对话按天落盘（收口点是 addLine）
import fs from 'node:fs';

const F = 'E:/DeepFish/avatar/relay.mjs';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(F, 'utf8');

const from1 = `const lines = [];
let lineSeq = 0;`;

const to1 = `const lines = [];
let lineSeq = 0;

// ── 窗口对话落盘（2026-10-25）────────────────────────────────────────────
// 记忆归档管线要按天读「窗口」这条来源，而窗口对话原先只活在内存里（最多 500 条）。
// 收口点就是 addLine：窗口两个页签的收发全走它。只追加、按天一个文件；
// 写失败绝不影响对话（catch 里只打一行日志）。
const WINDOW_LOG_DIR = 'E:\\\\DeepFish\\\\History\\\\chats';
let windowLogDay = '';
let windowLogStream = null;
function persistWindowLine(rec) {
  try {
    const day = new Date(rec.ts).toLocaleDateString('sv-SE'); // 本地时区 YYYY-MM-DD
    if (day !== windowLogDay) {
      if (windowLogStream) { try { windowLogStream.end(); } catch {} }
      fs.mkdirSync(WINDOW_LOG_DIR, { recursive: true });
      windowLogStream = fs.createWriteStream(WINDOW_LOG_DIR + '\\\\window_' + day + '.jsonl', { flags: 'a' });
      windowLogDay = day;
    }
    windowLogStream.write(JSON.stringify(rec) + '\\n');
  } catch (error) {
    log('[relay] 窗口落盘失败（不影响对话）：' + String(error?.message ?? error));
  }
}`;

const from2 = `function addLine(target, from, text) {
  lineSeq += 1;
  lines.push({ n: lineSeq, t: target, from, text: String(text ?? ''), ts: Date.now() });
  if (lines.length > 500) lines.splice(0, lines.length - 500);
}`;

const to2 = `function addLine(target, from, text) {
  lineSeq += 1;
  const rec = { n: lineSeq, t: target, from, text: String(text ?? ''), ts: Date.now() };
  lines.push(rec);
  if (lines.length > 500) lines.splice(0, lines.length - 500);
  persistWindowLine(rec);
}`;

const patches = [
  { name: 'R1 addLine 前插入落盘工具', from: from1, to: to1 },
  { name: 'R2 addLine 里调用落盘', from: from2, to: to2 }
];

let ok = true;
for (const p of patches) {
  const n = src.split(p.from).length - 1;
  console.log(`${n === 1 ? '✅' : '❌'} ${p.name}：${n} 处`);
  if (n !== 1) { ok = false; continue; }
  src = src.split(p.from).join(p.to);
}
if (!ok) { console.log('🛑 锚点对不上，未写盘'); process.exit(2); }
if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(F, src, 'utf8');
console.log('✍️  已写 relay.mjs');
