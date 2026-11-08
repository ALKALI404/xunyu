#!/usr/bin/env node
// scripts/rotate-watch.mjs —— 换代触发器（BG-002）
//
// 主人原话：「程序化的会话交接，00 派任务，程序负责会话交接指派的全链路」。
// 这个脚本只干**触发那一段**：每 5 分钟扫一遍工号会话压力，到线（默认 650,000）且该工号
// 没有未结的换代票 → 自动开一张 `ROT-<工号>-<MMDD>` 并派给 00。剩下十步由 00 跑
// `rotate.mjs --worker <工号> --auto`（十步全自动、只在复述校验不过时停）。
//
// 用法：
//   node scripts\rotate-watch.mjs --once          # 扫一轮就退（配计划任务/手测）
//   node scripts\rotate-watch.mjs --watch         # 常驻，每 5 分钟一轮（自己吞异常）
//   node scripts\rotate-watch.mjs --supervise     # 守护模式：子进程挂了 5 秒拉起
//   node scripts\rotate-watch.mjs --once --dry-run
//   node scripts\rotate-watch.mjs --once --simulate-tokens 09:680000   # 演练：假装 09 到线
//
// 退出码：0 = 本轮正常（含"没票可开"）｜1 = 本轮有错（写进审计）｜2 = 用法错
//
// 开关：ROTATE_AUTO=0 关闭自动触发（任务书 §5 的回滚口），此时 --once 只打印不动手；
//       ROTATE_TRIGGER_TOKENS（默认 650000）、ROTATE_WATCH_MS（默认 5 分钟）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replay } from './worklist-core.mjs';
import { evaluateLoadGate } from './dispatch-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(HERE, '..');
const ROSTER = path.join(WS, 'state', 'roster.json');
const AUDIT = path.join(WS, 'state', 'rotate-watch.jsonl');
const WORKLIST = path.join(WS, 'scripts', 'worklist.mjs');
const NODE = process.execPath;

const TRIGGER = Number(process.env.ROTATE_TRIGGER_TOKENS ?? 650000);
const INTERVAL_MS = Number(process.env.ROTATE_WATCH_MS ?? 5 * 60 * 1000);
const OPEN_STATES = new Set(['queued', 'doing', 'submitted', 'inbox']);

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const ONCE = flag('once');
const WATCH = flag('watch');
const SUPERVISE = flag('supervise');
const DRY = flag('dry-run');
const asJson = flag('json');
const SIM = opt('simulate-tokens', null);
const ONLY = opt('only', null);   // --only 09：只扫这一个工号（演练/定向补开用）

if (!ONCE && !WATCH && !SUPERVISE) {
  process.stderr.write('用法：node scripts\\rotate-watch.mjs [--once|--watch|--supervise] [--dry-run] [--json] [--simulate-tokens 09:680000]\n');
  process.exit(2);
}

