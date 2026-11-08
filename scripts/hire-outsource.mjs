// scripts\hire-outsource.mjs —— 外包岗位：按票开临时工位，交付即关
// 规则：docs\规则\外包岗位-2026-11-07.md
//
// 用法：
//   node scripts\hire-outsource.mjs hire ST-128 --why "04 排了 5 张，128 能独立做"
//   node scripts\hire-outsource.mjs list
//   node scripts\hire-outsource.mjs fire OUT-1
import fs from 'node:fs';
import path from 'node:path';

const WS = 'E:/DSH_workspace';
const BOOK = path.join(WS, 'state', 'outsource.json');
const TASKS = path.join(WS, 'state', 'tasks');
const ROSTER = path.join(WS, 'state', 'roster.json');
const BRIDGE = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
const MAX_LIVE = 2;        // 同时在线上限
const MAX_OPEN_PER_DAY = 4;

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const book = fs.existsSync(BOOK) ? JSON.parse(fs.readFileSync(BOOK, 'utf8').replace(/^\uFEFF/, '')) : { jobs: [] };
book.jobs = book.jobs || [];

const save = () => fs.writeFileSync(BOOK, JSON.stringify(book, null, 2), 'utf8');
const live = () => book.jobs.filter((j) => j.state === 'live');

async function client() {
  const { NodeApiClient, unwrap } = await import(BRIDGE);
  const { resolveDshBase } = await import('file:///' + WS + '/scripts/dsh-base.mjs');
  const { url } = resolveDshBase();
  const api = new NodeApiClient(url, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });
  return { api, unwrap };
}

if (cmd === 'list') {
  if (!book.jobs.length) { console.log('  没有外包记录'); process.exit(0); }
  for (const j of book.jobs) {
    console.log(`  ${j.id}  ${j.state.padEnd(6)}  ${j.ticket}  开于 ${new Date(j.openedAt).toLocaleString('zh-CN')}${j.closedAt ? '  关：' + new Date(j.closedAt).toLocaleString('zh-CN') : ''}`);
    if (j.why) console.log(`      理由：${j.why}`);
  }
  process.exit(0);
}

if (cmd === 'hire') {
  const ticket = argv[1];
  const whyIdx = argv.indexOf('--why');
  const why = whyIdx > 0 ? argv.slice(whyIdx + 1).join(' ') : '';
  if (!ticket) { console.error('  要票号：hire ST-128 --why "…"'); process.exit(1); }

  if (live().length >= MAX_LIVE) { console.error(`  同时在线的外包已达上限 ${MAX_LIVE}，先 fire 一个`); process.exit(1); }
  const today = new Date().toISOString().slice(0, 10);
  const openedToday = book.jobs.filter((j) => String(j.openedAt).slice(0, 10) === today || new Date(j.openedAt).toISOString().slice(0, 10) === today).length;
  if (openedToday >= MAX_OPEN_PER_DAY) { console.error(`  今天已开 ${openedToday} 个外包，超过每日 ${MAX_OPEN_PER_DAY} 上限`); process.exit(1); }

  const bookFile = path.join(TASKS, ticket + '.md');
  if (!fs.existsSync(bookFile)) { console.error('  找不到任务书：' + bookFile); process.exit(1); }
  const spec = fs.readFileSync(bookFile, 'utf8');

  // 目录：从任务书里抠「目录 / cwd / 项目根」，抠不到就用 DSH_workspace
  const dirMatch = spec.match(/(E:\\[^\s`"）)]+)/);
  const cwd = dirMatch ? dirMatch[1].replace(/\\+$/, '') : WS;

  const { api, unwrap } = await client();
  const created = unwrap(await api.workspace.create({ path: cwd }), 'w');
  const wsId = created.workspaceId;
  const s = unwrap(await api.sessions.create({ workspaceId: wsId }), 'c');
  const sid = s.sessionId || s.session?.sessionId;

  const n = book.jobs.filter((j) => String(j.id).startsWith('OUT-')).length + 1;
  const id = 'OUT-' + n;
  await api.sessions.rename({ sessionId: sid, title: `外包 ${id} · ${ticket}` });

  const prompt = [
    `【你是外包 ${id}：只做 ${ticket} 这一段，做完就结束】`,
    '',
    '**你不是长期工，只干这一张票。** 交付后这个工位会被关掉。',
    '',
    '**规矩**：',
    '1. **只做任务书里写的那一段**（通常是 P1 接口与函数），**不要顺手改别的**；',
    '2. **不许碰 worklist / 派单 / 名册**（那是固定工的事）；',
    '3. 交付写 `records\\交付\\' + id + '-' + ticket + '.md`，**带证据**（命令输出/截图）；',
    '4. **无明文令牌/Key**；路径只白名单；改动要可回滚（`.bak-<票号>`）；',
    '5. **有疑问先问，别猜**；猜错了返工没人替你收拾。',
    '',
    '**开发规范**：`docs\\规则\\开发规范-2026-11-07.md`（P1 接口与函数 → P2 管线 → P3 接管）。',
    '',
    '--- 任务书原文 ---',
    spec.slice(0, 12000),
  ].join('\n');

  unwrap(await api.sessions.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text: prompt }] }), 'p');

  const job = { id, ticket, sessionId: sid, workspaceId: wsId, cwd, why, state: 'live', openedAt: Date.now() };
  book.jobs.push(job);
  save();

  // 名册记一笔（type=outsource）
  try {
    const roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8').replace(/^\uFEFF/, ''));
    roster.active = roster.active || [];
    roster.active.push({
      id, type: 'outsource', role: '外包（临时）', title: `外包 ${id} · ${ticket}`,
      sessionId: sid, cwd, status: 'active', owns: [ticket],
      boundaries: ['只做这一张票', '不碰 worklist', '交付即关'], activatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(ROSTER, JSON.stringify(roster, null, 2), 'utf8');
  } catch { /* 名册写失败不挡开工 */ }

  console.log(`  ✅ ${id} 已开：${ticket}  session=${sid}`);
  console.log(`     目录：${cwd}`);
  console.log(`     交付写：records\\交付\\${id}-${ticket}.md`);
  process.exit(0);
}

if (cmd === 'fire') {
  const id = argv[1];
  const job = book.jobs.find((j) => j.id === id && j.state === 'live');
  if (!job) { console.error('  找不到在线的 ' + id); process.exit(1); }

  const { api, unwrap } = await client();
  try {
    unwrap(await api.sessions.rename({ sessionId: job.sessionId, title: `[已关] 外包 ${job.id} · ${job.ticket}` }), 'r');
  } catch { /* 改名失败不影响关闭 */ }

  job.state = 'closed';
  job.closedAt = Date.now();
  save();

  try {
    const roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8').replace(/^\uFEFF/, ''));
    const w = (roster.active || []).find((x) => x.id === id);
    if (w) { w.status = 'retired'; w.retiredAt = new Date().toISOString(); }
    fs.writeFileSync(ROSTER, JSON.stringify(roster, null, 2), 'utf8');
  } catch { /* 名册失败不挡 */ }

  console.log(`  ✅ ${id} 已关（票 ${job.ticket}）`);
  process.exit(0);
}

console.error('用法：hire <票号> --why "…" | list | fire <OUT-n>');
process.exit(1);
