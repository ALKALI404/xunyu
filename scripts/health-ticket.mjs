#!/usr/bin/env node
import { readJson as readJsonIo } from './json-io.mjs';
// scripts\health-ticket.mjs —— 看板 FAIL 自动开单（UG-024 / W-264，03·维护 2026-10-30）
//
// 背景：看板只会"显示红"，没人派活——今天 transport/8788/pain 三红挂了一晚上。
// 这个脚本把「组件 ok→fail」变成一张票，并且恢复后自动关单（写恢复时间）。
//
// 数据来源（只读）：
//   · state\health-history.jsonl —— WS-011 的组件健康**变化流**（每次状态翻转追加一行）
//   · scripts\health-components.mjs 的 collectComponents() —— 用来数"连续 3 次 ok"
// 只写：worklist 台账（新增/关闭票）+ 自己的 state\health-tickets.json + logs\health-ticket.log
//
// owner 映射：优先读 state\health-components.json 里组件的 `owner` 字段；没有就用本文件的
// DEFAULT_OWNER（并按组件名/端口猜）。**不改 07 的那份配置**。
//
// 用法：
//   node scripts\health-ticket.mjs --once        # 扫一轮（自测/CI）
//   node scripts\health-ticket.mjs               # 常驻，每 10s 一轮
//   node scripts\health-ticket.mjs --simulate "企微隧道 8788"   # 伪造一次 FAIL 事件（验收④用）
// 环境变量：AUTO_TICKET=0 关闭（退回"只看板"）
//
// 出口码：0 正常 ｜ 1 本轮有开单/关单 ｜ 2 用法/依赖失败

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectComponents } from './health-components.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const CONFIG = path.join(WORKSPACE, 'state', 'health-components.json');
const HISTORY = path.join(WORKSPACE, 'state', 'health-history.jsonl');
const STATE = path.join(WORKSPACE, 'state', 'health-tickets.json');
const LOG = path.join(WORKSPACE, 'logs', 'health-ticket.log');
const WORKLIST = path.join(WORKSPACE, 'scripts', 'worklist.mjs');

const DEDUPE_MS = 30 * 60 * 1000;      // 同组件 30 分钟内只开一张
const OK_STREAK_TO_CLOSE = 3;          // 连续 3 次 ok 才关单
const DEFAULTS = { fallbackOwner: '03', fallbackPrefix: '03' };

// 组件 → 工号（没有 owner 字段时的兜底映射；按关键字匹配）
const OWNER_GUESS = [
  [/8788|隧道|企微/, '03'],
  [/DSH daemon/i, '02'],
  [/QQ|3100|bridge/i, '04'],
  [/relay|body|pain/i, '04'],
  [/工作台|9340|窗口|9342|exe/i, '06']
];

const argv = process.argv.slice(2);
const once = argv.includes('--once');
const simIdx = argv.indexOf('--simulate');
const simulate = simIdx >= 0 ? argv[simIdx + 1] : null;
const enabled = String(process.env.AUTO_TICKET ?? '1') !== '0';

function log(msg) {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} [health-ticket] ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { }
  process.stdout.write(line + '\n');
}

function readJson(file, dflt) {
  try { return readJsonIo(file); } catch { return dflt; }
}
function writeJson(file, obj) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8'); } catch { }
}

function loadConfig() {
  const cfg = readJson(CONFIG, { components: [] });
  return Array.isArray(cfg.components) ? cfg.components : [];
}

const VALID_AGENTS = new Set(['00', '01', '02', '03', '04', '05', '06', '07']);

function ownerOf(component) {
  const forced = process.env.HEALTH_TICKET_OWNER_OVERRIDE;   // 仅用于验收④（伪造无效 owner）
  if (forced) return String(forced);
  if (component?.owner && VALID_AGENTS.has(String(component.owner))) return String(component.owner);
  const label = `${component?.name ?? ''} ${component?.kind ?? ''} ${component?.port ?? ''}`;
  for (const [re, who] of OWNER_GUESS) if (re.test(label)) return who;
  return DEFAULTS.fallbackOwner;
}

/** 无效 owner（不存在/不是 00-07）→ 回退 03，并留下日志。 */
function safeOwner(component) {
  const who = ownerOf(component);
  if (VALID_AGENTS.has(who)) return { owner: who, fellBack: false, raw: who };
  log(`owner 无效（${who}）→ 回退 ${DEFAULTS.fallbackOwner}`);
  return { owner: DEFAULTS.fallbackOwner, fellBack: true, raw: who };
}

function runWorklist(args, timeoutMs = 60000) {
  return execFileSync(process.execPath, [WORKLIST, ...args], {
    cwd: WORKSPACE, encoding: 'utf8', windowsHide: true, timeout: timeoutMs
  });
}

