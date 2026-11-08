#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// 孤儿票检查器（UG-023 / W-263，审计 #9）
// 解决什么：改代/建档之后，`doing` 票可能还挂在**已经归档或不在名册上**的会话名下——
//   票看着"有人在干"，其实那个会话早没了，谁也不会再来交（W-238 就是这么躺了三天）。
// 判据：`state\roster.json` 的 `active` 里，状态 active 且真有 sessionId 的工号 = 活跃；
//   一张 `doing` 票的 target 不在这集合里 → 孤儿。
// 动作：默认**自动回收**——`doing → queued`（退回排队等重派），并写一条 `op: orphan-recovered`
//   审计事件（谁被回收、原来挂在哪、为什么）。回 `queued` 而不 `dropped`：票没错，错的是它挂的人。
//
// 用法：
//   node scripts\orphan-check.mjs              检测 + 自动回收（默认）
//   node scripts\orphan-check.mjs --check      只读检测：exit 0 = 无孤儿，1 = 有孤儿（handoff 归档闸门用）
//   node scripts\orphan-check.mjs --dry-run    只读检测，exit 恒 0（人看用）
//   node scripts\orphan-check.mjs --json       机器读（可与上面任意一个组合）
// 退出码：0 正常 / 1 检测到孤儿（仅 --check）/ 2 读不到名册或回收失败

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, setState, appendEvent } from './worklist-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(HERE, '..');
const ROSTER = path.join(WS, 'state', 'roster.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);

/** 读名册（容忍 BOM；读不到返回 null → 调用方按"检不了"处理，不许当成"无孤儿"）。 */
export function readRoster(file = ROSTER) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

/** 活跃工号 = active 数组里 status=active 且真的带了 sessionId 的。 */
export function activeWorkers(roster) {
  const map = new Map();
  for (const m of (Array.isArray(roster?.active) ? roster.active : [])) {
    if (String(m?.status ?? 'active') !== 'active') continue;
    if (!m?.sessionId) continue;
    map.set(String(m.id), m);
  }
  return map;
}

/**
 * 找孤儿：`doing` 票的持有者不在活跃工号里（含 target 为空的票——那连"谁在做"都说不清）。
 * 只读，不改任何东西。
 */
export function findOrphans(tasks = replay(), roster = readRoster()) {
  const active = activeWorkers(roster);
  const out = [];
  for (const t of tasks) {
    if (t.state !== 'doing') continue;
    if (t.target === 'test') continue;                  // 夹具单不参与
    const key = String(t.target ?? '').trim();
    if (!key) {
      out.push({ task: t, reason: 'no-target', detail: 'doing 票没有 target（谁在做说不清）' });
      continue;
    }
    if (!active.has(key)) {
      out.push({ task: t, reason: 'holder-inactive', detail: `工号 ${key} 在 roster.active 里没有活跃会话` });
    }
  }
  return out;
}

/** 回收：doing → queued，并留一条 orphan-recovered（回收这件事必须可回放）。 */
export function recoverOrphans(orphans, { by = 'orphan-check' } = {}) {
  const done = [];
  const failed = [];
  for (const o of orphans) {
    const t = o.task;
    const note = `孤儿票回收：持有者 ${t.target ?? '（空）'} ${o.detail}；退回排队等重派（${by}）`;
    try {
      setState(t.id, 'queued', { from: by, note });
      appendEvent({ id: t.id, op: 'orphan-recovered', from: by, ticket: t.ticket ?? null, wasTarget: t.target ?? null, reason: o.reason });
      done.push({ id: t.id, ticket: t.ticket ?? null, from: t.target ?? null, reason: o.reason });
    } catch (e) {
      failed.push({ id: t.id, error: String(e?.message ?? e) });
    }
  }
  return { done, failed };
}

function printOrphans(orphans) {
  for (const o of orphans) {
    const t = o.task;
    console.log(`  ${t.id}  ${t.ticket ?? '（无单号）'}  ${t.state}  target=${t.target ?? '—'}  「${t.title ?? ''}」`);
    console.log(`      → ${o.detail}`);
  }
}

// ── CLI（被 import 时不执行）────────────────────────────────────────────
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const roster = readRoster();
  if (!roster) {
    console.error(`✗ 读不到名册：${ROSTER}（检不了 ≠ 没孤儿，不许当通过）`);
    process.exit(2);
  }
  const orphans = findOrphans(replay(), roster);
  const readOnly = has('check') || has('dry-run');
  const json = has('json');

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      mode: readOnly ? (has('check') ? 'check' : 'dry-run') : 'recover',
      activeWorkers: activeWorkers(roster).size,
      orphanCount: orphans.length,
      orphans: orphans.map((o) => ({
        id: o.task.id, ticket: o.task.ticket ?? null, target: o.task.target ?? null,
        reason: o.reason, detail: o.detail
      }))
    }));
  } else if (!orphans.length) {
    console.log(`✓ 无孤儿票：${activeWorkers(roster).size} 个活跃工号，doing 票的持有者都在名册上`);
  } else {
    console.log(`⚠ 孤儿票 ${orphans.length} 张（doing 票的持有者不在活跃名册里）：`);
    printOrphans(orphans);
  }

  if (readOnly) {
    // --check：有孤儿 exit 1（handoff 归档闸门靠它）；--dry-run：只看，exit 恒 0
    process.exit(has('check') && orphans.length ? 1 : 0);
  }

  if (!orphans.length) process.exit(0);
  const { done, failed } = recoverOrphans(orphans);
  if (!json) {
    if (done.length) console.log(`✓ 已回收 ${done.length} 张 → queued（并记 orphan-recovered）：${done.map((d) => d.id).join('、')}`);
    for (const f of failed) console.log(`✗ 回收失败 ${f.id}：${f.error}`);
  }
  process.exit(failed.length ? 2 : 0);
}
