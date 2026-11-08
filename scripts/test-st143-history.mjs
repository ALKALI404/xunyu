// scripts/test-st143-history.mjs —— ST-143 P1 单测（直接 require web\quiz-history.js，一份源码）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const H = require('E:\\DeepFish\\study\\web\\quiz-history.js')

test('humanTime：ISO 长串 → 11-07 07:07', () => {
  assert.equal(H.humanTime('2026-11-07T07:07:00+08:00'), '11-07 07:07')
})

test('humanTime 反例：空/非法给破折号，不显示 Invalid Date', () => {
  assert.equal(H.humanTime(null), '—')
  assert.equal(H.humanTime(''), '—')
  assert.equal(H.humanTime('不是时间'), '—')
})

test('verdictOf：三态带字带图标', () => {
  assert.equal(H.verdictOf('pass').text, '对')
  assert.equal(H.verdictOf('half').text, '半对')
  assert.equal(H.verdictOf('fail').text, '错')
})

test('verdictOf 反例：未知判定不冒充「对」', () => {
  assert.equal(H.verdictOf('weird').text, '未判')
  assert.equal(H.verdictOf(null).text, '未判')
})

test('sectionChip：四态 + 无题', () => {
  assert.equal(H.sectionChip({ status: 'done' }).text, '已通过')
  assert.equal(H.sectionChip({ status: 'learning' }).text, '在做')
  assert.equal(H.sectionChip({ status: 'rework' }).text, '待重做')
  assert.equal(H.sectionChip({ status: 'todo' }).text, '未作答')
  assert.equal(H.sectionChip({ questions: 0 }).text, '已读（无题）')
})

test('sectionChip 反例：没题的节不许挂「在做」', () => {
  assert.equal(H.sectionChip({ state: 'in_progress', noQuestion: true }).text, '已读（无题）')
  assert.equal(H.sectionChip({ status: 'learning', questions: 0 }).text, '已读（无题）')
  assert.equal(H.sectionChip({ noQuestion: true }).text, '已读（无题）')
})

test('sectionChip：/quiz/section/summary 的 state 口径也认（passed/in_progress/todo）', () => {
  assert.equal(H.sectionChip({ state: 'passed' }).text, '已通过')
  assert.equal(H.sectionChip({ state: 'in_progress' }).text, '在做')
  assert.equal(H.sectionChip({ state: 'rework' }).text, '待重做')
  assert.equal(H.sectionChip({ state: 'todo' }).text, '未作答')
})

test('sectionChip 反例：done=true 也算已通过，且 chip 里必须有字', () => {
  const c = H.sectionChip({ done: true })
  assert.equal(c.text, '已通过')
  assert.ok(c.text.length > 0)
})

test('chapterChip：全过 / 在做 n/m / 待重做 / 未作答', () => {
  assert.equal(H.chapterChip({ sections: [{ status: 'done', questions: 2 }, { status: 'done', questions: 1 }] }).text, '已通过')
  assert.equal(H.chapterChip({ sections: [{ status: 'done', questions: 2 }, { status: 'learning', questions: 1 }] }).text, '在做 1/2')
  assert.equal(H.chapterChip({ sections: [{ status: 'done', questions: 2 }, { status: 'rework', questions: 1 }] }).text, '待重做')
  assert.equal(H.chapterChip({ sections: [{ status: 'todo', questions: 2 }] }).text, '未作答')
})

test('chapterChip 反例：无题的节不参与分母', () => {
  const c = H.chapterChip({ sections: [{ status: 'done', questions: 2 }, { status: 'todo', questions: 0, read: true }] })
  assert.equal(c.text, '已通过')
})

test('foldAttempts：默认露 2 条，多的藏起来', () => {
  const r = H.foldAttempts([{ i: 3 }, { i: 2 }, { i: 1 }], 2)
  assert.equal(r.shown.length, 2)
  assert.equal(r.hiddenCount, 1)
  assert.equal(r.total, 3)
})

test('foldAttempts 反例：不超 2 条时不许冒出「展开」', () => {
  const r = H.foldAttempts([{ i: 1 }], 2)
  assert.equal(r.hiddenCount, 0)
})

test('foldAttempts：最多 20 条，超了标 capped', () => {
  const arr = Array.from({ length: 25 }, (_, i) => ({ i }))
  const r = H.foldAttempts(arr, 2)
  assert.equal(r.total, 25)
  assert.equal(r.shown.length + r.hiddenCount, 20)
  assert.equal(r.capped, true)
})

test('attemptTitle：第 N 次 + 判定 + 用过提示', () => {
  assert.equal(H.attemptTitle(1, 2, { verdict: 'half', usedHint: true }), '我的答案（第 2 次 · 半对 · 用过提示 · 最近）')
})

test('attemptTitle 反例：未知判定不写成「对」', () => {
  assert.match(H.attemptTitle(0, 1, {}), /未判/)
})

test('previousLine：已回答 n 次 · 最近：半对（时间）', () => {
  assert.equal(H.previousLine({ count: 2, lastVerdict: 'half', lastAt: '2026-11-07T07:07:00+08:00' }), '已回答 2 次 · 最近：半对（11-07 07:07）')
})

test('previousLine 反例：没做过就别显示"已回答 0 次"', () => {
  assert.equal(H.previousLine(null), '')
  assert.equal(H.previousLine({ count: 0 }), '')
})

test('displayOrder：最近的排最上面（后端是旧→新）', () => {
  const r = H.displayOrder([{ n: 1 }, { n: 2 }, { n: 3 }])
  assert.deepEqual(r.map((x) => x.n), [3, 2, 1])
})

test('displayOrder 反例：空/非数组不炸', () => {
  assert.deepEqual(H.displayOrder(null), [])
  assert.deepEqual(H.displayOrder([]), [])
})

test('missingText：漏点拼一行；没有就空串', () => {
  assert.equal(H.missingText({ missing: ['诉诸权威不算论证', '判据缺失'] }), '漏了：诉诸权威不算论证；判据缺失')
  assert.equal(H.missingText({}), '')
  assert.equal(H.missingText(null), '')
})
