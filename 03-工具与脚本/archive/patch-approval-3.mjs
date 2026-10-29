// 第三批补丁：窗口按钮 = 主人**亲自**批，不走「代批」闸门
//
// 现状（改前）：窗口的「通过」和鲟鱼的代批走同一个 /api/dsh/approve → decideDelegation：
//   没开代批窗 → 409「代批窗口未开启或已过期」
//   高危条目 → 409「必须管理员单独确认，不能代批」
// 结果：主界面那张卡片的按钮在大多数时候是废的；危险条目从窗口永远批不了。
//
// 改法：窗口来源带 source='window'，直接按主人本人的决定执行（拒绝也立刻生效）；
// 鲟鱼/其它 agent 来源保持原样（要代批窗、不许碰高危）。
//
// 遗留风险（记在 P0-4 里做真修）：source 目前是**自称**的，本机能调用 127.0.0.1:9334 的
// 进程都能这么声明；正确做法是给窗口发独立令牌（P0-4 权限矩阵）。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1';
const BRIDGE = `${ROOT}/src/bridge.js`;
const RELAY = 'E:/DeepFish/avatar/relay.mjs';
const BACKUP = 'E:/DSH_workspace/backup';
const WRITE = process.argv.includes('--write');

const bridgePatches = [
  {
    name: 'W1 窗口来源绕过代批闸门（仍记高危标记）',
    count: 1,
    from: `          const verdict = decideDelegation({
            toolName: entry.toolName,
            argsText: entry.argsText ?? '',
            decision: body.decision,
            windowUntil: delegationWindowUntil
          });`,
    to: `          // 2026-10-25：窗口按钮 = 主人**亲自**点，不是「代批」。
          // 所以窗口来源不受「代批窗是否开着」「高危不许批」这两道限制——
          // 危险条目本来就该由主人在这张卡片上点（那正是把它弹出来的目的）。
          // 鲟鱼 / 其它 agent 来源仍然走 decideDelegation，规则一点不放宽。
          const fromWindow = body.source === 'window';
          const verdict = fromWindow
            ? {
              ok: true,
              allow: body.decision !== 'deny',
              dangerous: !!dangerousReason({ toolName: entry.toolName, argsText: entry.argsText ?? '' })
            }
            : decideDelegation({
              toolName: entry.toolName,
              argsText: entry.argsText ?? '',
              decision: body.decision,
              windowUntil: delegationWindowUntil
            });`
  },
  {
    name: 'W2 审计/日志区分「主人亲自批」与「鲟鱼代批」',
    count: 1,
    from: `            appendApprovalAudit({
              ts: Date.now(), event: allow ? 'approve' : 'deny', by: 'agent(鲟鱼)',
              key: ownerKey, sessionId: entry.sessionId, tool: entry.toolName ?? '',
              reason: entry.reason ?? '', highRisk, note: String(body.note ?? '').slice(0, 300)
            });
            log(\`[代批] 鲟鱼\${allow ? '批准' : '拒绝'}了 \${entry.toolName}（\${entry.sessionId}\${highRisk ? '，高危已放行' : ''}）\`);`,
    to: `            appendApprovalAudit({
              ts: Date.now(), event: allow ? 'approve' : 'deny', by: fromWindow ? 'owner(window)' : 'agent(鲟鱼)',
              key: ownerKey, sessionId: entry.sessionId, tool: entry.toolName ?? '',
              reason: entry.reason ?? '', highRisk, note: String(body.note ?? '').slice(0, 300)
            });
            if (fromWindow) {
              log(\`[窗口] 主人在窗口里\${allow ? '通过' : '拒绝'}了 \${entry.toolName}（\${entry.sessionId}\${highRisk ? '，高危' : ''}）\`);
            } else {
              log(\`[代批] 鲟鱼\${allow ? '批准' : '拒绝'}了 \${entry.toolName}（\${entry.sessionId}\${highRisk ? '，高危已放行' : ''}）\`);
            }`
  }
];

const relayPatches = [
  {
    name: 'R1 中继声明来源是窗口（这张卡片只有窗口会点）',
    count: 1,
    from: `          const r = await bridge('/api/dsh/approve', { method: 'POST', body: { key, decision, note: body.note, approvalId: body.approvalId } });`,
    to: `          const r = await bridge('/api/dsh/approve', { method: 'POST', body: { key, decision, note: body.note, approvalId: body.approvalId, source: 'window' } });`
  }
];

function stage(file, patches) {
  const raw = fs.readFileSync(file);
  const hasBom = raw.length > 2 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let src = raw.toString('utf8');
  if (hasBom) src = src.slice(1);
  const report = [];
  for (const p of patches) {
    const n = src.split(p.from).length - 1;
    if (n !== p.count) { report.push(`  ❌ ${p.name}：期望 ${p.count} 处，实际 ${n} 处`); return { ok: false, report, file }; }
    src = src.split(p.from).join(p.to);
    report.push(`  ✅ ${p.name}：${n} 处`);
  }
  return { ok: true, report, file, src, hasBom };
}

const staged = [];
let allOk = true;
for (const [file, patches] of [[BRIDGE, bridgePatches], [RELAY, relayPatches]]) {
  const r = stage(file, patches);
  console.log(`\n=== ${path.basename(file)} ${r.ok ? '（全部命中）' : '（有对不上的锚点）'}`);
  console.log(r.report.join('\n'));
  if (!r.ok) allOk = false; else staged.push(r);
}
if (!allOk) { console.log('\n🛑 有锚点对不上，一个字节都不写。'); process.exit(2); }
if (!WRITE) { console.log('\n✅ dry-run 通过，加 --write 才写盘。'); process.exit(0); }

fs.mkdirSync(BACKUP, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const r of staged) {
  const bak = path.join(BACKUP, `${path.basename(r.file)}.${stamp}.bak3`);
  fs.copyFileSync(r.file, bak);
  fs.writeFileSync(r.file, (r.hasBom ? '\uFEFF' : '') + r.src, 'utf8');
  console.log(`✍️  已写 ${r.file}（备份 ${bak}）`);
}
console.log('\n🎉 写完了。');
