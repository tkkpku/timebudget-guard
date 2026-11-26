import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Hook-variant tests. Each case runs the real hook as a CHILD PROCESS, the way a
 * harness runs it: one process, one JSON payload on stdin, one JSON object (or
 * nothing) on stdout. State therefore crosses a real file boundary, which is the
 * only way to catch a state-persistence bug.
 *
 * "Quiet" means the hook emitted no recognised key — it always prints `{}` so the
 * caller never has to distinguish empty stdout from a parse failure.
 */

const HOOK = fileURLToPath(new URL('../hooks/hook.mjs', import.meta.url))
const STATE = mkdtempSync(join(tmpdir(), 'tbg-hook-test-'))

let pass = 0
const failures = []

function run(payload, env = {}) {
  const child = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      TIMEBUDGET_STATE_DIR: STATE,
      TIMEBUDGET_LOCALE: 'en',
      ...env,
    },
  })
  const out = (child.stdout ?? '').trim()
  let json = null
  try {
    json = out === '' ? null : JSON.parse(out)
  } catch {
    json = null
  }
  return { status: child.status, stderr: child.stderr, json, raw: out }
}

/** True when the hook said nothing a harness would act on. */
function quiet(res) {
  return res.json === null || Object.keys(res.json).length === 0
}

const session = (id) => ({ session_id: id })

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

const BIG = 'refactor the whole plugin architecture and migrate the storage format, then add regression tests'
const FAILING_CALL = {
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  tool_response: 'Error: cannot find module foo',
}

test('1 未声明预算的大任务 → 每条用户消息只问一次预算', () => {
  const first = run({ ...session('s-question'), hook_event_name: 'UserPromptSubmit', prompt: BIG })
  assert.equal(first.status, 0)
  assert.match(first.json.hookSpecificOutput.additionalContext, /budget/i)

  // 同一轮里的工具调用不得再问：预算询问属于「开新轮」的那一刻，不是每次调用。
  const during = run({ ...session('s-question'), hook_event_name: 'PostToolUse', ...FAILING_CALL })
  assert.ok(quiet(during), '同一轮的工具调用不得重复问预算')
})

test('2 已声明预算 → 不出现预算询问', () => {
  const out = run({
    ...session('s-stated'),
    hook_event_name: 'UserPromptSubmit',
    prompt: 'budget 3min refactor the whole plugin architecture and migrate the storage format',
  })
  assert.ok(quiet(out))
})

test('3 同一错误两次 → 开闸并给出四问', () => {
  run({ ...session('s-gate'), hook_event_name: 'UserPromptSubmit', prompt: 'fix the build' })
  const first = run({ ...session('s-gate'), hook_event_name: 'PostToolUse', ...FAILING_CALL })
  assert.ok(quiet(first), '第一次尚未构成重复')

  const second = run({ ...session('s-gate'), hook_event_name: 'PostToolUse', ...FAILING_CALL })
  const text = second.json?.hookSpecificOutput?.additionalContext ?? ''
  assert.match(text, /four/i)
  assert.match(text, /Blocker/i)
  assert.match(text, /reply IS the report|Put the four answers directly/i)
})

test('4 闸门开启期间：变更类被拒，读类与询问放行', () => {
  const denied = run({ ...session('s-gate'), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } })
  assert.equal(denied.json.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(denied.json.hookSpecificOutput.permissionDecisionReason, /locked/i)

  assert.ok(quiet(run({ ...session('s-gate'), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/a' } })), '读类不得被拒')
  assert.ok(quiet(run({ ...session('s-gate'), hook_event_name: 'PreToolUse', tool_name: 'ask_user_question', tool_input: {} })), '询问工具不得被拒')
  assert.ok(quiet(run({ ...session('s-gate'), hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/b' } })) === false, '写文件必须被拒')
})

test('5 闸门未关时 Stop 强制再走一步', () => {
  const stopped = run({ ...session('s-gate'), hook_event_name: 'Stop', stop_hook_active: false })
  assert.equal(stopped.json.decision, 'block')
  assert.match(stopped.json.reason, /four/i)
})

test('6 状态跨进程存活（同一 session 的第二次调用读得到第一次）', () => {
  // 若状态没落盘，第二次 PostToolUse 会把它当第一次、永不开闸。
  const payload = { tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: 'Error: boom' }
  run({ ...session('s-persist'), hook_event_name: 'UserPromptSubmit', prompt: 'build it' })
  assert.ok(quiet(run({ ...session('s-persist'), hook_event_name: 'PostToolUse', ...payload })))
  const second = run({ ...session('s-persist'), hook_event_name: 'PostToolUse', ...payload })
  assert.equal(second.json.hookSpecificOutput.additionalContext !== undefined, true, '第二次必须读到第一次留下的状态')
})

test('7 坏载荷安静退出，不破坏 harness', () => {
  const out = run('{not json')
  assert.equal(out.status, 0)
  assert.equal(out.raw, '{}')
})

test('8 未知事件安静退出', () => {
  const out = run({ ...session('s-unknown'), hook_event_name: 'Notification' })
  assert.equal(out.status, 0)
  assert.equal(out.raw, '{}')
})

test('9 中文 locale 生效', () => {
  const out = run({ ...session('s-zh'), hook_event_name: 'UserPromptSubmit', prompt: BIG }, { TIMEBUDGET_LOCALE: 'zh' })
  assert.match(out.json.hookSpecificOutput.additionalContext, /预算/)
})

rmSync(STATE, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
