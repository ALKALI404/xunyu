// 把「日差异」从「今天 vs 昨天」改成「增量：上次跑完之后新增的」
// 主人验收：同一天跑两次 daily，第二次的差异必须是空的。
import fs from 'node:fs';

const F = 'E:/DeepFish/avatar/memory-pipeline/memory-pipeline.mjs';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(F, 'utf8');

const fromDiff = `function diff(day) {
  const cur = readJson(path.join(DIRS.distill, \`\${day}.json\`), null);
  if (!cur) { log(\`diff \${day}：没有当天蒸馏，跳过\`); return []; }
  const prevDay = new Date(new Date(\`\${day}T12:00:00\`).getTime() - 86400000).toLocaleDateString('sv-SE');
  const prev = readJson(path.join(DIRS.distill, \`\${prevDay}.json\`), null);
  const curKeys = new Set(cur.facts.map((f) => f.key));
  const prevKeys = new Set((prev?.facts ?? []).map((f) => f.key));
  const rows = [];
  for (const f of cur.facts) {
    if (!prevKeys.has(f.key)) rows.push(\`+ 〔\${f.tier}〕\${oneLine(f.text)} \${f.ptr}\`);
  }
  for (const f of (prev?.facts ?? [])) {
    if (!curKeys.has(f.key)) rows.push(\`- 消失：\${oneLine(f.text)}（上次见于 \${f.day} \${f.ptr}）\`);
  }
  const head = \`# \${day} 差异（只列增删，不写摘要）\\n\\n\${prev ? \`对比基准：\${prevDay}\` : '首日（无对比基准，全部算新增）'}\\n\`;
  const body = rows.length ? rows.join('\\n') : '（无变化）';
  if (!DRY) {
    fs.writeFileSync(path.join(DIRS.diff, \`\${day}.md\`), \`\${head}\\n\${body}\\n\`, 'utf8');
  }
  log(\`diff \${day}：+\${rows.filter((r) => r.startsWith('+')).length} / -\${rows.filter((r) => r.startsWith('-')).length}\`);
  return rows;
}`;

const toDiff = `function diff(day) {
  // 增量口径（2026-10-25 主人验收要求）：只报「上次跑完之后新增/消失的」，
  // **不是**「今天 vs 昨天」。所以同一天跑第二次、期间没有新消息 → 差异必须为空。
  const cur = readJson(path.join(DIRS.distill, \`\${day}.json\`), null);
  if (!cur) { log(\`diff \${day}：没有当天蒸馏，跳过\`); return []; }
  const reported = new Set((state.reported?.[day] ?? []).map(String));
  const curKeys = new Map(cur.facts.map((f) => [f.key, f]));
  const rows = [];
  for (const f of cur.facts) {
    if (!reported.has(f.key)) rows.push(\`+ 〔\${f.tier}〕\${oneLine(f.text)} \${f.ptr}\`);
  }
  for (const k of reported) {
    if (!curKeys.has(k)) rows.push(\`- 消失：\${oneLine(String(k).split('|')[1] ?? k)}（本次蒸馏里不再出现）\`);
  }
  if (!state.reported) state.reported = {};
  state.reported[day] = [...curKeys.keys()];
  writeJson(STATE_FILE, state);
  const head = \`# \${day} 差异（只列增删，不写摘要；口径＝增量）\\n\\n\${reported.size ? '基线：本日已报过 ' + reported.size + ' 条' : '本日首次运行（全部算新增）'}\\n\`;
  const body = rows.length ? rows.join('\\n') : '（无变化）';
  if (!DRY) fs.writeFileSync(path.join(DIRS.diff, \`\${day}.md\`), \`\${head}\\n\${body}\\n\`, 'utf8');
  log(\`diff \${day}：新增 \${rows.filter((r) => r.startsWith('+')).length} / 消失 \${rows.filter((r) => r.startsWith('-')).length}（增量口径）\`);
  return rows;
}`;

const fromDaily = `const runDaily = (by) => {
  const d = distill(TODAY);
  const rows = diff(TODAY);
  diary(TODAY, rows);
  state.daily[TODAY] = { at: new Date().toISOString(), by, facts: d.facts.length, rules: d.rules };
  writeJson(STATE_FILE, state);
  return { facts: d.facts.length, diffRows: rows.length };
};`;

const toDaily = `const runDaily = (by) => {
  const d = distill(TODAY);
  const rows = diff(TODAY);
  // 没有新增量就不动日记（否则重跑会把昨天的日记覆盖成「没有变化」）
  if (rows.length) diary(TODAY, rows);
  else log(\`日记 \${TODAY}：本次无新增，保持原文件不动\`);
  state.daily[TODAY] = { at: new Date().toISOString(), by, facts: d.facts.length, rules: d.rules };
  writeJson(STATE_FILE, state);
  return { facts: d.facts.length, diffRows: rows.length };
};`;

const patches = [
  { name: 'D1 diff 改增量口径', from: fromDiff, to: toDiff },
  { name: 'D2 runDaily 无增量不动日记', from: fromDaily, to: toDaily }
];

let ok = true;
for (const p of patches) {
  const n = src.split(p.from).length - 1;
  console.log(`${n === 1 ? '✅' : '❌'} ${p.name}：${n} 处`);
  if (n !== 1) { ok = false; continue; }
  src = src.split(p.from).join(p.to);
}
if (!ok) { console.log('🛑 锚点不对，未写盘'); process.exit(2); }
if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(F, src, 'utf8');
console.log('✍️  已写 memory-pipeline.mjs');
