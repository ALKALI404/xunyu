// scripts\blame.mjs —— 从"错误"回溯到"问题发生位置"（最短路径优先）
//
// 核心思想：**每一跳都必须落在可验证的锚点上**（台账行号 / 文件路径:行 / 进程 pid / 日志行号），
// 不许出现"可能是…"这种无锚点的推断。跳数越少越好，每跳给出**复现命令**。
//
// 用法：
//   node scripts\blame.mjs UG-042           按单号回溯
//   node scripts\blame.mjs W-332            按台账 id 回溯
//   node scripts\blame.mjs --literal P3_对账通过   按体检文字回溯
//
// 输出：按时间排序的证据链 + 「第一处分歧」（最早出现不一致的那一跳）
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = 'E:/DSH_workspace';
const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
const wantLiteral = argv[argv.indexOf('--literal') + 1];

const read = (p, d = '') => { try { return fs.readFileSync(path.join(WORKSPACE, p), 'utf8'); } catch { return d; } };
const jsonl = (p) => read(p).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const exists = (p) => fs.existsSync(path.join(WORKSPACE, p));

const hops = [];
function hop(depth, what, anchor, how) { hops.push({ depth, what, anchor, how }); }

// ── 0. 输入解析：单号 ↔ 台账 id ──────────────────────────────────────
let ticket = target;
let ledgerId = null;
const events = jsonl('state/worklist.jsonl');
if (/^W-\d+$/.test(String(target))) {
  ledgerId = target;
  const t = [...events].reverse().find((e) => e.id === ticket);
  ticket = t?.ticket ?? null;
} else {
  const t = [...events].reverse().find((e) => e.ticket === ticket);
  ledgerId = t?.id ?? null;
}
if (!ticket) { console.error('找不到票据：', target); process.exit(2); }
hop(0, `目标票 ${ticket}（台账 ${ledgerId}）`, `state/worklist.jsonl（${events.length} 行）`, `node scripts\\worklist.mjs show ${ledgerId}`);

// ── 1. 台账末态：错误最直接的落点 ───────────────────────────────────
const mine = events.filter((e) => e.ticket === ticket || e.id === ledgerId);
const last = [...mine].reverse();
const lastState = last.find((e) => e.state);
hop(1, `末态 = ${lastState?.state ?? '?'}（by ${lastState?.by ?? '?'}）`,
  `state/worklist.jsonl 中 ${ticket} 的 ${mine.length} 条事件`,
  `node scripts\\worklist.mjs show ${ledgerId}`);

// ── 2. 最后一次状态变化的理由（往往直接指向原因）───────────────────
const lastNote = last.find((e) => e.note);
if (lastNote) {
  hop(2, `最后一条说明：${String(lastNote.note).slice(0, 90)}`,
    `op=${lastNote.op ?? lastNote.state} by=${lastNote.by ?? '?'} t=${new Date(lastNote.t ?? 0).toISOString()}`,
    `node scripts\\worklist.mjs show ${ledgerId} | Select-Object -Last 5`);
}

// ── 3. 派发审计：这一票被派过几次、为什么失败 ──────────────────────
const disp = jsonl('logs/dispatch.jsonl').filter((d) => d.ticket === ticket || d.id === ledgerId);
if (disp.length) {
  const fails = disp.filter((d) => d.ok === false || d.error);
  const firstFail = fails[0];
  hop(3, `派发 ${disp.length} 次，失败 ${fails.length} 次`,
    firstFail ? `首败：${JSON.stringify(firstFail).slice(0, 110)}` : '全部成功',
    `Select-String -Path logs\\dispatch.jsonl -Pattern '${ticket}'`);
}

// ── 4. 任务书：闸门最常卡在这里 ────────────────────────────────────
const book = `state/tasks/${ticket}.md`;
if (exists(book)) {
  const txt = read(book);
  const hasContract = /^##\s*接口契约/m.test(txt);
  const hasWhat = /^##\s*做什么/m.test(txt);
  const hasExp = /^##\s*(0\.5\s*)?预期结果/m.test(txt);
  hop(4, `任务书：契约 ${hasContract ? '有' : '缺'} / 做什么 ${hasWhat ? '有' : '缺'} / 预期结果 ${hasExp ? '有' : '缺'}`,
    `${book}（${txt.split('\n').length} 行）`,
    `Select-String -Path ${book.replace(/\//g, '\\')} -Pattern '^## '`);
} else {
  hop(4, '任务书不存在（这是硬缺失）', book, `Test-Path ${book.replace(/\//g, '\\')}`);
}

// ── 5. 项目栏：票有没有贴进去 ─────────────────────────────────────
const projects = JSON.parse(read('state/projects.json', '{}') || '{}');
let boardHit = null;
for (const p of projects.projects ?? []) {
  for (const f of p.features ?? []) {
    if ((f.tickets ?? []).includes(ticket)) boardHit = { project: p.id, feature: f.id, contract: f.contract ?? '' };
  }
}
hop(5, boardHit ? `项目栏：${boardHit.project}/${boardHit.feature}（契约 ${boardHit.contract || '空'}）` : '项目栏**没有**这张票（not-in-project 的直接原因）',
  'state/projects.json',
  `node scripts\\pr-reconcile.mjs --check`);

// ── 6. 交付物：有没有真实产物 ─────────────────────────────────────
const delivDir = path.join(WORKSPACE, 'records/交付');
let deliv = null;
try { deliv = fs.readdirSync(delivDir).find((n) => n.includes(ticket)); } catch { }
hop(6, deliv ? `交付存在：${deliv}` : '**没有交付文件**',
  deliv ? `records/交付/${deliv}` : delivDir,
  `Get-ChildItem records\\交付 -Filter '*${ticket}*'`);

// 体检文字直查
if (wantLiteral) {
  const lits = jsonl('state/health-literals.jsonl').filter((l) => l.literal === wantLiteral).slice(-5);
  hop(7, lits.length ? `体检文字 ${wantLiteral} 最近 ${lits.length} 次：${lits.map((l) => l.value).join(',')}` : `体检文字 ${wantLiteral} 还没有登记（尚在"外挂探测"阶段）`,
    'state/health-literals.jsonl', `node scripts\\health-3sat.mjs --verbose`);
}

// ── 输出：链 + 第一处分歧 ─────────────────────────────────────────
console.log(`== 回溯链：${ticket}（${hops.length} 跳）==\n`);
for (const h of hops) {
  console.log(`[${h.depth}] ${h.what}`);
  console.log(`     锚点：${h.anchor}`);
  console.log(`     复现：${h.how}`);
}

// 第一处分歧：深度最小的"坏"信号
// 选"第一处分歧"：硬缺失（缺件/不存在/没有）优先于一般失败；同分取跳数最小
const score = (h) => {
  const w = h.what;
  if (/缺|不存在|没有|not-in-project|项目栏\*\*没有/.test(w)) return 2;
  if (/失败|UNSAT|drop/.test(w)) return 1;
  return 0;
};
const bad = hops.filter((h) => score(h) > 0).sort((a, b) => (score(b) - score(a)) || (a.depth - b.depth))[0];
console.log('\n== 最短路径结论 ==');
if (bad) {
  console.log(`**第一处分歧在第 ${bad.depth} 跳**：${bad.what}`);
  console.log(`**落地位置**：${bad.anchor}`);
  console.log(`**下一步**：${bad.how}`);
  console.log('说明：这一跳之前都"看起来正常"，坏是从这里开始的——先修这里，再往上验。');
} else {
  console.log('这条链上没有发现缺件；错误可能在链外（进程/权限/网络），请用 health-3sat 的 U 状态细分。');
}