const pad2 = (n) => String(n).padStart(2, '0');
const stamp = () => new Date().toISOString();
const mmdd = (d = new Date()) => `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

function log(rec) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, `${JSON.stringify({ at: Date.now(), ...rec })}\n`, 'utf8');
  } catch { /* 审计写不了不阻塞 */ }
}

/** 工号清单：以 roster.active 为准（数组），坏文件就退化成常见的 00–07。 */
function rosterActiveIds() {
  try {
    const r = JSON.parse(fs.readFileSync(ROSTER, 'utf8').replace(/^\uFEFF/, ''));
    const ids = (Array.isArray(r.active) ? r.active : Object.values(r.active ?? {}))
      .map((x) => String(x?.id ?? '').trim()).filter(Boolean);
    return ids.length ? new Set(ids) : null;   // null = 读不到/空 → 不做名册校验，别把整条链路卡死
  } catch { return null; }
}

function workers() {
  try {
    const r = JSON.parse(fs.readFileSync(ROSTER, 'utf8').replace(/^\uFEFF/, ''));
    const ids = (Array.isArray(r.active) ? r.active : Object.values(r.active ?? {}))
      .map((x) => String(x?.id ?? '').trim()).filter(Boolean);
    if (ids.length) return [...new Set(ids)].sort();
  } catch { /* fallthrough */ }
  return ['00', '01', '02', '03', '04', '05', '06', '07'];
}

/** 这个工号名下有没有"还没结"的换代票（queued/doing/submitted）。
 *  ⚠ 台账单号规则只收 `<前缀>-<三位序号>`（ROT-09-1031 会被判"格式不合规"），
 *  所以工号/日期记在**标题与备注**里，靠标题判重；单号用自动分配的 ROT-001/002… */
function openRotationTicket(worker, tasks) {
  const want = `执行工号${worker}换代`;
  return tasks.find((t) => String(t.title ?? '').trim() === want && OPEN_STATES.has(String(t.state))) ?? null;
}

/** 已结的换代票（done/dropped）不再重复开，但允许下次到线再开新票（日期不同就会是新号）。 */
function lastRotationTicket(worker, tasks) {
  const want = `执行工号${worker}换代`;
  return tasks.filter((t) => String(t.title ?? '').trim() === want)
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0] ?? null;
}

/** 下一个合规的 ROT 单号：ROT-001、ROT-002…（<前缀>-<三位序号>）。 */
function nextRotTicket(tasks) {
  let max = 0;
  for (const t of tasks) {
    const m = /^ROT-(\d{1,3})$/i.exec(String(t.ticket ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `ROT-${String(max + 1).padStart(3, '0')}`;
}

function runWorklist(args, timeout = 60000) {
  const r = execFileSync(NODE, [WORKLIST, ...args], { cwd: WS, encoding: 'utf8', timeout });
  return String(r ?? '');
}

/** 自动开票必须连任务书一起写：dispatch 有「接口优先闸门」，
 *  没有 `## 接口契约`（且不是占位）就 409 no-contract，票根本派不出去。 */