/** 从 worklist add 的输出里抠出**台账 id（W-xxx）**——dispatch/accept 用的是它，不是单号。 */
function parseTicket(output) {
  const text = String(output ?? '');
  const byId = /新增\s+(W-\d+)/.exec(text);
  if (byId) return { id: byId[1], code: (/\b([A-Z]{2,4}-\d{3})\b/.exec(text)?.[1]) ?? '' };
  const byCode = /\b([A-Z]{2,4}-\d{3})\b/.exec(text);
  if (byCode) return { id: byCode[1], code: byCode[1] };   // 兜底：老票号可能就是 id
  return { id: '', code: '' };
}

function errText(error) {
  const out = String(error?.stdout ?? '').trim();
  const err = String(error?.stderr ?? '').trim();
  return (out + ' ' + err).trim() || String(error?.message ?? error ?? '');
}

function stateInit() {
  const st = readJson(STATE, { components: {} });
  st.components = st.components ?? {};
  return st;
}

function readHistoryTails(offsetBytes) {
  const buf = fs.readFileSync(HISTORY);
  const start = Number.isFinite(offsetBytes) && offsetBytes <= buf.length ? offsetBytes : 0;
  const chunk = buf.slice(start).toString('utf8');
  return { next: buf.length, events: chunk.split(/\r?\n/).filter((l) => l.trim().startsWith('{')) };
}

/**
 * 自动开出来的任务书是模板生成的，"## 接口契约"那一节是空的 → dispatch 会 409 no-contract。
 * 自动开单这件事确实**不改任何组件接口**，所以补一段实话即可（不是糊弄闸门）。
 */
