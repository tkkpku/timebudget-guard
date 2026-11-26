/**
 * Message-table parity test.
 *
 * The two locale tables must define the same fields with the same arity: a
 * missing key in `zh` would throw only when a Chinese user happened to trip that
 * one branch, which is the worst possible time to find out.
 *
 * The last case is a leak check: this package ships publicly, so no local path,
 * host name, or private nickname may survive in the shipped source.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TABLES, REQUIRED_FIELDS, messages } from '../lib/messages.mjs'

let pass = 0
const failures = []

function test(title, body) {
  try {
    body()
    pass++
    console.log(`ok   ${title}`)
  } catch (error) {
    failures.push({ title, error })
    console.log(`FAIL ${title}: ${error.message}`)
  }
}

test('1 两种语言的字段集合完全一致', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    assert.deepEqual(Object.keys(table).sort(), [...REQUIRED_FIELDS].sort(), `${name} 字段集合不一致`)
  }
})

test('2 每个字段的函数参数个数一致', () => {
  for (const key of REQUIRED_FIELDS) {
    const ref = TABLES.en[key]
    for (const [name, table] of Object.entries(TABLES)) {
      const fn = table[key]
      assert.equal(typeof fn, typeof ref, `${name}.${key} 类型不一致`)
      if (typeof ref === 'function') {
        assert.equal(fn.length, ref.length, `${name}.${key} 参数个数不一致（${fn.length} vs ${ref.length}）`)
      }
    }
  }
})

test('3 triggerLabel 覆盖全部触发类型', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    for (const kind of ['repeat', 'repeat-error', 'no-progress', 'over-budget']) {
      assert.ok(table.triggerLabel[kind], `${name}.triggerLabel 缺 ${kind}`)
    }
  }
})

test('4 未知 locale 回落到英文而不是抛错', () => {
  assert.equal(messages('fr'), TABLES.en)
  assert.equal(messages(undefined), TABLES.en)
  assert.equal(messages(''), TABLES.en)
})

test('5 locale 大小写不敏感', () => {
  assert.equal(messages('ZH'), TABLES.zh)
  assert.equal(messages('Zh'), TABLES.zh)
})

test('6 源码里不残留本机路径或私有称呼', () => {
  const files = [
    '../lib/core.mjs',
    '../lib/messages.mjs',
    '../lib/index.mjs',
    '../hooks/hook.mjs',
    '../test/core.test.mjs',
    '../test/integration.test.mjs',
    '../test/hook.test.mjs',
    '../test/scenarios.mjs',
  ]
  // Built from fragments so this very file does not match itself.
  const patterns = [
    new RegExp('tan' + '83', 'i'),
    new RegExp('Desk' + 'top\\\\\\\\codex', 'i'),
    new RegExp('App' + 'Data', 'i'),
    new RegExp('少' + '爷'),
    new RegExp('北大', 'i'),
  ]
  for (const rel of files) {
    const path = fileURLToPath(new URL(rel, import.meta.url))
    const text = readFileSync(path, 'utf8')
    for (const re of patterns) {
      assert.doesNotMatch(text, re, `${rel} 仍含本机信息：${re}`)
    }
  }
})

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
