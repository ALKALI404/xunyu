// 差遣身份码（owner/agent）——强制点全部在桥接
//
// 依据：工作日志 20:55 方案。要点：
//  · owner 码只存 state/delegate-owner.code，本体拿不到；QQ 通道一律 agent
//  · agent 命中受限面（配置/插件/人格记忆/HANDOFF/审批）→ 投递前 403「需要管理员本人」
//  · agent 会话的受限审批 → 直接拒绝回执
//  · /api/dsh/approve 只认 owner（窗口 source=window 或带 owner 码）
//  · 定位：挡 QQ/远端提权，不挡坐在机器前的人
import fs from 'node:fs';
import path from 'node:path';

const B = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const WRITE = process.argv.includes('--write');

const HELPER_ANCHOR = `        const dshShoutDenied = (key, agentToken) => {
          const allow = dshShoutAllowList();
          if (!allow.length) return '喊话白名单为空（dshShout.allow 与 ownerQQ 都没配置）：入口已关闭';
          const match = /^private:(\\d+)$/.exec(String(key ?? ''));
          if (!match) return \`喊话仅限私聊，群聊一律拒绝（当前 key：\${String(key ?? '未指定')}）\`;
          const qq = Number(match[1]);
          if (!allow.includes(qq)) return \`QQ \${qq} 不在喊话白名单内（允许：\${allow.join(', ')}）\`;
          if (!dshReady) return 'DSH 当前不可用，请稍后再试';
          if (!agentTokenOk(\`private:\${qq}\`, String(agentToken ?? ''))) return '会话令牌不匹配，拒绝喊话';
          return '';
        };`;

const HELPERS = `${HELPER_ANCHOR}

        // ── 差遣身份码（2026-10-25）────────────────────────────────────────────
        // owner 码只存在桥接里（state/delegate-owner.code），本体拿不到；QQ 通道一律 agent。
        // 定位：挡的是「QQ/远端提权」，不是坐在机器前的人——窗口/控制台也是本机进程。
        const DELEGATE_CODE_FILE = path.join(STATE_DIR, 'delegate-owner.code');
        const DELEGATE_DENY = '需要管理员本人：这条属于受限操作（配置 / 插件 / 人格记忆 / HANDOFF / 审批），差遣指令（agent）不能动';
        const DELEGATE_PROTECTED = [
          /config\\.json/i, /plugins[\\\\/]/i, /roles[\\\\/]/i, /memory[\\\\/]/i, /notes[\\\\/]/i,
          /HANDOFF\\.md/i, /工作日志\\.md/i, /delegate-owner\\.code/i,
          /default-target/i, /\\/api\\/dsh\\/approve/i
        ];
        const DELEGATE_PROTECTED_WORDS = [
          '改配置', '配置改', '装插件', '安装插件', '卸载插件', '改人格', '改记忆', '写记忆', '人格文档',
          '批审批', '批准审批', '通过审批', '代批'
        ];
        function loadDelegateOwnerCode() {
          try {
            const v = String(fs.readFileSync(DELEGATE_CODE_FILE, 'utf8') || '').replace(/^\\uFEFF/, '').trim();
            if (/^[0-9a-f]{32,64}$/i.test(v)) return v;
            log('⚠️ owner 码文件格式不对，重新生成（旧码立即失效）');
          } catch {}
          const code = crypto.randomBytes(24).toString('hex');
          try {
            fs.mkdirSync(path.dirname(DELEGATE_CODE_FILE), { recursive: true });
            fs.writeFileSync(DELEGATE_CODE_FILE, code, { encoding: 'utf8', mode: 0o600 });
            log('owner 码已生成（state/delegate-owner.code；不外显、不进日志）');
          } catch (error) {
            log(\`⚠️ owner 码写入失败：\${error?.message ?? error}（本次进程内仍可用）\`);
          }
          return code;
        }
        const delegateOwnerCode = loadDelegateOwnerCode();
        // 角色只认通道 + 码，不认自称：QQ/agent 通道永远 agent。
        const delegateRoleOf = (req, body) => {
          const code = String(req.headers['x-delegate-code'] ?? body?.code ?? '').trim();
          const wantsOwner = body?.origin === 'relay' || String(body?.role ?? '').toLowerCase() === 'owner';
          if (!wantsOwner) return 'agent';
          return code && code === delegateOwnerCode ? 'owner' : 'agent';
        };
        // 命中受限面 → 返回命中的片段（空串＝没命中）。启发式：挡明显越界，不是形式化证明。
        const delegateTap = (text) => {
          const s = String(text ?? '');
          for (const re of DELEGATE_PROTECTED) { const m = re.exec(s); if (m) return m[0]; }
          for (const w of DELEGATE_PROTECTED_WORDS) { if (s.includes(w)) return w; }
          return '';
        };
        const sessionDelegateRole = new Map(); // sessionId -> { role, at }
        const DELEGATE_ROLE_TTL_MS = 30 * 60 * 1000;
        const delegateRoleOfSession = (sessionId) => {
          const k = String(sessionId ?? '');
          const hit = sessionDelegateRole.get(k);
          if (!hit) return 'agent';
          if (Date.now() - hit.at > DELEGATE_ROLE_TTL_MS) { sessionDelegateRole.delete(k); return 'agent'; }
          return hit.role;
        };`;