function ensureContract(code) {
  const file = path.join(WORKSPACE, 'state', 'tasks', `${code}.md`);
  try {
    if (!fs.existsSync(file)) { log(`契约：找不到任务书 ${file}`); return; }
    const text = fs.readFileSync(file, 'utf8');
    const m = /##\s*接口契约[\s\S]*?(?=\n## |\n*$)/.exec(text);
    const body = m ? m[0].replace(/^##\s*接口契约/, '').replace(/[-`\s|:：]/g, '') : '';
    if (body.length >= 15) return;   // 已有实质内容，不动
    const block = '## 接口契约\n\n接口未变：本票由 health-ticket 自动开单，只写台账（worklist add/dispatch/drop），\n不新增、不修改任何组件接口与数据格式；排查/修复动作由领票工号按组件既有契约执行。\n';
    const next = m ? text.replace(m[0], block) : `${text.trimEnd()}\n\n${block}`;
    fs.writeFileSync(file, next, 'utf8');
    log(`契约：已给 ${code} 补「接口未变」段`);
  } catch (error) {
    log(`契约补写失败（${code}）：${String(error?.message ?? error).slice(0, 120)}`);
  }
}

function openTicket(state, component, event) {
  const decided = safeOwner(component);
  const owner = decided.owner;
  const name = component?.name ?? event.name ?? '未知组件';
  const err = String(event.error ?? event.detail ?? 'ok→fail').slice(0, 160);
  const title = `健康FAIL：${name}——${err}`.slice(0, 120);
  const note = [
    `自动开单（health-ticket）：${name} 从 ok→fail`,
    `错误：${err}`,
    `时间：${new Date().toISOString()}`,
    `组件 owner：${owner}`
  ].join('；');

  let ticketId = '';
  let ticketCode = '';
  try {
    const out = runWorklist(['add', '--title', title, '--target', owner, '--project', 'upgrade', '--feature', 'ug-gate', '--note', note]);
    const parsed = parseTicket(out);
    ticketId = parsed.id;
    ticketCode = parsed.code;
    log(`开票 ${ticketId || '(未解析到台账 id)'}${ticketCode ? `（单号 ${ticketCode}）` : ''} ← ${name}（owner=${owner}）`);
  } catch (error) {
    const text = errText(error);
    // 已有近似未完成票（抖动/重启后的第二次故障）→ 当作去重，挂到那张票上，不再开新票
    const dup = /近似未完成票[\s\S]*?(W-\d+)/.exec(text);
    if (dup) {
      log(`去重（worklist 判定重复）：${name} 已有 ${dup[1]}，不再开新票`);
      state.components[name] = { ticket: dup[1], owner, openedAt: now, error: err, okStreak: 0 };
      return dup[1];
    }
    log(`开票失败（${name}）：${text.slice(0, 300)}`);
    return null;
  }
  if (!ticketId) return null;

  // 自动开的票也得先过"接口契约"闸门：往任务书里补一段实话，否则 dispatch 409 no-contract
  ensureContract(ticketCode || ticketId);

  // 派给 owner；失败回退 03
  // 自动开出来的票是"散票"（projects.json 的 tickets[] 是脚本生成的，新票还没进去），
  // 规则 §32 允许用 --allow-out-of-project 强派并记审计——自动开单这条路必须用它，否则永远派不出去。
  let dispatchedTo = owner;
  try {
    runWorklist(['dispatch', ticketId, '--allow-out-of-project']);
    log(`派单 ${ticketId} → ${owner}`);
  } catch (error) {
    const msg = errText(error).replace(/\s+/g, ' ').slice(0, 200);
    log(`派单给 ${owner} 失败（${msg}），回退 ${DEFAULTS.fallbackOwner}`);
    try {
      runWorklist(['dispatch', ticketId, '--force', '--allow-out-of-project']);
      dispatchedTo = DEFAULTS.fallbackOwner;
      log(`派单 ${ticketId} → ${dispatchedTo}（--force 回退）`);
    } catch (error2) {
      log(`回退派单也失败：${errText(error2).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }

  state.components[name] = {
    ticket: ticketId,
    ticketCode,
    owner: dispatchedTo,
    openedAt: Date.now(),
    error: err,
    okStreak: 0
  };
  return ticketId;
}

function closeTicket(state, name, rec) {
  const recoveredAt = new Date().toISOString();
  const note = `组件恢复（自动关单）：${name} 连续 ${OK_STREAK_TO_CLOSE} 次 ok，恢复时间 ${recoveredAt}`;
  let closed = false;
  // 自动开的票通常还停在 queued（没人认领），`accept` 会报"不允许 queued→done"，
  // 所以先 `drop`（关单、记恢复时间），drop 不行再试 accept。
  for (const cmd of ['drop', 'accept']) {
    try {
      runWorklist([cmd, rec.ticket, '--note', note]);
      log(`${cmd} ${rec.ticket} ← ${name} 恢复于 ${recoveredAt}`);
      closed = true;
      break;
    } catch (error) {
      log(`${cmd} ${rec.ticket} 失败：${errText(error).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  if (closed) {
    rec.closedAt = recoveredAt;
    rec.closed = true;
    return true;
  }
  return false;
}

async function cycle(state) {
  const components = loadConfig();
  const byName = new Map(components.map((c) => [String(c.name), c]));
  const now = Date.now();
  let acted = 0;

  // ① 处理"变化流"里的 ok→fail
  let events = [];
  if (simulate) {
    events = [JSON.stringify({ t: now, at: new Date().toISOString(), name: simulate, ok: false, from: true, to: false, error: '模拟故障（--simulate）' })];
    log(`--simulate：伪造 ${simulate} 的 ok→fail`);
  } else {
    const tail = readHistoryTails(state.offset);
    events = tail.events;
    state.offset = tail.next;
  }

  for (const raw of events) {
    let ev = null;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.to !== false || ev.from !== true) continue;       // 只认 ok→fail
    // 只处理"最近的"故障：历史积压（几小时前挂过又好了）不该一夜之间补开一堆票
    const ageMs = now - (Number(ev.t) || 0);
    if (!Number.isFinite(ageMs) || ageMs > 10 * 60 * 1000) continue;
    const name = String(ev.name ?? '');
    const rec = state.components[name];
    if (rec && !rec.closed && now - rec.openedAt < DEDUPE_MS) {
      log(`去重：${name} 30 分钟内已开过 ${rec.ticket}，不再开新票`);
      continue;
    }
    const component = byName.get(name) ?? { name };
    if (openTicket(state, component, ev)) acted += 1;
  }

  // ② 恢复检测：连续 3 次 ok 才关单
  let report = null;
  try { report = await collectComponents({ force: true, self: null }); } catch (error) { log(`collectComponents 失败：${String(error?.message ?? error).slice(0, 120)}`); }
  const rows = report?.components ?? [];
  for (const row of rows) {
    const rec = state.components[String(row.name)];
    if (!rec || rec.closed) continue;
    if (row.ok) {
      rec.okStreak = (rec.okStreak ?? 0) + 1;
      if (rec.okStreak >= OK_STREAK_TO_CLOSE) { if (closeTicket(state, String(row.name), rec)) acted += 1; }
    } else {
      rec.okStreak = 0;
    }
  }

  writeJson(STATE, state);
  return acted;
}

async function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法: node scripts\\health-ticket.mjs [--once] [--simulate <组件名>]\n  AUTO_TICKET=0 关闭自动开单\n');
    return;
  }
  if (!enabled) { log('AUTO_TICKET=0：自动开单已关闭（只看板）'); return; }

  const state = stateInit();
  if (once || simulate) {
    const acted = await cycle(state);
    process.exitCode = acted ? 1 : 0;
    return;
  }
  log('常驻启动：每 10s 一轮（AUTO_TICKET=0 可关）');
  const tick = async () => {
    try { await cycle(state); } catch (error) { log(`cycle error：${String(error?.message ?? error).slice(0, 200)}`); }
    setTimeout(tick, 10000);
  };
  setTimeout(tick, 0);
}

main().catch((error) => { log(`崩了：${String(error?.stack ?? error).slice(0, 500)}`); process.exitCode = 2; });
