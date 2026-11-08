// scripts/test-console-view.mjs —— WS-030 P1 单测（node:test，零依赖）
// 跑法：node --test scripts/test-console-view.mjs      或  node scripts/test-console-view.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  rollupChecks, filterLogLines, tailLogLines, maskToken,
  mergeSettingsPatch, pickBridgePatch, bridgeLight, agoText, portStateFromProbe,
} from './lib/console-view.mjs'

test('rollupChecks：全过 = 绿', () => {
  const r = rollupChecks([{ name: 'a', ok: true }, { name: 'b', ok: true }])
  assert.equal(r.level, 'ok')
  assert.equal(r.okCount, 2)
  assert.equal(r.total, 2)
})

test('rollupChecks 反例：关键项(services)挂了 = 红，不是黄', () => {
  const r = rollupChecks([{ name: 'services', ok: false }, { name: 'a', ok: true }])
  assert.equal(r.level, 'bad')
  assert.equal(r.icon, '✖')
})

test('rollupChecks：非关键项挂 = 黄', () => {
  const r = rollupChecks([{ name: 'services', ok: true }, { name: 'qq-bridge', ok: false }])
  assert.equal(r.level, 'warn')
  assert.equal(r.icon, '△')
})

test('rollupChecks 反例：空数据不当全好', () => {
  assert.equal(rollupChecks([]).level, 'bad')
  assert.equal(rollupChecks(null).total, 0)
})

test('filterLogLines：关键字不分大小写', () => {
  const lines = [{ level: 'info', text: 'Hello World' }, { level: 'info', text: 'other' }]
  assert.equal(filterLogLines(lines, { keyword: 'hello' }).length, 1)
})

test('filterLogLines 反例：仅异常时普通行必须被滤掉', () => {
  const lines = [
    { level: 'info', text: 'all good' },
    { level: 'error', text: 'boom' },
    { level: 'info', text: '连不上 127.0.0.1' },
  ]
  const r = filterLogLines(lines, { onlyError: true })
  assert.equal(r.length, 2)          // error 行 + 文本含"连不上"的行
  assert.ok(r.every((l) => l.level === 'error' || /连不上|fail|error/i.test(l.text)))
})

test('filterLogLines：空入参不炸', () => {
  assert.deepEqual(filterLogLines(null, { keyword: 'x' }), [])
  assert.deepEqual(filterLogLines([], {}), [])
})

test('tailLogLines：返回最后 n 行并标截断', () => {
  const lines = [1, 2, 3, 4, 5].map((i) => ({ text: 'L' + i }))
  const r = tailLogLines(lines, 2)
  assert.deepEqual(r.lines.map((l) => l.text), ['L4', 'L5'])
  assert.equal(r.truncated, true)
})

test('tailLogLines 反例：行数不足时不许标截断', () => {
  const r = tailLogLines([{ text: 'a' }], 10)
  assert.equal(r.truncated, false)
  assert.equal(r.lines.length, 1)
})

test('tailLogLines：非法 n 退回 200', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ text: 'x' + i }))
  assert.equal(tailLogLines(many, 0).lines.length, 200)
  assert.equal(tailLogLines(many, 'abc').lines.length, 200)
})

test('maskToken：只露头2尾3', () => {
  assert.equal(maskToken('sk-abcdefghijkWdbR'), 'sk…dbR')
})

test('maskToken 反例：短串必须全掩（不许露出全部）', () => {
  assert.equal(maskToken('abc'), '…')
  assert.equal(maskToken('12345678'), '…')
  assert.equal(maskToken(''), '—')
  assert.equal(maskToken(null), '—')
  assert.ok(!maskToken('12345678').includes('1234'))
})

test('mergeSettingsPatch：空 key 不覆盖（关键安全项）', () => {
  const p = mergeSettingsPatch({ model: { key: '   ', name: 'deepseek-flash' } }, { model: { keyMasked: 'sk…x' } })
  assert.equal(p.model.key, undefined)
  assert.equal(p.model.name, 'deepseek-flash')
})

