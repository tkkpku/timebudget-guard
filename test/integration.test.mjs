/**
 * Integration test: drives the real native plugin through a fake Cordis context.
 *
 * This is the test that matters — it proves the wiring (which listener touches
 * which state, in which order) rather than the pure signal logic. Every case
 * mounts with `locale: 'zh'` so the Chinese assertions also prove the locale
 * plumbing end to end.
 *
 *   1. a real user message opens a window; a small task asks for no budget
 *   2. a large task with no stated budget gets one non-blocking question
 *   2b. a stated budget is never questioned
 *   3. identical failing calls open the gate with the four questions
 *   4. while the gate is open: write / shell / subagent denied, read / ask / MCP open
 *   5. an incomplete report is rejected and does NOT unlock
 *   6. a complete report unlocks, and the explained evidence cannot re-trip
 *   7. an explicit budget opens the gate when it runs out
 *   8. subagent sessions are not guarded
 *   9. twelve different images are not a stall
 *  10. after a resume (no `agent/inbox/claimed`) the guard still observes
 */

import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'

let pass = 0
const failures = []

const CFG = { locale: 'zh' }

/** Minimal Cordis context: records listeners, effects and registered tools. */
function fakeCtx() {
  const listeners = new Map()
  const tools = new Map()
  const logs = []
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    effect(factory) {
      factory()
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    logger: { warn: (m) => logs.push(m) },
    listeners,
    registry: tools,
    logs,
  }
}

/** Run the `tools/post-execute` chain the way the pipeline does. */
async function postExecute(ctx, exec, result) {
  const chain = ctx.listeners.get('tools/post-execute') ?? []
  const callAt = (i) => async () => (i + 1 < chain.length
    ? chain[i + 1](exec, result, callAt(i + 1))
    : { kind: 'accept' })
  return chain[0](exec, result, callAt(0))
}

/** Run the `tools/pre-execute` chain; the first deny wins. */
async function preExecute(ctx, exec) {
  const chain = ctx.listeners.get('tools/pre-execute') ?? []
  const callAt = (i) => async () => (i + 1 < chain.length
    ? chain[i + 1](exec, callAt(i + 1))
    : { kind: 'allow' })
  return chain[0](exec, callAt(0))
}

function fakeAgent(cancels) {
  return {
    session: { id: 'sid-1', header: {} },
    cancel(cause) { cancels.push(cause) },
  }
}

function textOf(decision) {
  return (decision?.additionalContexts ?? [])
    .flatMap((m) => m.content ?? [])
    .map((b) => b.text ?? '')
    .join('\n')
}

const STUCK_CALL = {
  name: 'pwsh',
  arguments: { command: 'npm test' },
}
const STUCK_RESULT = { isError: true, content: [{ type: 'text', text: 'Error: cannot find module foo' }] }

/**
 * Drive identical failing calls until the gate opens. With the shipped
 * errLimit = 2 the gate legitimately opens on the SECOND call (the same error
 * twice with nothing new in between is already a loop), so this returns the
 * first decision that carried a report demand, not the last one.
 */
async function openGate(ctx, agent) {
  for (let i = 0; i < 3; i++) {
    const decision = await postExecute(ctx, { ...STUCK_CALL, agent }, STUCK_RESULT)
    if ((decision?.additionalContexts ?? []).length > 0) return decision
  }
  return { kind: 'accept' }
}

const GOOD_REPORT = {
  goal: '让 npm test 通过',
  blocker: 'foo 模块到底该从 dist 还是 src 解析，这一点我不知道',
  options: ['改 tsconfig paths（代价：可能影响其他包）', '在 package.json 加 exports（代价：需重新构建）'],
  decision: '要不要动 workspace 的解析配置',
}

