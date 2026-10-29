// 第二批补丁：没绑定的会话，审批/提问不能静默丢弃
//
// 背景（2026-10-25 实测发现）：桥接重启会清掉内存里的 relayBindings（中继绑定）。
// 之后任何「启动时没绑定」的会话（例如鲟鱼工作组自己）发出的审批请求，
// 会因为 `const key = directKey ?? relayKey` 拿到 undefined 而被 `if (!key) continue;` 丢弃：
// 窗口没卡片、QQ 没消息、DSH 那边一直悬着等——比「推到 QQ」糟得多。
// 修法：拿不到绑定时回落到主人私聊键，至少让主人能看到并处理。

import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const BACKUP = 'E:/DSH_workspace/backup';
const WRITE = process.argv.includes('--write');

const patches = [
  {
    name: 'N1 无绑定的提问/审批回落到主人私聊键（两处）',
    count: 2,
    from: `            const key = directKey ?? relayKey;
            if (!key) continue;`,
    to: `            // 2026-10-25：没绑定的会话**不能静默丢弃**。桥接重启会清掉内存里的中继绑定，
            // 之后这条请求会永远悬着：窗口没卡片、QQ 没消息、DSH 那边一直等。
            // 回落到主人私聊键，至少让主人看得到、点得到。
            const ownerKey = Number(cfg.ownerQQ ?? 0) ? \`private:\${Number(cfg.ownerQQ)}\` : null;
            const key = directKey ?? relayKey ?? ownerKey;
            if (!key) continue;`
  }
];

const raw = fs.readFileSync(BRIDGE);
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
if (!ok) { console.log('🛑 锚点对不上，未写盘。'); process.exit(2); }
if (!WRITE) { console.log('✅ dry-run 通过，加 --write 才写盘。'); process.exit(0); }

fs.mkdirSync(BACKUP, { recursive: true });
const bak = path.join(BACKUP, `bridge.js.${new Date().toISOString().replace(/[:.]/g, '-')}.bak2`);
fs.copyFileSync(BRIDGE, bak);
fs.writeFileSync(BRIDGE, (hasBom ? '\uFEFF' : '') + src, 'utf8');
console.log(`✍️  已写 ${BRIDGE}（备份 ${bak}）`);
