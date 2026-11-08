// scripts\qq-wait-friend.mjs —— 等某个 QQ 通过好友后自动打招呼（给"朋友的鱼"用）
//
// 为什么需要：SnowLuma 网关**没有"主动加好友"的接口**（`send_friend_request` 返回 unknown action），
// 只能等对方通过；通过后我们这边才能发私聊。
//
// 用法：
//   node scripts\qq-wait-friend.mjs --qq 2694054422 [--say "鲟鱼来串门"] [--minutes 30]
//
// 行为：
//   每 20 秒查一次好友列表；一旦目标出现在好友里 →
//   ① 记一行 state\qq-friend-waits.jsonl；② 通过桥发第一条私聊；③ 退出 0。
//   超时退出 2（什么都没做）。
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = 'E:/DSH_workspace';
const BRIDGE_DIR = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const qq = Number(opt('qq', '0'));
if (!qq) { console.error('用法：--qq <号码> [--say 话] [--minutes 30]'); process.exit(2); }
const say = opt('say', '鲟鱼来串门，先打个招呼。');
const minutes = Number(opt('minutes', '30'));
const logFile = path.join(WORKSPACE, 'state', 'qq-friend-waits.jsonl');

const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
const gateway = 'http://127.0.0.1:3000';
const accessToken = cfg.snowluma?.accessToken || '';

async function friends() {
  const r = await fetch(gateway + '/get_friend_list', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken }, body: '{}',
  });
  const j = await r.json();
  return (j.data || []).map((x) => Number(x.user_id));
}
async function say2(text) {
  const token = fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'console-token'), 'utf8').trim();
  const r = await fetch('http://127.0.0.1:3100/api/send/private', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-console-token': token },
    body: JSON.stringify({ userId: qq, message: text }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

const record = (o) => fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n', 'utf8');

const deadline = Date.now() + minutes * 60000;
let seen = false;
while (Date.now() < deadline) {
  try {
    const list = await friends();
    if (list.includes(qq)) {
      console.log(`✅ ${qq} 已通过好友`);
      record({ qq, event: 'friend-accepted' });
      const r = await say2(say);
      console.log('首条私聊 →', r.status, r.body);
      record({ qq, event: 'first-message', status: r.status });
      process.exit(0);
    }
  } catch (e) {
    if (!seen) { console.log('查询好友失败：', String(e.message).slice(0, 60)); seen = true; }
  }
  await new Promise((r) => setTimeout(r, 20000));
}
console.log(`⏱ ${minutes} 分钟内 ${qq} 没有通过，先退出（白名单已加，通过后消息会自动进来）`);
record({ qq, event: 'timeout', minutes });
process.exit(2);
