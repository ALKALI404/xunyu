// scripts\st-acceptance.mjs —— ST（学习区）专属验收管线：待验收的 ST 票直接推给「本体」
// 2026-11-07 主人：「in 还是 01 验，st 能不能单开验收管线直接自动找你」
//
// 扫 worklist 里 state=submitted 且 ticket 以 ST- 开头的票 → 每张只推一次
// （state\st-acceptance.json 记已推）→ 直接调 DSH 的 sessions/prompt 推进本体会话。
// 不走 QQ 桥（桥要 token、且会被 session/list 超时卡住）。
//
// 用法：
//   node scripts\st-acceptance.mjs           正常跑（计划任务每 3 分钟）
//   node scripts\st-acceptance.mjs --dry     只打印，不推
import fs from 'node:fs';
import path from 'node:path';

const WS = 'E:/DSH_workspace';
const WORKLIST = path.join(WS, 'state', 'worklist.jsonl');
const SEEN = path.join(WS, 'state', 'st-acceptance.json');
const LOG = path.join(WS, 'logs', 'st-acceptance.jsonl');
const OWNER_SESSION = 'session-b6eb5c94-6e85-415d-a353-e91c68208442'; // 本体
const DRY = process.argv.includes('--dry');

const readSeen = () => { try { return JSON.parse(fs.readFileSync(SEEN, 'utf8')); } catch { return {}; } };
const writeSeen = (o) => { fs.mkdirSync(path.dirname(SEEN), { recursive: true }); fs.writeFileSync(SEEN, JSON.stringify(o, null, 2), 'utf8'); };

function submittedTickets() {
  const rows = fs.readFileSync(WORKLIST, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const m = new Map();
  for (const r of rows) {
    if (!r.id) continue;
    const cur = m.get(r.id) || { id: r.id, ticket: '', state: '', target: '', at: 0 };
    if (r.ticket) cur.ticket = r.ticket;
    if (r.state) cur.state = r.state;
    if (r.target) cur.target = r.target;
    if (r.t && Number(r.t) > cur.at) cur.at = Number(r.t);
    m.set(r.id, cur);
  }
  return [...m.values()].filter((x) => x.state === 'submitted' && /^ST-/.test(x.ticket));
}

const seen = readSeen();
const todo = submittedTickets().filter((x) => !seen[x.id]);

if (!todo.length) { console.log('  ST 待验收：0 张（没有新的）'); process.exit(0); }

const list = todo.map((x) => `- ${x.id} ${x.ticket}（交于 ${new Date(x.at).toLocaleString('zh-CN')}）`).join('\n');
console.log(`  ST 待验收 ${todo.length} 张：\n${list}`);
if (DRY) { console.log('  [dry] 不推送'); process.exit(0); }

const text = [
  '【ST 验收管线·自动提醒】',
  '',
  `学习区有 ${todo.length} 张票已交付待验收：`,
  list,
  '',
  '按 ST 独立验收规则：**这批由本体验**（不经 01）。',
  '交付在 `records\\交付\\` 下；验完用 `node scripts\\worklist.mjs state <W号> done --note "…"` 结票。',
].join('\n');

let ok = false;
let detail = '';
try {
  const BRIDGE = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
  const { NodeApiClient, unwrap } = await import(BRIDGE);
  const { resolveDshBase } = await import('file:///E:/DSH_workspace/scripts/dsh-base.mjs');
  const { url } = resolveDshBase();
  const api = new NodeApiClient(url, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });
  const res = unwrap(await api.sessions.prompt({ sessionId: OWNER_SESSION, mode: 'queue', content: [{ type: 'text', text }] }), 'p');
  ok = Boolean(res && res.accepted !== false);
  detail = JSON.stringify(res).slice(0, 150);
} catch (e) {
  detail = String(e?.message ?? e).slice(0, 160);
}

fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), pushed: todo.map((x) => x.id), ok, detail }) + '\n', 'utf8');

if (ok) {
  for (const x of todo) seen[x.id] = new Date().toISOString();
  writeSeen(seen);
  console.log(`  ✅ 已推送本体（${todo.length} 张）`);
} else {
  console.log(`  ❌ 推送失败：${detail}`);
}
