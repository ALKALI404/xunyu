#!/usr/bin/env node
// scripts\pr-reconcile.mjs —— 台账 ↔ 项目栏对账（UG-068，2026-10-31）
//
// 为什么有它：今晚派单被拦 9 次，6 次是"两边贴对不上"——
//   feature-mismatch（台账 upgrade/ug-gate ↔ 项目栏 auto/auto-ops）
//   not-in-project（散票）  no-contract（项目栏契约空）
// 口径（规则 §32）：**项目栏是唯一派单源**，所以对不上时以项目栏为准回写台账。
//
// 用法：
//   node scripts\pr-reconcile.mjs --check           # 只报（exit 1 = 有不一致）
//   node scripts\pr-reconcile.mjs --check --json    # 机读
//   node scripts\pr-reconcile.mjs --fix             # 修能确定的，其余进 remaining
//   node scripts\pr-reconcile.mjs --ticket UG-041   # 只看一张票（dispatch 前置用）
//
// fix 规则：
//   · 项目栏有这张票、台账没归属或归属不同 → 把项目栏的 project/feature **回写台账**（追加 reconcile 事件）
//   · 项目栏没有、但台账归属指向一个存在的 feature → 把票**补进那个 feature 的 tickets[]**
//   · 项目栏没有、台账也没归属  → remaining（no-attribution），不臆造
//   · feature 的 contract 为空   → remaining（empty-contract），不臆造
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, appendEvent, readEvents, WORKLIST_FILE } from './worklist-core.mjs';
import { readJson, writeJson } from './json-io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..');
export const PROJECTS_FILE = process.env.PR_PROJECTS_FILE ? path.resolve(process.env.PR_PROJECTS_FILE) : path.join(WORKSPACE, 'state', 'projects.json');
export const AUDIT_FILE = process.env.PR_AUDIT_FILE ? path.resolve(process.env.PR_AUDIT_FILE) : path.join(WORKSPACE, 'state', 'pr-reconcile.jsonl');
/** 台账文件（单测可用 PR_WORKLIST_FILE 指到夹具，不动生产台账）。 */
export const LEDGER_FILE = process.env.PR_WORKLIST_FILE ? path.resolve(process.env.PR_WORKLIST_FILE) : WORKLIST_FILE;

/** 单号前缀 → 项目（契约给定；项目栏里同一前缀有多个项目时以这里为准）。 */
export const PREFIX_PROJECT = { UG: 'upgrade', WS: 'workdesk', AV: 'avatar', WC: 'wecom', WCS: 'wecom-cs', BG: 'bridge', MEM: 'memory', WG: 'workgroup', PN: 'pain-heal' };

/** 「本域不适用接口契约」的标记：contract 写成 n/a、na、不适用…都算已声明，不算空契约。 */
export const NOT_APPLICABLE_RE = /^(n\/?a|not[- _]?applicable|本域不适用|不适用)/i;
export function isContractSatisfied(contract) {
  const s = String(contract ?? '').trim();
  if (!s) return false;
  return NOT_APPLICABLE_RE.test(s) || s.length > 0;   // 有值且不是空的就算写了
}
/**
 * 历史测试票豁免（01 2026-10-31 判的 (a) 路径）：
 * 这些票**不在项目栏、台账也没有归属**，它们是测试夹具不是项目票，纳入对账只会永远是脏数据。
 * 只豁免"两边都没有"的票——真的在项目栏里的票不受影响（照样对账）。
 */
export const EXEMPT_TICKET_RE = /^(TEST\d*|FX|DT70-[\d-]+|D\d+[A-Z]?\d*)$/i;
/** 这张票算不算"历史测试票/夹具"（只用于**两边都没有**的票，项目栏里有的票永远照常对账）。 */
export function isExemptTicket(task, ticket) {
  const tk = String(ticket ?? '');
  if (EXEMPT_TICKET_RE.test(tk)) return 'pattern';
  if (String(task?.src ?? '') === 'fixture') return 'src=fixture';
  if (String(task?.target ?? '') === 'test') return 'target=test';
  if (loadExemptFile().has(tk)) return 'pr-exempt.json';
  return null;
}
export function loadExemptFile() {
  try {
    const j = readJson(path.join(WORKSPACE, 'state', 'pr-exempt.json'));
    return new Set((j?.tickets ?? []).map(String));
  } catch { return new Set(); }
}
export function projectOfTicket(ticket) {
  const prefix = String(ticket ?? '').split('-')[0].toUpperCase();
  return PREFIX_PROJECT[prefix] ?? null;
}

function loadBoard() {
  const doc = readJson(PROJECTS_FILE);
  const index = new Map();     // ticket -> {project, feature, contract}
  const features = new Map();  // 'project/feature' -> feature object
  for (const p of doc.projects ?? []) {
    for (const f of p.features ?? []) {
      features.set(`${p.id}/${f.id}`, { ...f, projectId: p.id, project: p });
      for (const t of f.tickets ?? []) index.set(String(t), { project: p.id, feature: f.id, contract: String(f.contract ?? '').trim() });
    }
  }
  return { doc, index, features };
}

