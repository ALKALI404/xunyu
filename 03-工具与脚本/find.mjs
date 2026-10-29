// 按地图检索：只给路径和锚点，**不读文件内容**
//
// 用法：
//   node scripts\find.mjs 收款码
//   node scripts\find.mjs 唤醒 --verbose     # 连 keywords 命中原因一起打
//   node scripts\find.mjs --all               # 列整张地图
//
// 输出示例：
//   qq.sticker  收藏表情：列表/看图/备注/发送
//     files    qq-bridge/src/sticker-lib.js
//     anchors  —
//     stores   qq-bridge/state/（表情库 JSON）
//     http     GET /api/stickers
//     → 只读这几处：用 peek/切片，别整份读
import fs from 'node:fs';

const MAP = 'E:/DSH_workspace/state/map.json';
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const q = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const all = argv.includes('--all') || !q;

const scored = map.entries.map((e) => {
  const hay = [e.cap, e.what, ...(e.keywords || []), ...(e.files || []), ...(e.stores || []), ...(e.endpoints || [])].join(' ').toLowerCase();
  const hits = [];
  for (const k of (e.keywords || [])) if (q && (k.toLowerCase().includes(q.toLowerCase()) || q.toLowerCase().includes(k.toLowerCase()))) hits.push(k);
  const inText = q && hay.includes(q.toLowerCase());
  return { e, score: hits.length * 2 + (inText ? 1 : 0), hits };
}).filter((x) => all || x.score > 0).sort((a, b) => b.score - a.score);

if (!scored.length) {
  console.log(`地图里没有命中「${q}」。`);
  console.log('→ 这一步就该停：不要通篇 grep 全仓。先问自己：这个功能属于哪个模块？再 node scripts\\find.mjs --all 看一遍地图。');
  process.exit(0);
}

for (const { e, hits } of scored) {
  console.log(`\n${e.cap}  ${e.what}`);
  if (verbose && hits.length) console.log(`  命中关键词: ${hits.join(', ')}`);
  if (e.files?.length) console.log(`  文件     ${e.files.join('  ')}`);
  if (e.anchors?.length) console.log(`  锚点     ${e.anchors.join('  ')}`);
  if (e.stores?.length) console.log(`  存储     ${e.stores.join('  ')}`);
  if (e.endpoints?.length) console.log(`  接口     ${e.endpoints.join('  ')}`);
}
console.log('\n→ 只读上面这几处，按 g/l 精确翻，别整份读；需要大输出时用 scripts\\peek.mjs 落盘再切片。');
