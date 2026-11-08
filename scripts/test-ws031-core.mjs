#!/usr/bin/env node
// scripts\test-ws031-core.mjs —— WS-031 纯函数层回归测试（开发规范 v1）
//
// 纪律：只测 ws031-core.mjs 的公开导出；每个函数**至少 1 正例 + 1 反例**。
// 跑法：node --test scripts\test-ws031-core.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  maskSecret, clipLine, levelOf, isErrorLogName, parseClock, formatEntry,
  collapseRepeats, seqOf, sanitizeLogText, numIn,
  validateSamplingPatch, validateModelPatch, validateBridgeToken, validateToggle,
} from './ws031-core.mjs';

// ── maskSecret ───────────────────────────────────────────────────────────────
test('maskSecret 正例：sk- 开头只留 sk-…尾4', () => {
  assert.equal(maskSecret('sk-abcdefghijklmnopWxyz'), 'sk-…Wxyz');
  assert.equal(maskSecret('0123456789abcdef'), '012…cdef');
});
test('maskSecret 反例：空/短串不泄露任何字符', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret(null), '');
  assert.equal(maskSecret('sk-1234'), '••••');   // ≤8 位一律全遮
});

// ── clipLine ─────────────────────────────────────────────────────────────────
test('clipLine 正例：超长截到 max（含省略号），正好等于上限不动', () => {
  assert.equal(clipLine('x'.repeat(600), 500).length, 500);
  assert.ok(clipLine('x'.repeat(600), 500).endsWith('…'));
  assert.equal(clipLine('abc', 500), 'abc');
});
test('clipLine 反例：max 非法（0/NaN）回落到 500，不返回空串', () => {
  assert.equal(clipLine('y'.repeat(600), 0).length, 500);
  assert.equal(clipLine('y'.repeat(600), NaN).length, 500);
});

// ── levelOf / isErrorLogName ─────────────────────────────────────────────────
test('levelOf 正例：含 error/失败/超时 判 error，普通行判 info', () => {
  assert.equal(levelOf('14:00:00 [bridge] Error: boom'), 'error');
  assert.equal(levelOf('投递失败：没有合格的任务书'), 'error');
  assert.equal(levelOf('14:00:00 [bridge] 已连上 DSH'), 'info');
});
test('levelOf 反例：空行/非字符串不炸，按 info', () => {
  assert.equal(levelOf(''), 'info');
  assert.equal(levelOf(undefined), 'info');
});
test('isErrorLogName 正例：.err.log 与 errors.jsonl 都是错误日志', () => {
  assert.equal(isErrorLogName('bridge.err.log'), true);
  assert.equal(isErrorLogName('errors.jsonl'), true);
});
test('isErrorLogName 反例：正常 out 日志不是', () => {
  assert.equal(isErrorLogName('bridge.log'), false);
  assert.equal(isErrorLogName('errors.txt'), false);
});

// ── parseClock ───────────────────────────────────────────────────────────────
test('parseClock 正例：ISO 与裸时分秒都认', () => {
  assert.equal(parseClock('2026-11-07 14:11:56 [bridge] x'), Date.parse('2026-11-07T14:11:56'));
  const fallback = Date.parse('2026-11-07T00:00:00');
  const got = parseClock('14:11:56 [bridge] x', fallback);
  assert.equal(new Date(got).getHours(), 14);
  assert.equal(new Date(got).getMinutes(), 11);
});
test('parseClock 反例：没有时间戳 → 原样回 fallback（不编当前时间）', () => {
  const fb = 1794031234567;
  assert.equal(parseClock('没有时间的一行', fb), fb);
  assert.equal(parseClock('', fb), fb);
});

// ── formatEntry ──────────────────────────────────────────────────────────────
test('formatEntry 正例：jsonl 行压成人话，at 取 obj.at', () => {
  const line = JSON.stringify({ at: 1794031166979, id: 'window-proxy', action: 'alert', detail: '超过上限' });
  const e = formatEntry(line, { atMs: 1, src: 'supervisor' });
  assert.equal(e.at, 1794031166979);
  assert.equal(e.text, 'window-proxy alert：超过上限');
  assert.equal(e.src, 'supervisor');
});
test('formatEntry 反例：坏 JSON / 空行不炸，原文保留并截断', () => {
  const e = formatEntry('{"at": 1, 坏掉了', { atMs: 42 });
  assert.equal(e.at, 42);
  assert.equal(e.level, 'info');
  const long = formatEntry('z'.repeat(900), { atMs: 1 });
  assert.equal(long.text.length, 500);
});
test('formatEntry：forceLevel 覆盖关键词判定（.err.log 整份算错）', () => {
  const e = formatEntry('[bridge] 已有实例在运行', { atMs: 1, forceLevel: 'error' });
  assert.equal(e.level, 'error');
});

// ── collapseRepeats ──────────────────────────────────────────────────────────
test('collapseRepeats 正例：相邻同文合并成一条并计数', () => {
  const rows = [
    { at: 1, level: 'info', text: 'A', src: 's' },
    { at: 2, level: 'info', text: 'A', src: 's' },
    { at: 3, level: 'info', text: 'B', src: 's' },
  ];
  const r = collapseRepeats(rows);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].repeat, 2);
  assert.equal(r.deduped, 1);
});
test('collapseRepeats 反例：不相邻的同文不合并（中间隔了别行）', () => {
  const rows = [
    { at: 1, level: 'info', text: 'A', src: 's' },
    { at: 2, level: 'info', text: 'B', src: 's' },
    { at: 3, level: 'info', text: 'A', src: 's' },
  ];
  const r = collapseRepeats(rows);
  assert.equal(r.rows.length, 3);
  assert.equal(r.deduped, 0);
  assert.deepEqual(collapseRepeats([]).rows, []);
});

