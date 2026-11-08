#!/usr/bin/env node
// scripts\test-console-core.mjs —— WS-027 聚合纯函数回归测试（开发规范 v1）
//
// 每个函数至少 1 正例 + 1 反例。
// 跑法：node --test scripts\test-console-core.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseActivity, shapeQq, shapeRelay, shapeFiles, shapePersona,
  shapeMemory, shapeCost, shapeTickets, shapeServices, cacheDecision, degradedOf,
} from './console-core.mjs';

const NOW = Date.parse('2026-11-07T14:30:00');

// ── parseActivity ────────────────────────────────────────────────────────────
test('parseActivity 正例：收发都数对，lastAt 取最后一条', () => {
  const raw = [
    '[14:20:38] group:835658578 [reserved2] 消息已入未读：在戒别搞',
    '[14:21:09] group:1033092642 [reserved2] 工具统一发送：成功 1/1 条',
    '[14:22:19] group:1033092642 [reserved2] 工具统一发送：成功 2/3 条',
  ].join('\n');
  const r = parseActivity(raw, NOW);
  assert.equal(r.recv, 1);
  assert.equal(r.sent, 3);          // 1 + 2，不是"2 条"也不是"2 次"
  assert.equal(r.lines, 3);
  assert.equal(new Date(r.lastAt).getHours(), 14);
  assert.equal(new Date(r.lastAt).getMinutes(), 22);
});
test('parseActivity 反例：空日志 / 没时间戳 / 非字符串都不炸', () => {
  assert.deepEqual(parseActivity('', NOW), { sent: 0, recv: 0, lastAt: null, lines: 0 });
  const r = parseActivity('没有时间的一行', NOW);
  assert.equal(r.lines, 1);
  assert.equal(r.lastAt, null);
  assert.equal(parseActivity(undefined, NOW).lines, 0);
});

