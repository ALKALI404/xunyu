// scripts/test-st139-shelf.mjs —— ST-139 P1 单测：直接 import web\shelf.js（一份源码）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const S = require('E:\\DeepFish\\study\\web\\shelf.js')

test('levelOf：后端给 level 也认（difficulty 优先）', () => {
  assert.equal(S.levelOf({ level: '进阶' }), '进阶')
  assert.equal(S.levelOf({ difficulty: '硬', level: '进阶' }), '硬')
  assert.equal(S.levelOf({}), '')
  assert.equal(S.levelOf(null), '')
})

test('难度排序：入门 → 进阶 → 硬', () => {
  const r = S.sortByDifficulty([{ title: 'c', level: '硬' }, { title: 'a', level: '入门' }, { title: 'b', difficulty: '进阶' }])
  assert.deepEqual(r.map((x) => x.title), ['a', 'b', 'c'])
})

test('难度排序反例：没标的排最后，不瞎猜', () => {
  const r = S.sortByDifficulty([{ title: 'x' }, { title: 'y', difficulty: '硬' }])
  assert.deepEqual(r.map((x) => x.title), ['y', 'x'])
  assert.equal(S.difficultyRank('随便'), 9)
  assert.equal(S.difficultyRank(null), 9)
})

test('难度标签：带字，不靠颜色；未知写「未标」', () => {
  assert.deepEqual(S.difficultyChip('入门'), { text: '入门', cls: 'diff diff-easy' })
  assert.deepEqual(S.difficultyChip('硬'), { text: '硬', cls: 'diff diff-hard' })
  assert.equal(S.difficultyChip('').text, '未标')
})

test('分区：每区先书后课，各自简→难', () => {
  const g = S.groupShelf([{ name: '逻辑学', books: [{ title: 'B', difficulty: '硬' }, { title: 'A', difficulty: '入门' }], courses: [{ title: '课2', difficulty: '硬' }, { title: '课1', difficulty: '入门' }] }])
  assert.equal(g.length, 1)
  assert.deepEqual(g[0].books.map((x) => x.title), ['A', 'B'])
  assert.deepEqual(g[0].courses.map((x) => x.title), ['课1', '课2'])
  assert.equal(g[0].bookN, 2)
  assert.equal(g[0].courseN, 2)
})

test('分区反例：空学科也留着（要显示空态）', () => {
  const g = S.groupShelf([{ name: '物理学', books: [], courses: [] }])
  assert.equal(g.length, 1)
  assert.equal(g[0].bookN + g[0].courseN, 0)
  assert.deepEqual(S.groupShelf(null), [])
})

test('上传校验：PDF 放行', () => {
  assert.equal(S.validateUpload({ name: '书.pdf', type: 'application/pdf', size: 1024 }).ok, true)
  assert.equal(S.validateUpload({ name: '书.PDF', type: '', size: 1024 }).ok, true)
})

test('上传校验反例：.txt 必须拦，并说清楚是"不是 PDF"', () => {
  const r = S.validateUpload({ name: '笔记.txt', type: 'text/plain', size: 10 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'not-pdf')
  assert.match(r.message, /PDF/)
})

test('上传校验反例：太大 / 没文件 / 没名字', () => {
  assert.equal(S.validateUpload({ name: 'a.pdf', type: 'application/pdf', size: 999 * 1024 * 1024 }).code, 'too-big')
  assert.equal(S.validateUpload(null).code, 'no-file')
  assert.equal(S.validateUpload({ name: '', type: 'application/pdf' }).code, 'no-name')
})

test('上传错误翻人话：重名要说"自动改名"', () => {
  assert.match(S.uploadErrorMessage({ code: 'dup', renamed: '书-2.pdf' }), /自动改名/)
  assert.match(S.uploadErrorMessage({ status: 500 }), /HTTP 500/)
  assert.match(S.uploadErrorMessage({ error: '磁盘满了' }), /磁盘满了/)
})

test('书链接：id 必须 encode；有页码才拼 #page', () => {
  assert.equal(S.bookHref({ id: 'logic-intro' }), '/book/file?id=logic-intro')
  assert.equal(S.bookHref({ id: 'a b', page: 61 }), '/book/file?id=a%20b#page=61')
  assert.equal(S.bookHref({ id: 'x', page: 0 }), '/book/file?id=x')
})

test('书链接反例：没 id 返回空串（不出 400 的链接）', () => {
  assert.equal(S.bookHref({ title: '只有书名' }), '')
  assert.equal(S.bookHref(null), '')
})
