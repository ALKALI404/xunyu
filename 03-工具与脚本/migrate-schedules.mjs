#!/usr/bin/env node
/**
 * 日课（schedule）迁移工具 —— 2026-10-27 立
 *
 * 为什么要它：换代归档时，旧会话的 daily 日课还挂在它身上，扫描器会报活绑定、归档被拦；
 * 而唯一能「建」的接口是工具面 schedule_create（`schedule/create` RPC 不存在，HTTP 404），
 * 能删的 `schedule/delete` 却可以删**任何**会话的记录（它只认入参里的 sessionId，不带调用者身份）。
 * 一头建不了、一头随便删 —— 所以把流程钉成两步，删之前必须先证明新会话里已经有了同一条。
 *
 * 用法：
 *   plan   <旧会话id> [--new <新会话id>]
 *       → 列出旧会话日课 + 存快照 + 打印待办（工具面 schedule_create 的参数）
 *   finish <旧会话id> [--new <新会话id>] [--dry-run] --yes
 *       → 逐条核对新会话有同 title+prompt，缺一条就整体拒绝；全有才删旧的，删完复验
 *
 * 退出码：0 完成 / 1 拒绝或出错 / 2 用法错误
 *
 * ⚠️ 2026-10-27 的血债：本脚本第一版把 `process.exit(n)` 换成「定退出码 + 定时真退」，
 * 结果那个函数**设完定时器就返回**，脚本没停、一路落进删除分支，把本体自己的两条日课删了。
 * 现在 `finish()` 一律抛 Stop 真停——**任何「先收尾再继续跑」的写法都是坑**。
 */
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
const WORKSPACE = '<工作区>';
const STATE = path.join(WORKSPACE, 'state');
const SNAPDIR = path.join(STATE, 'schedule-migrations');
const LOG = path.join(STATE, 'schedule-migrations.log');

const short = (id) => String(id ?? '').replace(/^session-/, '').slice(0, 8);
const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv.slice(1).filter((a) => !a.startsWith('--'));
const has = (f) => argv.includes(f);
const flagValue = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

class Stop extends Error { constructor(code) { super(`stop:${code}`); this.stopCode = code; } }
/** 真停：抛出去，谁也别想接着跑 */
const finish = (code) => { throw new Stop(code); };

if (!['plan', 'finish'].includes(cmd) || !pos[0]) {
  console.log('用法：\n  node scripts\\migrate-schedules.mjs plan   <旧会话id> [--new <新会话id>]\n  node scripts\\migrate-schedules.mjs finish <旧会话id> [--new <新会话id>] [--dry-run] --yes');
  process.exit(2);
}

const OLD = pos[0].startsWith('session-') ? pos[0] : `session-${pos[0]}`;
const DRY = has('--dry-run');

function newSessionId() {
  const explicit = flagValue('--new');
  if (explicit) return explicit.startsWith('session-') ? explicit : `session-${explicit}`;
  try {
    const h = JSON.parse(fs.readFileSync(path.join(STATE, 'handoff.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (h.newSessionId && h.newSessionId !== OLD) return h.newSessionId;
  } catch { /* 交给调用方显式给 */ }
  return null;
}

async function main() {
  const mod = await import(CLIENT);
  const { NodeApiClient, unwrap } = mod;
  const { resolveDshBase } = await import('file:///E:/DSH_workspace/scripts/dsh-base.mjs');
  const { url, source } = resolveDshBase();
  const api = new NodeApiClient(url, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });

  const listSched = async (sid) => unwrap(await api.callUnary('schedule/list', { request: { sessionId: sid } }), 'schedule.list') ?? [];
  const sameTask = (a, b) => a.title === b.title && a.prompt === b.prompt;

  const NEW = newSessionId();
  console.log(`DSH = ${url}（${source}）\n旧会话 = ${short(OLD)}　新会话 = ${NEW ? short(NEW) : '（未给）'}${DRY ? '　[dry-run]' : ''}`);

  const oldOnes = await listSched(OLD);
  if (!oldOnes.length) { console.log('\n旧会话没有日课，不需要迁移。'); return 0; }

  const mine = NEW ? await listSched(NEW) : [];
  const pending = oldOnes.filter((s) => !mine.some((m) => sameTask(m, s)));

  if (cmd === 'plan') {
    fs.mkdirSync(SNAPDIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snap = path.join(SNAPDIR, `old-${short(OLD)}-${stamp}.json`);
    fs.writeFileSync(snap, JSON.stringify(oldOnes, null, 2), 'utf8');
    console.log(`\n旧会话 ${oldOnes.length} 条日课，快照已存：${snap}`);
    if (!pending.length) { console.log('\n新会话已全部有同一条，直接跑 finish。'); return 0; }
    console.log(`\n待建 ${pending.length} 条 —— 在**工具面**逐条执行 schedule_create（RPC 没有 create）：`);
    for (const s of pending) {
      console.log(`\n  { "title": ${JSON.stringify(s.title)}, "daily": { "time": ${JSON.stringify(String(s.time ?? '').replace(/\.\d+Z?$/, ''))}, "time_zone": ${JSON.stringify(s.timeZone)} },`);
      console.log(`    "prompt": ${JSON.stringify(s.prompt)} }`);
    }
    console.log(`\n建完再跑：node scripts\\migrate-schedules.mjs finish ${OLD}${NEW ? ` --new ${NEW}` : ''} --yes`);
    return 0;
  }

  // ── finish ──
  if (!has('--yes')) { console.log('\nfinish 会删旧会话的记录，要显式 --yes（建议先加 --dry-run 看一眼）。'); return 2; }
  if (!NEW) { console.log('\n没有新会话 id（--new 或 state\\handoff.json），拒绝删除。'); return 1; }

  if (pending.length) {
    console.log(`\n✗ 新会话缺 ${pending.length} 条，整体拒绝删除（先按 plan 的输出建好）：`);
    for (const s of pending) console.log(`   · ${s.title}`);
    return 1;
  }

  if (DRY) {
    console.log(`\n[dry-run] 新会话已齐 ${oldOnes.length} 条，本该删掉旧会话这些：`);
    for (const s of oldOnes) console.log(`   · ${s.title}（${s.id}）`);
    return 0;
  }

  let deleted = 0;
  for (const s of oldOnes) {
    const r = unwrap(await api.callUnary('schedule/delete', { request: { sessionId: OLD, id: s.id } }), 'schedule.delete');
    const okDel = r?.deleted === true;
    console.log(`${okDel ? '✅' : '✗'} 删旧「${s.title}」${okDel ? '' : JSON.stringify(r)}`);
    if (okDel) deleted++;
  }

  const left = await listSched(OLD);
  const verify = await listSched(NEW);
  fs.mkdirSync(STATE, { recursive: true });
  fs.appendFileSync(LOG, `${new Date().toISOString()} OLD=${OLD} NEW=${NEW} 迁移=${oldOnes.length} 删除=${deleted} 旧剩=${left.length} 新有=${verify.length}\n`, 'utf8');
  console.log(`\n旧会话剩 ${left.length} 条；新会话有 ${verify.length} 条\n审计已记账：${LOG}`);
  return deleted === oldOnes.length && left.length === 0 ? 0 : 1;
}

const _exit = process.exit.bind(process);
main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((e) => {
    if (e instanceof Stop) { process.exitCode = e.stopCode; }
    else { console.error('✗', e?.stack ?? String(e)); process.exitCode = 1; }
  })
  .finally(() => { setTimeout(() => _exit(process.exitCode ?? 0), 1200); });
