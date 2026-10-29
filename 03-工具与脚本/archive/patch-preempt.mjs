// 窗口挤队：窗口（origin=relay）的话不再排在 3~5 分钟的回合后面
//
// 现象：本体的一个回合里会连做 qq_dsh_wait(180s)/qq_wait_for_messages(180s)/Start-Sleep，
// 一个回合 3~5 分钟；DSH 一次只跑一个回合，所以窗口说话要排队，看起来像"不工作"。
//
// 改法：`/api/dsh/say` 里，origin=relay（窗口）且该会话**已经忙超过 6 秒**时，
// 先 stopSessionWork（清掉陈旧 inbox + cancel 当前回合），再投递 → 窗口的消息立刻开新回合。
// QQ 喊话等其它来源保持原有排队，不做打断。
// 逃生口：请求体带 preempt:false 可单次关闭。
import fs from 'node:fs';
const B = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(B, 'utf8');

const from = `            relayBindings.set(sessionId, { key: \`private:\${senderQQ}\`, title: matchedTitle, at: Date.now(), silent: body.silent === true });
            try { api.events.follow(sessionId); } catch {}
            const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: injected }] });`;

const to = `            relayBindings.set(sessionId, { key: \`private:\${senderQQ}\`, title: matchedTitle, at: Date.now(), silent: body.silent === true });
            try { api.events.follow(sessionId); } catch {}
            // ── 窗口挤队（2026-10-25）──────────────────────────────────────────
            // 人在窗口里说话，不能排在 3~5 分钟的回合后面（本体常在回合里做 180 秒的长等待）。
            // 会话忙超 6 秒 → 先 stopSessionWork（清掉陈旧 inbox + cancel 当前回合）再投递。
            // QQ 喊话等其它来源不受影响（继续排队，不打断）。
            if (body.origin === 'relay' && body.preempt !== false) {
              const turnStart = v2TurnStartAt.get(sessionId) ?? 0;
              const busyMs = turnStart ? Date.now() - turnStart : 0;
              if (busyMs > 6000) {
                try {
                  const cleared = await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork');
                  log(\`[中继] 窗口挤队：打断 \${sessionId} 进行中的回合（已忙 \${Math.round(busyMs / 1000)}s，清掉 inbox \${cleared?.removed ?? 0} 条）\`);
                } catch (error) {
                  log(\`[中继] 挤队失败，仍按队列投递（不影响这一条）：\${error?.message ?? error}\`);
                }
              }
            }
            const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: injected }] });`;

const n = src.split(from).length - 1;
console.log(`${n === 1 ? '✅' : '❌'} 窗口挤队锚点：${n} 处`);
if (n !== 1) process.exit(2);
src = src.split(from).join(to);
if (!WRITE) { console.log('✅ dry-run 通过，加 --write 写盘'); process.exit(0); }
fs.writeFileSync(B, src, 'utf8');
console.log('✍️  已写');
