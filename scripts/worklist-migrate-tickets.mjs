#!/usr/bin/env node
// scripts/worklist-migrate-tickets.mjs —— 空号票清单（D37 守卫的配套迁移脚本）
//
// 背景：D37 起「没有单号不许建单/派单」。上线前已经存在的 ticket=null 任务需要人工补号，
// 这个脚本只做一件事：把它们列出来，并尽量从标题里猜一个「建议单号」供人核对。
// **只读**：不写台账、不改状态（补号由人决定后，用 worklist 的下一条新单承接，或人工改账本）。

import { replay } from './worklist-core.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');

/** 从标题里猜单号：D12 / W1 / B2 / C1 这类；猜不到留空。 */
function suggest(title) {
  const t = String(title ?? '');
  const m = /(?:^|【|\s)([A-Z]{1,3}\d{1,3})(?=[\s·】\-—:：]|$)/.exec(t);
  return m ? m[1] : '';
}

const rows = replay()
  .filter((t) => !String(t.ticket ?? '').trim())
  .map((t) => ({
    id: t.id,
    state: t.state,
    target: t.target,
    title: t.title,
    suggestedTicket: suggest(t.title),
    createdAt: t.createdAt
  }))
  .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

if (json) {
  process.stdout.write(`${JSON.stringify({ total: rows.length, rows }, null, 2)}\n`);
} else {
  console.log(`空号票：${rows.length} 条（ticket 为空；D37 起既不能新建、也不能派发）\n`);
  if (!rows.length) console.log('（没有，干净）');
  for (const r of rows) {
    const sug = r.suggestedTicket ? `建议单号 ${r.suggestedTicket}` : '建议单号？（标题里没有可识别的号）';
    console.log(`  ${String(r.id).padEnd(8)} ${String(r.state).padEnd(9)} 工号 ${String(r.target ?? '—').padEnd(3)} ${sug}`);
    console.log(`           ${r.title.slice(0, 60)}`);
  }
  if (rows.length) {
    console.log('\n补号方式（人工决定）：给这条任务补 ticket 后再派；或作废它、按规范新建带单号的单。');
  }
}
process.exitCode = 0;
