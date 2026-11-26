/**
 * Portable hook entry point.
 *
 * Runs as a `command` hook for any harness that speaks the Claude Code or Codex
 * hook dialect — Claude Code itself, Codex, the DeepSeek Harness's two hook
 * bridges, or anything else that follows the same stdin-JSON / stdout-JSON
 * contract.
 *
 * Contract this file implements:
 *
 *   stdin  one JSON payload with `hook_event_name`, `session_id`, and the
 *          per-event fields (`tool_name` / `tool_input` for the tool points,
 *          `prompt` for UserPromptSubmit).
 *   stdout one JSON object, or nothing. Recognised keys:
 *            hookSpecificOutput.permissionDecision  (PreToolUse: allow/deny/ask)
 *            hookSpecificOutput.additionalContext   (any point: model-visible)
 *            decision + reason                      (Stop: block to force a step)
 *
 * Every invocation is a FRESH PROCESS, so all cross-call state lives in one JSON
 * file per session under the state dir. That is also the source of this variant's
 * three limitations, which are properties of the hook contract rather than bugs:
 *
 *   1. No tool registration — a hook cannot add a `guard_report` tool, so the
 *      four answers are delivered as prose in the model's reply.
 *   2. No same-request injection — `additionalContext` reaches the model on its
 *      NEXT request, never the one already being assembled.
 *   3. No turn cancellation — `{"continue": false}` is recorded by the bridges
 *      and ignored. The closest available lever is blocking `Stop`, which forces
 *      one more step.
 *
 * For the stronger behaviour, mount `lib/index.mjs` as a native Cordis plugin.
 *
 * Environment:
 *   TIMEBUDGET_STATE_DIR     where per-session state lives (default: XDG state dir)
 *   TIMEBUDGET_LOCALE        'en' | 'zh' — language of the model-facing text
 *   TIMEBUDGET_DEFAULT_MIN   default budget in minutes (default 20, 0 = unlimited)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import {
  armBudget,
  budgetAskMessage,
  checkpointMessage,
  classify,
  collectTriggers,
  contentText,
  createSessionState,
  estimateMinutes,
  extractBudgetMinutes,
  isContinueMessage,
  isLocked,
  lockReason,
  normalizeConfig,
  observe,
  REPORT_HINT_PROSE,
  reportMessage,
  resetTurn,
  resetWindow,
} from '../lib/core.mjs'

function stateRoot() {
  return process.env.TIMEBUDGET_STATE_DIR
    ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'timebudget-guard')
}

const CFG = normalizeConfig({
  locale: process.env.TIMEBUDGET_LOCALE,
  budgetDefaultMinutes: process.env.TIMEBUDGET_DEFAULT_MIN,
  logPath: process.env.TIMEBUDGET_LOG ?? '',
})

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj))
  process.exit(0)
}

const emitNothing = () => emit({})

function stateFile(sessionId) {
  const safe = String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
  return join(stateRoot(), `${safe}.json`)
}

/**
 * Revive the state. `JSON.stringify` cannot carry a Set, so `seen` is stored as
 * an array and rebuilt here; `recent` is a plain array of records and survives
 * as-is. A corrupt or missing file is treated as "no state" rather than an
 * error: losing the guard's memory must never break the user's tool call.
 */
function loadState(sessionId) {
  let raw
  try {
    raw = JSON.parse(readFileSync(stateFile(sessionId), 'utf8'))
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  return {
    ...raw,
    seen: new Set(Array.isArray(raw.seen) ? raw.seen : []),
    recent: Array.isArray(raw.recent) ? raw.recent : [],
  }
}

function saveState(st) {
  const path = stateFile(st.id)
  try {
    mkdirSync(dirname(path), { recursive: true })
    // Cap the signature set: a very long session must not grow the state file
    // without bound, and old signatures stop mattering once they fall out of the
    // tail window anyway.
    const serializable = { ...st, seen: [...st.seen].slice(-1500) }
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(serializable), 'utf8')
    // Atomic on the same volume. A torn state file would read back as "no state"
    // and silently reset the guard mid-turn.
    renameSync(tmp, path)
  } catch {
    // An unwritable state dir must never break the user's tool call.
  }
}

function fresh(sessionId) {
  const st = createSessionState(sessionId)
  resetTurn(st, Date.now())
  armBudget(st, CFG.budgetDefaultMinutes * 60000)
  st.budgetSource = 'default'
  return st
}

const ensure = (sessionId) => loadState(sessionId) ?? fresh(sessionId)

/**
 * Text of a tool result. Harnesses differ: `tool_response` may be a string, an
 * object, or content blocks. All three are folded into one comparable string so
 * the signatures stay meaningful across dialects.
 */
function responseText(payload) {
  const r = payload.tool_response ?? payload.tool_result ?? payload.result
  if (r === null || r === undefined) return ''
  if (typeof r === 'string') return r
  if (Array.isArray(r)) return contentText(r)
  if (typeof r === 'object') {
    if (Array.isArray(r.content)) return contentText(r.content)
    for (const key of ['stdout', 'output', 'text', 'error', 'message']) {
      if (typeof r[key] === 'string') return r[key]
    }
  }
  try {
    return JSON.stringify(r)
  } catch {
    return ''
  }
}

