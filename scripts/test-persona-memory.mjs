// WS-032 的测试（先写、先跑红，再写实现）。
// 口径全部对着任务书：sha8=内容 sha256 前 8 位、chars=去空白字数、chapters=二级标题数、lines=行数。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const mod = await import('./persona-memory.mjs').catch(() => ({}));
const missing = !mod.readPersona && !mod.buildSnapshot;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws032-'));
  const roles = path.join(root, 'roles');
  const memory = path.join(root, 'memory');
  const inbox = path.join(memory, 'inbox');
  const distill = path.join(memory, 'distill');
  for (const d of [roles, memory, inbox, distill]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(roles, '鲟鱼.md'), '# 鲟鱼\n\n## 我是谁\n一条鱼。\n\n## 说话\n短一点。\n', 'utf8');
  fs.writeFileSync(path.join(memory, 'long-term.md'), '# 长期\n\n## 甲\nx\n\n## 乙\ny\n', 'utf8');
  fs.writeFileSync(path.join(distill, '2026-11-06.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(distill, '2026-11-07.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(inbox, 'qq-2026-11-07.jsonl'), '{"a":1}\n{"a":2}\n', 'utf8');
  return { root, roles, memory, inbox, distill };
}

test('WS-032 契约：模块导出接口', () => {
  assert.equal(missing, false, 'persona-memory.mjs 应导出 readPersona/readMemory/buildSnapshot');
});

test('① 人设：路径/mtime/chars/sha8/title 齐全，all 只含存在的文件', { skip: missing }, () => {
  const f = fixture();
  const r = mod.readPersona({ rolesDir: f.roles, names: ['鲟鱼.md', '保单助理.md'] });
  assert.equal(r.ok, true);
  assert.equal(r.primary.path, path.join(f.roles, '鲟鱼.md'));
  assert.equal(r.primary.title, '鲟鱼', 'title 取一级标题');
  assert.equal(r.primary.chars, '#鲟鱼##我是谁一条鱼。##说话短一点。'.length, 'chars = 去空白字数（保留 #）');
  assert.match(r.primary.sha8, /^[0-9a-f]{8}$/);
  assert.equal(r.primary.sha8, crypto.createHash('sha256').update(fs.readFileSync(r.primary.path)).digest('hex').slice(0, 8));
  assert.equal(typeof r.primary.mtime, 'number');
  assert.equal(r.all.length, 1, '保单助理.md 不存在，不进 all');
  assert.equal(r.all[0].path, r.primary.path);
  assert.equal(JSON.stringify(r).includes('一条鱼'), false, '不许回正文');
});

test('④ 改一个字符 → sha8 变', { skip: missing }, () => {
  const f = fixture();
  const before = mod.readPersona({ rolesDir: f.roles, names: ['鲟鱼.md'] }).primary.sha8;
  fs.appendFileSync(path.join(f.roles, '鲟鱼.md'), '!', 'utf8');
  const after = mod.readPersona({ rolesDir: f.roles, names: ['鲟鱼.md'] }).primary.sha8;
  assert.notEqual(before, after);
  assert.equal(after, crypto.createHash('sha256').update(fs.readFileSync(path.join(f.roles, '鲟鱼.md'))).digest('hex').slice(0, 8));
});

test('③ 人设读不到 → ok:false + 人话（不是静默空着）', { skip: missing }, () => {
  const f = fixture();
  fs.rmSync(path.join(f.roles, '鲟鱼.md'));
  const r = mod.readPersona({ rolesDir: f.roles, names: ['鲟鱼.md'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /鲟鱼\.md/);
  assert.match(r.reason, /不存在|读不到/);
});

test('② 记忆：longTerm 字数/章节、distill 最新日期与份数、QQ 记事行数', { skip: missing }, () => {
  const f = fixture();
  const r = mod.readMemory({ memoryDir: f.memory, inboxDir: f.inbox, distillDir: f.distill });
  assert.equal(r.ok, true);
  assert.equal(r.longTerm.path, path.join(f.memory, 'long-term.md'));
  assert.equal(r.longTerm.chars, '#长期##甲x##乙y'.length, 'chars = 去空白字数');
  assert.equal(r.longTerm.chapters, 2, '二级标题数');
  assert.equal(r.distill.latestDate, '2026-11-07');
  assert.equal(r.distill.count, 2);
  assert.equal(r.notebooks.qq.lines, 2);
  assert.equal(r.notebooks.qq.path.endsWith('qq-2026-11-07.jsonl'), true);
  assert.equal(typeof r.notebooks.qq.lastAt, 'number');
  assert.equal(r.notebooks.window.lines, 0, '窗口记事本还没有源：给 0 并说明，不报错');
  assert.match(r.notebooks.window.missing, /win-/);
  assert.equal(JSON.stringify(r).includes('一条鱼'), false);
});

test('②b 长期记忆缺失 → ok:false 且指出路径', { skip: missing }, () => {
  const f = fixture();
  fs.rmSync(path.join(f.memory, 'long-term.md'));
  const r = mod.readMemory({ memoryDir: f.memory, inboxDir: f.inbox, distillDir: f.distill });
  assert.equal(r.ok, false);
  assert.match(r.reason, /long-term\.md/);
});

test('HTTP 形状：handlePersonaMemory 只认这两条路由，其余返回 null', { skip: missing }, async () => {
  const f = fixture();
  const env = { rolesDir: f.roles, memoryDir: f.memory, inboxDir: f.inbox, distillDir: f.distill, names: ['鲟鱼.md'] };
  const a = await mod.handlePersonaMemory({ route: '/api/persona', url: new URL('http://x/api/persona'), env });
  assert.equal(a.status, 200);
  assert.equal(a.body.ok, true);
  assert.equal(typeof a.body.primary.sha8, 'string');
  const b = await mod.handlePersonaMemory({ route: '/api/memory', url: new URL('http://x/api/memory'), env });
  assert.equal(b.body.distill.latestDate, '2026-11-07');
  const c = await mod.handlePersonaMemory({ route: '/api/other', url: new URL('http://x/api/other'), env });
  assert.equal(c, null);
});

test('规范 v1：源读不到必须是 5xx，不许 200 + ok:false', { skip: missing }, async () => {
  const f = fixture();
  fs.rmSync(path.join(f.roles, '鲟鱼.md'));
  const env = { rolesDir: f.roles, memoryDir: f.memory, inboxDir: f.inbox, distillDir: f.distill, names: ['鲟鱼.md'] };
  const a = await mod.handlePersonaMemory({ route: '/api/persona', url: new URL('http://x/api/persona'), env });
  assert.equal(a.status, 503);
  assert.equal(a.body.ok, false);
  assert.match(a.body.reason, /鲟鱼\.md/);
  fs.rmSync(path.join(f.memory, 'long-term.md'));
  const b = await mod.handlePersonaMemory({ route: '/api/memory', url: new URL('http://x/api/memory'), env });
  assert.equal(b.status, 503);
  assert.equal(b.body.ok, false);
});

test('性能：单次快照 < 50ms（不许全量扫 memory）', { skip: missing }, () => {
  const f = fixture();
  const t0 = performance.now();
  mod.readMemory({ memoryDir: f.memory, inboxDir: f.inbox, distillDir: f.distill });
  assert.ok(performance.now() - t0 < 50);
});
