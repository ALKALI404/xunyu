#!/usr/bin/env node
// scripts\test-qq-file-core.mjs —— WS-028 文件通道纯函数回归测试（开发规范 v1）
//
// 每个函数至少 1 正例 + 1 反例；路径白名单与扩展名黑名单是重点（反例优先）。
// 跑法：node --test scripts\test-qq-file-core.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveInside, checkExtension, checkSize, validateSend, uniqueName,
  bumpStatus, shapeStatus, shapeReceived, parseGatewaySend, pickFileSegments,
  MAX_BYTES, WARN_BYTES,
} from './qq-file-core.mjs';

const ROOT = 'E:/DSH_workspace/输出';
const recvRoot = 'E:/DSH_workspace/收件箱';

// ── resolveInside ───────────────────────────────────────────────────────────
test('resolveInside 正例：根内、根下的子目录、大小写混用都算在里面', () => {
  assert.equal(resolveInside(ROOT, 'E:\\DSH_workspace\\输出\\a.pdf').ok, true);
  assert.equal(resolveInside(ROOT, 'E:/DSH_workspace/输出/sub/b.txt').ok, true);
  assert.equal(resolveInside(ROOT, 'e:/dsh_workspace/输出/a.pdf').ok, true);
});
test('resolveInside 反例：`..` 越界、别的前缀、空路径一律拒', () => {
  assert.equal(resolveInside(ROOT, 'E:/DSH_workspace/输出/../secret.txt').code, 'path-outside');
  assert.equal(resolveInside(ROOT, 'C:/Windows/win.ini').code, 'path-outside');
  assert.equal(resolveInside(ROOT, 'E:/DSH_workspace/输出2/a.pdf').code, 'path-outside');   // 前缀骗术
  assert.equal(resolveInside(ROOT, '').code, 'path-outside');
});

// ── checkExtension ──────────────────────────────────────────────────────────
test('checkExtension 正例：pdf/zip/png 放行并给出扩展名', () => {
  assert.deepEqual(checkExtension('a.PDF'), { ok: true, ext: '.pdf' });
  assert.equal(checkExtension('打包.zip').ok, true);
  assert.equal(checkExtension('没有后缀').ext, '');
});
test('checkExtension 反例：九种禁发扩展名全拒（含大写）', () => {
  for (const name of ['a.exe', 'a.BAT', 'a.cmd', 'a.ps1', 'a.js', 'a.vbs', 'a.lnk', 'a.scr', 'a.msi']) {
    const r = checkExtension(name);
    assert.equal(r.ok, false, name);
    assert.equal(r.code, 'blocked-type');
  }
});

// ── checkSize ───────────────────────────────────────────────────────────────
test('checkSize 正例：小文件放行无提示；超 200MB 放行但给提示', () => {
  assert.deepEqual(checkSize(1024), { ok: true, warn: null });
  const r = checkSize(WARN_BYTES + 1);
  assert.equal(r.ok, true);
  assert.match(r.warn, /200 MB/);
});
test('checkSize 反例：超 4GB 拒、负数/NaN 拒', () => {
  assert.equal(checkSize(MAX_BYTES + 1).code, 'too-large');
  assert.equal(checkSize(-1).code, 'bad-size');
  assert.equal(checkSize(NaN).code, 'bad-size');
});

