// 主人决定：信得过鲟鱼，把权限对它全放开。
// 做法：加一个开关 dshShout.delegateGate（默认 'off'），关掉时：
//   · 差遣投递不再按受限面拦（D2）
//   · agent 会话的审批不再被直接拒绝（D4）
//   · /api/dsh/approve 不再强制 owner 码（D5，回到「代批」原样）
// 危险条目（会搞崩机器/断网）仍然 409 —— 这是本机安全阀，跟「信不信鲟鱼」无关。
// 代码全部保留，config 里把 delegateGate 改成 "on" 就恢复全套闸门。
import fs from 'node:fs';

const B = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const C = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/config.json';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(B, 'utf8');

const patches = [
  {
    name: 'G1 加 delegateGate 开关（默认 off＝放开）',
    from: `    const delegateOwnerCode = loadDelegateOwnerCode();`,
    to: `    const delegateOwnerCode = loadDelegateOwnerCode();
    // 2026-10-25 主人决定：信得过鲟鱼 → 差遣闸门默认关闭（'on' 才启用全套）。
    // 关掉的是「按受限面拦投递 / 拒审批 / 强制 owner 码」，**危险条目的 409 不受影响**。
    const delegateGateOn = String(cfg.dshShout?.delegateGate ?? 'off').toLowerCase() === 'on';`
  },
  {
    name: 'G2 D2 投递闸门受开关控制',
    from: `          const delegateRole = delegateRoleOf(req, body);
          if (delegateRole !== 'owner') {`,
    to: `          const delegateRole = delegateRoleOf(req, body);
          if (delegateGateOn && delegateRole !== 'owner') {`
  },
  {
    name: 'G3 D4 审批拦截受开关控制',
    from: `            if (delegateRoleOfSession(frame.sessionId) !== 'owner') {`,
    to: `            if (delegateGateOn && delegateRoleOfSession(frame.sessionId) !== 'owner') {`
  },
  {
    name: 'G4 D5 approve 闸门受开关控制',
    from: `          const approveRole = body.source === 'window' ? 'owner' : delegateRoleOf(req, body);
          let approveMode = 'owner';
          if (approveRole !== 'owner') {`,
    to: `          const approveRole = body.source === 'window' ? 'owner' : delegateRoleOf(req, body);
          let approveMode = 'owner';
          if (delegateGateOn && approveRole !== 'owner') {`
  }
];

let ok = true;
for (const p of patches) {
  const n = src.split(p.from).length - 1;
  console.log(`${n === 1 ? '✅' : '❌'} ${p.name}：${n} 处`);
  if (n !== 1) { ok = false; continue; }
  src = src.split(p.from).join(p.to);
}
if (!ok) { console.log('🛑 锚点不对，未写盘'); process.exit(2); }

// config：加 delegateGate=off
let cfgText = fs.readFileSync(C, 'utf8');
const cfgHas = /"delegateGate"\s*:/.test(cfgText);
if (!cfgHas) {
  const anchor = '"defaultTarget"';
  const i = cfgText.indexOf(anchor);
  if (i < 0) { console.log('🛑 config 里找不到 dshShout.defaultTarget'); process.exit(2); }
  cfgText = cfgText.slice(0, i) + '"delegateGate": "off",\n    ' + cfgText.slice(i);
  console.log('✅ config 已插入 dshShout.delegateGate = "off"');
} else {
  console.log('ℹ️ config 里已有 delegateGate，保持原值');
}

if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(B, src, 'utf8');
fs.writeFileSync(C, cfgText, 'utf8');
console.log('✍️  已写 bridge.js + config.json');