const patches = [
  {
    name: 'D1 身份码工具（owner 码文件 / 角色判定 / 受限面匹配）',
    count: 1,
    from: HELPER_ANCHOR,
    to: HELPERS
  },
  {
    name: 'D2 /api/dsh/say：agent 命中受限面，投递前就拒',
    count: 1,
    from: `          if (!target) { sendJson({ ok: false, error: 'target 不能为空：请传 sessionId 或会话标题的精确值（或配置 dshShout.defaultTarget）' }, 400); return; }`,
    to: `          if (!target) { sendJson({ ok: false, error: 'target 不能为空：请传 sessionId 或会话标题的精确值（或配置 dshShout.defaultTarget）' }, 400); return; }
          // ── 身份码闸门（2026-10-25）：agent 不得触碰受限面，**投递前**就拒 ──
          const delegateRole = delegateRoleOf(req, body);
          if (delegateRole !== 'owner') {
            const hit = delegateTap(\`\${message}\\n\${target}\`);
            if (hit) {
              log(\`[差遣] 拒绝 agent 受限指令（命中「\${hit}」）→ 需要管理员本人\`);
              sendJson({ ok: false, role: 'agent', hit, error: DELEGATE_DENY }, 403);
              return;
            }
          }`
  },
  {
    name: 'D3 记录会话的差遣角色（供审批层判断）',
    count: 1,
    from: `            relayBindings.set(sessionId, { key: \`private:\${senderQQ}\`, title: matchedTitle, at: Date.now(), silent: body.silent === true });`,
    to: `            sessionDelegateRole.set(sessionId, { role: delegateRole, at: Date.now() });
            relayBindings.set(sessionId, { key: \`private:\${senderQQ}\`, title: matchedTitle, at: Date.now(), silent: body.silent === true });`
  },
  {
    name: 'D4 审批层：agent 会话的受限审批直接拒绝并回执',
    count: 1,
    from: `            // ③ 代批直放（2026-10-25）：**非本体会话**（走 relay 绑定的，例如鲟鱼工作组/子实体）`,
    to: `            // ── 差遣闸门（2026-10-25）：agent 会话的受限审批，直接拒绝并回执 ──
            if (delegateRoleOfSession(frame.sessionId) !== 'owner') {
              const gateArgs = approvalArgsText(frame);
              const gateHit = delegateTap(\`\${frame.toolName ?? ''} \${gateArgs}\`);
              if (gateHit) {
                log(\`[差遣] agent 会话申请受限审批（\${frame.toolName} 命中「\${gateHit}」）→ 拒绝并回执\`);
                try {
                  await withTimeout(api.respond({ clientId: frame.clientId, eventId: frame.eventId, outcome: { kind: 'result', value: 'rejected' } }), 5000, '差遣拒绝回执');
                } catch (error) {
                  log(\`[差遣] 拒绝回执失败：\${error?.message ?? error}\`);
                }
                appendApprovalAudit({
                  ts: Date.now(), event: 'deny', by: 'bridge(差遣拦截)', key: key ?? '',
                  sessionId: frame.sessionId, tool: frame.toolName ?? '', reason: DELEGATE_DENY,
                  highRisk: true, note: \`hit=\${gateHit}\`
                });
                continue;
              }
            }
            // ③ 代批直放（2026-10-25）：**非本体会话**（走 relay 绑定的，例如鲟鱼工作组/子实体）`
  },
  {
    name: 'D5 /api/dsh/approve：只认 owner（窗口 source=window 或带 owner 码）',
    count: 1,
    from: `          const ownerKey = \`private:\${Number(cfg.ownerQQ ?? 0)}\`;
          // 多条排队后必须指定批哪一条：body.approvalId（窗口和鲟鱼都会带）；`,
    to: `          // ── 身份码闸门（2026-10-25）：批审批只认 owner ──
          // 窗口（本机 GUI，source=window）算 owner；其它必须带正确 owner 码。
          // 差遣指令（agent，含本体代批）一律回「需要管理员本人」。
          const approveRole = body.source === 'window' ? 'owner' : delegateRoleOf(req, body);
          if (approveRole !== 'owner') {
            log(\`[差遣] 拒绝 agent 批审批（role=\${approveRole}）\`);
            sendJson({ ok: false, role: approveRole, error: DELEGATE_DENY }, 403);
            return;
          }
          const ownerKey = \`private:\${Number(cfg.ownerQQ ?? 0)}\`;
          // 多条排队后必须指定批哪一条：body.approvalId（窗口和鲟鱼都会带）；`
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
