// 一次性补丁：代批直放（③）+ 挂起项排队共存 + approvalId 精确批 + 窗口卡片带 id
//
// 设计原则：
//   1. 每条补丁的锚点必须**精确命中期望次数**（多数是 1，两块重复代码是 2），
//      任何一条对不上 → 整体中止、一个字节都不写。
//   2. 写盘前先把原文件备份到备份目录。
//   3. 保留原文件的 BOM（chat-window.ps1 没有 BOM 会被 PowerShell 5.1 解析失败）。
//
// 用法：node patch-approval-2026-10-25.mjs            → 只校验不写盘
//       node patch-approval-2026-10-25.mjs --write    → 校验通过才写盘

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1';
const AVATAR = 'E:/DeepFish/avatar';
const BACKUP = 'E:/DSH_workspace/backup';
const WRITE = process.argv.includes('--write');

const F_BRIDGE = `${ROOT}/src/bridge.js`;
const F_RELAY = `${AVATAR}/relay.mjs`;
const F_WINDOW = `${AVATAR}/chat-window.ps1`;

// ───────────────────────── bridge.js ─────────────────────────
const bridgePatches = [
  {
    name: 'B1 pending 改成「每键多条排队」并把工具函数放好',
    count: 1,
    from: `  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }`,
    to: `  // key -> [{ kind, rpcId, sessionId, ... }]：一个会话键下**多条**挂起排队共存。
  // 2026-10-25 之前是 Map<key, entry>（只有一个位置）：新请求会把旧请求 cancel 成「拒绝」，
  // 本体自己那条 write 审批就是被我这条 edit 顶掉并判拒的（日志：新挂起请求覆盖旧请求 → 已取消挂起审批）。
  const pending = new Map();
  const PEND_MAX_PER_KEY = 8; // 单键排队上限：超出丢最老的（拒掉），避免无限堆积
  const pendList = (key) => pending.get(key) ?? [];
  const pendOldest = (key) => pendList(key)[0] ?? null;
  const pendId = (entry) => String(entry?.approvalId ?? entry?.rpcId ?? '');
  const pendAdd = (key, entry) => {
    const arr = pending.get(key) ?? [];
    arr.push(entry);
    while (arr.length > PEND_MAX_PER_KEY) {
      const dropped = arr.shift();
      clearTimeout(dropped?.timer);
      if (dropped) cancelPendingEntry(dropped).catch(() => {});
    }
    pending.set(key, arr);
    return entry;
  };
  const pendRemove = (key, entry) => {
    const arr = pending.get(key);
    if (!arr) return false;
    const i = arr.indexOf(entry);
    if (i < 0) return false;
    arr.splice(i, 1);
    if (!arr.length) pending.delete(key);
    return true;
  };
  const pendDropAll = (key) => {
    const arr = pending.get(key) ?? [];
    pending.delete(key);
    for (const e of arr) { clearTimeout(e.timer); cancelPendingEntry(e).catch(() => {}); }
    return arr.length;
  };
  const pendFind = (key, approvalId) => {
    const arr = pendList(key);
    if (approvalId == null || approvalId === '') return arr[0] ?? null;
    return arr.find((e) => String(e.approvalId ?? e.rpcId ?? '') === String(approvalId)) ?? null;
  };`
  },
  {
    name: 'B2 退役会话：清掉该键下全部挂起',
    count: 1,
    from: `    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);`,
    to: `    pendDropAll(key);`
  },
  {
    name: 'B3 /api/pending 控制台列表：展开数组',
    count: 1,
    from: `          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }`,
    to: `          for (const [key, arr] of pending.entries()) {
            for (const p of arr) list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: pendId(p) } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }`
  },
  {
    name: 'B4 /api/dsh/pending 返回全部挂起（带 approvalId）',
    count: 1,
    from: `          const ownerKey = \`private:\${Number(cfg.ownerQQ ?? 0)}\`;
          const entry = pending.get(ownerKey);
          if (!entry) {
            sendJson({ ok: true, pending: [], window: { active: delegationWindowActive(), remainingMs: delegationWindowRemaining() } });
            return;
          }
          // 2026-10-24 新规则：默认可以代批，只有「会搞崩机器/断网」的要管理员单独确认；
          // 而且代批必须在一个有效的 30 分钟窗口里（管理员回「允许代批」开启）。
          const danger = entry.kind === 'approval' ? dangerousReason({ toolName: entry.toolName, argsText: entry.argsText ?? '' }) : '';
          const win = windowState({ windowUntil: delegationWindowUntil });
          sendJson({
            ok: true,
            window: { active: win.active, remainingMs: win.remainingMs },
            pending: [{
              id: String(entry.sessionId ?? ''),
              kind: entry.kind,
              sessionId: entry.sessionId,
              tool: entry.toolName ?? '',
              reason: entry.reason ?? '',
              dangerous: !!danger,
              dangerReason: danger,
              windowActive: win.active,
              // 只有「窗口开着 且 不是危险条目」才能由鲟鱼直接批；拒绝不受限
              canDelegate: entry.kind === 'approval' ? (win.active && !danger) : true,
              ageMs: Date.now() - Number(entry.at ?? Date.now()),
              expiresInMs: Math.max(0, Number(entry.at ?? Date.now()) + Number(cfg.questionTimeoutMs ?? 300000) - Date.now())
            }]
          });
          return;`,
    to: `          const ownerKey = \`private:\${Number(cfg.ownerQQ ?? 0)}\`;
          // 2026-10-24 新规则：默认可以代批，只有「会搞崩机器/断网」的要管理员单独确认；
          // 而且代批必须在一个有效的 30 分钟窗口里（管理员回「允许代批」开启）。
          // 2026-10-25：改成**多条排队**——同一个键下可以有多个挂起，不再互相顶掉。
          const win = windowState({ windowUntil: delegationWindowUntil });
          const list = pendList(ownerKey).map((entry) => {
            const danger = entry.kind === 'approval' ? dangerousReason({ toolName: entry.toolName, argsText: entry.argsText ?? '' }) : '';
            return {
              id: String(entry.sessionId ?? ''),
              approvalId: pendId(entry),
              kind: entry.kind,
              sessionId: entry.sessionId,
              tool: entry.toolName ?? '',
              reason: entry.reason ?? '',
              dangerous: !!danger,
              dangerReason: danger,
              windowActive: win.active,
              // 只有「窗口开着 且 不是危险条目」才能由鲟鱼直接批；拒绝不受限
              canDelegate: entry.kind === 'approval' ? (win.active && !danger) : true,
              ageMs: Date.now() - Number(entry.at ?? Date.now()),
              expiresInMs: Math.max(0, Number(entry.at ?? Date.now()) + Number(cfg.questionTimeoutMs ?? 300000) - Date.now())
            };
          });
          sendJson({ ok: true, window: { active: win.active, remainingMs: win.remainingMs }, pending: list });
          return;`
  },
  {
    name: 'B5 /api/dsh/approve 支持按 approvalId 精确批',
    count: 1,
    from: `          const ownerKey = \`private:\${Number(cfg.ownerQQ ?? 0)}\`;
          const entry = pending.get(ownerKey);
          if (!entry || entry.kind !== 'approval') {
            sendJson({ ok: false, error: '当前没有挂起的审批请求' }, 404);
            return;
          }`,
    to: `          const ownerKey = \`private:\${Number(cfg.ownerQQ ?? 0)}\`;
          // 多条排队后必须指定批哪一条：body.approvalId（窗口和鲟鱼都会带）；
          // 不传则取最老的一条（兼容旧调用）。
          const wantedId = body.approvalId ?? body.id ?? '';
          let entry = null;
          if (wantedId) {
            entry = pendFind(ownerKey, wantedId);
            if (!entry) {
              sendJson({ ok: false, error: \`找不到这条挂起请求（approvalId=\${wantedId}），它可能已被处理或超时\` }, 404);
              return;
            }
            if (entry.kind !== 'approval') { sendJson({ ok: false, error: '这条不是审批请求' }, 400); return; }
          } else {
            entry = pendList(ownerKey).find((e) => e.kind === 'approval') ?? null;
          }
          if (!entry) {
            sendJson({ ok: false, error: '当前没有挂起的审批请求' }, 404);
            return;
          }`
  },
  {
    name: 'B6 /reset 清挂起（两处重复代码）',
    count: 2,
    from: `          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);`,
    to: `          pendDropAll(key);`
  },
  {
    name: 'B7 清空工作区：遍历所有数组',
    count: 1,
    from: `          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();`,
    to: `          for (const arr of pending.values()) {
            for (const entry of arr) {
              clearTimeout(entry.timer);
              cancelPendingEntry(entry).catch(() => {});
            }
          }
          pending.clear();`
  },
  {
    name: 'B8 QQ 文字回复作用于最老那条',
    count: 1,
    from: `    const p = pending.get(key);`,
    to: `    // 多条排队时，QQ 里的文字回复默认作用于**最老**的那条（FIFO）；回执日志里会写明是哪条。
    const p = pendOldest(key);`
  },
  {
    name: 'B9 /交接 闸门看最老那条',
    count: 1,
    from: `        const pend = pending.get(key);`,
    to: `        const pend = pendOldest(key);`
  },
  {
    name: 'B10 答完之后精确移除这一条（两处）',
    count: 2,
    from: `        if (pending.get(key) === p) pending.delete(key);`,
    to: `        pendRemove(key, p);`
  },
  {
    name: 'B11a 强信号兜底：按 rpcId 找自己那条（10 空格）',
    count: 1,
    from: `          const still = pending.get(key);`,
    to: `          const pendArr = pendList(key);
          const still = rpcId != null ? pendArr.find((e) => String(e.rpcId ?? '') === String(rpcId)) : (pendArr[pendArr.length - 1] ?? null);`
  },
  {
    name: 'B11b 弱信号兜底：按 rpcId 找自己那条（8 空格）',
    count: 1,
    from: `        const still = pending.get(key);`,
    to: `        const pendArr = pendList(key);
        const still = rpcId != null ? pendArr.find((e) => String(e.rpcId ?? '') === String(rpcId)) : (pendArr[pendArr.length - 1] ?? null);`
  },
  {
    name: 'B12 registerPending：追加排队，不再覆盖',
    count: 1,
    from: `  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(\`新挂起请求覆盖旧请求 (\${key})\`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(\`挂起请求超时 (\${key})\`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }`,
    to: `  async function registerPending(key, entry) {
    // 2026-10-25：不再「新请求覆盖旧请求」——那会把旧请求 cancel 成**拒绝**回执。
    // 改成同键排队共存；每条各自计时、各自超时。
    if (entry.approvalId == null) entry.approvalId = String(entry.rpcId ?? '');
    const timer = setTimeout(() => {
      if (!pendList(key).includes(entry)) return; // 已被回答/已被顶上/已超时
      pendRemove(key, entry);
      log(\`挂起请求超时 (\${key})：\${entry.toolName ?? entry.kind}\`);
      cancelPendingEntry(entry).catch(() => {});
      sendToQQ(key, \`⏰ 等待回答超时，已取消该请求（\${entry.toolName ?? entry.kind}）\`);
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pendAdd(key, entry);
    const depth = pendList(key).length;
    if (depth > 1) log(\`挂起请求排队 (\${key})：当前 \${depth} 条\`);
  }`
  },
  {
    name: 'B13 clearOwnerPending：按条件清掉匹配的多条',
    count: 1,
    from: `  function clearOwnerPending(reason, { sessionId = '', toolName = '' } = {}) {
    const ownerKey = \`private:\${Number(cfg.ownerQQ ?? 0)}\`;
    const entry = pending.get(ownerKey);
    if (!entry) return false;
    if (sessionId && entry.sessionId !== sessionId) return false;
    if (toolName && String(entry.toolName ?? '') !== toolName) return false;
    clearTimeout(entry.timer);
    pending.delete(ownerKey);
    log(\`挂起审批已作废（\${reason}）：\${entry.toolName ?? '?'} @ \${entry.sessionId ?? '?'}\`);
    return true;
  }`,
    to: `  function clearOwnerPending(reason, { sessionId = '', toolName = '' } = {}) {
    const ownerKey = \`private:\${Number(cfg.ownerQQ ?? 0)}\`;
    let cleared = 0;
    for (const entry of [...pendList(ownerKey)]) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      if (toolName && String(entry.toolName ?? '') !== toolName) continue;
      clearTimeout(entry.timer);
      pendRemove(ownerKey, entry);
      cleared += 1;
      log(\`挂起审批已作废（\${reason}）：\${entry.toolName ?? '?'} @ \${entry.sessionId ?? '?'}\`);
    }
    return cleared > 0;
  }`
  },
  {
    name: 'B14 ③ 代批直放：非本体会话 + 不危险 + 窗开着 → 直接 allowed-once',
    count: 1,
    from: `            if (directKey && !isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }`,
    to: `            if (directKey && !isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            // ③ 代批直放（2026-10-25）：**非本体会话**（走 relay 绑定的，例如鲟鱼工作组/子实体）
            // + 不危险 + 代批窗开着 → 桥接直接放行。不注册挂起、不占主人的槽位、不推 QQ。
            // 本体会话（directKey === private:<ownerQQ>）永远走 ①：只落窗口/QQ，绝不给自己放权。
            if (!directKey && relayKey) {
              const autoArgsText = approvalArgsText(frame);
              const autoDanger = dangerousReason({ toolName: frame.toolName, argsText: autoArgsText });
              const autoWin = windowState({ windowUntil: delegationWindowUntil });
              if (!autoDanger && autoWin.active) {
                try {
                  await withTimeout(api.respond({
                    clientId: frame.clientId,
                    eventId: frame.eventId,
                    outcome: { kind: 'result', value: 'allowed-once' }
                  }), 5000, '代批直放回执');
                  appendApprovalAudit({
                    ts: Date.now(), event: 'approve', by: 'bridge(代批直放)', key,
                    sessionId: frame.sessionId, tool: frame.toolName ?? '', reason: frame.reason ?? '',
                    highRisk: false, note: 'window-open auto-allow'
                  });
                  log(\`[代批] 窗开着且不危险，直接放行 \${frame.toolName}（\${frame.sessionId}）；不占主人挂起位\`);
                  continue;
                } catch (error) {
                  // 不静默：直放失败就回落成正常挂起流程，请求不会因为直放出错而卡死。
                  log(\`[代批] 直放回执失败，回落到挂起流程：\${error?.message ?? error}\`);
                }
              }
            }`
  },
  {
    name: 'B15 回执日志带上工具名（便于追踪批的是哪条）',
    count: 1,
    from: `        log(\`已处理审批 (\${key}): \${outcome}\`, receipt);`,
    to: `        log(\`已处理审批 (\${key}): \${outcome}（\${p.toolName ?? p.kind}）\`, receipt);`
  }
];

