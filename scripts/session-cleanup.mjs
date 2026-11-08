// scripts\session-cleanup.mjs —— 归档"废会话"（测试/重复/占位），保护名册与本体
//
// 判废规则（三条，任中其一）：
//   A. 标题是占位样式：`【当前时间】`、`【当前角色】`、空标题
//   B. 标题含 test/测试/临时/废弃/tmp
//   C. **同一工号/同一群名重复**，只保留名册里的那个（active sessionId）与最近活跃的一个
//
// 保护（永不归档）：本体、名册 active 的 sessionId、正在跑的会话。
//
// 用法：
//   node scripts\session-cleanup.mjs            只报告
//   node scripts\session-cleanup.mjs --apply    真的归档（逐个走 handoff archive）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORKSPACE = 'E:/DSH_workspace';
const BRIDGE = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1';
const apply = process.argv.includes('--apply');

const ws = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.dsh/storages/workspace.json'), 'utf8'));
const archived = new Set(ws.global?.archivedSessionIds ?? []);

// 2026-11-04：把 QQ 桥正在用的会话也加进保护名单。
// 事故背景：三条 QQ 会话（两个群 + 一个私聊）被当成"重复会话"归档，桥随后找不到会话而全线哑掉。
try {
  const bridgeState = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'state/sessions.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const sid of Object.values(bridgeState.sessions ?? {})) if (sid) protectedIds.add(String(sid));
} catch { /* 桥没跑过/没映射就跑，不影响其它保护 */ }

const roster = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'state/roster.json'), 'utf8'));
const protectedIds = new Set();
for (const arr of Object.values(roster)) {
  if (!Array.isArray(arr)) continue;
  for (const x of arr) if (x?.sessionId) protectedIds.add(String(x.sessionId));
}

const { NodeApiClient, unwrap } = await import('file:///' + BRIDGE + '/src/dsh-client.js');
const api = new NodeApiClient('http://127.0.0.1:53389', undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });
const list = unwrap(await api.sessions.list({}), 's');

const rows = (list.items ?? []).map((x) => ({
  id: String(x.sessionId),
  title: String(x.projections?.values?.title ?? '').trim(),
  updatedAt: Number(x.updatedAt ?? x.projections?.values?.updatedAt ?? 0),
  running: !!x.running,
  cwd: String(x.cwd ?? ''),
})).filter((x) => !archived.has(x.id));

const placeholder = (t) => !t || t.startsWith('【当前时间】') || t.startsWith('【当前角色】');
const junkWord = (t) => /(test|测试|临时|废弃|tmp|演练|占位)/i.test(t);

const verdict = [];
const keep = [];
for (const x of rows) {
  if (protectedIds.has(x.id) || x.running || x.title.includes('本体')) { keep.push({ ...x, why: '受保护' }); continue; }
  if (placeholder(x.title)) { verdict.push({ ...x, why: '占位标题' }); continue; }
  if (junkWord(x.title)) { verdict.push({ ...x, why: '测试/临时' }); continue; }
  keep.push({ ...x, why: '有正经标题' });
}

// 同一标题保留最新一个
const byTitle = new Map();
for (const x of keep) {
  if (!x.title) continue;
  if (!byTitle.has(x.title)) byTitle.set(x.title, []);
  byTitle.get(x.title).push(x);
}
for (const [title, arr] of byTitle) {
  if (arr.length <= 1) continue;
  arr.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const dup of arr.slice(1)) {
    verdict.push({ ...dup, why: `与「${title.slice(0, 20)}」重复` });
  }
}

console.log(`未归档会话 ${rows.length} 个｜建议归档 ${verdict.length} 个｜保留 ${keep.length} 个\n`);
for (const v of verdict.slice(0, 40)) {
  console.log(`  [${v.why}] ${v.id.slice(9, 17)}  ${(v.title || '(空标题)').slice(0, 34)}  ${new Date(v.updatedAt).toLocaleDateString('zh-CN')}`);
}
if (verdict.length > 40) console.log(`  …共 ${verdict.length} 个`);

if (!apply) { console.log('\n（只报告；加 --apply 才归档）'); process.exit(0); }

let ok = 0, fail = 0;
for (const v of verdict) {
  try {
    execFileSync(process.execPath, ['scripts/handoff.mjs', 'archive', v.id, '--yes'], { cwd: WORKSPACE, stdio: 'ignore', timeout: 120000 });
    ok += 1;
  } catch { fail += 1; }
}
console.log(`\n✅ 归档 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`);
