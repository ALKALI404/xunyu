// 代批改回「双凭据」：owner 授权 + 代批票据
//
// 主人（2026-10-25）：「owner 可以提供代批审批，但需要提供 owner 和代批的两份认证」
// 实现：
//   ① owner 授权 = 开窗动作本身必须 owner 认证（窗口按钮 source=window，或带正确 owner 码）
//   ② 代批票据 = 开窗时生成的 grant id，agent 批的时候必须带上；票据通过 /api/dsh/pending 暴露给鲟鱼
//   少一把 → 403「需要管理员本人」；危险条目仍然 409（既有规则不变）
import fs from 'node:fs';

const B = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const WRITE = process.argv.includes('--write');

const patches = [
  {
    name: 'G1 代批双凭据的状态与工具',
    count: 1,
    from: `        const sessionDelegateRole = new Map(); // sessionId -> { role, at }`,
    to: `        // ── 代批双凭据（2026-10-25）────────────────────────────────────────────
        // 「代批」= agent 也能批，但必须同时具备两把钥匙：
        //   ① owner 授权：开窗这个动作必须由 owner 认证（窗口 source=window 或正确 owner 码）
        //   ② 代批票据：开窗时生成的 grant id，agent 提交审批时必须带上（票据可从 /api/dsh/pending 取）
        // 少一把 → 403「需要管理员本人」。
        let delegateGrant = null; // { id, until, by }
        const newGrantId = () => crypto.randomBytes(6).toString('hex');
        const grantActive = () => !!(delegateGrant && delegateGrant.until > Date.now());
        const sessionDelegateRole = new Map(); // sessionId -> { role, at }`
  },
  {
    name: 'G2 开窗 = 第一把钥匙（必须 owner 认证）+ 生成票据',
    count: 1,
    from: `          const defaultMinutes = Math.max(1, Math.round((Number(cfg.dshShout?.delegationWindowMs) || DANGEROUS_WINDOW_MS) / 60000));
          const minutes = Math.max(1, Math.min(1440, Number(body.minutes) || defaultMinutes));
          const windowMs = minutes * 60000;
          delegationWindowUntil = Date.now() + windowMs;
          appendApprovalAudit({ ts: Date.now(), event: 'grant', key: String(body.key ?? ''), sessionId: '', tool: '', by: 'avatar-window', windowMs });
          log(\`[代批] 对话窗开启代批窗口：\${minutes} 分钟，至 \${new Date(delegationWindowUntil).toLocaleTimeString('zh-CN')}\`);
          sendJson({ ok: true, minutes, windowMs, remainingMs: delegationWindowRemaining(), until: delegationWindowUntil });`,
    to: `          // 第一把钥匙：开窗必须是 owner 认证（窗口按钮 source=window，或带正确 owner 码）。
          const grantRole = body.source === 'window' ? 'owner' : delegateRoleOf(req, body);
          if (grantRole !== 'owner') {
            log(\`[代批] 拒绝非 owner 开窗（role=\${grantRole}）\`);
            sendJson({ ok: false, role: grantRole, need: ['owner-auth'], error: '需要管理员本人：开启代批窗口必须由主人认证（窗口按钮或 owner 码）' }, 403);
            return;
          }
          const defaultMinutes = Math.max(1, Math.round((Number(cfg.dshShout?.delegationWindowMs) || DANGEROUS_WINDOW_MS) / 60000));
          const minutes = Math.max(1, Math.min(1440, Number(body.minutes) || defaultMinutes));
          const windowMs = minutes * 60000;
          delegationWindowUntil = Date.now() + windowMs;
          // 第二把钥匙：票据。agent 代批时必须带回来。
          delegateGrant = { id: newGrantId(), until: delegationWindowUntil, by: body.source === 'window' ? 'window' : 'owner-code' };
          appendApprovalAudit({ ts: Date.now(), event: 'grant', key: String(body.key ?? ''), sessionId: '', tool: '', by: \`owner(\${delegateGrant.by})\`, windowMs });
          log(\`[代批] 代批窗口已开：\${minutes} 分钟，owner 授权=\${delegateGrant.by}，票据 \${delegateGrant.id}（票据会随 /api/dsh/pending 下发给鲟鱼）\`);
          sendJson({ ok: true, minutes, windowMs, remainingMs: delegationWindowRemaining(), until: delegationWindowUntil, grant: delegateGrant.id });`
  },
  {
    name: 'G3 agent 批审批：必须 owner 授权 + 票据（双凭据）',
    count: 1,
    from: `          // ── 身份码闸门（2026-10-25）：批审批只认 owner ──
          // 窗口（本机 GUI，source=window）算 owner；其它必须带正确 owner 码。
          // 差遣指令（agent，含本体代批）一律回「需要管理员本人」。
          const approveRole = body.source === 'window' ? 'owner' : delegateRoleOf(req, body);
          if (approveRole !== 'owner') {
            log(\`[差遣] 拒绝 agent 批审批（role=\${approveRole}）\`);
            sendJson({ ok: false, role: approveRole, error: DELEGATE_DENY }, 403);
            return;
          }`,
    to: `          // ── 批审批双凭据（2026-10-25，主人要求）────────────────────────────
          // owner 亲自批：窗口（source=window）或带正确 owner 码 → 直接放行。
          // agent 代批：必须 ①代批窗口由 owner 开且仍有效 ②提交时带上票据（body.grant）。
          // 少一把 → 403「需要管理员本人」。
          const approveRole = body.source === 'window' ? 'owner' : delegateRoleOf(req, body);
          let approveMode = 'owner';
          if (approveRole !== 'owner') {
            const ticket = String(body.grant ?? body.grantId ?? '').trim();
            if (!grantActive()) {
              log('[代批] 拒绝 agent 批审批：缺第一把钥匙（owner 未开窗或已过期）');
              sendJson({ ok: false, role: 'agent', need: ['owner-grant', 'delegate-ticket'], error: '需要管理员本人：代批需要「owner 授权 + 代批票据」两份凭据，当前代批窗口未开启或已过期' }, 403);
              return;
            }
            if (!ticket || ticket !== delegateGrant.id) {
              log(\`[代批] 拒绝 agent 批审批：票据不对（\${ticket ? '有票但不对' : '没带票'}）\`);
              sendJson({
                ok: false, role: 'agent', need: ['owner-grant', 'delegate-ticket'],
                error: \`需要管理员本人：代批票据不对。票据在 GET /api/dsh/pending 的 grant.id 里（剩余 \${Math.round((delegateGrant.until - Date.now()) / 1000)} 秒）\`
              }, 403);
              return;
            }
            approveMode = 'delegate';
            log(\`[代批] agent 凭双凭据批审批（票据 \${delegateGrant.id}，owner 授权=\${delegateGrant.by}）\`);
          }`
  },
  {
    name: 'G4 /api/dsh/pending 下发代批票据',
    count: 1,
    from: `          sendJson({ ok: true, window: { active: win.active, remainingMs: win.remainingMs }, pending: list });`,
    to: `          sendJson({
            ok: true,
            window: { active: win.active, remainingMs: win.remainingMs },
            // 代批票据（第二把钥匙）：agent 要代批必须把它带回来
            grant: grantActive() ? { active: true, id: delegateGrant.id, remainingMs: delegateGrant.until - Date.now() } : { active: false, id: '' },
            pending: list
          });`
  }
];

const raw = fs.readFileSync(B);
let src = raw.toString('utf8');
const hasBom = src.charCodeAt(0) === 0xfeff;
if (hasBom) src = src.slice(1);

let ok = true;
for (const p of patches) {
  const n = src.split(p.from).length - 1;
  console.log(`${n === p.count ? '✅' : '❌'} ${p.name}：${n} 处`);
  if (n !== p.count) { ok = false; continue; }
  src = src.split(p.from).join(p.to);
}
if (!ok) { console.log('🛑 锚点对不上，未写盘'); process.exit(2); }
if (!WRITE) { console.log('✅ dry-run 通过，加 --write 写盘'); process.exit(0); }
fs.writeFileSync(B, (hasBom ? '\uFEFF' : '') + src, 'utf8');
console.log('✍️  已写 bridge.js');