function ledgerTasks({ includeDropped = false } = {}) {
  return replay(readEvents(LEDGER_FILE)).filter((t) => String(t.ticket ?? '').trim() && (includeDropped || t.state !== 'dropped'));
}

/**
 * 全量对账（只读）。
 * @returns {{ok:boolean, count:number, mismatches:Array, remaining:Array, stats:object}}
 */
export function checkAll() {
  const { index, features } = loadBoard();
  const tasks = ledgerTasks();
  const mismatches = [];
  const remaining = [];
  let ok = 0;
  const exemptFile = loadExemptFile();
  const exempt = [];
  for (const t of tasks) {
    const ticket = String(t.ticket);
    const led = { project: t.project ?? null, feature: t.feature ?? null };
    const b = index.get(ticket);
    if (b) {
      if (led.project !== b.project || led.feature !== b.feature) {
        mismatches.push({ ticket, kind: 'feature-mismatch', ledger: led, board: { project: b.project, feature: b.feature }, fixable: true, state: t.state });
        continue;
      }
      if (!isContractSatisfied(b.contract)) {
        mismatches.push({ ticket, kind: 'no-contract', ledger: led, board: { project: b.project, feature: b.feature }, fixable: false, state: t.state });
        continue;
      }
      ok += 1;
      continue;
    }
    // 项目栏没有这张票：**测试夹具/历史测试票一律豁免**（不算脏数据，也不假装它一致）
    // 但"真票贴错 feature"不豁免——那种会走下面的 remaining，逼人修数据。
    const whyExempt = isExemptTicket(t, ticket);
    if (whyExempt) { exempt.push({ ticket, by: whyExempt }); continue; }
    const placeable = led.project && led.feature && features.has(`${led.project}/${led.feature}`);
    mismatches.push({
      ticket, kind: 'not-in-project', ledger: led, board: null, fixable: Boolean(placeable),
      fixTo: placeable ? { project: led.project, feature: led.feature } : null, state: t.state
    });
  }
  const count = mismatches.length;
  return { ok: count === 0, count, mismatches, remaining, exempt, stats: { ledgerTickets: tasks.length, ok, exempt: exempt.length, fixable: mismatches.filter((m) => m.fixable).length, blocked: mismatches.filter((m) => !m.fixable).length } };
}

/**
 * 单张票的对账（dispatch 前置用）：只关心这一张。
 * @returns {{ok:boolean, kind?:string, detail?:string}}
 */
export function checkTicket(ticket) {
  const want = String(ticket ?? '').trim();
  if (!want) return { ok: true };
  const { index, features } = loadBoard();
  const task = replay(readEvents(LEDGER_FILE)).find((t) => String(t.ticket ?? '') === want);
  if (!task) return { ok: true };                       // 台账里没有就不在这里拦（别的闸门会管）
  const led = { project: task.project ?? null, feature: task.feature ?? null };
  const b = index.get(want);
  if (b) {
    if (led.project !== b.project || led.feature !== b.feature) {
      return { ok: false, kind: 'feature-mismatch', detail: `台账 ${led.project ?? '—'}/${led.feature ?? '—'} ↔ 项目栏 ${b.project}/${b.feature}（以项目栏为准：node scripts\\pr-reconcile.mjs --fix）` };
    }
    if (!b.contract) return { ok: false, kind: 'no-contract', detail: `项目栏 ${b.project}/${b.feature} 的 contract 为空（补上或换 feature：不臆造）` };
    return { ok: true };
  }
  const placeable = led.project && led.feature && features.has(`${led.project}/${led.feature}`);
  if (placeable) return { ok: false, kind: 'not-in-project', detail: `项目栏没有 ${want}（可补：node scripts\\pr-reconcile.mjs --fix）` };
  return { ok: false, kind: 'not-in-project', detail: `项目栏没有 ${want}，台账也没有可落的功能域（先补 project/feature）` };
}

function audit(rec) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch { /* 审计写不进去不能影响修复 */ }
}

/**
 * 修复能确定的，其余进 remaining。
 * @returns {{fixed:number, remaining:Array, details:Array}}
 */
