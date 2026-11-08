#!/usr/bin/env node
// scripts\test-supervisor-core.mjs —— supervisor 核心的回归测试（WS-016，node:test）
//
// 纪律：只测**公开接口**（supervisor-core 导出的纯函数），不测内部实现细节。
// 跑法：node --test scripts\test-supervisor-core.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { backoffFor, restartBudget, decideActions, HOUR_MS } from './supervisor-core.mjs';
// ── 片 A：退避与配额 ─────────────────────────────────────────────────────────
test('退避阶梯：第 1/2/3 次 → 5s / 15s / 60s，之后封顶 60s', () => {
  assert.equal(backoffFor(1), 5000);
  assert.equal(backoffFor(2), 15000);
  assert.equal(backoffFor(3), 60000);
  assert.equal(backoffFor(4), 60000);
  assert.equal(backoffFor(99), 60000);
});

test('退避：次数非法（0/负数/NaN）按第 1 次算，不返回 0 或 NaN', () => {
  assert.equal(backoffFor(0), 5000);
  assert.equal(backoffFor(-3), 5000);
  assert.equal(backoffFor(NaN), 5000);
});

test('小时配额：一小时窗口内数重启次数，窗口外的不算', () => {
  const now = 1_000_000_000;
  const events = [
    { id: 'engine', action: 'start', at: now - 10_000 },
    { id: 'engine', action: 'start', at: now - 5 * 60_000 },
    { id: 'engine', action: 'start', at: now - HOUR_MS - 1 },   // 窗口外
    { id: 'engine', action: 'alert', at: now - 1000 },          // alert 不算重启
    { id: 'other', action: 'start', at: now - 1000 },           // 别的服务不算
  ];
  assert.equal(restartBudget(events, 'engine', { now }), 2);
});

test('小时配额：没有事件 → 0；空输入不炸', () => {
  assert.equal(restartBudget([], 'engine', { now: 1 }), 0);
  assert.equal(restartBudget(undefined, 'engine', { now: 1 }), 0);
});

// ── 片 B：这一拍该干什么（含依赖顺序与上限转告警）────────────────────────────
const SVC = (id, extra = {}) => ({ id, name: id, port: 9000, deps: [], restart: { maxPerHour: 5, backoffMs: 5000 }, ...extra });

test('健康的服务：不产生任何动作', () => {
  const r = decideActions({ services: [SVC('a')], states: { a: { up: true } }, events: [], now: 1000 });
  assert.deepEqual(r, []);
});

test('挂了且没有历史：立刻 start', () => {
  const r = decideActions({ services: [SVC('a')], states: { a: { up: false } }, events: [], now: 1000 });
  assert.equal(r.length, 1);
  assert.equal(r[0].action, 'start');
  assert.equal(r[0].id, 'a');
});

test('刚拉过、退避没到：skip（不重复拉）', () => {
  const now = 1_000_000;
  const r = decideActions({
    services: [SVC('a')], states: { a: { up: false } },
    events: [{ id: 'a', action: 'start', at: now - 3_000 }], failures: { a: 1 }, now,
  });
  assert.equal(r[0].action, 'skip');
  assert.match(r[0].reason, /退避|等待/);
});

test('退避期过了：再 start', () => {
  const now = 1_000_000;
  const r = decideActions({
    services: [SVC('a')], states: { a: { up: false } },
    events: [{ id: 'a', action: 'start', at: now - 20_000 }], failures: { a: 1 }, now,   // 第 2 次要等 15s
  });
  assert.equal(r[0].action, 'start');
});

test('连续 3 次拉不起来：转 alert，不再硬拉', () => {
  const now = 1_000_000;
  const r = decideActions({
    services: [SVC('a')], states: { a: { up: false } },
    events: [{ id: 'a', action: 'start', at: now - 999_999 }], failures: { a: 3 }, now,
  });
  assert.equal(r[0].action, 'alert');
  assert.match(r[0].reason, /连续 3 次/);
});

test('一小时重启超上限：转 alert 并说明超限（不静默）', () => {
  const now = 10_000_000;
  const events = Array.from({ length: 5 }, (_, i) => ({ id: 'a', action: 'start', at: now - 60_000 * (i + 1) }));
  const r = decideActions({ services: [SVC('a')], states: { a: { up: false } }, events, failures: { a: 0 }, now });
  assert.equal(r[0].action, 'alert');
  assert.match(r[0].detail, /5 次\/小时|超过/);
});

test('按依赖顺序拉：被依赖的先 start', () => {
  const r = decideActions({
    services: [SVC('relay', { deps: ['bridge'] }), SVC('bridge')],
    states: { relay: { up: false }, bridge: { up: false } },
    events: [], now: 1000,
  });
  assert.deepEqual(r.map((x) => x.id), ['bridge', 'relay']);
  assert.ok(r.every((x) => x.action === 'start'));
});

test('依赖还活着：只拉下游', () => {
  const r = decideActions({
    services: [SVC('relay', { deps: ['bridge'] }), SVC('bridge')],
    states: { relay: { up: false }, bridge: { up: true } },
    events: [], now: 1000,
  });
  assert.deepEqual(r.map((x) => x.id), ['relay']);
});

// ── 片 C：注册表校验（services.json 是唯一真相，写错要当场炸）─────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry } from './supervisor-core.mjs';

function withRegistry(obj, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
  const file = path.join(dir, 'services.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('注册表：合法配置读得回来', () => {
  const r = withRegistry({ services: [SVC('workdesk', { port: 9340, cmd: ['node', 'x.mjs'], cwd: 'E:\\x' })] }, (f) => loadRegistry(f));
  assert.equal(r.services.length, 1);
  assert.equal(r.services[0].id, 'workdesk');
});

test('注册表：重复 id 拒绝（不能两个同名的抢锁）', () => {
  assert.throws(
    () => withRegistry({ services: [SVC('a', { cmd: ['node', 'x.mjs'] }), SVC('a', { cmd: ['node', 'y.mjs'] })] }, (f) => loadRegistry(f)),
    /重复/
  );
});

test('注册表：缺 cmd 或 cmd 不是数组 拒绝', () => {
  assert.throws(() => withRegistry({ services: [{ id: 'a', port: 1 }] }, (f) => loadRegistry(f)), /cmd/);
  assert.throws(() => withRegistry({ services: [{ id: 'a', port: 1, cmd: 'node x.mjs' }] }, (f) => loadRegistry(f)), /cmd/);
});

test('注册表：依赖指向不存在的服务 拒绝', () => {
  assert.throws(
    () => withRegistry({ services: [SVC('relay', { deps: ['nope'], cmd: ['node', 'x.mjs'] })] }, (f) => loadRegistry(f)),
    /依赖/
  );
});

test('注册表：端口非法 拒绝', () => {
  assert.throws(
    () => withRegistry({ services: [{ id: 'a', port: 'abc', cmd: ['node', 'x.mjs'] }] }, (f) => loadRegistry(f)),
    /端口/
  );
});

