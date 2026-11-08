#!/usr/bin/env node
// scripts/drill.mjs —— 演练口 CLI（D80）
//
// 等价于 `POST /api/relay/drill`：让指定票在**派发阶段**强制失败 N 次（不真派），
// 用来验「连败退避 / 拉黑 / 邮件通路」。只有持有台账锁的那个实例会接受，其它实例返回 409。
//
// 用法：
//   node scripts\drill.mjs --ticket D80T --fail-times 3 [--minutes 10]
//   node scripts\drill.mjs --off
//   node scripts\drill.mjs --status
//
// 退出码：0 成功 ｜ 1 被拒（非持锁实例 / 参数不对）｜ 2 连不上服务

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const base = String(opt('url', process.env.WORKDESK_URL ?? 'http://127.0.0.1:9340')).replace(/\/$/, '');

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

if (flag('status')) {
  try {
    const r = await call('GET', '/api/relay');
    const d = r.json?.drill ?? { on: false };
    if (!d.on) console.log('演练：没开');
    else console.log(`演练中：${d.ticket} 强制失败 ${d.times} 次（已用 ${d.count ?? 0}，剩 ${d.left ?? 0}，${new Date(d.until).toLocaleTimeString('zh-CN', { hour12: false })} 自动解除）｜持锁：${r.json?.lockHolder}`);
    process.exit(0);
  } catch (e) { console.error(`✗ 连不上 ${base}：${e?.message ?? e}`); process.exit(2); }
}

let body;
if (flag('off')) body = { mode: 'off', by: 'drill-cli' };
else {
  const ticket = String(opt('ticket', '')).trim();
  const times = Number(opt('fail-times', opt('times', 1)));
  if (!ticket) { console.error('用法：drill --ticket <票号> --fail-times N [--minutes 10] ｜ --off ｜ --status'); process.exit(1); }
  body = { mode: 'fail', ticket, times, minutes: Number(opt('minutes', 10)), by: 'drill-cli' };
}

try {
  const r = await call('POST', '/api/relay/drill', body);
  if (r.status === 200 && r.json?.ok) {
    console.log(body.mode === 'off' ? '✓ 演练已解除' : `✓ 演练已开：${body.ticket} 强制失败 ${body.times} 次（${body.minutes} 分钟后自动解除）`);
    process.exit(0);
  }
  console.error(`✗ 被拒（HTTP ${r.status}）：${r.json?.error ?? r.text}`);
  process.exit(1);
} catch (e) {
  console.error(`✗ 连不上 ${base}：${e?.message ?? e}`);
  process.exit(2);
}
