// P0-4 第二步：仲裁 B（配额 + 优先级排队 + 合并）写进 body-service.mjs
//
// 依据：<工作区>\方案-P0-4-仲裁B.md
// 口径：本体 3 > 窗口 2 > 工作组 1；本体 1句/3s、4句/10s、15句/60s，动作 1/2s；
//       超额不拒、改成「算最早可发时刻再排」；3 秒内同角色 spam 合并；
//       队列满 20 按 dev→window→owner 丢最旧；manual 不合并/不丢弃/不排队；
//       等超 30s 提级；AVATAR_BODY_ARB=off 退回 FIFO。
//
// 顺带：/health 和 /state 暴露队列明细（role/priority/boosted/mergedCount），history 里也记 role。

import fs from 'node:fs';
import path from 'node:path';

const BODY = 'E:/DeepFish/avatar/body-service.mjs';
const BACKUP = 'E:/DSH_workspace/backup';
const WRITE = process.argv.includes('--write');

const QUEUE_BLOCK_FROM = `// ── 队列（单飞 + 有限深度）─────────────────────────────────────────────
const queue = [];
const history = [];             // 最近 50 条动作，供 /state 看
let busy = false;
let seq = 0;

function historyPush(rec) {
  history.push(rec);
  while (history.length > 50) history.shift();
}

/** 队列满时丢一个：优先丢「不是说话」的，其次丢最旧的。 */
function dropOne() {
  if (queue.length < QUEUE_MAX) return null;
  let idx = queue.findIndex((j) => j.action !== 'say');
  if (idx < 0) idx = 0;
  const [dropped] = queue.splice(idx, 1);
  log(\`队列满(\${QUEUE_MAX})，丢弃 \${dropped.action}（source=\${dropped.source}）\`);
  dropped.reject(Object.assign(new Error(\`身体队列已满，\${dropped.action} 被丢弃\`), { code: 'QUEUE_FULL' }));
  return dropped;
}

function enqueue(action, source, run) {
  dropOne();
  return new Promise((resolve, reject) => {
    const job = { id: ++seq, action, source, run, resolve, reject, queuedAt: Date.now() };
    queue.push(job);
    drain();
  });
}

async function drain() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  const startedAt = Date.now();
  try {
    const result = await job.run();
    const rec = { id: job.id, action: job.action, source: job.source, ok: result?.ok !== false, waitedMs: startedAt - job.queuedAt, tookMs: Date.now() - startedAt, at: new Date().toISOString() };
    historyPush(rec);
    if (!rec.ok) log(\`动作失败 \${job.action}（source=\${job.source}）：\${JSON.stringify(result).slice(0, 300)}\`);
    job.resolve({ ...result, bodyJob: rec });
  } catch (error) {
    const rec = { id: job.id, action: job.action, source: job.source, ok: false, error: String(error?.message ?? error), waitedMs: startedAt - job.queuedAt, tookMs: Date.now() - startedAt, at: new Date().toISOString() };
    historyPush(rec);
    log(\`动作异常 \${job.action}（source=\${job.source}）：\${rec.error}\`);
    job.reject(error);
  } finally {
    busy = false;
    setImmediate(drain);
  }
}`;