function looksLikeError(payload, text) {
  if (payload.is_error === true || payload.isError === true) return true
  if (payload.tool_response?.is_error === true) return true
  return /^\s*(?:\[?error|exception|traceback|fatal|command failed)/i.test(text)
}

function summarize(toolName, input) {
  const args = input ?? {}
  const pick = args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.description ?? args.task
  if (typeof pick !== 'string' || pick === '') return String(toolName ?? 'tool')
  const one = pick.replace(/\s+/g, ' ').trim()
  return one.length > 120 ? `${one.slice(0, 120)}...` : one
}

// ── event handlers ─────────────────────────────────────────────────────────

function onUserPromptSubmit(payload) {
  const st = ensure(payload.session_id)
  const text = String(payload.prompt ?? '')
  const explicit = extractBudgetMinutes(text)
  const carry = st.budgetMs
  const budgetMs = explicit === null
    ? (isContinueMessage(text) && carry > 0 ? carry : CFG.budgetDefaultMinutes * 60000)
    : explicit === 0 ? 0 : explicit * 60000

  resetTurn(st, Date.now())
  armBudget(st, budgetMs)
  st.budgetSource = explicit === null ? 'default' : explicit === 0 ? 'unlimited' : 'user'
  st.estimate = estimateMinutes(text)
  st.askedBudget = false

  // One non-blocking line, only when no budget was stated.
  if (st.budgetSource === 'default' && st.estimate >= CFG.estimateThresholdMinutes) {
    st.askedBudget = true
    saveState(st)
    emit({ hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: budgetAskMessage(st.estimate, st.budgetMs, CFG),
    } })
  }
  saveState(st)
  emitNothing()
}

function onPreToolUse(payload) {
  const st = ensure(payload.session_id)
  const action = classify(payload.tool_name)
  if (!st.reportPending || !isLocked(action)) {
    saveState(st)
    emitNothing()
  }

  const now = Date.now()
  const triggers = collectTriggers(st, CFG, now)
  saveState(st)
  emit({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: lockReason(st, triggers, CFG, now),
  } })
}

function onPostToolUse(payload) {
  const st = ensure(payload.session_id)
  const now = Date.now()
  const text = responseText(payload)
  const { action } = observe(st, {
    name: payload.tool_name,
    args: payload.tool_input,
    text,
    isError: looksLikeError(payload, text),
    summary: summarize(payload.tool_name, payload.tool_input),
  }, CFG, now)

  // No `guard_report` tool exists here, so the unlock is the model speaking the
  // four answers in prose. The hook cannot read the assistant's reply, so the
  // next settled call is treated as the report: waiting for something the hook
  // cannot observe would make the lock permanent.
  if (action === 'report') {
    st.reportPending = false
    st.reports++
    resetWindow(st, now)
    saveState(st)
    emitNothing()
  }
  if (st.reportPending || st.cancelled) {
    saveState(st)
    emitNothing()
  }

  const triggers = collectTriggers(st, CFG, now)
  if (triggers.length === 0) {
    saveState(st)
    emitNothing()
  }

  st.reportPending = true
  st.gateSince = now
  st.triggers = triggers.map((t) => t.kind)
  if (st.budgetMs > 0) {
    while (st.budgetNextFire > 0 && now - st.turnStart >= st.budgetNextFire) {
      st.budgetNextFire += st.budgetMs
    }
  }
  saveState(st)
  emit({ hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: reportMessage(st, triggers, CFG, now, REPORT_HINT_PROSE),
  } })
}

function onStop(payload) {
  const st = ensure(payload.session_id)
  const now = Date.now()

  // A gate still open at the stop boundary means the model is trying to end the
  // turn without reporting. Blocking Stop forces one more step — the closest a
  // hook can get to a hard stop.
  if (st.reportPending && !st.cancelled) {
    const triggers = collectTriggers(st, CFG, now)
    saveState(st)
    emit({ decision: 'block', reason: reportMessage(st, triggers, CFG, now, REPORT_HINT_PROSE) })
  }

  // Otherwise, spend the one line the hook is allowed to add on a checkpoint.
  if (st.budgetMs > 0 && !st.checkpointDone && now - st.turnStart >= st.budgetMs * CFG.checkpointRatio) {
    st.checkpointDone = true
    saveState(st)
    emit({ hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: checkpointMessage(st, CFG, now),
    } })
  }
  saveState(st)
  emitNothing()
}

// ── main ───────────────────────────────────────────────────────────────────

const raw = readStdin().replace(/^\uFEFF/, '').trim()
let payload = null
try {
  payload = raw === '' ? null : JSON.parse(raw)
} catch {
  payload = null
}
if (payload === null) emitNothing()

switch (String(payload.hook_event_name ?? '')) {
  case 'UserPromptSubmit': onUserPromptSubmit(payload); break
  case 'PreToolUse': onPreToolUse(payload); break
  case 'PostToolUse': onPostToolUse(payload); break
  case 'Stop': onStop(payload); break
  default: emitNothing()
}