export function fixAll({ by = 'pr-reconcile' } = {}) {
  const { doc, index, features } = loadBoard();
  const tasks = ledgerTasks();
  const fixed = [];
  const remaining = [];
  let boardDirty = false;

  for (const t of tasks) {
    const ticket = String(t.ticket);
    const led = { project: t.project ?? null, feature: t.feature ?? null };
    const b = index.get(ticket);
    if (b) {
      if (led.project !== b.project || led.feature !== b.feature) {
        // 以项目栏为准回写台账
        appendEvent({ t: Date.now(), id: t.id, op: 'reconcile', from: by, project: b.project, feature: b.feature, note: `对账：${led.project ?? '—'}/${led.feature ?? '—'} → ${b.project}/${b.feature}（以项目栏为准）` }, LEDGER_FILE);
        audit({ ts: Date.now(), op: 'fix', ticket, kind: 'feature-mismatch', from: led, to: { project: b.project, feature: b.feature }, by });
        fixed.push({ ticket, kind: 'feature-mismatch', from: led, to: { project: b.project, feature: b.feature } });
        continue;
      }
      if (!isContractSatisfied(b.contract)) {
        remaining.push({ ticket, kind: 'no-contract', project: b.project, feature: b.feature, reason: '项目栏该 feature 的 contract 为空：不臆造，交人定' });
        continue;
      }
      continue;
    }
    // 两边都没有的历史测试票：豁免，不进 remaining（01 2026-10-31 判的 (a) 路径）
    if (isExemptTicket(t, ticket)) continue;
    // 项目栏缺票：台账归属指向的 feature 存在 → 补进 tickets[]
    if (led.project && led.feature && features.has(`${led.project}/${led.feature}`)) {
      const f = features.get(`${led.project}/${led.feature}`);
      f.tickets = Array.isArray(f.tickets) ? f.tickets : [];
      if (!f.tickets.map(String).includes(ticket)) {
        f.tickets.push(ticket);
        boardDirty = true;
        audit({ ts: Date.now(), op: 'fix', ticket, kind: 'not-in-project', to: { project: led.project, feature: led.feature }, by, how: 'append-to-board' });
        fixed.push({ ticket, kind: 'not-in-project', to: { project: led.project, feature: led.feature } });
      }
      continue;
    }
    remaining.push({ ticket, kind: 'not-in-project', ledger: led, reason: '项目栏没这张票，台账也没有可落的功能域：先定 project/feature' });
  }

  if (boardDirty) {
    writeJson(PROJECTS_FILE, doc);
    audit({ ts: Date.now(), op: 'fix-board', file: PROJECTS_FILE, by });
  }
  return { fixed: fixed.length, remaining, details: fixed };
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('用法：node scripts\\pr-reconcile.mjs [--check|--fix] [--json] [--ticket <单号>]');
    process.exit(0);
  }
  if (argv.includes('--ticket')) {
    const ticket = argv[argv.indexOf('--ticket') + 1];
    const r = checkTicket(ticket);
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(r.ok ? `✓ ${ticket} 台账与项目栏一致` : `✗ ${ticket} ${r.kind}：${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (argv.includes('--fix')) {
    const before = checkAll();
    const r = fixAll();
    const after = checkAll();
    if (json) console.log(JSON.stringify({ fixed: r.fixed, remaining: r.remaining, before: before.count, after: after.count, ok: after.ok }, null, 2));
    else {
      console.log(`修复 ${r.fixed} 条｜修前不一致 ${before.count} 条 → 修后 ${after.count} 条${after.ok ? '（清零）' : ''}`);
      for (const d of r.details.slice(0, 10)) console.log(`  ✓ ${d.ticket} ${d.kind} → ${d.to?.project}/${d.to?.feature}`);
      if (r.details.length > 10) console.log(`  …另有 ${r.details.length - 10} 条`);
      if (r.remaining.length) {
        console.log(`留给人定 ${r.remaining.length} 条：`);
        for (const x of r.remaining.slice(0, 10)) console.log(`  ? ${x.ticket} ${x.kind}：${x.reason}`);
        if (r.remaining.length > 10) console.log(`  …另有 ${r.remaining.length - 10} 条（--json 看全量）`);
      }
    }
    // exit 0 = 没有还能自动修的了（remaining 是交人定的，不算失败）；1 = 还有可修的没修掉
    process.exit(after.stats.fixable > 0 ? 1 : 0);
  }
  const r = checkAll();
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`台账票 ${r.stats.ledgerTickets} 张｜一致 ${r.stats.ok}｜不一致 ${r.count}（可自动修 ${r.stats.fixable}，需人定 ${r.stats.blocked}）`);
    const byKind = {};
    for (const m of r.mismatches) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    console.log('  分类：' + Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ｜ '));
    for (const m of r.mismatches.slice(0, 10)) {
      console.log(`  ✗ ${m.ticket} ${m.kind}${m.board ? `：台账 ${m.ledger.project ?? '—'}/${m.ledger.feature ?? '—'} ↔ 项目栏 ${m.board.project}/${m.board.feature}` : `：项目栏没有（台账 ${m.ledger.project ?? '—'}/${m.ledger.feature ?? '—'}）`}`);
    }
    if (r.count > 10) console.log(`  …另有 ${r.count - 10} 条（--json 看全量）`);
    if (r.count) console.log('修：node scripts\\pr-reconcile.mjs --fix');
  }
  process.exit(r.ok ? 0 : 1);
}
