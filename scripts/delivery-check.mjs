#!/usr/bin/env node
import { readJson as readJsonIo } from './json-io.mjs';
// scripts/delivery-check.mjs —— 投递确认（D92 · B2）
// ⚠ 别混：delivery-check = 送达确认（消息有没有到）；check-delivery = 交付预检（文件合不合规）。命名是历史遗留。
//
// 干什么：
//   1. `addPending(entry)` 给 dispatch / mail post 用：投出去之后立刻记下"对方当时的读水位"；
//   2. `--once` / `--watch` 跑检查：超过 retryMs（默认 10 分钟）水位没动 ⇒ 自动重投一次；
//      超过 reportMs（默认 20 分钟）还是没动 ⇒ 给本体（00）报一封，一封就够、不刷屏；
//   3. 每条回执都能拿到"对方侧证据"：水位值 / 重投次数 / 是否已上报。
//
// 状态：state\delivery-pending.json（数组，最多保留 200 条）
// 测试加速：环境变量 XUNYU_DELIVERY_RETRY_MS / XUNYU_DELIVERY_REPORT_MS 可调小。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const PENDING = path.join(WORKSPACE, 'state', 'delivery-pending.json');
const MAIL_BOX = 'E:/DeepFish/Xunyu/memory/mail';
const MAIL_FILE = path.join(MAIL_BOX, 'mailbox.jsonl');

const RETRY_MS = Number(process.env.XUNYU_DELIVERY_RETRY_MS ?? 10 * 60 * 1000);
const REPORT_MS = Number(process.env.XUNYU_DELIVERY_REPORT_MS ?? 20 * 60 * 1000);

