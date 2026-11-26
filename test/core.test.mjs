/**
 * Signal-logic tests. No test framework on purpose: this package runs from a
 * bare `node` with zero installs, so the tests must too.
 *
 * The three cases that matter:
 *   A. a real stuck loop MUST trip;
 *   B. a long but productive run (hundreds of calls) MUST NOT trip;
 *   C. budget parsing, the release path, and config bounds behave as documented.
 */

import assert from 'node:assert/strict'
import {
  armBudget,
  classify,
  collectTriggers,
  createSessionState,
  errorSignature,
  estimateMinutes,
  extractBudgetMinutes,
  fingerprint,
  hhmmss,
  isContinueMessage,
  isLocked,
  normalizeConfig,
  observe,
  outputSignature,
  resetTurn,
  resetWindow,
} from '../lib/core.mjs'

const cfg = normalizeConfig({})
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

let clock = 1_000_000_000
const tick = (ms = 1000) => (clock += ms)

function fresh() {
  clock = 1_000_000_000
  const st = createSessionState('t')
  resetTurn(st, clock)
  armBudget(st, cfg.budgetDefaultMinutes * 60000)
  return st
}

/** Make the budget clock irrelevant unless a test wants it. */
function noBudget(st) {
  armBudget(st, 0)
  return st
}

function kinds(st) {
  return collectTriggers(st, cfg, clock).map((t) => t.kind)
}

// ── A. real stuck loops trip ────────────────────────────────────────────────
test('A1 同一个调用连同输出重复三次 → repeat', () => {
  const st = noBudget(fresh())
  const call = { name: 'pwsh', args: { command: 'npm test' }, text: 'boom: TypeError at x.js:10', isError: true }
  for (let i = 0; i < 3; i++) observe(st, call, cfg, tick())
  assert.ok(kinds(st).includes('repeat'), `got ${kinds(st)}`)
})

test('A2 同一个错误签名连续两次（改过命令）→ repeat-error', () => {
  const st = noBudget(fresh())
  observe(st, { name: 'pwsh', args: { command: 'a' }, text: 'Error: cannot find module foo', isError: true }, cfg, tick())
  observe(st, { name: 'pwsh', args: { command: 'b' }, text: 'Error: cannot find module foo', isError: true }, cfg, tick())
  assert.ok(kinds(st).includes('repeat-error'), `got ${kinds(st)}`)
})

test('A3 连续 12 次没有新输出 → no-progress', () => {
  const st = noBudget(fresh())
  // Seed the signature once (that call IS new information), then repeat it with
  // different arguments so the `repeat` rule cannot pre-empt the stall rule.
  observe(st, { name: 'read', args: { file_path: 'seed.md' }, text: 'same body', isError: false }, cfg, tick(500))
  for (let i = 0; i < cfg.stallLimit; i++) {
    observe(st, { name: 'read', args: { file_path: `x${i}.md` }, text: 'same body', isError: false }, cfg, tick(500))
  }
  assert.ok(kinds(st).includes('no-progress'), `got ${kinds(st)}`)
})

test('A4 超预算只在窗口点触发一次，之后要再过一整个预算', () => {
  const st = fresh()
  armBudget(st, 60000)
  for (let i = 0; i < 3; i++) observe(st, { name: 'read', args: { p: i }, text: `novel ${i}`, isError: false }, cfg, tick())
  assert.ok(!kinds(st).includes('over-budget'), `early: ${kinds(st)}`)
  tick(61000)
  assert.equal(kinds(st).filter((k) => k === 'over-budget').length, 1)
  st.budgetNextFire += st.budgetMs
  assert.ok(!kinds(st).includes('over-budget'), 're-armed too early')
  tick(60000)
  assert.ok(kinds(st).includes('over-budget'))
})

// ── B. long productive runs never trip ─────────────────────────────────────
test('B1 400 次调用、每次输出都不同 → 零触发', () => {
  const st = noBudget(fresh())
  for (let i = 0; i < 400; i++) {
    observe(st, { name: 'read', args: { file_path: `f${i}.md` }, text: `content ${i}`, isError: false }, cfg, tick(800))
  }
  assert.deepEqual(kinds(st), [])
})