test('mergeSettingsPatch 反例：填了 key 才带上', () => {
  const p = mergeSettingsPatch({ model: { key: 'sk-new' } }, {})
  assert.equal(p.model.key, 'sk-new')
})

test('mergeSettingsPatch：空表单 = 空补丁（别拿旧值硬写）', () => {
  assert.deepEqual(mergeSettingsPatch({}, {}), {})
  assert.deepEqual(mergeSettingsPatch(null, null), {})
})

test('mergeSettingsPatch：采样数字转数字、非法值丢弃、deepThink 转布尔', () => {
  const p = mergeSettingsPatch({ sampling: { temperature: '0.3', maxTokens: '', freqPenalty: 'x', deepThink: 1 } }, {})
  assert.equal(p.sampling.temperature, 0.3)
  assert.equal(p.sampling.maxTokens, undefined)
  assert.equal(p.sampling.freqPenalty, undefined)
  assert.equal(p.sampling.deepThink, true)
})

test('pickBridgePatch：只留五个白名单字段', () => {
  const p = pickBridgePatch({ sendDelayMs: 100, allow: ['1'], deny: [], ackMessage: 'ok', questionTimeoutMs: 5000, evil: 1, token: 'x' })
  assert.deepEqual(Object.keys(p).sort(), ['ackMessage', 'allow', 'deny', 'questionTimeoutMs', 'sendDelayMs'])
  assert.equal(p.evil, undefined)
  assert.equal(p.token, undefined)
})

test('pickBridgePatch 反例：全非法 → 空对象', () => {
  assert.deepEqual(pickBridgePatch({ token: 'x', secret: 'y' }), {})
  assert.deepEqual(pickBridgePatch(null), {})
})

test('bridgeLight：离线红 / 未绑黄 / 正常绿', () => {
  assert.equal(bridgeLight({ up: false }).level, 'bad')
  assert.equal(bridgeLight({ up: true, sessionBound: 0 }).level, 'warn')
  assert.equal(bridgeLight({ up: true, sessionBound: 2 }).level, 'ok')
})

test('bridgeLight 反例：缺字段不崩，按离线算', () => {
  assert.equal(bridgeLight(null).level, 'bad')
  assert.equal(bridgeLight({}).level, 'bad')
})

test('agoText：毫秒/秒/分/时', () => {
  assert.equal(agoText(0), '0 ms')
  assert.equal(agoText(1500), '2 秒')
  assert.equal(agoText(120000), '2 分')
  assert.equal(agoText(7200000), '2 小时')
})

test('agoText 反例：负值/NaN 给破折号，不显示负数', () => {
  assert.equal(agoText(-5), '—')
  assert.equal(agoText(NaN), '—')
  assert.equal(agoText(undefined), '—')
})

test('portStateFromProbe：resolve = 活着', () => {
  assert.equal(portStateFromProbe({ ok: true, ms: 3 }), 'up')
})

test('portStateFromProbe：401 卡到超时(abort) 也算活着（连接被接受了）', () => {
  assert.equal(portStateFromProbe({ ok: false, ms: 2003, err: 'abort' }, 2000), 'up')
})

test('portStateFromProbe 反例：端口秒拒 = 死了', () => {
  assert.equal(portStateFromProbe({ ok: false, ms: 2, err: 'TypeError: Failed to fetch' }, 2000), 'down')
})

test('portStateFromProbe 反例：很快就 abort（不是超时）不算活着', () => {
  assert.equal(portStateFromProbe({ ok: false, ms: 120, err: 'abort' }, 2000), 'down')
})

test('portStateFromProbe 反例：空输入按死处理', () => {
  assert.equal(portStateFromProbe(null), 'down')
  assert.equal(portStateFromProbe({}), 'down')
})