// ── seqOf ────────────────────────────────────────────────────────────────────
test('seqOf 正例：同一毫秒内按行号递增（增量不漏行）', () => {
  const a = seqOf(1794032000000, 0);
  const b = seqOf(1794032000000, 1);
  assert.ok(b > a);
  assert.ok(seqOf(1794032000001, 0) > b);
});
test('seqOf 反例：非法时间不产出 NaN', () => {
  assert.equal(Number.isFinite(seqOf('不是时间', 0)), true);
  assert.equal(Number.isFinite(seqOf(undefined, 5)), true);
});

// ── sanitizeLogText ──────────────────────────────────────────────────────────
test('sanitizeLogText 正例：sk- 与 token= 都被抹掉', () => {
  assert.ok(!sanitizeLogText('key sk-abcdefgh12345678 end').includes('abcdefgh12345678'));
  assert.ok(!sanitizeLogText('access_token="abcdefghijklmnopqrst"').includes('abcdefghijklmnopqrst'));
});
test('sanitizeLogText 反例：普通文本原样，不误伤短词', () => {
  assert.equal(sanitizeLogText('[bridge] 已连上 DSH'), '[bridge] 已连上 DSH');
  assert.equal(sanitizeLogText('token 已刷新'), 'token 已刷新');
});

// ── numIn ────────────────────────────────────────────────────────────────────
test('numIn 正例：区间内返回数字，边界值算合法', () => {
  assert.equal(numIn('0.5', 0, 2), 0.5);
  assert.equal(numIn(0, 0, 2), 0);
  assert.equal(numIn(2, 0, 2), 2);
});
test('numIn 反例：越界/非数字/空串一律 null', () => {
  assert.equal(numIn(99, 0, 2), null);
  assert.equal(numIn('abc', 0, 2), null);
  assert.equal(numIn('', 0, 2), null);
});

// ── validateSamplingPatch ────────────────────────────────────────────────────
test('validateSamplingPatch 正例：三项合法都进 applied', () => {
  const r = validateSamplingPatch({ temperature: 1 }, { temperature: 0.45, maxTokens: 8192, deepThink: true });
  assert.deepEqual(r.applied, ['sampling.temperature', 'sampling.maxTokens', 'sampling.deepThink']);
  assert.equal(r.sampling.temperature, 0.45);
  assert.deepEqual(r.warnings, []);
});
test('validateSamplingPatch 反例：越界不改 + 人话 warning；同值不算改动', () => {
  const r = validateSamplingPatch({ temperature: 0.45 }, { temperature: 99 });
  assert.deepEqual(r.applied, []);
  assert.equal(r.sampling.temperature, 0.45);
  assert.match(r.warnings[0], /不合法（要 0~2）/);
  assert.deepEqual(validateSamplingPatch({ temperature: 0.45 }, { temperature: 0.45 }).applied, []);
});

// ── validateModelPatch ───────────────────────────────────────────────────────
test('validateModelPatch 正例：name/baseUrl 映射到 dsh.model/dsh.baseUrl', () => {
  const r = validateModelPatch({ model: 'deepseek-flash', baseUrl: 'http://a' }, { name: 'deepseek-pro', baseUrl: 'http://b' });
  assert.equal(r.dsh.model, 'deepseek-pro');
  assert.equal(r.dsh.baseUrl, 'http://b');
  assert.deepEqual(r.applied, ['model.baseUrl', 'model.name']);
});
test('validateModelPatch 反例：空 key / 短 key 都不写（红线：空串=不改）', () => {
  const r1 = validateModelPatch({ authToken: 'k'.repeat(40) }, { key: '' });
  assert.equal(r1.dsh.authToken, 'k'.repeat(40));
  assert.deepEqual(r1.applied, []);
  assert.match(r1.warnings[0], /空字符串 = 不改/);
  const r2 = validateModelPatch({}, { key: 'short' });
  assert.equal(r2.dsh.authToken, undefined);
  assert.match(r2.warnings[0], /形态不像 Key/);
});

// ── validateBridgeToken ──────────────────────────────────────────────────────
test('validateBridgeToken 正例：≥24 位可见 ASCII 收下', () => {
  assert.equal(validateBridgeToken('a'.repeat(32)).ok, true);
});
test('validateBridgeToken 反例：空串与带空格/太短都拒，并给原因', () => {
  assert.equal(validateBridgeToken('').ok, false);
  assert.match(validateBridgeToken('').warning, /空字符串 = 不改/);
  assert.equal(validateBridgeToken('short').ok, false);
  assert.equal(validateBridgeToken('a'.repeat(30) + ' 空格').ok, false);
});

// ── validateToggle ───────────────────────────────────────────────────────────
test('validateToggle 正例：白名单五个字段都能过，数字被归一化', () => {
  assert.deepEqual(validateToggle('sendDelayMs', '1200'), { ok: true, value: 1200 });
  assert.deepEqual(validateToggle('ackMessage', '收到'), { ok: true, value: '收到' });
  const allow = validateToggle('allow', { private: [' 123 ', ''], groups: [456] });
  assert.deepEqual(allow.value, { private: ['123'], groups: ['456'] });
});
test('validateToggle 反例：非白名单 403、取值错 400，都带人话', () => {
  const denied = validateToggle('consoleToken', 'x');
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.match(denied.error, /只允许改这五个字段/);
  const bad = validateToggle('sendDelayMs', 'abc');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.match(bad.error, /0~60000/);
  assert.equal(validateToggle('allow', 'not-an-object').status, 400);
});
