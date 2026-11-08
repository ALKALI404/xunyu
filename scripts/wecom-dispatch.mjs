// scripts\wecom-dispatch.mjs —— 企微「每个会话一条本地线」：自动存档 + 按会话路由到窗口
//
// 干三件事（全部写死在代码里）：
//   1) 存档：把 state\wecom-chats.jsonl 的新行，按会话分文件追加到 state\wecom\archive\<会话>.jsonl，
//      并维护 state\wecom\index.json（会话 → 最后一条、未读数、总条数）
//   2) 路由：每个企微会话首次出现时，自动建一个 DSH 会话，标题「企微·<会话名>」，cwd 落在鲟鱼窝
//      （映射写 state\wecom\sessions.json）
//   3) 投递：新「对方说的」行 → 投给该会话对应的 DSH 会话；DSH 会话要回话就调 vm-sender，
//      提示词里直接给好命令（--conv "<会话名>"）
//
// 用法：
//   node scripts\wecom-dispatch.mjs --watch     常驻（4s 一轮）
//   node scripts\wecom-dispatch.mjs --once      只跑一轮
//
// 开关（state\wecom\config.json）：
//   { "enabled": true, "autoReply": true, "workspaceCwd": "E:/DeepFish/Xunyu" }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = 'E:/DSH_workspace';
const STATE = path.join(ROOT, 'state');
const CHATS = path.join(STATE, 'wecom-chats.jsonl');
const WD = path.join(STATE, 'wecom');
const ARCH = path.join(WD, 'archive');
const IDX = path.join(WD, 'index.json');
const MAP = path.join(WD, 'sessions.json');
const CFG = path.join(WD, 'config.json');
const OFFSET = path.join(WD, 'offset.json');
const LOG = path.join(ROOT, 'logs', 'wecom-dispatch.log');

const CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';

fs.mkdirSync(ARCH, { recursive: true });

function log(s) {
  const line = `${new Date().toISOString()} ${s}`;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { }
  console.log(line);
}
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); }

const cfg = readJson(CFG, { enabled: true, autoReply: true, workspaceCwd: 'E:/DeepFish/Xunyu' });
if (!fs.existsSync(CFG)) writeJson(CFG, cfg);

const safeName = (s) => String(s ?? 'unknown').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'unknown';

const { NodeApiClient, unwrap } = await import(CLIENT);
const api = new NodeApiClient(process.env.DSH_WEB_URL || 'http://127.0.0.1:53389', undefined,
  { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });

function rows() {
  try { return fs.readFileSync(CHATS, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; }
}

async function ensureSession(conv, map) {
  const key = conv;
  if (map.sessions[key]?.sessionId) return map.sessions[key].sessionId;
  const created = unwrap(await api.sessions.create({ cwd: cfg.workspaceCwd }), 'create');
  const sessionId = created.sessionId;
  const title = `企微·${conv}`;
  try { await api.sessions.rename({ sessionId, title }); } catch { }
  map.sessions[key] = { sessionId, title, createdAt: new Date().toISOString() };
  writeJson(MAP, map);
  log(`新建本地会话 ${title} -> ${sessionId.slice(8, 16)}`);
  return sessionId;
}

async function tick() {
  if (!cfg.enabled) { log('已停用（config.enabled=false）'); return; }
  const all = rows();
  const off = readJson(OFFSET, { n: 0 }).n || 0;
  const start = Math.max(0, Math.min(off, all.length));
  const fresh = all.slice(start);
  if (!fresh.length) return;

  const map = readJson(MAP, { sessions: {} });
  const idx = readJson(IDX, { conversations: {} });
  const firstSeen = {};
  for (const conv of Object.values(map.sessions)) firstSeen[conv.sessionId] = true;

  const byConv = new Map();
  for (const line of fresh) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const conv = String(o.session ?? '').trim();
    if (!conv) continue;
    // 1) 存档
    const f = path.join(ARCH, safeName(conv) + '.jsonl');
    fs.appendFileSync(f, JSON.stringify({ at: o.at, frameAt: o.frameAt, side: o.side, text: o.text, src: o.src ?? null }) + '\n', 'utf8');
    // 2) 索引
    const cur = idx.conversations[conv] ?? { count: 0, unread: 0 };
    cur.count += 1;
    cur.lastText = o.text;
    cur.lastAt = o.at;
    cur.lastSide = o.side;
    if (o.side === 'in') cur.unread += 1;
    idx.conversations[conv] = cur;
    if (o.side === 'in') {
      if (!byConv.has(conv)) byConv.set(conv, []);
      byConv.get(conv).push(o);
    }
  }
  writeJson(IDX, idx);
  writeJson(OFFSET, { n: all.length });

  if (!byConv.size) { log(`新增 ${fresh.length} 行，无"对方说的"`); return; }
  if (!cfg.autoReply) { log(`新增 ${byConv.size} 个会话有来消息（autoReply=false，只存档）`); return; }

  // 3) 路由：每个会话投给自己的本地会话
  for (const [conv, msgs] of byConv) {
    let sessionId;
    try { sessionId = await ensureSession(conv, map); } catch (e) { log(`建会话失败 ${conv}: ${String(e.message).slice(0, 60)}`); continue; }
    const body = msgs.map((m) => m.text).join('\n');
    const prompt = [
      `【企微·${conv}】对方刚说（OCR，可能有 1 字误差）：`,
      body,
      '',
      '要回话就跑这一条（内容自己换）：',
      `node scripts\\vm-sender.mjs --conv "${conv}" --text "你的回复"`,
      '发出去会返回 {"code":"sent"}；失败就把 code 说出来，别假装发了。',
    ].join('\n');
    try {
      const r = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
      const ok = (r?.value?.accepted ?? r?.result?.value?.accepted) === true;
      log(`投递 ${conv} -> ${sessionId.slice(8, 16)} ${ok ? 'accepted:true' : 'accepted:FALSE'}｜${msgs.length} 条`);
      idx.conversations[conv].unread = 0;
    } catch (e) {
      log(`投递失败 ${conv}: ${String(e.message).slice(0, 80)}`);
    }
  }
  writeJson(IDX, idx);
}

if (process.argv.includes('--watch')) {
  log(`企微分会话分发启动（enabled=${cfg.enabled} autoReply=${cfg.autoReply}）`);
  for (;;) {
    try { await tick(); } catch (e) { log('tick 异常：' + String(e.message).slice(0, 100)); }
    await new Promise((r) => setTimeout(r, 4000));
  }
} else {
  await tick();
  console.log('跑完一轮');
}