const tests = [
  ['1 真实用户消息开窗；插件注入的消息不开窗；小任务不弹预算询问', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    const claim = ctx.listeners.get('agent/inbox/claimed')[0]

    claim({ agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看下这个报错' }] }, turn: 1 })
    claim({ agent, message: { source: { kind: 'plugin:x' }, content: [{ type: 'text', text: '预算 999min' }] }, turn: 1 })

    const pre = ctx.listeners.get('agent/pre-step')[0]
    const decision = await pre({ agent }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 0, '小任务不该弹预算询问')
  }],

  ['2 大任务在 pre-step 注入一行预算询问（不阻断）', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    const big = '重构整个插件的架构，设计系统级的错误恢复，迁移到新的存储格式，并补全回归测试。'
    ctx.listeners.get('agent/inbox/claimed')[0]({
      agent,
      message: { source: { kind: 'user' }, content: [{ type: 'text', text: big }] },
      turn: 1,
    })
    const decision = await ctx.listeners.get('agent/pre-step')[0]({ agent }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 1)
    assert.match(decision.messages[0].content[0].text, /预算/)
    assert.match(decision.messages[0].content[0].text, /习惯/, '预算询问必须带上「声明预算」的建议')
    assert.equal(decision.messages[0].source.kind, 'plugin:timebudget-guard')
  }],

  ['2b 已声明预算时不再问预算（文案与裁决同源）', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    const big = '预算 60min：重构整个插件的架构，设计系统级的错误恢复，迁移到新的存储格式，并补全回归测试。'
    ctx.listeners.get('agent/inbox/claimed')[0]({
      agent,
      message: { source: { kind: 'user' }, content: [{ type: 'text', text: big }] },
      turn: 1,
    })
    const decision = await ctx.listeners.get('agent/pre-step')[0]({ agent }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 0, '已写预算就不该再问预算')
  }],

  ['3 相同失败调用 → 开闸并给出四问', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    const text = textOf(await openGate(ctx, agent))
    assert.match(text, /timebudget-guard · L1/)
    assert.match(text, /\(1\) 目标/)
    assert.match(text, /\(2\) 卡点/)
    assert.match(text, /\(4\) 决策/)
  }],

  ['4 闸门开启期间：write / pwsh / subagent 被拒，read / ask / 未归类工具放行', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    await openGate(ctx, agent)

    const deny = await preExecute(ctx, { name: 'write', arguments: { file_path: 'a.ts' }, agent })
    assert.equal(deny.kind, 'deny')
    assert.match(deny.reason, /timebudget-guard · L2/)
    assert.match(deny.reason, /guard_report/)

    assert.equal((await preExecute(ctx, { name: 'pwsh', arguments: { command: 'x' }, agent })).kind, 'deny')
    assert.equal((await preExecute(ctx, { name: 'read', arguments: { file_path: 'a.ts' }, agent })).kind, 'allow')
    assert.equal((await preExecute(ctx, { name: 'guard_report', arguments: {}, agent })).kind, 'allow')
    // Asking the human is what the gate wants: never block the question tool.
    assert.equal((await preExecute(ctx, { name: 'ask_user_question', arguments: {}, agent })).kind, 'allow')
    // Spawning a subagent is more autonomous work: locked like shell.
    assert.equal((await preExecute(ctx, { name: 'subagent', arguments: {}, agent })).kind, 'deny')
    // Unknown / MCP tools stay open; the hard stop is the backstop.
    assert.equal((await preExecute(ctx, { name: 'web_search', arguments: {}, agent })).kind, 'allow')
  }],

  ['4b Claude Code 风格的 PascalCase 工具名同样被识别', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    await openGate(ctx, agent)
    assert.equal((await preExecute(ctx, { name: 'Bash', arguments: { command: 'x' }, agent })).kind, 'deny')
    assert.equal((await preExecute(ctx, { name: 'Write', arguments: { file_path: 'a' }, agent })).kind, 'deny')
    assert.equal((await preExecute(ctx, { name: 'Read', arguments: { file_path: 'a' }, agent })).kind, 'allow')
  }],

  ['5 空话汇报被驳回，闸门不放', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    await openGate(ctx, agent)

    const tool = ctx.registry.get('guard_report')
    const rejection = tool.execute({ goal: '修', blocker: '卡', options: ['a'], decision: '' }, { agent })
    assert.match(rejection, /驳回/)

    await postExecute(ctx, { name: 'guard_report', arguments: {}, agent }, { isError: false, content: [{ type: 'text', text: rejection }] })
    assert.equal((await preExecute(ctx, { name: 'write', arguments: { file_path: 'a.ts' }, agent })).kind, 'deny')
  }],

  ['6 完整汇报 → 解锁；已解释的旧证据不会立刻再开闸', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    await openGate(ctx, agent)

    const tool = ctx.registry.get('guard_report')
    const reply = tool.execute(GOOD_REPORT, { agent })
    assert.match(reply, /已入册/)

    await postExecute(ctx, { name: 'guard_report', arguments: GOOD_REPORT, agent }, { isError: false, content: [{ type: 'text', text: reply }] })
    assert.equal((await preExecute(ctx, { name: 'write', arguments: { file_path: 'a.ts' }, agent })).kind, 'allow')

    const after = await postExecute(ctx, { ...STUCK_CALL, agent }, STUCK_RESULT)
    assert.doesNotMatch(textOf(after), /timebudget-guard · L1/, '窗口重启后旧证据不该复发')
  }],

  ['7 user states a 2min budget → 超时开闸', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    ctx.listeners.get('agent/inbox/claimed')[0]({
      agent,
      message: { source: { kind: 'user' }, content: [{ type: 'text', text: '预算 2min 帮我把测试跑通' }] },
      turn: 1,
    })

    const realNow = Date.now
    let fake = realNow()
    Date.now = () => fake
    try {
      await postExecute(ctx, { name: 'read', arguments: { file_path: 'a' }, agent }, { isError: false, content: [{ type: 'text', text: 'one' }] })
      fake += 130000
      const decision = await postExecute(
        ctx,
        { name: 'read', arguments: { file_path: 'b' }, agent },
        { isError: false, content: [{ type: 'text', text: 'two' }] },
      )
      assert.match(textOf(decision), /超出时间预算/)
    } finally {
      Date.now = realNow
    }
  }],

  ['8 子智能体会话不参与（rootOnly）', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const child = { session: { id: 'child-1', header: { parentSession: 'sid-1' } }, cancel() {} }
    ctx.listeners.get('agent/inbox/claimed')[0]({
      agent: child,
      message: { source: { kind: 'user' }, content: [{ type: 'text', text: '做事' }] },
      turn: 1,
    })
    for (let i = 0; i < 5; i++) await postExecute(ctx, { ...STUCK_CALL, agent: child }, STUCK_RESULT)
    assert.equal((await preExecute(ctx, { name: 'write', arguments: { file_path: 'a' }, agent: child })).kind, 'allow')
  }],

  ['9 十二张不同的图片不算空转（非文本块曾全读成空串）', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    let last = null
    for (let i = 0; i < 13; i++) {
      last = await postExecute(
        ctx,
        { name: 'read_image', arguments: { file_path: `img${i}.png` }, agent },
        { isError: false, content: [{ type: 'image', data: `AAA${i}`, mimeType: 'image/png' }] },
      )
    }
    assert.equal(textOf(last), '', '不同图片必须算新信息')
  }],

  ['10 resume 后 lazy state：未收到 claimed 也能观察并开闸', async () => {
    const ctx = fakeCtx()
    apply(ctx, CFG)
    const agent = fakeAgent([])
    // 不调用 inbox/claimed —— 模拟 resume：claimed 不会重放。
    let opened = false
    for (let i = 0; i < 4 && !opened; i++) {
      const decision = await postExecute(ctx, { ...STUCK_CALL, agent }, STUCK_RESULT)
      if ((decision?.additionalContexts ?? []).length > 0) opened = true
    }
    assert.ok(opened, 'resume 后仍须能观察并开闸')
  }],

  ['11 默认 locale 是英文（不传配置时）', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    const text = textOf(await openGate(ctx, agent))
    assert.match(text, /Goal/)
    assert.doesNotMatch(text, /目标/)
  }],
]

for (const [title, body] of tests) {
  try {
    await body()
    pass++
    console.log(`ok   ${title}`)
  } catch (error) {
    failures.push({ title, error })
    console.log(`FAIL ${title}: ${error.message}`)
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