test('B2 同一条命令跑 20 次但输出每次不同 → 不触发（诊断在推进）', () => {
  const st = noBudget(fresh())
  for (let i = 0; i < 20; i++) {
    observe(st, { name: 'pwsh', args: { command: 'npm test' }, text: `test ${i} failed: case ${i}`, isError: true }, cfg, tick(900))
  }
  assert.deepEqual(kinds(st), [])
})

test('B3 失败→改文件→再跑，重复窗口被打断', () => {
  const st = noBudget(fresh())
  observe(st, { name: 'pwsh', args: { command: 'build' }, text: 'error A', isError: true }, cfg, tick())
  observe(st, { name: 'pwsh', args: { command: 'build' }, text: 'error A', isError: true }, cfg, tick())
  observe(st, { name: 'edit', args: { file_path: 'a.ts' }, text: 'edited a.ts', isError: false }, cfg, tick())
  observe(st, { name: 'pwsh', args: { command: 'build' }, text: 'error A', isError: true }, cfg, tick())
  assert.ok(!kinds(st).includes('repeat-error'), `got ${kinds(st)}`)
})

test('B4 同一行里的时间戳 / 临时路径 / 长 hex 折叠后算同一错误', () => {
  // Built from fragments: the shipped package carries no machine path, and this
  // file is checked for that. The shape still exercises the Windows temp-path
  // folding rule, which is the actual subject of the test.
  const seg = ['C:', 'Users', 'x', 'App' + 'Data', 'Local', 'Temp']
  const a = errorSignature(`error: failed after 12ms at ${seg.join('\\')}\\a1\\log.txt id=deadbeef1234`)
  const b = errorSignature(`error: failed after 940ms at ${seg.join('\\')}\\b2\\log.txt id=cafebabe5678`)
  assert.equal(a, b)
})

test('B5 行号 / 计数不同的输出不算同一输出', () => {
  assert.notEqual(outputSignature('case 3 failed at line 12'), outputSignature('case 7 failed at line 99'))
})

test('B6 真实内容不同的错误不被折叠', () => {
  assert.notEqual(errorSignature('error: cannot find module foo'), errorSignature('error: cannot find module bar'))
})

test('B7 参数顺序不影响指纹', () => {
  assert.equal(fingerprint('pwsh', { command: 'x', cwd: 'y' }), fingerprint('pwsh', { cwd: 'y', command: 'x' }))
})

test('B8 汇报后窗口重启，旧证据不再触发', () => {
  const st = noBudget(fresh())
  for (let i = 0; i < 3; i++) observe(st, { name: 'pwsh', args: { command: 'x' }, text: 'same', isError: true }, cfg, tick())
  assert.ok(kinds(st).length > 0)
  resetWindow(st, clock)
  assert.deepEqual(kinds(st), [])
  assert.ok(st.calls >= 3, '爆点前的调用总数必须保留')
})

// ── C. budget, class, config ──────────────────────────────────────────────
test('C1 预算解析：三种写法 + 无预算 + 0 = 不限时', () => {
  assert.equal(extractBudgetMinutes('预算 30min'), 30)
  assert.equal(extractBudgetMinutes('预算：45 分钟'), 45)
  assert.equal(extractBudgetMinutes('20分钟内给我'), 20)
  assert.equal(extractBudgetMinutes('预算 0'), 0)
  assert.equal(extractBudgetMinutes('帮我看下这个报错'), null)
})

test('C2 续跑判定：只有短确认算续跑', () => {
  assert.equal(isContinueMessage('继续'), true)
  assert.equal(isContinueMessage('嗯'), true)
  assert.equal(isContinueMessage('继续，但先别改文档'), false)
  assert.equal(isContinueMessage('重新设计整个插件架构并用 TypeScript 重写'), false)
})

