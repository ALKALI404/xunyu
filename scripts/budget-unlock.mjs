#!/usr/bin/env node
// scripts/budget-unlock.mjs —— 日预算闸人工放行（UG-026）
//
// 用法：node scripts\budget-unlock.mjs --reason "主人同意继续" [--by 本体] [--json]
// 退出码：0 成功（含"本来就没锁"）｜2 用法错（缺 --reason）
//
// 规矩：**必须带理由**——放行是花钱动作，理由要进审计（state\budget-alerts.jsonl，level='unlock'）。
// 回滚：不放行也行，直接删 state\budget-lock；但那样审计里没记录，不推荐。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_FILE, ALERTS_FILE, budgetGate } from './budget-gate.mjs';

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const reason = String(opt('reason', '') ?? '').trim();
const by = String(opt('by', '本体') ?? '本体');
const asJson = argv.includes('--json');

if (!reason) {
  process.stderr.write('用法：node scripts\\budget-unlock.mjs --reason "为什么可以继续花"\n');
  process.exit(2);
}

let lock = null;
try { lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch { lock = null; }

const rec = {
  at: Date.now(), day: budgetGate().day, level: 'unlock',
  reason: reason.slice(0, 300), by,
  lockDay: lock?.day ?? null, lockSpent: lock?.spent ?? null
};
let removed = false;
try {
  if (fs.existsSync(LOCK_FILE)) { fs.rmSync(LOCK_FILE, { force: true }); removed = true; }
  fs.mkdirSync(path.dirname(ALERTS_FILE), { recursive: true });
  fs.appendFileSync(ALERTS_FILE, `${JSON.stringify(rec)}\n`, 'utf8');
} catch (e) {
  process.stderr.write(`✗ 放行失败：${e?.message ?? e}\n`);
  process.exit(1);
}

const g = budgetGate({ spentOverride: null });
if (asJson) {
  process.stdout.write(`${JSON.stringify({ ok: true, removed, reason, by, gate: g }, null, 2)}\n`);
} else {
  process.stdout.write(`${removed ? '✓ 已解锁' : '· 本来就没有锁'}（理由：${reason}｜放行人：${by}）\n`);
  process.stdout.write(`  今日 ¥${g.spent.toFixed(2)}（soft ¥${g.soft} / hard ¥${g.hard}）${g.locked ? '｜⚠ 仍在锁（检查 BUDGET_ENFORCE / 花费是否已过 hard）' : '｜闸门已开'}\n`);
  process.stdout.write(`  审计：state\\budget-alerts.jsonl（level=unlock）\n`);
}
process.exitCode = 0;
