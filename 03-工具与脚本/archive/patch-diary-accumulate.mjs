// 日记改成「按当天累计」重写：增量 diff 不覆盖当天已写的日记（否则同一天多跑几次，日记会越跑越短）
import fs from 'node:fs';
const F = 'E:/DeepFish/avatar/memory-pipeline/memory-pipeline.mjs';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(F, 'utf8');

const from = `const runDaily = (by) => {
  const d = distill(TODAY);
  const rows = diff(TODAY);
  // 没有新增量就不动日记（否则重跑会把昨天的日记覆盖成「没有变化」）
  if (rows.length) diary(TODAY, rows);
  else log(\`日记 \${TODAY}：本次无新增，保持原文件不动\`);
  state.daily[TODAY] = { at: new Date().toISOString(), by, facts: d.facts.length, rules: d.rules };
  writeJson(STATE_FILE, state);
  return { facts: d.facts.length, diffRows: rows.length };
};`;

const to = `const runDaily = (by) => {
  const d = distill(TODAY);
  const rows = diff(TODAY);
  // 日记按「当天累计」重写：diff 是增量（只为判断「这次有没有新东西」），
  // 但日记要反映**一整天**，所以把历次增量累起来再写，避免同一天多跑几次越跑越短。
  if (!state.diaryRows) state.diaryRows = {};
  const prevRows = Array.isArray(state.diaryRows[TODAY]) ? state.diaryRows[TODAY] : [];
  const merged = [...new Set([...prevRows, ...rows])];
  state.diaryRows[TODAY] = merged;
  if (merged.length) diary(TODAY, merged);
  else log(\`日记 \${TODAY}：今天还没有任何变化，先不写\`);
  state.daily[TODAY] = { at: new Date().toISOString(), by, facts: d.facts.length, rules: d.rules };
  writeJson(STATE_FILE, state);
  return { facts: d.facts.length, diffRows: rows.length, diaryRows: merged.length };
};`;

const n = src.split(from).length - 1;
console.log(`${n === 1 ? '✅' : '❌'} 锚点：${n} 处`);
if (n !== 1) process.exit(2);
src = src.split(from).join(to);
if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(F, src, 'utf8');
console.log('✍️  已写');