// ── shapeQq ─────────────────────────────────────────────────────────────────
test('shapeQq 正例：连上且在线 → ok:true，带上今日收发', () => {
  const r = shapeQq({
    statusBody: { mode: 'reserved2', snowluma: { connected: true, accountOnline: true } },
    activity: '[10:00:00] group:1 [x] 工具统一发送：成功 5/5 条\n[10:01:00] group:1 [x] 消息已入未读：hi',
    nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.online, true);
  assert.equal(r.sentToday, 5);
  assert.equal(r.recvToday, 1);
  assert.match(r.detail, /reserved2/);
});
test('shapeQq 反例：软失败/离线/读不到 都不是 ok，且原因是人话', () => {
  assert.equal(shapeQq({ statusBody: { ok: false, error: '内部错误' } }).ok, false);
  assert.match(shapeQq({ statusBody: { ok: false, error: '内部错误' } }).detail, /内部错误/);
  assert.equal(shapeQq({ statusBody: { snowluma: { connected: true, accountOnline: false } } }).ok, false);
  assert.match(shapeQq({ error: '超时' }).detail, /读不到：超时/);
  assert.equal(shapeQq({}).ok, false);
});

// ── shapeRelay ──────────────────────────────────────────────────────────────
test('shapeRelay 正例：ok + 从 detail 里读出 2/2', () => {
  const r = shapeRelay({ ok: true, checks: { bindings: { ok: true, detail: '2/2 已绑定' } } });
  assert.equal(r.ok, true);
  assert.equal(r.bound, 2);
  assert.equal(r.total, 2);
});
test('shapeRelay 反例：0/2 判红、缺字段不炸、读不到有原因', () => {
  const r = shapeRelay({ ok: true, checks: { bindings: { ok: false, detail: '0/2 已绑定' } } });
  assert.equal(r.ok, false);
  assert.equal(r.bound, 0);
  assert.equal(shapeRelay({}).ok, false);
  assert.match(shapeRelay(null, '连接被拒').detail, /读不到：连接被拒/);
});

// ── shapeFiles ──────────────────────────────────────────────────────────────
test('shapeFiles 正例：implemented:true 才报已接入与计数', () => {
  const r = shapeFiles({ implemented: true, lastAt: NOW, sentToday: 3, recvToday: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.implemented, true);
  assert.equal(r.sentToday, 3);
});
test('shapeFiles 反例：没实现/文件缺失都是「未接入」，不许画成离线', () => {
  for (const doc of [null, {}, { implemented: false }]) {
    const r = shapeFiles(doc);
    assert.equal(r.ok, false);
    assert.equal(r.implemented, false);
    assert.match(r.detail, /未接入/);
  }
});

// ── shapePersona ────────────────────────────────────────────────────────────
test('shapePersona 正例：字数按码点算，front-matter 识别', () => {
  const r = shapePersona({ file: 'a.md', mtime: 1, text: '---\nname: 鲟鱼\n---\n正文' });
  assert.equal(r.ok, true);
  assert.equal(r.hasFrontMatter, true);
  assert.equal(r.chars, [...'---\nname: 鲟鱼\n---\n正文'].length);
});
test('shapePersona 反例：读不到时 chars 为 null 且 ok:false，不编 0 字', () => {
  const r = shapePersona({ file: 'a.md', error: 'ENOENT' });
  assert.equal(r.ok, false);
  assert.equal(r.chars, null);
  assert.equal(r.hasFrontMatter, false);
});

// ── shapeMemory ─────────────────────────────────────────────────────────────
test('shapeMemory 正例：多文件汇总 bytes/lines', () => {
  const r = shapeMemory([{ bytes: 10, lines: 2 }, { bytes: 5, lines: 3 }]);
  assert.deepEqual(r, { files: 2, lines: 5, bytes: 15 });
});
test('shapeMemory 反例：非数组/缺字段按 0，不返回 NaN', () => {
  assert.deepEqual(shapeMemory(null), { files: 0, lines: 0, bytes: 0 });
  assert.deepEqual(shapeMemory([{ bytes: 'x' }]), { files: 1, lines: 0, bytes: 0 });
});

// ── shapeCost ───────────────────────────────────────────────────────────────
test('shapeCost 正例：tokens = hit+miss+out，金额按元', () => {
  const r = shapeCost({ currency: 'CNY', totals: { turns: 302, hit: 100, miss: 20, out: 5, cost: 31.5 } });
  assert.equal(r.today, 31.5);
  assert.equal(r.turns, 302);
  assert.equal(r.tokens, 125);
});
test('shapeCost 反例：报告空了也不返回 NaN', () => {
  const r = shapeCost(undefined);
  assert.deepEqual([r.today, r.turns, r.tokens], [0, 0, 0]);
});

// ── shapeTickets ────────────────────────────────────────────────────────────
test('shapeTickets 正例：只取三个数', () => {
  assert.deepEqual(shapeTickets({ queued: 2, doing: 1, submitted: 3, done: 99 }), { queued: 2, doing: 1, submitted: 3 });
});
test('shapeTickets 反例：缺 summary 全 0', () => {
  assert.deepEqual(shapeTickets(undefined), { queued: 0, doing: 0, submitted: 0 });
});

// ── shapeServices ───────────────────────────────────────────────────────────
test('shapeServices 正例：实时探活覆盖快照里的 up（杀掉 15 秒内就能红）', () => {
  const snap = { services: [{ id: 'engine', name: '评分引擎', port: 9351, up: true, restartsLastHour: 2 }] };
  const out = shapeServices(snap, { engine: false });
  assert.equal(out[0].up, false);
  assert.equal(out[0].restartsLastHour, 2);
});
test('shapeServices 反例：没有快照/没有 override 时按快照，不抛错', () => {
  assert.deepEqual(shapeServices(null), []);
  const out = shapeServices({ services: [{ id: 'a', up: true }] }, null);
  assert.equal(out[0].up, true);
});

// ── cacheDecision ───────────────────────────────────────────────────────────
test('cacheDecision 正例：TTL 内命中，带 ageMs', () => {
  const r = cacheDecision(10_000, 8_000, 4_000);
  assert.equal(r.hit, true);
  assert.equal(r.ageMs, 2_000);
});
test('cacheDecision 反例：过期/没缓存/ttl<=0 都不命中', () => {
  assert.equal(cacheDecision(10_000, 1_000, 4_000).hit, false);
  assert.equal(cacheDecision(10_000, 0, 4_000).hit, false);
  assert.equal(cacheDecision(10_000, 9_999, 0).hit, false);   // ttl=0 = 不吃缓存
});

// ── state / degradedOf（P1 票面要求：读不到 = unreachable，不许装成离线）──────
test('state 正例：正常是 ok，能连但账号离线是 degraded，未接入单独一档', () => {
  assert.equal(shapeQq({ statusBody: { snowluma: { connected: true, accountOnline: true } } }).state, 'ok');
  assert.equal(shapeQq({ statusBody: { snowluma: { connected: true, accountOnline: false } } }).state, 'degraded');
  assert.equal(shapeQq({ error: '超时' }).state, 'unreachable');
  assert.equal(shapeRelay({ checks: { bindings: { ok: true, detail: '2/2' } } }).state, 'ok');
  assert.equal(shapeFiles(null).state, 'not-implemented');
});
test('degradedOf 反例：qq/relay 任一 unreachable 才算降级；files 未接入不算', () => {
  assert.equal(degradedOf({ qq: { state: 'ok' }, relay: { state: 'ok' }, files: { state: 'not-implemented' } }), false);
  assert.equal(degradedOf({ qq: { state: 'unreachable' }, relay: { state: 'ok' } }), true);
  assert.equal(degradedOf({ qq: { state: 'degraded' }, relay: { state: 'ok' } }), true);
  assert.equal(degradedOf({ qq: { state: 'ok' }, relay: { state: 'unreachable' } }), true);
  assert.equal(degradedOf(undefined), false);
});