const QUEUE_BLOCK_TO = `// ── 队列（单飞 + 仲裁 B：配额 / 优先级 / 合并）────────────────────────────
// 口径（2026-10-25）：本体 3 > 窗口 2 > 工作组 1；本体 1句/3s、4句/10s、15句/60s、动作 1/2s。
// 超额**不拒绝**，改成算出「最早可发时刻」再排；3 秒内同角色 spam 合并成一句；
// 队列满 20 按 dev→window→owner 丢最旧；manual（窗口里人亲自说的）不合并/不丢弃/不排队；
// 等超 30 秒的 job 提级（饥饿保护）。AVATAR_BODY_ARB=off 整体退回 FIFO。
const ARB_ON = String(process.env.AVATAR_BODY_ARB || 'on').toLowerCase() !== 'off';
const QUEUE_LIMIT = Math.max(1, Number(process.env.AVATAR_BODY_ARB_MAX || QUEUE_MAX));
const PRIORITY = { owner: 3, window: 2, dev: 1 };
const QUOTAS = {
  owner: { say: [[3000, 1], [10000, 4], [60000, 15]], action: [[2000, 1]] },
  window: { say: [[2000, 1], [10000, 6], [60000, 20]], action: [[2000, 1]] },
  dev: { say: [[5000, 1], [60000, 6]], action: [[5000, 1]] }
};
const STARVE_MS = 30000;
const MERGE_GAP_MS = 3000;
const MERGE_MAX_CHARS = 200;
const SEAM = '　';

const queue = [];
const history = [];             // 最近 50 条动作，供 /state 看
let busy = false;
let seq = 0;
let wakeTimer = null;
let wakeAt = 0;

const roleOf = (job) => (PRIORITY[job.role] ? job.role : 'dev');
const planTimes = { say: { owner: [], window: [], dev: [] }, action: { owner: [], window: [], dev: [] } };

function historyPush(rec) {
  history.push(rec);
  while (history.length > 50) history.shift();
}

function settle(job, err, value) {
  const waiters = job.waiters;
  job.waiters = [];
  for (const w of waiters) {
    try { if (err) w.reject(err); else w.resolve(value); } catch {}
  }
}

/** 该角色这一类动作的最早可发时刻；顺手把这次占位写进计划表（避免两条同时算到同一时刻）。 */
function planSlot(role, kind, now) {
  const arr = planTimes[kind][role] ?? (planTimes[kind][role] = []);
  let at = now;
  if (ARB_ON) {
    for (const [windowMs, max] of (QUOTAS[role]?.[kind] ?? [])) {
      while (arr.length && now - arr[0] > windowMs) arr.shift();
      const idx = arr.length - max;
      if (idx >= 0) at = Math.max(at, arr[idx] + windowMs + 1);
    }
  }
  arr.push(at);
  arr.sort((a, b) => a - b);
  return at;
}

const betterKey = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]);

/** 选出下一个该跑的 job：饥饿提级 > 优先级 > 先来先跑。 */
function pickIndex(now) {
  let bestIdx = -1;
  let bestKey = null;
  for (let i = 0; i < queue.length; i += 1) {
    const j = queue[i];
    const boosted = now - j.queuedAt >= STARVE_MS;
    if (boosted && !j.boosted) {
      j.boosted = true;
      log(\`[仲裁] 饥饿保护：\${j.action}@\${roleOf(j)} 等了 \${((now - j.queuedAt) / 1000).toFixed(1)}s，提到最前\`);
    }
    const key = [j.boosted ? 1 : 0, PRIORITY[roleOf(j)] ?? 1, -j.id];
    if (!bestKey || betterKey(key, bestKey)) { bestIdx = i; bestKey = key; }
  }
  return bestIdx;
}

/** 队列满时丢一个：dev 最旧 → window 非 manual 最旧 → owner 最旧；manual 永不丢。 */
function dropOne() {
  if (queue.length < QUEUE_LIMIT) return null;
  let idx = -1;
  for (const role of ['dev', 'window', 'owner']) {
    idx = queue.findIndex((j) => roleOf(j) === role && !j.manual);
    if (idx >= 0) break;
  }
  if (idx < 0) {
    log(\`[仲裁] ⚠️ 队列 \${queue.length} 条全是 manual，临时超限（上限 \${QUEUE_LIMIT}）\`);
    return null;
  }
  const [dropped] = queue.splice(idx, 1);
  log(\`[仲裁] 队列满(\${QUEUE_LIMIT})，丢弃 \${dropped.action}@\${roleOf(dropped)}（id=\${dropped.id}，manual=\${!!dropped.manual}）\`);
  settle(dropped, Object.assign(new Error(\`身体队列已满，\${dropped.action} 被丢弃\`), { code: 'QUEUE_FULL' }));
  return dropped;
}

function queueCountByRole() {
  const out = { owner: 0, window: 0, dev: 0 };
  for (const j of queue) out[roleOf(j)] = (out[roleOf(j)] ?? 0) + 1;
  return out;
}

const queueItem = (j) => ({
  id: j.id, action: j.action, role: roleOf(j), source: j.source, priority: PRIORITY[roleOf(j)] ?? 1,
  queuedAt: j.queuedAt, fireAt: j.fireAt, waitMs: Date.now() - j.queuedAt, boosted: !!j.boosted,
  manual: !!j.manual, mergedCount: j.mergedCount, droppedChars: j.droppedChars
});

/**
 * 入队。payload 会被合并逻辑改写（say 合并时改 payload.text，adapter 执行时读的就是它）。
 * opts.manual = 窗口里人亲自说的话：不合并、不丢弃、不排队。
 */
function enqueue(action, source, role, payload, run, opts = {}) {
  const now = Date.now();
  const kind = action === 'say' ? 'say' : 'action';
  const manual = opts.manual === true;
  const jobRole = PRIORITY[role] ? role : 'dev';

  if (ARB_ON && kind === 'say' && !manual) {
    // 合并：同角色、同一波（3 秒内入队）、还没开跑的那条 say
    const target = queue.find((j) => j.action === 'say' && roleOf(j) === jobRole && !j.manual && !j.started && now - j.createdAt <= MERGE_GAP_MS);
    if (target) {
      const add = String(payload?.text ?? '').trim();
      const merged = \`\${String(target.payload.text ?? '').trim()}\${SEAM}\${add}\`.trim();
      const cut = merged.length > MERGE_MAX_CHARS ? merged.slice(0, MERGE_MAX_CHARS) : merged;
      target.droppedChars += Math.max(0, merged.length - cut.length);
      target.payload.text = cut;
      target.mergedCount += 1;
      log(\`[仲裁] 合并 say@\${jobRole} → id=\${target.id}（累计 \${target.mergedCount} 次，截断 \${target.droppedChars} 字）\`);
      return new Promise((resolve, reject) => { target.waiters.push({ resolve, reject }); });
    }
  }

  dropOne();
  return new Promise((resolve, reject) => {
    const job = {
      id: ++seq, action, source, role: jobRole, kind, payload: payload ?? {}, run,
      waiters: [{ resolve, reject }], queuedAt: now, createdAt: now, started: false,
      manual, mergedCount: 0, droppedChars: 0,
      fireAt: manual ? now : planSlot(jobRole, kind, now),
      boosted: false
    };
    queue.push(job);
    if (wakeTimer && job.fireAt < wakeAt) { clearTimeout(wakeTimer); wakeTimer = null; }
    drain();
  });
}

async function drain() {
  if (busy) return;
  const now = Date.now();
  const idx = pickIndex(now);
  if (idx < 0) return;
  const job = queue[idx];
  if (ARB_ON && job.fireAt > now) {
    // 配额还没轮到：挂个定时器等，别空转
    if (wakeTimer) return;
    wakeAt = job.fireAt;
    wakeTimer = setTimeout(() => { wakeTimer = null; drain(); }, Math.min(60000, job.fireAt - now));
    return;
  }
  queue.splice(idx, 1);
  if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
  job.started = true;
  busy = true;
  const startedAt = Date.now();
  const base = {
    id: job.id, action: job.action, role: roleOf(job), source: job.source,
    priority: PRIORITY[roleOf(job)] ?? 1, manual: !!job.manual,
    mergedCount: job.mergedCount, droppedChars: job.droppedChars,
    waitedMs: startedAt - job.queuedAt, at: new Date().toISOString()
  };
  try {
    const result = await job.run();
    const rec = { ...base, ok: result?.ok !== false, tookMs: Date.now() - startedAt };
    historyPush(rec);
    if (!rec.ok) log(\`动作失败 \${job.action}@\${rec.role}（source=\${job.source}）：\${JSON.stringify(result).slice(0, 300)}\`);
    settle(job, null, { ...result, bodyJob: rec });
  } catch (error) {
    const rec = { ...base, ok: false, tookMs: Date.now() - startedAt, error: String(error?.message ?? error) };
    historyPush(rec);
    log(\`动作异常 \${job.action}@\${rec.role}（source=\${job.source}）：\${rec.error}\`);
    settle(job, error);
  } finally {
    busy = false;
    setImmediate(drain);
  }
}`;

