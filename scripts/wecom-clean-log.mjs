// scripts\wecom-clean-log.mjs —— 把 OCR 原始入库清洗成"人话日志"
//
// 用法：
//   node scripts\wecom-clean-log.mjs --conv 许驰 --out records\日志\企微-许驰-清洗-20261030.log
//   node scripts\wecom-clean-log.mjs --conv 许驰 --dry      只打印统计，不写文件
//
// 清洗规则（全部写死在代码里，不靠记忆）：
//   1) 丢掉纯噪音：只有 O/o/0/·/。/、 等头像残渣，或纯时间（22:04 / 22：04 / 0420 这类）
//   2) 丢掉长度 < 2 的碎片
//   3) 相邻同侧、时间差 ≤ 20 秒、且不是明显两句的，合并成一条（OCR 把一条消息拆成两行）
//   4) 标注 [疑似拼接]（同一帧里把两句话粘在一起）与 [重复]（与上一条相似度 ≥0.90）
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const CONV = opt('conv', '');
const OUT = opt('out', '');
const DRY = argv.includes('--dry');
const SRC = 'E:/DSH_workspace/state/wecom-chats.jsonl';

function compact(s) { return String(s ?? '').replace(/\s+/g, ''); }

function isNoise(t) {
  const c = compact(t);
  if (!c || c.length < 2) return true;
  if (/^[Oo0CFIcfi·。、，,：:]{1,6}$/.test(c)) return true;         // 头像残渣 / 纯标点（含 OCF、OCI、O，，同 这类）
  if (/^\d{1,2}[:：]\d{2}([:：]\d{2})?$/.test(c)) return true;     // 纯时间
  if (/^\d{3,12}$/.test(c)) return true;                          // 纯数字碎片（0420 / 7016）
  const puncts = (c.match(/[·。、，,：:「」【】〔〕（）(){}\[\]]/g) ?? []).length;
  if (c.length <= 4 && puncts >= Math.ceil(c.length / 2)) return true; // 短且一半以上是标点
  return false;
}

function grams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i += 1) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}
function sim(a, b) {
  const s = compact(a), t = compact(b);
  if (!s || !t) return 0;
  if (s === t) return 1;
  const ga = grams(s), gb = grams(t);
  let inter = 0, total = 0;
  for (const [k, v] of ga) { total += v; if (gb.has(k)) inter += Math.min(v, gb.get(k)); }
  for (const v of gb.values()) total += v;
  return total ? (2 * inter) / total : 0;
}

const rows = fs.readFileSync(SRC, 'utf8').split(/\r?\n/).filter(Boolean);
const picked = [];
for (const line of rows) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (CONV && !String(o.session ?? '').includes(CONV)) continue;
  picked.push(o);
}
picked.sort((a, b) => String(a.frameAt).localeCompare(String(b.frameAt)));

let droppedNoise = 0;
const kept = [];
// 去掉行首/行尾的"头像残渣"（O / OC / OCF / OCI 这类，OCR 把头像圆圈读成字母）
const stripAvatar = (s) => String(s)
  .replace(/^[Oo0]{1,2}([CFIcfi]{1,2})?(?=[\[\{（(【「〔一-龥])/, '')
  .replace(/^[Oo0]{1,2}(?=[A-Za-z0-9])/, '')                       // "OOCR验证" / "O00101收到" 这类
  .replace(/(?<=[。！？·\]\}）)】」〕])[Oo0]{1,2}([CFIcfi]{1,2})?$/, '')
  .replace(/^[，,。、\s]+/, '')
  .trim();
for (const o of picked) {
  if (isNoise(o.text)) { droppedNoise += 1; continue; }
  const cleaned = stripAvatar(compact(o.text));
  if (isNoise(cleaned)) { droppedNoise += 1; continue; }
  kept.push({ ts: String(o.frameAt).slice(11, 19), side: o.side, text: cleaned, raw: o.text, frameAt: String(o.frameAt) });
}

// 不再跨条合并（2026-10-30 修：把不同消息粘成一长条，比不合并更糟）。
// 同一条消息的多行合并交给采集端（wecom-ingest 已按 y 邻近合并）。
const merged = kept.map((k) => ({ ts: k.ts, side: k.side, text: k.text, frameAt: k.frameAt, tags: new Set() }));

// 去重 + 标疑似拼接
const out = [];
for (const m of merged) {
  const prev = out[out.length - 1];
  if (prev && sim(prev.text, m.text) >= 0.9 && prev.side === m.side) { prev.tags.add('重复'); continue; }
  if (/(收到|看懂|回我).*(收到|看懂|回我)/.test(m.text) && m.text.length > 16) m.tags.add('疑似拼接');
  out.push(m);
}

const lines = [];
lines.push(`# 企微 · ${CONV || '全部会话'} · 清洗后日志`);
lines.push(`# 来源：${SRC}（原始 ${picked.length} 条）`);
lines.push(`# 清洗：去噪音 ${droppedNoise} 条 / 合并 ${kept.length - merged.length} 次 / 去重 ${merged.length - out.length} 条 → 保留 ${out.length} 条`);
lines.push('');
for (const m of out) {
  const who = m.side === 'in' ? `${CONV || '对方'}` : '我  ';
  const tag = m.tags.size ? `   [${[...m.tags].join('/')}]` : '';
  lines.push(`[${m.ts}] ${who} : ${m.text}${tag}`);
}
lines.push('');
lines.push(`# —— 保留 ${out.length} 条 ——`);

const text = lines.join('\n') + '\n';
if (DRY || !OUT) {
  console.log(text);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text, 'utf8');
  console.log(`${OUT}  ${fs.statSync(OUT).size} B｜原始 ${picked.length} → 噪音 ${droppedNoise} → 保留 ${out.length}`);
}