function writeTaskBook(ticket, worker, tokens, day) {
  const file = path.join(WS, 'state', 'tasks', `${ticket}.md`);
  const body = [
    `# 工单 ${ticket} · 执行工号${worker}换代（rotate-watch 自动开票）`,
    '',
    `> 派单 ${stamp()}｜rotate-watch 自动触发：工号 ${worker} 上下文 ${tokens} ≥ ${TRIGGER}｜日期 ${day}`,
    '> 本票由程序开，不要人来判断要不要换——到线就换，跑完回写名册。',
    '',
    '## 0.5 预期结果',
    `00 执行一条命令 \`node scripts\\rotate.mjs --worker ${worker} --auto\` → 十步全绿；名册三处一致；归档集合 +1。`,
    '',
    '## 接口契约',
    '- 入口：`node scripts\\rotate.mjs --worker <工号> --auto`（新增 `--auto` 开关；`rotate.mjs` 其余参数与语义不变）',
    '- 产出：`state\\rotate-state.json`（十步状态）、`state\\rotate-audit.jsonl`（一行一步）、失败时 `state\\rotate-failed.json`',
    '- 回写：`roster.active[工号] = 新 sessionId`、`roster.reserved += 旧`、`archivedSessionIds += 旧`',
    '',
    '## 2. 做什么',
    '1. 00 跑上面那条命令（十步全自动，只在第 6 步"复述校验"不过时停）；',
    '2. 停了就按失败步号修，然后 `--resume` 续跑（已完成步不回滚）。',
    '',
    '## 3. 验收判据',
    '① 十步全绿；② `tmp\\check-roster-consistency.mjs` 输出 0 处不一致；③ `archivedSessionIds` +1；④ `state\\rotate-audit.jsonl` 十行。',
    '',
    '## 4. 边界',
    '只换代：不改 `handoff.mjs` 的契约、不改工号标题命名规则、不动别人正在跑的票。',
    '',
    '## 5. 回滚',
    '`ROTATE_AUTO=0` 关闭自动触发（退回人工）；已建的新会话可手工归档。',
    '',
    '## 6. 交付',
    `\`records\\交付\\00-<YYYYMMDD>-${ticket}.md\`（执行人 00）。`,
    ''
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
    return { ok: true, file: path.relative(WS, file) };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** 优先窗口开着时，名单外的票一律 409 out-of-priority（`--force` 也不许绕）。
 *  换代票是"必须执行"的票，所以正确做法是**把它加进名单**，而不是绕闸。 */
function addToPriority(ticket) {
  const file = path.join(WS, 'state', 'priority-list.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    j.tickets = Array.isArray(j.tickets) ? j.tickets : [];
    if (j.tickets.includes(ticket)) return { ok: true, already: true };
    j.tickets.push(ticket);
    j.autoAdded = Array.isArray(j.autoAdded) ? j.autoAdded : [];
    j.autoAdded.push({ ticket, at: stamp(), by: 'rotate-watch' });
    fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`, 'utf8');
    return { ok: true, added: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** 规则 §32：票必须能落到项目表的 feature 里，否则 dispatch 会 409 not-in-project。
 *  新开的票还没进项目表 → 跑 pr-reconcile --fix 把它放进去（只修"台账 project/feature 能对上"的那些）。 */
function placeIntoBoard(ticket) {
  try {
    const chk = execFileSync(NODE, [path.join(WS, 'scripts', 'pr-reconcile.mjs'), '--check', '--ticket', ticket, '--json'],
      { cwd: WS, encoding: 'utf8', timeout: 60000 });
    if (/"ok"\s*:\s*true/.test(chk)) return { ok: true, already: true };
  } catch { /* 不 ok 就往下修 */ }
  try {
    const out = execFileSync(NODE, [path.join(WS, 'scripts', 'pr-reconcile.mjs'), '--fix', '--json'],
      { cwd: WS, encoding: 'utf8', timeout: 120000 });
    const m = String(out).match(/"fixed"\s*:\s*(\d+)/);
    return { ok: true, fixed: m ? Number(m[1]) : null, out: String(out).replace(/\s+/g, ' ').slice(0, 160) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(-200) };
  }
}

/** 一轮：读压力 → 判触发 → 开票 → 派单。返回本轮动作列表。 */
async function tick({ now = Date.now() } = {}) {
  const actions = [];
  if (process.env.ROTATE_AUTO === '0') {
    actions.push({ act: 'skip', why: 'ROTATE_AUTO=0（回滚开关关着）' });
    log({ act: 'disabled' });
    return { at: now, actions, disabled: true };
  }
  const tasks = replay();
  const sim = SIM && SIM.includes(':') ? { worker: SIM.split(':')[0].trim(), tokens: Number(SIM.split(':')[1]) } : null;

  // 演练（--simulate-tokens）只针对被模拟的那一个工号；否则会把真到线的工号也打一遍，
  // 屏幕上就分不清"哪些是演练、哪些是真到线"（UG-070 判据① 实测踩到过）。
  const targets = sim ? [sim.worker] : (ONLY ? [String(ONLY)] : workers());
  for (const w of targets) {
    let gate = { tokens: 0, code: 'load-unknown', sessionId: null };
    if (sim && sim.worker === w) {
      gate = { tokens: sim.tokens, code: 'simulated', sessionId: null };
    } else {
      try {
        gate = await evaluateLoadGate(w, { force: false });
      } catch (e) {
        actions.push({ worker: w, act: 'skip', why: `读压力失败：${String(e?.message ?? e).slice(0, 80)}` });
        log({ act: 'gate-error', worker: w, error: String(e?.message ?? e).slice(0, 200) });
        continue;
      }
    }
    const tokens = Number(gate?.tokens ?? 0);
    if (!(tokens >= TRIGGER)) { actions.push({ worker: w, act: 'skip', tokens, why: '未到线' }); continue; }

    // 真开票前：工号必须在名册 active 里（名册外的号真到线也不开票——ROT-001 就是这么白开的）。
    // 这一条放在演练判定**之前**：演练也该如实反映"真跑会发生什么"。
    const rosterIds = rosterActiveIds();
    if (rosterIds && !rosterIds.has(String(w))) {
      actions.push({ worker: w, act: 'skip', tokens, why: '不在名册' });
      log({ act: 'skip-not-in-roster', worker: w, tokens, drill: Boolean(SIM) });
      continue;
    }

    // ── UG-070：演练（--simulate-tokens）绝不碰台账 ───────────────────────────
    // 契约：演练命中只打一行 `[演练] would-open ROT-### worker=NN tokens=<n>`，
    // 不 add、不写任务书、不进项目表、不进优先名单、不 dispatch。
    if (SIM) {
      const ticket = nextRotTicket(tasks);
      actions.push({ worker: w, act: 'would-open', ticket, tokens, drill: true });
      log({ act: 'drill-would-open', worker: w, ticket, tokens });
      tasks.push({ ticket, title: `执行工号${w}换代`, state: 'queued', updatedAt: now });
      continue;
    }

    const open = openRotationTicket(w, tasks);
    if (open && open.state !== 'queued') {
      actions.push({ worker: w, act: 'skip', tokens, why: `已有未结换代票 ${open.ticket}（${open.state}）` });
      continue;
    }
    // 已经开着但还在 queued（上一轮开票成功、派单失败/没派出去）→ 不重复开票，补派
    if (open && open.state === 'queued') {
      actions.push({ worker: w, act: 'reuse', ticket: open.ticket, id: open.id, state: open.state, tokens });
      const tb = writeTaskBook(open.ticket, w, tokens, mmdd());
      actions.push({ worker: w, act: 'taskbook', ticket: open.ticket, ...tb });
      log({ act: 'taskbook', worker: w, ticket: open.ticket, ...tb, reused: true });
      const pl = placeIntoBoard(open.ticket);
      actions.push({ worker: w, act: 'place', ticket: open.ticket, ...pl });
      log({ act: 'place', worker: w, ticket: open.ticket, ...pl, reused: true });
      const pri = addToPriority(open.ticket);
      actions.push({ worker: w, act: 'priority', ticket: open.ticket, ...pri });
      log({ act: 'priority', worker: w, ticket: open.ticket, ...pri, reused: true });
      try {
        const out = runWorklist(['dispatch', String(open.id)], 120000);
        actions.push({ worker: w, act: 'dispatch', ticket: open.ticket, ok: true, out: out.trim().slice(0, 120) });
        log({ act: 'dispatch', worker: w, ticket: open.ticket, id: open.id, ok: true, out: out.trim().slice(0, 200), reused: true });
      } catch (e) {
        actions.push({ worker: w, act: 'dispatch-failed', ticket: open.ticket, why: String(e?.message ?? e).slice(-200) });
        log({ act: 'dispatch-failed', worker: w, ticket: open.ticket, id: open.id, error: String(e?.message ?? e).slice(-300), reused: true });
      }
      continue;
    }

    const ticket = nextRotTicket(tasks);
    const title = `执行工号${w}换代`;
    const day = mmdd(new Date(now));
    const dup = tasks.find((t) => String(t.ticket ?? '').toUpperCase() === ticket.toUpperCase());
    const note = `自动触发（rotate-watch ${stamp()}）：工号 ${w} 上下文 ${tokens} ≥ ${TRIGGER}｜${day}${sim ? '｜演练模拟' : ''}。00 执行：node scripts\\rotate.mjs --worker ${w} --auto`;

    if (DRY) {
      actions.push({ worker: w, act: 'would-open', ticket, tokens, drill: false });
      log({ act: 'dry-open', worker: w, ticket, tokens });
      // dry 也要把"假设开出去的号"记进快照，否则多个工号会显示同一个 ROT 号（假报表）
      tasks.push({ ticket, title, state: 'queued', updatedAt: now });
      continue;
    }
    if (dup) {
      // 今天的票已经开过（可能已 done）→ 不重复开，直接尝试派单（幂等）
      actions.push({ worker: w, act: 'reuse', ticket, state: dup.state, tokens });
    } else {
      try {
        const out = runWorklist(['add', '--ticket', ticket, '--title', title, '--target', '00', '--project', 'auto', '--feature', 'auto-rotate', '--note', note]);
        // 台账里 dispatch/show 都认**任务 id（W-xxx）**，不认单号 → 开完票回读一次拿 id
        const id = replay().find((t) => String(t.ticket ?? '').toUpperCase() === ticket.toUpperCase())?.id ?? null;
        actions.push({ worker: w, act: 'open', ticket, id, tokens });
        log({ act: 'open', worker: w, ticket, id, tokens, trigger: TRIGGER, out: String(out).trim().slice(0, 160) });
        // 同一轮里可能有好几个工号同时到线：不把刚开的票补进本地快照，下一个工号会撞同一个 ROT 号
        tasks.push({ id, ticket, title, state: 'queued', updatedAt: now });
        const tb = writeTaskBook(ticket, w, tokens, day);
        actions.push({ worker: w, act: 'taskbook', ticket, ...tb });
        log({ act: 'taskbook', worker: w, ticket, ...tb });
        const placed = placeIntoBoard(ticket);
        actions.push({ worker: w, act: 'place', ticket, ...placed });
        log({ act: 'place', worker: w, ticket, ...placed });
        const pri = addToPriority(ticket);
        actions.push({ worker: w, act: 'priority', ticket, ...pri });
        log({ act: 'priority', worker: w, ticket, ...pri });
      } catch (e) {
        actions.push({ worker: w, act: 'open-failed', ticket, why: String(e?.message ?? e).slice(-200) });
        log({ act: 'open-failed', worker: w, ticket, error: String(e?.message ?? e).slice(-300) });
        continue;
      }
    }
    // 派给 00：这一步失败也要记（票还在 queued，下一轮会再试）
    try {
      const target = tasks.find((t) => String(t.ticket ?? '').toUpperCase() === ticket.toUpperCase())?.id
        ?? replay().find((t) => String(t.ticket ?? '').toUpperCase() === ticket.toUpperCase())?.id;
      if (!target) throw new Error(`开票后回读不到 ${ticket} 的任务 id`);
      const out = runWorklist(['dispatch', String(target)], 120000);
      actions.push({ worker: w, act: 'dispatch', ticket, ok: true, out: out.trim().slice(0, 120) });
      log({ act: 'dispatch', worker: w, ticket, id: target, ok: true, out: out.trim().slice(0, 200) });
    } catch (e) {
      actions.push({ worker: w, act: 'dispatch-failed', ticket, why: String(e?.message ?? e).slice(-200) });
      log({ act: 'dispatch-failed', worker: w, ticket, error: String(e?.message ?? e).slice(-300) });
    }
  }
  return { at: now, actions };
}

function printTick(r) {
  if (asJson) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return; }
  // 「不在名册」是契约要求必须打出来的（UG-070），不能被当成普通 skip 吞掉
  const hot = r.actions.filter((a) => a.act !== 'skip' || a.why === '不在名册');
  const skipped = r.actions.filter((a) => a.act === 'skip' && a.why !== '不在名册');
  if (r.disabled) { console.log('[rotate-watch] 关着（ROTATE_AUTO=0）'); return; }
  if (!hot.length) { console.log(`[rotate-watch] 本轮到线 0 个（扫了 ${r.actions.length} 个工号）`); }
  for (const a of hot) {
    // UG-070 契约里规定的两种行格式，一字不差
    if (a.act === 'would-open') {
      if (a.drill) console.log(`[演练] would-open ${a.ticket} worker=${a.worker} tokens=${a.tokens}`);
      else console.log(`[dry] would-open ${a.ticket} worker=${a.worker} tokens=${a.tokens}`);
    }
    else if (a.act === 'skip' && a.why === '不在名册') console.log(`[跳过] 工号 ${a.worker} 不在名册`);
    else console.log(`[rotate-watch] ${a.worker} ${a.act} ${a.ticket ?? ''}${a.ok === false ? ' ✗' : ''}${a.why ? `（${a.why}）` : ''}`);
  }
  if (skipped.length && process.env.ROTATE_WATCH_VERBOSE === '1') for (const a of skipped) console.log(`[rotate-watch] ${a.worker} skip（${a.why}${a.tokens != null ? ` ${a.tokens}` : ''}）`);
}

async function once() {
  const r = await tick();
  printTick(r);
  process.exitCode = 0;
}

async function watch() {
  console.log(`[rotate-watch] 常驻：每 ${Math.round(INTERVAL_MS / 1000)}s 一轮｜触发线 ${TRIGGER}｜ROTATE_AUTO=${process.env.ROTATE_AUTO ?? '1'}`);
  for (;;) {
    const t0 = Date.now();
    try { printTick(await tick()); }
    catch (e) { console.error(`[rotate-watch] 本轮异常：${String(e?.message ?? e).slice(0, 200)}`); log({ act: 'tick-error', error: String(e?.message ?? e).slice(0, 300) }); }
    const sleep = Math.max(1000, INTERVAL_MS - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, sleep));
  }
}

/** 守护：子进程退出就 5 秒后拉起（和 wecom-supervisor 同款套路，但不引入新依赖）。 */
function supervise() {
  const child = spawn(NODE, [fileURLToPath(import.meta.url), '--watch'], { cwd: WS, stdio: 'inherit' });
  child.on('exit', (code, sig) => {
    console.error(`[rotate-watch] 子进程退出（code=${code} sig=${sig}），5 秒后拉起`);
    log({ act: 'supervise-restart', code, sig });
    setTimeout(supervise, 5000);
  });
}

if (ONCE) await once();
else if (WATCH) await watch();
else supervise();