function readJson(p, fallback) {
  try { return readJsonIo(p); } catch { return fallback; }
}
function writePending(list) {
  try {
    fs.mkdirSync(path.dirname(PENDING), { recursive: true });
    fs.writeFileSync(PENDING, `${JSON.stringify(list.slice(-200), null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
}
export function readPending() { return readJson(PENDING, []); }

/** 对方的读水位：邮件用 <agent>.read；dispatch 用会话的 lastPromptAt（没有就 null）。 */

/**
 * 引擎侧的"对方有动作"信号（参考 docs 会话绑定三字段 §6：判断到位只能看画面/结果，不能只看自己写的值）。
 * 这里用 sessions.list 投影里的 lastPromptAt / running —— 是引擎给的，不是我们写的。
 * 取不到就返回 {acted:false, reason:'no-engine'}，调用方仍可用水位判。
 */
let __sessionsCache = { at: 0, items: null };
async function engineActivity(agent, seq) {
  try {
    const [{ NodeApiClient, unwrap }, { resolveDshBase }] = await Promise.all([
      import('file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js'),
      import('file:///E:/DSH_workspace/scripts/dsh-base.mjs')
    ]);
    const { url } = resolveDshBase();
    const api = new NodeApiClient(url, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });
    const res = await Promise.race([api.sessions.list({}), new Promise((_, rej) => setTimeout(() => rej(new Error('list 超时')), 3000))]);
    const items = unwrap(res, 'session.list').items ?? [];
    const key = String(agent);
    const hit = items.find((s) => String(s.projections?.values?.title ?? '').includes(`工号${key.padStart(2, '0')}`) || String(s.projections?.values?.title ?? '').includes(`工号 ${key}`));
    if (!hit) return { acted: false, reason: 'no-session' };
    const lastPromptAt = Number(hit.projections?.values?.lastPromptAt ?? 0) || Number(hit.updatedAt ?? 0) || 0;
    return { acted: Boolean(hit.running), lastPromptAt, reason: 'engine' };
  } catch (e) {
    return { acted: false, error: String(e?.message ?? e).slice(0, 80) };
  }
}

export function mailWatermark(agent) {
  try { return Number(fs.readFileSync(path.join(MAIL_BOX, `${agent}.read`), 'utf8').trim()) || 0; } catch { return 0; }
}
function lastMailSeq() {
  try {
    const lines = fs.readFileSync(MAIL_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.length ? Number(JSON.parse(lines[lines.length - 1]).seq) || 0 : 0;
  } catch { return 0; }
}
function postMail(to, body) {
  try {
    execFileSync(process.execPath, [path.join(WORKSPACE, 'scripts', 'mail.mjs'), 'post', '--to', to, '--from', 'delivery-check', '--body', body], { stdio: 'ignore' });
    return lastMailSeq();
  } catch { return null; }
}

/** 记一条待确认的投递。kind: 'mail' | 'dispatch' */
export function addPending(entry) {
  const list = readPending();
  const rec = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: entry.kind,
    to: entry.to ?? null,
    seq: entry.seq ?? null,
    taskId: entry.taskId ?? null,
    ticket: entry.ticket ?? null,
    body: entry.body ?? null,
    note: entry.note ?? null,
    watermarkAtSend: entry.kind === 'mail' ? mailWatermark(entry.to) : (entry.watermarkAtSend ?? null),
    at: Date.now(),
    retried: 0,
    reported: false,
    evidence: null
  };
  list.push(rec);
  writePending(list);
  return rec;
}

/** 跑一轮检查。返回本次做了什么的摘要（给日志/回执用）。 */
export function checkOnce({ now = Date.now(), dry = false } = {}) {
  const list = readPending();
  const actions = [];
  for (const rec of list) {
    const age = now - Number(rec.at ?? 0);
    if (rec.kind === 'mail') {
      const wm = mailWatermark(rec.to);
      // 参考 docs（会话绑定三字段 §6）：不能只拿"自己写的存储值"当到位证据。
      // 所以这里两个信号都看：① 对方读水位（我们自己写的，弱证据）② 对方会话在投递后有真实动作（引擎投影，强证据）。
      const engine = engineActivity(rec.to, rec.seq);
      const moved = (wm >= Number(rec.seq ?? 0)) || engine.acted;
      rec.evidence = { watermark: wm, seq: rec.seq, moved, engine };
      if (moved) { rec.confirmed = true; continue; }
      if (age >= REPORT_MS && !rec.reported) {
        if (!dry) {
          const seq = postMail('00', `【投递未确认】给 ${rec.to} 的邮件 #${rec.seq} 过了 ${Math.round(age / 60000)} 分钟仍未读（水位 ${wm}）。已重投 ${rec.retried} 次。`);
          rec.reported = true;
          rec.reportSeq = seq;
        }
        actions.push({ type: 'report', to: rec.to, seq: rec.seq, reportSeq: rec.reportSeq ?? null });
      } else if (age >= RETRY_MS && rec.retried < 1) {
        if (!dry) {
          const seq = postMail(rec.to, `【重投】${String(rec.body ?? '').slice(0, 400) || '（原投递未读，重投一次）'}`);
          rec.retried = Number(rec.retried ?? 0) + 1;
          rec.retrySeq = seq;
        } else {
          rec.retried = 1;
        }
        actions.push({ type: 'retry', to: rec.to, seq: rec.seq, retrySeq: rec.retrySeq ?? null });
      }
    } else if (rec.kind === 'dispatch') {
      // 派发确认：对方会话的 lastPromptAt 是否在派发后前进（由调用方在检查时填 evidence）
      if (!rec.confirmed && age >= REPORT_MS && !rec.reported) {
        if (!dry) {
          const seq = postMail('00', `【投递未确认】派给 ${rec.to} 的 ${rec.ticket ?? rec.taskId} 过了 ${Math.round(age / 60000)} 分钟，没看到对方侧动作（${rec.note ?? ''}）。`);
          rec.reported = true;
          rec.reportSeq = seq;
        }
        actions.push({ type: 'report', to: rec.to, taskId: rec.taskId, reportSeq: rec.reportSeq ?? null });
      }
    }
  }
  if (!dry) writePending(list);
  return { at: now, actions, pending: list.length, retryMs: RETRY_MS, reportMs: REPORT_MS };
}

function main() {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once') || !argv.includes('--watch');
  const json = argv.includes('--json');
  const run = () => {
    const r = checkOnce({ dry: argv.includes('--dry') });
    if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
    if (!r.actions.length) console.log(`投递确认：${r.pending} 条待确认，本轮无动作（重投阈值 ${r.retryMs / 60000} 分 / 上报阈值 ${r.reportMs / 60000} 分）`);
    for (const a of r.actions) {
      if (a.type === 'retry') console.log(`↻ 重投：${a.to}（原 #${a.seq} → 新 #${a.retrySeq}）`);
      if (a.type === 'report') console.log(`⚠ 上报本体：${a.to} ${a.seq ? `#${a.seq}` : (a.taskId ?? '')}（上报邮件 #${a.reportSeq}）`);
    }
    return r;
  };
  if (once) { run(); process.exitCode = 0; return; }
  console.log(`投递确认在跑：每 60 秒查一次（重投 ${RETRY_MS / 60000} 分 / 上报 ${REPORT_MS / 60000} 分）`);
  setInterval(run, 60000);
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