// ───────────────────────── relay.mjs ─────────────────────────
const relayPatches = [
  {
    name: 'R1 /approve 透传 approvalId',
    count: 1,
    from: `          const r = await bridge('/api/dsh/approve', { method: 'POST', body: { key, decision, note: body.note } });`,
    to: `          const r = await bridge('/api/dsh/approve', { method: 'POST', body: { key, decision, note: body.note, approvalId: body.approvalId } });`
  }
];

// ───────────────────────── chat-window.ps1 ─────────────────────────
const windowPatches = [
  {
    name: 'W1 卡片显示最老那条 + 排队条数，并记住 approvalId',
    count: 1,
    from: `            if ($pd.ok -and $pd.pending -and $pd.pending.Count -gt 0) {
                $it = $pd.pending[0]
                $kind = if ($it.kind -eq "question") { "提问" } else { "审批" }
                $danger = if ($it.dangerous) { " ⚠高危" } else { "" }
                $apTitle.Text = "$kind：$($it.tool)$danger"
                $apDetail.Text = ("" + $it.reason + "  （剩 " + [Math]::Round($it.expiresInMs / 1000) + " 秒）")
                $approval.Visible = $true
            } else {
                $approval.Visible = $false
            }`,
    to: `            if ($pd.ok -and $pd.pending -and $pd.pending.Count -gt 0) {
                # 多条排队：卡片永远显示**最老**那条，按钮按它的 approvalId 精确批，避免批错对象。
                $it = $pd.pending[0]
                $script:pendId = [string]$it.approvalId
                $kind = if ($it.kind -eq "question") { "提问" } else { "审批" }
                $danger = if ($it.dangerous) { " ⚠高危" } else { "" }
                $more = if ($pd.pending.Count -gt 1) { "（另有 " + ($pd.pending.Count - 1) + " 条排队）" } else { "" }
                $apTitle.Text = "$kind：$($it.tool)$danger$more"
                $apDetail.Text = ("" + $it.reason + "  （剩 " + [Math]::Round($it.expiresInMs / 1000) + " 秒）")
                $approval.Visible = $true
            } else {
                $script:pendId = ""
                $approval.Visible = $false
            }`
  },
  {
    name: 'W2 点按钮时带上这一条的 approvalId',
    count: 1,
    from: `        $body = @{ decision = $decision } | ConvertTo-Json -Compress`,
    to: `        $body = @{ decision = $decision; approvalId = [string]$script:pendId } | ConvertTo-Json -Compress`
  }
];

