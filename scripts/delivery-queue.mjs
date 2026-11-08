#!/usr/bin/env node
/**
 * scripts/delivery-queue.mjs —— 「交付即通知」队列（UG-084，2026-11-05）
 *
 * 为什么：01 收作业靠 `Start-Sleep` 轮询等结果，验收从几分钟拖到十几分钟
 * （规则 `docs\规则\交付与验收-2026-11-05.md` 二/三节明令禁止轮询）。
 * 改成**工号推**：`worklist.mjs state <票> submitted` 成功后台账多一行，
 * 01 只读 `state\delivery-queue.jsonl`。
 *
 * 三条硬口径：
 *   1. **只追加，不重写历史**——连"取走"也是追加一条 `taken:true` 的同票行，
 *      读者按**同一票的最后一行**判定状态（所以文件永远 append-only，出问题能回放）。
 *   2. **写队列失败绝不拖累票状态**——先落状态，再 best-effort 写队列，失败只警告。
 *   3. **坏行跳过不炸**——手改/半行/断电都可能留残行，读到就跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..');
export const QUEUE_FILE = path.join(WORKSPACE, 'state', 'delivery-queue.jsonl');

const asText = (v, max = 400) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);

/** 从备注里抠交付文件路径（`交付在 records\交付\xx.md`／裸路径都认） */
export function deliveryPathOf(note) {
  const s = String(note ?? '');
  const m = s.match(/(?:^|[\s（(：:])((?:[A-Za-z]:)?[\\/]?[^\s，,；;）)]*?records[\\/]交付[\\/][^\s，,；;）)]+\.md)/i);
  if (m) return m[1].replace(/\//g, '\\');
  return '';
}

/**
 * 追加一条交付通知。**永不抛**：返回 {ok:true, row} 或 {ok:false, error}。
 */
export function enqueueDelivery({ ticket, id, by, delivery, note, taken = false, takenAt = null, takenBy = null, file = QUEUE_FILE, t = Date.now() } = {}) {
  const row = {
    t,
    ticket: asText(ticket, 40) || null,
    id: asText(id, 40) || null,
    by: asText(by, 20) || null,
    delivery: asText(delivery ?? deliveryPathOf(note), 300),
    note: asText(note, 400),
    taken: Boolean(taken),
  };
  // 「取走」也走追加：多带两个字段，读者按同票最后一行判定（文件因此永远 append-only）
  if (row.taken) {
    row.takenAt = Number(takenAt ?? t);
    row.takenBy = asText(takenBy, 20) || '01';
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true, row };
  } catch (error) {
    return { ok: false, row, error: String(error?.message ?? error) };
  }
}

/** 读全部行（坏行跳过）；`_line` 是文件里的行号（1-based），便于排错 */
export function readQueue(file = QUEUE_FILE) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const o = JSON.parse(line);
      if (!o || typeof o !== 'object' || !o.ticket) return;
      out.push({ ...o, taken: Boolean(o.taken), _line: i + 1 });
    } catch { /* 坏行跳过 */ }
  });
  return out;
}

/** 同一票以**最后一行**为准（取走 = 追加一行 taken:true） */
export function latestByTicket(file = QUEUE_FILE) {
  const map = new Map();
  for (const row of readQueue(file)) map.set(String(row.ticket), row);
  return map;
}

/** 按票号**或** W-号找最新一行（`--take` 两种都能给，省得人记两种 id） */
export function findEntry(key, { file = QUEUE_FILE } = {}) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  const rows = readQueue(file);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (String(rows[i].ticket) === k || String(rows[i].id) === k) return rows[i];
  }
  return null;
}

/** 未取走的条目，按到达顺序（t 升序），最多 limit 条 */
export function pendingEntries({ limit = 10, file = QUEUE_FILE } = {}) {
  const rows = [...latestByTicket(file).values()].filter((r) => !r.taken);
  rows.sort((a, b) => Number(a.t ?? 0) - Number(b.t ?? 0));
  return rows.slice(0, Math.max(1, limit));
}

/**
 * 取走一张。幂等：已取走返回 {ok:true, alreadyTaken:true}（不报错）；查无返回 {ok:false, code:'not-found'}。
 */
export function takeEntry(ticket, { file = QUEUE_FILE, by = '01' } = {}) {
  const key = String(ticket ?? '').trim();
  const first = findEntry(key, { file });
  if (!first) return { ok: false, code: 'not-found', detail: `队列里没有 ${ticket}` };
  const cur = latestByTicket(file).get(String(first.ticket)) ?? first;
  if (cur.taken) return { ok: true, alreadyTaken: true, entry: cur, by: cur.takenBy ?? null };
  const row = { ...cur, taken: true, takenAt: Date.now(), takenBy: asText(by, 20) || '01' };
  delete row._line;
  const r = enqueueDelivery(row);
  if (!r.ok) return { ok: false, code: 'write-failed', detail: r.error, entry: cur };
  return { ok: true, alreadyTaken: false, entry: row };
}
