// scripts\relay04.mjs —— 只给 04 的"自动接力"（临时件，等 UG-039/UG-033 落地后废弃）
// 规则：04 空闲 + 台账里有它的 queued 票 + 优先名单内 → 投递任务书；accepted:true 才算派出去
// 用法：node scripts\relay04.mjs --once    跑一轮
//       node scripts\relay04.mjs --watch   每 60 秒一轮（后台常驻）
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:53389';
const ROOT = 'E:/DSH_workspace';
const LOG = path.join(ROOT, 'state', 'relay04.log');

// 04 的派发顺序（P0 → 之后）
// 只派"自动化项目"里的票（projects.json 的 auto 项目），别的项目一律不碰
const AUTO_PROJECT = 'auto';
const ORDER = ['UG-033', 'UG-034', 'UG-036', 'UG-026', 'UG-031', 'UG-032', 'UG-021'];

function autoTickets() {
  const p = path.join(ROOT, 'state', 'projects.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const proj = (j.projects || []).find((x) => x.id === AUTO_PROJECT);
  const set = new Set();
  for (const f of (proj && proj.features) || []) for (const t of f.tickets || []) set.add(t);
  return set;
}

function log(line) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function readTickets() {
  const p = path.join(ROOT, 'state', 'worklist.jsonl');
  const last = new Map();
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.ticket) last.set(r.ticket, r);
  }
  return last;
}

function taskBook(ticket) {
  const f = path.join(ROOT, 'state', 'tasks', `${ticket}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

const { NodeApiClient, unwrap } = await import(CLIENT);
const api = new NodeApiClient(BASE, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });

const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'roster.json'), 'utf8'));
const a04 = Object.values(roster.active || {}).find((v) => v && String(v.title || '').includes('工号04'));
if (!a04) { console.log('找不到工号04'); process.exit(1); }
const SID = a04.sessionId;

async function running() {
  const r = unwrap(await api.sessions.list({}), 'sessions');
  const it = (r.items || []).find((x) => String(x.sessionId) === SID);
  if (!it) return { found: false, running: false, tokens: 0 };
  const v = it.projections?.values || {};
  return { found: true, running: !!it.running, tokens: Number(v.pressureTokens || 0) };
}

async function tick() {
  const st = await running();
  if (!st.found) { log('04 会话不在列表里，跳过'); return; }
  if (st.running) { log(`04 在跑（${st.tokens}），等下一轮`); return; }
  if (st.tokens >= 650000) { log(`04 上下文 ${st.tokens} 已过闸，不派`); return; }

  const tickets = readTickets();
  const allowed = autoTickets();
  for (const t of ORDER) {
    if (!allowed.has(t)) { log(`${t} 不在自动化项目里，跳过`); continue; }
    const rec = tickets.get(t);
    if (!rec) continue;
    if (!['queued', 'inbox'].includes(String(rec.state))) continue;
    const book = taskBook(t);
    if (!book) { log(`${t} 有票无任务书，跳过`); continue; }

    const text = [
      `【自动接力：${t}】`,
      `你是工号 04。台账里这张票是 queued，你当前空闲，按优先顺序派给你。`,
      ``,
      `任务书：state\tasks\${t}.md（先读文件，别等我贴）`,
      goal ? `目标：${goal}` : '',
      `硬约束：①接口优先（先写契约再写模块）②只改任务书边界内文件 ③交 records\交付\04-<日期>-${t}.md`,
      ``,
      `---`,
      `开口先说一句"收到 ${t}"，做完按五段式（接口/模块/证据）交到 records\\交付\\04-<日期>-${t}.md。`,
    ].join('\n');

    try {
      const r = await api.sessions.prompt({ sessionId: SID, mode: 'queue', content: [{ type: 'text', text }] });
      const ok = r?.result?.accepted === true;
      log(`${t} 投递 ${ok ? 'accepted:true' : 'accepted:FALSE'} ${JSON.stringify(r?.result || {}).slice(0, 80)}`);
      if (ok) return;
    } catch (e) {
      log(`${t} 投递异常：${String(e.message).slice(0, 80)}`);
      return;
    }
  }
  log('04 没有可派的票');
}

const watch = process.argv.includes('--watch');
if (watch) {
  log('relay04 启动（watch 模式，60s 一轮）');
  for (;;) {
    try { await tick(); } catch (e) { log('tick 异常：' + String(e.message).slice(0, 80)); }
    await new Promise((r) => setTimeout(r, 60000));
  }
} else {
  await tick();
  console.log('跑完一轮，日志：state\\relay04.log');
}