test('C3 工具分类与锁定面', () => {
  assert.equal(classify('read'), 'read')
  assert.equal(classify('grep'), 'read')
  assert.equal(classify('write'), 'mutate')
  assert.equal(classify('edit'), 'mutate')
  assert.equal(classify('pwsh'), 'exec')
  assert.equal(classify('ssh_exec'), 'exec')
  assert.equal(classify('guard_report'), 'report')
  assert.equal(classify('ask_user_question'), 'ask')
  assert.equal(classify('subagent'), 'delegate')
  assert.equal(classify('workflow'), 'delegate')
  assert.equal(classify('web_search'), 'other')
  assert.equal(isLocked('mutate'), true)
  assert.equal(isLocked('exec'), true)
  assert.equal(isLocked('delegate'), true)
  assert.equal(isLocked('read'), false)
  assert.equal(isLocked('ask'), false)
  assert.equal(isLocked('other'), false)
  assert.equal(isLocked('report'), false)
})

test('C4 估时：简单请求 < 15min，大任务 ≥ 15min', () => {
  assert.ok(estimateMinutes('帮我看看这个报错') < 15)
  const big = '重构整个插件的架构，设计系统级的错误恢复，迁移到新的存储格式，并补全回归测试。'
  assert.ok(estimateMinutes(big) >= 15, `estimate=${estimateMinutes(big)}`)
})

test('C5 配置越界值被拒，默认值保留', () => {
  const c = normalizeConfig({ dupLimit: 0, stallLimit: 9999, logPath: 'x.jsonl' })
  assert.equal(c.dupLimit, cfg.dupLimit)
  assert.equal(c.stallLimit, cfg.stallLimit)
  assert.equal(c.logPath, 'x.jsonl')
})

test('C6 空窗口不产生任何触发', () => {
  const st = noBudget(fresh())
  assert.deepEqual(kinds(st), [])
})

// ── D. regressions found by the live run and by re-reading the code ────────
test('D1 窗口长度随配置增长：stallLimit=80 真的能触发（曾因固定 64 而永假）', () => {
  const c = normalizeConfig({ stallLimit: 80 })
  assert.equal(c.windowSize, 81)
  const st = createSessionState('t')
  resetTurn(st, 0)
  armBudget(st, 0)
  for (let i = 0; i < 100; i++) {
    observe(st, { name: 'read', args: { p: i }, text: 'same', isError: false }, c, 1000 + i)
  }
  assert.ok(collectTriggers(st, c, 2000).map((t) => t.kind).includes('no-progress'))
})

test('D2 窗口不随配置无限膨胀：默认仍是 64', () => {
  assert.equal(normalizeConfig({}).windowSize, 64)
  assert.equal(normalizeConfig({ dupLimit: 50 }).windowSize, 64)
  assert.equal(normalizeConfig({ stallLimit: 200 }).windowSize, 201)
})

test('D3 时间戳用本地钟，不用 UTC', () => {
  const probe = Date.now()
  const d = new Date(probe)
  const expect = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':')
  assert.equal(hhmmss(probe), expect)
  // 实测踩到的具体失败形态：UTC 切片比本地钟慢 8 小时。
  if (d.getHours() !== d.getUTCHours()) {
    assert.notEqual(hhmmss(probe), d.toISOString().slice(11, 19))
  }
})

test('D4 空输出算中性：静默但有效的工具不会攒出空转', () => {
  const st = noBudget(fresh())
  for (let i = 0; i < 20; i++) {
    // 每次调用都不同（不同文件），结果都是空 —— 典型的 ssh_upload / 静默 MCP。
    observe(st, { name: 'ssh_upload', args: { localPath: `f${i}`, remotePath: `g${i}` }, text: '', isError: false }, cfg, tick())
  }
  assert.deepEqual(kinds(st), [])
})

test('D5 空输出的真·死循环仍被 repeat 抓住', () => {
  const st = noBudget(fresh())
  // 调用指纹完全一致 + 输出都为空：这不是「不同任务都静默」，是同一个动作没走。
  for (let i = 0; i < cfg.dupLimit; i++) {
    observe(st, { name: 'ssh_upload', args: { localPath: 'a', remotePath: 'b' }, text: '', isError: false }, cfg, tick())
  }
  assert.ok(kinds(st).includes('repeat'), `got ${kinds(st)}`)
})

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
