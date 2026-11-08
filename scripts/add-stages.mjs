// scripts\add-stages.mjs —— 给现有任务书批量补「阶段（P1/P2/P3）」段
// 2026-11-07 主人：「把模块化接口补上，然后写进开发规范里面」
//
// 依据票在台账里的状态：
//   done      → P1 [x] P2 [x] P3 [x]
//   submitted → P1 [x] P2 [ ] P3 [ ]
//   doing     → P1 [ ] P2 [ ] P3 [ ]
//   queued    → P1 [ ] P2 [ ] P3 [ ]
// 已有的不重复加；`--dry` 只打印。
import fs from 'node:fs';
import path from 'node:path';

const WS = 'E:/DSH_workspace';
const TASKS = path.join(WS, 'state', 'tasks');
const WORKLIST = path.join(WS, 'state', 'worklist.jsonl');
const DRY = process.argv.includes('--dry');

const state = new Map();
for (const line of fs.readFileSync(WORKLIST, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  if (!r.id) continue;
  const cur = state.get(r.id) || {};
  if (r.ticket) cur.ticket = r.ticket;
  if (r.state) cur.state = r.state;
  state.set(r.id, cur);
}
const byTicket = new Map();
for (const [, v] of state) if (v.ticket) byTicket.set(v.ticket, v.state);

const box = (s) => (s === 'done' ? '[x]' : s === 'submitted' ? '[x]' : '[ ]');
let changed = 0;
let skipped = 0;

for (const name of fs.readdirSync(TASKS)) {
  if (!name.endsWith('.md')) continue;
  const ticket = name.replace(/\.md$/, '');
  if (!/^[A-Z]{2}-\d+$/.test(ticket)) continue;
  const st = byTicket.get(ticket) || 'queued';
  const full = path.join(TASKS, name);
  let t = fs.readFileSync(full, 'utf8');
  if (t.includes('## 阶段')) { skipped++; continue; }

  const p1 = box(st);
  const p23 = st === 'done' ? '[x]' : '[ ]';
  const block = [
    '',
    '## 阶段（开发规范 v1：P1 接口与函数 → P2 管线装配 → P3 接管测试）',
    '',
    `- ${st === 'done' || st === 'submitted' ? '[x]' : '[ ]'} **P1 接口与函数（含单测）**——只依赖本仓库`,
    `- ${p23} **P2 管线装配**——依赖外部/其他模块就绪`,
    `- ${p23} **P3 接管测试**——真机联调`,
    '',
    `> 台账状态：**${st}**。暂停的票只允许 P1 打勾（规则见 \`docs\\规则\\模块化暂停-接口先补齐-2026-11-07.md\`）。`,
    '',
  ].join('\n');

  // 插到第一个 ## 之前（保留标题与引用块在前）
  const idx = t.indexOf('\n## ');
  const out = idx > 0 ? t.slice(0, idx) + '\n' + block + t.slice(idx + 1) : t + '\n' + block;

  if (DRY) { console.log(`  [dry] ${ticket}（${st}）`); }
  else { fs.writeFileSync(full, out, 'utf8'); }
  changed++;
}

console.log(`  补阶段：${changed} 张，已有跳过 ${skipped} 张${DRY ? '（dry，未写）' : ''}`);