function run(file, patches) {
  const raw = fs.readFileSync(file);
  const hasBom = raw.length > 2 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let src = raw.toString('utf8');
  if (hasBom) src = src.slice(1);
  const report = [];
  for (const p of patches) {
    const n = src.split(p.from).length - 1;
    if (n !== p.count) {
      report.push(`  ❌ ${p.name}：期望 ${p.count} 处，实际 ${n} 处`);
      return { ok: false, report, src: null, hasBom, file };
    }
    src = src.split(p.from).join(p.to);
    report.push(`  ✅ ${p.name}：${n} 处`);
  }
  return { ok: true, report, src, hasBom, file };
}

const files = [
  [F_BRIDGE, bridgePatches],
  [F_RELAY, relayPatches],
  [F_WINDOW, windowPatches]
];

let allOk = true;
const staged = [];
for (const [file, patches] of files) {
  if (!fs.existsSync(file)) { console.log(`❌ 找不到文件：${file}`); allOk = false; continue; }
  const r = run(file, patches);
  console.log(`\n=== ${path.basename(file)} ${r.ok ? '（全部命中）' : '（有对不上的锚点）'}`);
  console.log(r.report.join('\n'));
  if (!r.ok) allOk = false; else staged.push(r);
}

if (!allOk) {
  console.log('\n🛑 有锚点对不上 → 一个字节都不写。请先核对上面失败的条目。');
  process.exit(2);
}
if (!WRITE) {
  console.log('\n✅ 全部锚点命中（dry-run）。加 --write 才会真正写盘。');
  process.exit(0);
}

fs.mkdirSync(BACKUP, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const r of staged) {
  const bak = path.join(BACKUP, `${path.basename(r.file)}.${stamp}.bak`);
  fs.copyFileSync(r.file, bak);
  fs.writeFileSync(r.file, (r.hasBom ? '\uFEFF' : '') + r.src, 'utf8');
  const after = fs.readFileSync(r.file);
  const bomAfter = after.length > 2 && after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf;
  console.log(`✍️  已写 ${r.file}（BOM: 原=${r.hasBom} 新=${bomAfter}，备份 ${bak}）`);
}
console.log('\n🎉 三个文件都改完了。');
