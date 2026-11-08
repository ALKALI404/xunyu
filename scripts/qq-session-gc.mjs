// scripts\qq-session-gc.mjs —— QQ 历史会话自动归档（只收"旧且不在用"的）
//
// 为什么需要：桥从 2026-11-04 起"退役不归档"，旧 QQ 会话会一直堆在列表里。
// 这里补一个保守的收集器：**只归档同时满足**下面三条的会话——
//   ① 标题是 QQ 会话（群聊·xxx / 鲟鱼QQ（xxx））
//   ② 不在桥当前的 sessions.json 映射里（不是正在用的）
//   ③ 最后活动早于 --hours（默认 24 小时）
// 并且每轮最多归档 --limit（默认 30）个，避免一次动太多。
//
// 用法：
//   node scripts\qq-session-gc.mjs                 只报告
//   node scripts\qq-session-gc.mjs --apply         真的归档
//   node scripts\qq-session-gc.mjs --hours 6 --limit 50 --apply
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORKSPACE = 'E:/DSH_workspace';
const BRIDGE = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const apply = argv.includes('--apply');
const hours = Number(opt('hours', '24'));
const limit = Number(opt('limit', '30'));

const ws = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.dsh/storages/workspace.json'), 'utf8'));
const archived = new Set(ws.global?.archivedSessionIds ?? []);

let live = new Set();
try {
  const st = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'state/sessions.json'), 'utf8').replace(/^\uFEFF/, ''));
  live = new Set(Object.values(st.sessions ?? {}).map(String));
} catch { }

const { NodeApiClient, unwrap } = await import('file:///' + BRIDGE.replace(/\\/g, '/') + '/src/dsh-client.js');
const api = new NodeApiClient('http://127.0.0.1:53389', undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });
const list = unwrap(await api.sessions.list({}), 's');

const cutoff = Date.now() - hours * 3600 * 1000;
const rows = (list.items ?? []).map((x) => ({
  id: String(x.sessionId),
  title: String(x.projections?.values?.title ?? ''),
  updatedAt: Number(x.updatedAt ?? x.projections?.values?.updatedAt ?? 0),
  running: !!x.running,
  cwd: String(x.cwd ?? ''),
}));

const qq = rows.filter((r) => /群聊|鲟鱼QQ/.test(r.title));
const candidates = qq.filter((r) =>
  !archived.has(r.id) && !live.has(r.id) && !r.running && r.updatedAt < cutoff);

console.log(`QQ 会话 ${qq.length} 个｜在用(映射) ${live.size} 个｜候选归档 ${candidates.length} 个（>${hours}h 且不在映射）`);
for (const c of candidates.slice(0, 15)) {
  console.log(`  ${c.id.slice(9, 17)}  ${c.title.slice(0, 26)}  ${new Date(c.updatedAt).toLocaleString('zh-CN')}  [${path.basename(c.cwd) || '-'}]`);
}
if (candidates.length > 15) console.log(`  …共 ${candidates.length} 个`);

if (!apply) {
  console.log('\n（只报告；加 --apply 才归档，每轮最多', limit, '个）');
  process.exit(0);
}

let ok = 0, fail = 0;
for (const c of candidates.slice(0, limit)) {
  try {
    execFileSync(process.execPath, ['scripts/handoff.mjs', 'archive', c.id, '--yes', '--by', 'qq-session-gc'],
      { cwd: WORKSPACE, stdio: 'ignore', timeout: 120000 });
    ok += 1;
  } catch { fail += 1; }
}
console.log(`\n✅ 归档 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`);
