// scripts/test-st136-book.mjs —— ST-136 P1 单测：直接从学习区页面里抠 ST-136-PURE 那段跑（一份源码，不抄第二份）
// 跑法：node --test scripts\test-st136-book.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const PAGE = 'E:\\DeepFish\\study\\web\\index.html'
const html = fs.readFileSync(PAGE, 'utf8')
const m = html.match(/\/\* ST-136-PURE-START[\s\S]*?ST-136-PURE-END \*\//)
assert.ok(m, '页面里找不到 ST-136-PURE 标记段')
const src = m[0]
const mod = new Function(src + '\nreturn { bookFileHref, viewTitle, cleanQueryForView, resolveBookId, VIEW_TITLES }')()

test('resolveBookId：书名 → book.id（括号书名也不许 400）', () => {
  const subs = [{ id: 'logic', name: '逻辑学', books: [{ id: 'logic-intro', title: '逻辑学导论（第15版）' }] }]
  assert.equal(mod.resolveBookId(subs, '逻辑学导论（第15版）'), 'logic-intro')
})

test('resolveBookId：带括号的串必须 encode 后才进 URL', () => {
  const subs = [{ id: 'logic', name: '逻辑学', books: [{ id: 'logic-intro', title: '逻辑学导论（第15版）' }] }]
  const id = mod.resolveBookId(subs, '逻辑学导论（第15版）')
  const href = mod.bookFileHref(id, '逻辑学导论（第15版）', 61)
  assert.ok(!href.includes('（'))
  assert.equal(href, '/book/file?id=logic-intro#page=61')
})

test('resolveBookId 反例：找不到就空串（不许拿书名凑）', () => {
  assert.equal(mod.resolveBookId([{ books: [{ id: 'x', title: '别的书' }] }], '逻辑学导论'), '')
  assert.equal(mod.resolveBookId(null, 'x'), '')
  assert.equal(mod.resolveBookId([], ''), '')
})

test('bookFileHref：优先 book.id', () => {
  assert.equal(mod.bookFileHref('logic-intro', '逻辑学导论', null), '/book/file?id=logic-intro')
})

test('bookFileHref：没有 id 才退回书名，且 encode', () => {
  assert.equal(mod.bookFileHref('', '逻辑学导论（第二版）', null), '/book/file?id=' + encodeURIComponent('逻辑学导论（第二版）'))
})

test('bookFileHref：带页码拼 #page=N', () => {
  assert.equal(mod.bookFileHref('logic-intro', null, 37), '/book/file?id=logic-intro#page=37')
})

test('bookFileHref 反例：页码非法（0/负数/NaN）不许拼 #page', () => {
  assert.equal(mod.bookFileHref('b', null, 0), '/book/file?id=b')
  assert.equal(mod.bookFileHref('b', null, -3), '/book/file?id=b')
  assert.equal(mod.bookFileHref('b', null, 'abc'), '/book/file?id=b')
})

test('bookFileHref 反例：id 和书名都空 → 空串（不许拼出 /book/file?id=）', () => {
  assert.equal(mod.bookFileHref('', '', null), '')
  assert.equal(mod.bookFileHref(null, undefined, 5), '')
})

test('viewTitle：首页必须是「学习区·概览」', () => {
  assert.equal(mod.viewTitle('home'), '学习区·概览')
})

test('viewTitle：错题/答题/分析/复习各有名字', () => {
  assert.equal(mod.viewTitle('wrong'), '学习区·错题')
  assert.equal(mod.viewTitle('quiz'), '学习区·答题')
  assert.equal(mod.viewTitle('analysis'), '学习区·分析')
  assert.equal(mod.viewTitle('review'), '学习区·复习')
})

test('viewTitle 反例：未知视图不给空标题', () => {
  assert.equal(mod.viewTitle('nope'), '学习区')
  assert.equal(mod.viewTitle(null), '学习区')
})

test('cleanQueryForView：回首页把所有书/章参数删干净', () => {
  const q = '?view=quiz&book=' + encodeURIComponent('逻辑学导论') + '&chapter=2&section=2.1&id=x&subject=logic'
  assert.equal(mod.cleanQueryForView(q, 'home'), '?view=home')
})

test('cleanQueryForView 反例：别的视图不误删参数', () => {
  const q = '?view=quiz&book=b&chapter=2'
  assert.equal(mod.cleanQueryForView(q, 'quiz'), q)
})

test('cleanQueryForView 反例：空 search 也能用', () => {
  assert.equal(mod.cleanQueryForView('', 'home'), '?view=home')
  assert.equal(mod.cleanQueryForView(null, 'wrong'), '')
})
