// 队列丢弃路径验收：需要一个 AVATAR_BODY_ARB_MAX=3 的实例（队列很短，才能真灌满）
// 用法：node test-arb-drop.mjs http://127.0.0.1:9337
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:9337';
const TOK = JSON.parse(fs.readFileSync('E:/DeepFish/avatar/state/body-tokens.json', 'utf8').replace(/^\uFEFF/, '')).roles;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`); };

async function call(path, role, body = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(role ? { 'x-body-token': TOK[role] } : {}) },
    body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

// 动作不参与合并 → 才能真正把队列灌满。
// 注意角色：dev 只有 say 权限，动作得用 window/owner 角色打。
const flood = Array.from({ length: 10 }, (_, i) => call('/anim', 'window', { name: `a${i + 1}` }));
const manual = call('/say', 'window', { text: '用户亲口这句', manual: true });
const res = await Promise.all(flood);
const m = await manual;
const ok200 = res.filter((r) => r.status === 200).length;
const dropped = res.filter((r) => r.status === 429).length;

check('队列上限生效（出现 429 丢弃）', dropped > 0, `丢弃 ${dropped} 条 / 接受 ${ok200} 条`);
check('接受条数受上限约束（≤ 4：1 在跑 + 3 排队）', ok200 <= 4, `接受 ${ok200} 条`);
check('被丢的错误码是 QUEUE_FULL', res.some((r) => r.status === 429), JSON.stringify(res.find((r) => r.status === 429)?.data ?? null));
check('manual（用户亲口）没被丢', m.status === 200, `HTTP ${m.status}`);

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
