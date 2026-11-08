#!/usr/bin/env node
/**
 * scripts/wake-log.mjs —— 「叫醒账」读写（UG-087，2026-11-05）
 *
 * 为什么单独一个文件：lane-runner 原来靠 `state\lane-runner.json` 里的 `lastWake` 做限流，
 * 那是**按"这一批 ids"**记账的；散票（没有链路）每拍只推进一张，必须**按票**记账，
 * 否则"A 叫完叫 B"会被同一批次覆盖。这里按票号记：
 *   - 同一张票 cooldown（默认 10 分钟）内不重复叫；
 *   - 每张票最多叫 MAX_N 次（默认 3）；
 *   - **失败也记一行**（ok:false + code），`--status` 据此显示「未叫醒」——
 *     不静默是硬要求：叫不醒和被叫过必须能区分。
 *
 * 用法（lane-runner 内部用，也可单独 cat 排查）：logs\wake.jsonl 一行一条。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(HERE, '..');
export const WAKE_LOG = path.join(WORKSPACE, 'logs', 'wake.jsonl');

/** 同一张票的冷却（测试可用 XUNYU_WAKE_COOLDOWN_MS 调小） */
export const WAKE_COOLDOWN_MS = Number(process.env.XUNYU_WAKE_COOLDOWN_MS ?? 10 * 60 * 1000);
/** 同一张票最多叫几次 */
export const WAKE_MAX_N = Number(process.env.XUNYU_WAKE_MAX_N ?? 3);

/** 读叫醒账（坏行跳过） */
export function readWakeLog(file = WAKE_LOG) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && o.ticket) out.push(o);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 某张票的叫醒历史（按时间升序） */
export function attemptsOf(ticket, rows = null) {
  const all = rows ?? readWakeLog();
  const key = String(ticket ?? '');
  return all.filter((r) => String(r.ticket) === key).sort((a, b) => Number(a.t ?? 0) - Number(b.t ?? 0));
}

/**
 * 这张票现在能不能叫。返回 {ok, n, reason, nextAt, last}：
 *   reason = 'ok' | 'cooldown' | 'maxed'
 *   n      = 已经叫过几次（含失败的）
 */
export function canWake(ticket, { now = Date.now(), rows = null } = {}) {
  const hist = attemptsOf(ticket, rows);
  const n = hist.length;
  const last = n ? hist[n - 1] : null;
  if (n >= WAKE_MAX_N) return { ok: false, n, reason: 'maxed', nextAt: null, last };
  if (last && now - Number(last.t ?? 0) < WAKE_COOLDOWN_MS) {
    return { ok: false, n, reason: 'cooldown', nextAt: Number(last.t ?? 0) + WAKE_COOLDOWN_MS, last };
  }
  return { ok: true, n, reason: 'ok', nextAt: null, last };
}

/** 追加一条叫醒记录（永不抛） */
export function appendWake(rec, file = WAKE_LOG) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
