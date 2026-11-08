// 饥饿保护验收：18 个动作（window 角色，1 个/2s 配额）→ 最后一个必须排到 ~34s 后 → 必被 30s 提级
import fs from 'node:fs';
const BASE = process.argv[2] ?? 'http://127.0.0.1:9338';
const TOK = JSON.parse(fs.readFileSync('E:/DeepFish/avatar/state/body-tokens.json', 'utf8').replace(/^\uFEFF/, '')).roles;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, role, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-body-token': TOK[role] }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
const getState = () => fetch(`${BASE}/state`, { headers: { 'x-body-token': TOK.dev } }).then((r) => r.json());

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`); };

const jobs = Array.from({ length: 18 }, (_, i) => post('/anim', 'window', { name: `a${i + 1}` }));
await sleep(1200);
let s = await getState();
const depths = s.queue.depth;
check('动作确实积压进了队列', depths >= 10, `队列深度 ${depths}`);
const maxFire = Math.max(...s.queue.items.map((it) => it.fireAt - Date.now()));
check('最后一个被排到 30 秒以后', maxFire > 30000, `最晚 ${(maxFire / 1000).toFixed(1)}s 后`);

await sleep(33000);
s = await getState();
const boosted = s.queue.items.filter((it) => it.boosted);
const maxWait = Math.max(0, ...s.queue.items.map((it) => it.waitMs));
check('出现被提级的 job', boosted.length > 0 || s.history.some((r) => r.boosted), `boosted ${boosted.length} 条，最长已等 ${(maxWait / 1000).toFixed(1)}s`);

const done = await Promise.all(jobs);
check('全部 18 个动作最终都执行了（没被丢）', done.every((r) => r.status === 200), `状态码 ${[...new Set(done.map((r) => r.status))].join(',')}`);

const pass = results.filter(Boolean).length;
console.log(`\n=== ${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
