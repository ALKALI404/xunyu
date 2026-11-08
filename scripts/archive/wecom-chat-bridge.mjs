// scripts\wecom-chat-bridge.mjs —— 企微聊天桥（最小版，给"鲟鱼企微"会话用）
//
// 干两件事：
//   ① 盯 state\wecom-chats.jsonl 的新增「in」行 → 作为用户消息投给企微聊天会话；
//   ② 告诉那个会话：要回话就跑 `node scripts\vm-sender.mjs --conv "<会话名>" --text "<内容>"`。
//
// 用法：
//   node scripts\wecom-chat-bridge.mjs --watch       常驻
//   node scripts\wecom-chat-bridge.mjs --once        只跑一轮（自测）
//
// 退出码：0 正常 / 1 有错
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:53389';
const ROOT = 'E:/DSH_workspace';
const CHATS = path.join(ROOT, 'state', 'wecom-chats.jsonl');
const OFFSET = path.join(ROOT, 'state', 'wecom-chat-bridge.offset');
const LOG = path.join(ROOT, 'logs', 'wecom-chat-bridge.log');
const CHATCFG = path.join(ROOT, 'state', 'wecom-chat.json');

const { NodeApiClient, unwrap } = await import(CLIENT);
const api = new NodeApiClient(BASE, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });

function log(line) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG, `${ts} ${line}\n`, 'utf8'); } catch { }
  console.log(`${ts} ${line}`);
}

function chatSession() {
  const j = JSON.parse(fs.readFileSync(CHATCFG, 'utf8'));
  return { sessionId: j.sessionId, title: j.title };
}

async function running(sessionId) {
  const r = unwrap(await api.sessions.list({}), 'sessions');
  const it = (r.items || []).find((x) => String(x.sessionId) === sessionId);
  return !!it?.running;
}

function readOffset() {
  try { return Number(fs.readFileSync(OFFSET, 'utf8').trim()) || 0; } catch { return 0; }
}
function writeOffset(n) { try { fs.writeFileSync(OFFSET, String(n), 'utf8'); } catch { } }

async function tick() {
  const { sessionId, title } = chatSession();
  if (!fs.existsSync(CHATS)) { log('没有 wecom-chats.jsonl（采集还没跑）'); return; }
  // 2026-10-30 修：之前用 split 的 length（含末尾空行）当 offset，
  // 会导致 offset 永远比实际行数大 1，新行永远读不到（22:38 那条就是这么丢的）。
  const rows = fs.readFileSync(CHATS, 'utf8').split(/\r?\n/).filter(Boolean);
  const prev = readOffset();
  const start = Math.max(0, Math.min(prev, rows.length));
  const fresh = rows.slice(start);
  writeOffset(rows.length);
  if (!fresh.length) { log('无新行'); return; }

  const inbound = [];
  for (const l of fresh) {
    try {
      const o = JSON.parse(l);
      if (o.side === 'in' && o.text) inbound.push(o);
    } catch { }
  }
  if (!inbound.length) { log(`新行 ${fresh.length} 条，其中 in 0 条`); return; }

  const body = inbound.map((o) => `[${o.session ?? '?'}] 对方：${String(o.text).replace(/\s+/g, ' ')}`).join('\n');
  const prompt = [
    '【企微·新消息（来自 OCR 采集，可能有 1-2 字误差）】',
    body,
    '',
    '要回话就这样发（单行命令，把内容换成你的）：',
    `node scripts\\vm-sender.mjs --conv "${inbound[inbound.length - 1].session ?? '许驰(service)'}" --text "你的回复"`,
    '发完不用汇报，除非发送失败。',
  ].join('\n');

  try {
    const r = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
    const ok = (r?.value?.accepted ?? r?.result?.accepted) === true;
    log(`${title} 投递 ${ok ? 'accepted:true' : 'accepted:FALSE'}｜in ${inbound.length} 条`);
  } catch (e) {
    log('投递异常：' + String(e.message).slice(0, 100));
  }
}

if (process.argv.includes('--watch')) {
  log('企微聊天桥启动（5s 一轮）');
  for (;;) {
    try { await tick(); } catch (e) { log('tick 异常：' + String(e.message).slice(0, 90)); }
    await new Promise((r) => setTimeout(r, 5000));
  }
} else {
  await tick();
  console.log('跑完一轮，日志：logs\\wecom-chat-bridge.log');
}
