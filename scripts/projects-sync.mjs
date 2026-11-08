#!/usr/bin/env node
import { readJson as readJsonIo } from './json-io.mjs';
// scripts/projects-sync.mjs —— 把台账里的票归属同步进 state\projects.json（D66）
//
// 解决什么：projects.json 的 tickets[] 以前靠 05 手填，票天天新派 → 永远对不上，项目视图落后。
// 现在：按台账里每张票的 project/feature 重新生成每个 feature 的 tickets[]。
//
// 规矩：
//   · **只重写 tickets[] 与 generated/generatedAt**；05 定义的 id/name/domain/owner/summary/doc/state 一律不碰；
//   · **合并而不是清空**：台账里没有归属信息的历史票（05 手填的、老票）原样保留，不会被冲掉；
//   · **幂等**：连着跑两次，第二次没有改动（内容一致就不写盘）；
//   · `--dry-run` 只打印差异；`--restore <备份>` 把 tickets[] 还原成备份里的样子。
//
// 用法：
//   node scripts\projects-sync.mjs [--dry-run] [--json]
//   node scripts\projects-sync.mjs --restore backup\proj-sync-20261028\projects.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from './worklist-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const PROJECTS = path.join(WORKSPACE, 'state', 'projects.json');
const BACKUP_DIR = path.join(WORKSPACE, 'backup', 'proj-sync-auto');

const PRESERVE = ['id', 'name', 'domain', 'owner', 'summary', 'doc', 'state', 'parallel', 'contract', 'blockedByDomain', 'note'];

function readJson(p) {
  try { return readJsonIo(p); } catch { return null; }
}

/** 台账 → { 'project/feature': [ticket,...] }；没有归属的老票进 `unattributed` 集合。 */
function deriveFromLedger() {
  const bySlot = new Map();
  const attributed = new Set();
  for (const t of replay()) {
    const ticket = String(t.ticket ?? '').trim();
    if (!ticket) continue;
    if (!t.project || !t.feature) continue;
    attributed.add(ticket);                    // 有归属就算「台账管着它」，作废也要能被摘掉
    if (t.state === 'dropped') continue;       // 作废的票不进项目视图
    const key = `${t.project}/${t.feature}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push({ ticket, at: t.createdAt ?? 0 });
  }
  const out = new Map();
  for (const [key, items] of bySlot) {
    out.set(key, [...new Set(items.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map((x) => x.ticket))]);
  }
  return { bySlot: out, attributed };
}

/**
 * 同步（幂等）。返回 {ok, changed, dryRun, diffs[], file}
 */
export function syncProjects({ dryRun = false, file = PROJECTS, now = Date.now() } = {}) {
  const doc = readJson(file);
  if (!doc || !Array.isArray(doc.projects)) return { ok: false, error: `读不到 ${file}`, changed: false, diffs: [] };
  const { bySlot, attributed } = deriveFromLedger();
  const diffs = [];

  for (const proj of doc.projects) {
    for (const feat of (proj.features ?? [])) {
      const key = `${proj.id}/${feat.id}`;
      const derived = bySlot.get(key) ?? [];
      const existing = Array.isArray(feat.tickets) ? [...feat.tickets] : [];
      // 保留：①台账已归属到本 feature 的票 ②老的手填票（台账里根本没有归属信息的）
      const keepLegacy = existing.filter((x) => !derived.includes(x) && !attributed.has(x));
      const next = [...new Set([...derived, ...keepLegacy])];
      const before = existing.join(',');
      const after = next.join(',');
      if (before !== after) {
        diffs.push({ project: proj.id, feature: feat.id, added: next.filter((x) => !existing.includes(x)), removed: existing.filter((x) => !next.includes(x)), before, after });
        if (!dryRun) {
          feat.tickets = next;
          feat.generated = true;
        }
      } else if (!dryRun && feat.generated !== true) {
        feat.generated = true;   // 首次标记来源（内容没变不算 diff）
      }
    }
  }

  if (!diffs.length) return { ok: true, changed: false, dryRun, diffs, file };

  if (dryRun) return { ok: true, changed: true, dryRun: true, diffs, file };

  // 写前自动备份（同一份里只留最近 20 个）
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, `projects-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`), fs.readFileSync(file, 'utf8'), 'utf8');
    const olds = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 20))) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  } catch { /* 备份失败不阻塞同步 */ }

  doc.generatedAt = new Date(now).toISOString();
  doc.generatedBy = 'projects-sync.mjs（D66）';
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return { ok: true, changed: true, dryRun: false, diffs, file };
}

/** 从备份还原 tickets[]（只还原票，不动 05 的其它字段）。 */
export function restoreTickets(backupFile, { file = PROJECTS } = {}) {
  const backup = readJson(backupFile);
  const doc = readJson(file);
  if (!backup || !doc) return { ok: false, error: '备份或当前文件读不到' };
  let n = 0;
  for (const proj of doc.projects ?? []) {
    const bp = (backup.projects ?? []).find((p) => p.id === proj.id);
    for (const feat of proj.features ?? []) {
      const bf = (bp?.features ?? []).find((f) => f.id === feat.id);
      if (bf && Array.isArray(bf.tickets)) { feat.tickets = [...bf.tickets]; n += 1; }
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return { ok: true, restored: n };
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const json = argv.includes('--json');
  const ri = argv.indexOf('--restore');
  if (ri >= 0) {
    const r = restoreTickets(argv[ri + 1]);
    if (json) process.stdout.write(`${JSON.stringify(r)}\n`);
    else process.stdout.write(r.ok ? `✓ 已从备份还原 ${r.restored} 个 feature 的 tickets[]\n` : `✗ ${r.error}\n`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  const r = syncProjects({ dryRun });
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...r, preserve: PRESERVE }, null, 2)}\n`);
  } else if (!r.ok) {
    process.stdout.write(`✗ ${r.error}\n`);
    process.exitCode = 1;
  } else if (!r.changed) {
    process.stdout.write(`无变化（${dryRun ? 'dry-run' : '已同步'}）：台账与 projects.json 的 tickets[] 一致\n`);
  } else {
    process.stdout.write(`${dryRun ? '将修改' : '已同步'} ${r.diffs.length} 个 feature：\n`);
    for (const d of r.diffs) {
      process.stdout.write(`  ${d.project}/${d.feature}  +${d.added.join(',') || '0'}  -${d.removed.join(',') || '0'}\n`);
    }
  }
  process.exitCode = 0;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry !== '' && entry === fileURLToPath(import.meta.url);
  } catch { return false; }
})();
if (invokedDirectly) main();
