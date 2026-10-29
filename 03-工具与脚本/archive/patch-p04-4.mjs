// 修两处：
//  1) 取队只挑「已经到点」的 job（队首没到点不该让身体空转，否则一个被配额压到 60s 后的 say
//     会把已经到点的闹钟/动作一起堵住）；没到点时算出最早的 fireAt 挂定时器。
//  2) 顺手把 pickIndex 改名 pickNext（返回 {idx, minFire}）。
import fs from 'node:fs';
const BODY = 'E:/DeepFish/avatar/body-service.mjs';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(BODY, 'utf8');

const patches = [
  {
    name: 'N1 pickIndex → pickNext（只挑到点的，回报最早时刻）',
    count: 1,
    from: `/** 选出下一个该跑的 job：饥饿提级 > 优先级 > 先来先跑。 */
function pickIndex(now) {
  let bestIdx = -1;
  let bestKey = null;
  for (let i = 0; i < queue.length; i += 1) {
    const j = queue[i];
    const boosted = now - j.queuedAt >= STARVE_MS;
    if (boosted && !j.boosted) {
      j.boosted = true;
      log(\`[仲裁] 饥饿保护：\${j.action}@\${jobRoleOf(j)} 等了 \${((now - j.queuedAt) / 1000).toFixed(1)}s，提到最前\`);
    }
    const key = [j.boosted ? 1 : 0, PRIORITY[jobRoleOf(j)] ?? 1, -j.id];
    if (!bestKey || betterKey(key, bestKey)) { bestIdx = i; bestKey = key; }
  }
  return bestIdx;
}`,
    to: `/**
 * 选出下一个该跑的 job：只挑**已经到点**的（饥饿提级 > 优先级 > 先来先跑）。
 * 没到点的只回报最早 fireAt —— 让 drain 挂定时器等，而不是让身体空转；
 * 否则一条被配额压到 60 秒后的 say 会把已经到点的闹钟/动作一起堵住。
 */
function pickNext(now) {
  let bestIdx = -1;
  let bestKey = null;
  let minFire = Infinity;
  for (let i = 0; i < queue.length; i += 1) {
    const j = queue[i];
    const boosted = now - j.queuedAt >= STARVE_MS;
    if (boosted && !j.boosted) {
      j.boosted = true;
      log(\`[仲裁] 饥饿保护：\${j.action}@\${jobRoleOf(j)} 等了 \${((now - j.queuedAt) / 1000).toFixed(1)}s，提到最前\`);
    }
    if (j.fireAt > now) {
      if (j.fireAt < minFire) minFire = j.fireAt;
      continue;
    }
    const key = [j.boosted ? 1 : 0, PRIORITY[jobRoleOf(j)] ?? 1, -j.id];
    if (!bestKey || betterKey(key, bestKey)) { bestIdx = i; bestKey = key; }
  }
  return { idx: bestIdx, minFire };
}`
  },
  {
    name: 'N2 drain 改用 pickNext',
    count: 1,
    from: `  const now = Date.now();
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
  queue.splice(idx, 1);`,
    to: `  const now = Date.now();
  const pick = pickNext(now);
  if (pick.idx < 0) {
    // 一条到点的都没有：按最早 fireAt 挂定时器（别空转）
    if (pick.minFire !== Infinity && !wakeTimer) {
      wakeAt = pick.minFire;
      wakeTimer = setTimeout(() => { wakeTimer = null; drain(); }, Math.min(60000, Math.max(50, pick.minFire - Date.now())));
    }
    return;
  }
  const job = queue[pick.idx];
  queue.splice(pick.idx, 1);`
  }
];

let ok = true;
for (const p of patches) {
  const n = src.split(p.from).length - 1;
  console.log(`${n === p.count ? '✅' : '❌'} ${p.name}：${n} 处`);
  if (n !== p.count) { ok = false; continue; }
  src = src.split(p.from).join(p.to);
}
if (!ok) { console.log('🛑 锚点不对，未写盘'); process.exit(2); }
if (!WRITE) { console.log('✅ dry-run 通过，加 --write 写盘'); process.exit(0); }
fs.writeFileSync(BODY, src, 'utf8');
console.log('✍️  已写');
