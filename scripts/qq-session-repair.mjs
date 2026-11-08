// scripts\qq-session-repair.mjs —— 修 QQ 桥的会话映射（每次来消息都新建会话的真凶）
//
// 现象：state\sessions.json 的 sessions 为空 → 每条消息都新建 DSH 会话 →
//       一个群攒出十几个同名会话；"自动改名"看着没生效（其实是在给新会话起名）。
//
// 做法（保守）：
//   1. 读 DSH 会话列表，按标题里的 QQ 号分组，挑**未归档、有活动**的那个当"正主"；
//   2. 写回 state\sessions.json 的 sessions 映射（先备份原文件）；
//   3. 其余重复会话**不动**（列出来给主人/我再归档）；
//   4. 打印每条映射的依据（标题 + sessionId + 最后更新时间）。
//
// 用法：node scripts\qq-session-repair.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1';
const STATE_FILE = path.join(BRIDGE, 'state', 'sessions.json');
const apply = process.argv.includes('--apply');

const { NodeApiClient, unwrap } = await import('file:///' + BRIDGE.replace(/\\/g, '/') + '/src/dsh-client.js');
const api = new NodeApiClient('http://127.0.0.1:53389', undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });

const ws = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.dsh/storages/workspace.json'), 'utf8'));
const archived = new Set(ws.global?.archivedSessionIds ?? []);

const list = unwrap(await api.sessions.list({}), 's');
const items = (list.items ?? []).map((x) => ({
  id: String(x.sessionId),
  title: String(x.projections?.values?.title ?? ''),
  updatedAt: Number(x.projections?.values?.updatedAt ?? x.updatedAt ?? 0),
  running: !!x.running,
})).filter((x) => !archived.has(x.id));

// 标题形如 群聊·名字（835658578） / 私聊·名字（2734856217）
const byKey = new Map();
for (const it of items) {
  const m = it.title.match(/^(群聊|私聊)·.*?（(\d{5,12})）/);
  if (!m) continue;
  const key = (m[1] === '群聊' ? 'group:' : 'private:') + m[2];
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(it);
}

const cur = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
const next = { ...cur, sessions: { ...(cur.sessions ?? {}) } };

console.log(`当前映射 ${Object.keys(next.sessions).length} 条；找到 ${byKey.size} 个 QQ 会话组\n`);
for (const [key, list2] of byKey) {
  list2.sort((a, b) => b.updatedAt - a.updatedAt);
  const best = list2[0];
  const old = next.sessions[key];
  next.sessions[key] = best.id;
  console.log(`${key}`);
  console.log(`  正主 → ${best.id.slice(9, 17)}  「${best.title}」  更新 ${new Date(best.updatedAt).toLocaleString('zh-CN')}`);
  console.log(`  旧映射：${old ? String(old).slice(9, 17) : '（空）'}${old === best.id ? '  ✅ 已一致' : '  → 需修'}`);
  if (list2.length > 1) {
    console.log(`  重复 ${list2.length - 1} 个：` + list2.slice(1, 5).map((x) => x.id.slice(9, 17)).join(', ') + (list2.length > 5 ? ' …' : ''));
  }
}

if (apply) {
  const bak = STATE_FILE + '.bak-repair-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(STATE_FILE, bak);
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  console.log(`\n✅ 已写回 ${STATE_FILE}（备份 ${path.basename(bak)}）`);
  console.log('⚠ 桥是启动时读一次映射：要重启桥才会用上新映射。');
} else {
  console.log('\n（演练模式，未写文件；加 --apply 才写）');
}
