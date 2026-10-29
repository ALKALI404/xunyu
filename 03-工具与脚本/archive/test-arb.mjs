// 仲裁 B 验收（跑在 9336 的 noop 哑身体上，不碰真身体）
// 用法：node test-arb.mjs [--slow]   （--slow 才跑 30 秒饥饿保护那条）
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:9336';
const TOK = JSON.parse(fs.readFileSync('E:/DeepFish/avatar/state/body-tokens.json', 'utf8').replace(/^\uFEFF/, '')).roles;
const SLOW = process.argv.includes('--slow');
const T0 = Date.now();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, role, body = {}) {
  const started = Date.now();
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(role ? { 'x-body-token': TOK[role] } : {}) },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, data, tookMs: Date.now() - started };
}
async function get(path, role) {
  const r = await fetch(`${BASE}${path}`, { headers: role ? { 'x-body-token': TOK[role] } : {} });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const say = (role, text, extra = {}) => call('/say', role, { text, ...extra });

async function state() { return (await get('/state', 'dev')).data; }
async function idle(timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await state();
    if (s && !s.queue.busy && s.queue.depth === 0) return s;
    await sleep(250);
  }
  return null;
}
const saysSince = (hist, fromId) => hist.filter((r) => r.action === 'say' && r.id > fromId);

// ── 0. 就绪 + 鉴权回归 ────────────────────────────────────────────────────
const h0 = await get('/health');
check('健康检查无令牌可读', h0.status === 200, `HTTP ${h0.status}`);
const noTok = await call('/say', null, { text: 'x' });
check('无令牌 /say 仍是 403', noTok.status === 403, `HTTP ${noTok.status}`);
const devTimer = await call('/timer', 'dev', { minutes: 5 });
check('dev 调 /timer 仍是 403', devTimer.status === 403, `HTTP ${devTimer.status}`);
const devSay = await say('dev', '');
check('dev /say 空文本 400（过了闸门）', devSay.status === 400, `HTTP ${devSay.status}`);

// ── 1. 合并 + 配额间隔（本体连发 3 句）───────────────────────────────────
await idle();
let s = await state();
const fromId1 = s.history.length ? s.history[s.history.length - 1].id : 0;
const p1 = say('owner', '第一句');
const p2 = say('owner', '第二句');
const p3 = say('owner', '第三句');
const r1 = await p1; const r2 = await p2; const r3 = await p3;
check('本体三连发都成功（无 429）', [r1, r2, r3].every((r) => r.status === 200), `HTTP ${r1.status}/${r2.status}/${r3.status}`);
await idle();
s = await state();
const say1 = saysSince(s.history, fromId1);
const merged = say1.reduce((n, r) => n + (r.mergedCount || 0), 0);
check('3 句被压缩成 ≤2 次发声', say1.length <= 2, `实际发声 ${say1.length} 次，合并 ${merged} 次`);
check('发生了合并（mergedCount>0）', merged > 0, `mergedCount=${merged}`);
const second = say1[1];
if (second) {
  check('第二句等到了配额（≥2.5s）', (second.waitedMs ?? 0) >= 2500, `waitedMs=${second.waitedMs}`);
  check('合并后的原文同时含二、三', /二/.test(second.text ?? '') && /三/.test(second.text ?? ''), JSON.stringify(second.text));
}

// ── 2. 爆发不丢不炸（本体连发 8 句）──────────────────────────────────────
await idle();
s = await state();
const fromId2 = s.history.length ? s.history[s.history.length - 1].id : 0;
const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => say('owner', `爆发${i + 1}`)));
check('8 句爆发全部 200（没有 429）', burst.every((r) => r.status === 200), `状态码: ${[...new Set(burst.map((r) => r.status))].join(',')}`);
await idle();
s = await state();
const say2 = saysSince(s.history, fromId2);
check('8 句被压成 ≤6 次发声', say2.length <= 6, `实际 ${say2.length} 次`);
const chars = say2.reduce((n, r) => n + (String(r.text ?? '').length), 0);
check('文本没有整体丢失（≥8 字）', chars >= 8, `合并后共 ${chars} 字，截断 ${say2.reduce((n, r) => n + (r.droppedChars || 0), 0)} 字`);

// ── 3. 优先级：工作组排队时本体插队 ──────────────────────────────────────
await idle();
s = await state();
const fromId3 = s.history.length ? s.history[s.history.length - 1].id : 0;
const devBurst = Array.from({ length: 5 }, (_, i) => say('dev', `工作组${i + 1}`));
await sleep(200);
const ownerJump = say('owner', '本体插队');
const jumpRes = await ownerJump;
await Promise.all(devBurst);
await idle();
s = await state();
const order = saysSince(s.history, fromId3);
const ownerIdx = order.findIndex((r) => r.role === 'owner');
const devAfter = order.filter((r, i) => r.role === 'dev' && i > ownerIdx).length;
check('本体没被工作组压在队尾（本体不晚于第 2 个）', ownerIdx >= 0 && ownerIdx <= 1, `出现位置 ${ownerIdx + 1}/${order.length}`);
check('工作组确实排在后面（优先级生效）', devAfter >= 1, `本体之后还有 ${devAfter} 条工作组`);

// ── 4. manual 永不丢（队列满的丢弃路径由 test-arb-drop.mjs 在小上限实例上验）────
await idle();
const manualP = say('window', '【用户亲口】这句不能丢', { manual: true });
const manualRes = await manualP;
check('manual（用户亲口）直接放行', manualRes.status === 200, `HTTP ${manualRes.status}，${manualRes.tookMs}ms`);
await idle();

// ── 5. 饥饿保护（30 秒，可选）──────────────────────────────────────────
if (SLOW) {
  await idle();
  const devWait = say('dev', '我会不会被饿死');
  await sleep(250);
  const floods = [];
  for (let i = 0; i < 12; i += 1) { floods.push(say('owner', `刷屏${i + 1}`)); await sleep(2200); }
  const waited = await devWait;
  const ok = waited.status === 200 && waited.tookMs < 34000;
  check('工作组等 30 秒内被放行（饥饿保护）', ok, `等了 ${(waited.tookMs / 1000).toFixed(1)}s`);
  await Promise.all(floods);
  await idle();
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} 通过，用时 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
process.exit(pass === results.length ? 0 : 1);