// ── validateSend（完整链路校验，statFn 注入假数据）───────────────────────────
test('validateSend 正例：合法文件返回绝对路径与体积', () => {
  const r = validateSend({
    roots: [ROOT], chatId: '2734856217', path: 'E:/DSH_workspace/输出/a.pdf',
    statFn: () => ({ isFile: true, size: 187000 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.size, 187000);
  assert.equal(r.chatId, '2734856217');
});
test('validateSend 反例：越界/禁发/超大/不是文件/坏 chatId 各有专属错误码', () => {
  const base = { roots: [ROOT], chatId: '2734856217', statFn: () => ({ isFile: true, size: 10 }) };
  assert.equal(validateSend({ ...base, path: 'C:/Windows/win.ini' }).code, 'path-outside');
  assert.equal(validateSend({ ...base, path: 'E:/DSH_workspace/输出/a.exe' }).code, 'blocked-type');
  assert.equal(validateSend({ ...base, path: 'E:/DSH_workspace/输出/a.pdf', statFn: () => ({ isFile: false }) }).code, 'not-found');
  assert.equal(validateSend({ ...base, path: 'E:/DSH_workspace/输出/a.pdf', statFn: () => ({ isFile: true, size: MAX_BYTES + 1 }) }).code, 'too-large');
  assert.equal(validateSend({ ...base, chatId: 'abc', path: 'E:/DSH_workspace/输出/a.pdf' }).code, 'bad-chat');
  assert.equal(validateSend({ ...base, chatId: '', path: 'E:/DSH_workspace/输出/a.pdf' }).code, 'bad-chat');
});

// ── uniqueName ──────────────────────────────────────────────────────────────
test('uniqueName 正例：重名依次加 -1 / -2，后缀位置正确', () => {
  assert.equal(uniqueName([], 'a.pdf'), 'a.pdf');
  assert.equal(uniqueName(['a.pdf'], 'a.pdf'), 'a-1.pdf');
  assert.equal(uniqueName(['a.pdf', 'a-1.pdf'], 'a.pdf'), 'a-2.pdf');
  assert.equal(uniqueName(['README'], 'README'), 'README-1');
});
test('uniqueName 反例：比较大小写不敏感，不会产出同名', () => {
  assert.equal(uniqueName(['A.PDF'], 'a.pdf'), 'a-1.pdf');
});

// ── bumpStatus ──────────────────────────────────────────────────────────────
test('bumpStatus 正例：发/收各记一笔，同日累加', () => {
  const t = Date.parse('2026-11-07T10:00:00Z');
  let d = bumpStatus(null, { kind: 'sent', at: t, name: 'a.pdf', fileId: 'F1' });
  d = bumpStatus(d, { kind: 'recv', at: t + 1000, name: 'b.pdf', sha256: 'abc' });
  assert.equal(d.sentToday, 1);
  assert.equal(d.recvToday, 1);
  assert.equal(d.lastAt, t + 1000);
  assert.equal(d.sent[0].fileId, 'F1');
  assert.equal(d.received[0].sha256, 'abc');
});
test('bumpStatus 反例：跨天清零、error 只记 lastError 不动计数', () => {
  const d1 = bumpStatus({ implemented: true, day: '2026-11-06', sentToday: 5, recvToday: 3 }, { kind: 'sent', at: Date.parse('2026-11-07T02:00:00Z') });
  assert.equal(d1.sentToday, 1);
  assert.equal(d1.recvToday, 0);
  const d2 = bumpStatus(d1, { kind: 'error', at: Date.now(), error: '网关 502' });
  assert.equal(d2.sentToday, d1.sentToday);
  assert.match(d2.lastError.text, /502/);
});

// ── shapeStatus / shapeReceived ─────────────────────────────────────────────
test('shapeStatus 正例：implemented:true 才 ok', () => {
  const s = shapeStatus({ implemented: true, sentToday: 2, recvToday: 1, lastAt: 5 });
  assert.equal(s.ok, true);
  assert.equal(s.sentToday, 2);
});
test('shapeStatus 反例：没这个文件（null）时不 ok、计数为 0', () => {
  const s = shapeStatus(null);
  assert.equal(s.ok, false);
  assert.equal(s.implemented, false);
  assert.equal(s.sentToday, 0);
});
test('shapeReceived 正例：倒序 + 限制条数 + 字段改名（name → id/savedAs）', () => {
  const doc = { received: [{ name: 'a.pdf', at: 1 }, { name: 'b.pdf', at: 2 }] };
  const r = shapeReceived(doc, 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'b.pdf');
  assert.equal(r[0].savedAs, 'b.pdf');
  assert.equal(r[0].id, 'b.pdf');
});
test('shapeReceived 反例：空/坏文档返回空数组，不抛', () => {
  assert.deepEqual(shapeReceived(null), []);
  assert.deepEqual(shapeReceived({ received: 'nope' }), []);
});

// ── parseGatewaySend ────────────────────────────────────────────────────────
test('parseGatewaySend 正例：OneBot 标准回包取 file_id', () => {
  assert.deepEqual(parseGatewaySend({ status: 'ok', retcode: 0, data: { file_id: 'ABC' } }), { ok: true, fileId: 'ABC' });
  assert.equal(parseGatewaySend({ status: 'ok', retcode: 0, data: {} }).fileId, null);
});
test('parseGatewaySend 反例：200+ok:false 的软失败、retcode≠0、非 JSON 都算失败且带原因', () => {
  assert.match(parseGatewaySend({ ok: false, error: '群不存在' }).error, /群不存在/);
  assert.match(parseGatewaySend({ status: 'failed', retcode: 1200, message: '文件太大' }).error, /文件太大/);
  assert.match(parseGatewaySend(null, 502).error, /HTTP 502/);
});

// ── pickFileSegments ────────────────────────────────────────────────────────
test('pickFileSegments 正例：从消息段里挑出文件（带 id/名/大小）', () => {
  const segs = [{ type: 'text', data: { text: 'hi' } }, { type: 'file', data: { file_id: 'X1', file_name: 'a.pdf', file_size: 12 } }];
  const r = pickFileSegments(segs);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { fileId: 'X1', name: 'a.pdf', bytes: 12, url: null });
});
test('pickFileSegments 反例：没有文件段 / 文件段没 id 也没 url → 空数组', () => {
  assert.deepEqual(pickFileSegments([{ type: 'text', data: { text: 'x' } }]), []);
  assert.deepEqual(pickFileSegments([{ type: 'file', data: { file_name: 'a.pdf' } }]), []);
  assert.deepEqual(pickFileSegments(null), []);
});

// 收件根也走同一套：确认收件箱能作为独立 root 用（WS-028 收侧）
test('resolveInside：收件箱与输出是两个独立根，互不相通', () => {
  assert.equal(resolveInside(recvRoot, 'E:/DSH_workspace/收件箱/x.pdf').ok, true);
  assert.equal(resolveInside(recvRoot, 'E:/DSH_workspace/输出/x.pdf').ok, false);
});