const patches = [
  {
    name: 'A1 队列块整体换成仲裁版',
    count: 1,
    from: QUEUE_BLOCK_FROM,
    to: QUEUE_BLOCK_TO
  },
  {
    name: 'A2 /health 队列信息（上限/角色分布/仲裁开关）',
    count: 1,
    from: `      queue: { depth: queue.length, busy, max: QUEUE_MAX },`,
    to: `      queue: { depth: queue.length, busy, max: QUEUE_LIMIT, arb: ARB_ON, byRole: queueCountByRole() },`
  },
  {
    name: 'A3 /state 队列明细',
    count: 1,
    from: `      queue: { depth: queue.length, busy },`,
    to: `      queue: { depth: queue.length, busy, arb: ARB_ON, byRole: queueCountByRole(), items: queue.map(queueItem) },`
  },
  {
    name: 'A4 say 入队带角色 + manual',
    count: 1,
    from: `        const r = await enqueue('say', source, () => adapter.say(payload));`,
    to: `        const r = await enqueue('say', source, role, payload, () => adapter.say(payload), { manual: body.manual === true });`
  },
  {
    name: 'A5 anim',
    count: 1,
    from: `        const r = await enqueue('anim', source, () => adapter.anim({ name: String(body.name).trim() }));`,
    to: `        const r = await enqueue('anim', source, role, null, () => adapter.anim({ name: String(body.name).trim() }));`
  },
  {
    name: 'A6 emotion',
    count: 1,
    from: `        const r = await enqueue('emotion', source, () => adapter.emotion({ name: String(body.name).trim() }));`,
    to: `        const r = await enqueue('emotion', source, role, null, () => adapter.emotion({ name: String(body.name).trim() }));`
  },
  {
    name: 'A7 dialogue',
    count: 1,
    from: `        const r = await enqueue('dialogue', source, () => adapter.dialogue({ text: String(body.text).trim() }));`,
    to: `        const r = await enqueue('dialogue', source, role, null, () => adapter.dialogue({ text: String(body.text).trim() }));`
  },
  {
    name: 'A8 chatpanel',
    count: 1,
    from: `        const r = await enqueue('chatpanel', source, () => adapter.chatpanel());`,
    to: `        const r = await enqueue('chatpanel', source, role, null, () => adapter.chatpanel());`
  },
  {
    name: 'A9 timer',
    count: 1,
    from: `        const r = await enqueue('timer', source, () => adapter.timer({ minutes }));`,
    to: `        const r = await enqueue('timer', source, role, null, () => adapter.timer({ minutes }));`
  },
  {
    name: 'A10 cancelalarm',
    count: 1,
    from: `        const r = await enqueue('cancelalarm', source, () => adapter.cancelalarm());`,
    to: `        const r = await enqueue('cancelalarm', source, role, null, () => adapter.cancelalarm());`
  }
];

const raw = fs.readFileSync(BODY);
const hasBom = raw.length > 2 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
let src = raw.toString('utf8');
if (hasBom) src = src.slice(1);

let ok = true;
for (const p of patches) {
  const n = src.split(p.from).length - 1;
  if (n !== p.count) { console.log(`❌ ${p.name}：期望 ${p.count} 处，实际 ${n} 处`); ok = false; continue; }
  src = src.split(p.from).join(p.to);
  console.log(`✅ ${p.name}：${n} 处`);
}
if (!ok) { console.log('\n🛑 有锚点对不上，一个字节都不写。'); process.exit(2); }
if (!WRITE) { console.log('\n✅ dry-run 通过，加 --write 才写盘。'); process.exit(0); }

fs.mkdirSync(BACKUP, { recursive: true });
const bak = path.join(BACKUP, `body-service.mjs.${new Date().toISOString().replace(/[:.]/g, '-')}.arb`);
fs.copyFileSync(BODY, bak);
fs.writeFileSync(BODY, (hasBom ? '\uFEFF' : '') + src, 'utf8');
console.log(`\n✍️  已写 ${BODY}（备份 ${bak}）`);
