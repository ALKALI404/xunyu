#!/usr/bin/env node
/**
 * build-wg-tier-presets —— 从**实测工具面**生成三档瘦身名单（UG-046）
 *
 * 为什么不用「前缀」：DSH 的 `ctx.tools.restrict({deny})` 只认**精确工具名**，
 * 名字不认识会抛错；而 `restrict` 是按 agent scope 生效的（profile 级全局限制会
 * 把每个 agent 都盖住）。所以档位必须落成「这一档要 deny 掉的确切名字清单」，
 * 由 preset 里的守卫行逐名 restrict —— 与 qq-agent-presets/qq-tool-restrict.mjs 同款做法。
 *
 * 输入：一份 context-report --json 的产物（默认 tmp\ctx-fresh.json = 实测的 183 个工具）
 * 输出：state\presets\wg-<tier>-deny.json
 *
 * 用法：node scripts\build-wg-tier-presets.mjs [--report tmp\ctx-fresh.json] [--out state\presets]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const REPORT = val('report', 'tmp\\ctx-fresh.json');
const OUT_DIR = val('out', 'state\\presets');

// 与 scripts\context-report.mjs 的 TIERS 保持一致（两份都改才算改）
const TIERS = {
  full: { drop: [], label: '现状（不砍）' },
  lean: { drop: ['cua_*'], label: '去掉电脑操作（CUA）' },
  minimal: {
    drop: ['cua_*', 'engram_*', 'mcp__snowluma__', 'mcp__bilibili__', 'mcp__net-accel__', 'mcp__qq-extras__'],
    label: '只留搜索 + 内置工具',
  },
};

const familyOf = (name) => {
  if (typeof name !== 'string') return 'builtin';
  if (name.startsWith('mcp__')) { const p = name.split('__'); return p.length >= 3 && p[1] ? `mcp__${p[1]}__` : 'builtin'; }
  if (name.startsWith('cua_driver_native__') || name.startsWith('cua_')) return 'cua_*';
  if (name.startsWith('engram_')) return 'engram_*';
  return 'builtin';
};

const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
// 精确工具名随 context-report 的产物一起来（report.toolNames）；没有就报错，别猜
const toolNames = Array.isArray(report.toolNames) ? report.toolNames : null;
if (!toolNames?.length) {
  console.error(`${REPORT} 里没有 toolNames：重跑 node scripts\\context-report.mjs --session <id> --json --out ${REPORT}`);
  process.exitCode = 1;
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const summary = {};
for (const [tier, def] of Object.entries(TIERS)) {
  const deny = toolNames.filter((n) => def.drop.includes(familyOf(n)));
  const kept = toolNames.length - deny.length;
  const predicted = report.tiers?.[tier]?.predictedPressureTokens ?? null;
  const doc = {
    schemaVersion: 1,
    ticket: 'UG-046',
    tier,
    label: def.label,
    dropFamilies: def.drop,
    denyTools: deny,
    denyCount: deny.length,
    keptTools: kept,
    predictedPressureTokens: predicted,
    measuredBaseline: { sessionId: report.sessionId, pressureTokens: report.pressureTokens, toolsCount: report.toolsCount },
    generatedAt: new Date().toISOString(),
    note: 'denyTools 是精确名字（restrict 只认精确名）。装法见 records\\交付\\03-20261031-UG-046.md §四。',
  };
  const file = path.join(OUT_DIR, `wg-${tier}-deny.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  summary[tier] = { file, deny: deny.length, kept, predicted };
  console.log(`${tier.padEnd(8)} deny=${String(deny.length).padStart(3)}  keep=${String(kept).padStart(3)}  推算 ${predicted ?? '?'} token  → ${file}`);
}
fs.writeFileSync(path.join(OUT_DIR, 'wg-tiers.summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`合计写 ${Object.keys(summary).length} 份档位名单到 ${OUT_DIR}`);
