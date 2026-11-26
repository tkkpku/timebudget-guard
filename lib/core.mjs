/**
 * timebudget-guard core — pure, zero-dependency signal logic and state machine.
 *
 * Design contract (why the thresholds look like this):
 *
 * 1. Judgement is by RECENT WINDOW, not cumulative counters. Every signal asks
 *    "did the last N calls look identical", so 500 productive calls can never
 *    accumulate into a false positive — the window only holds the tail. Long
 *    legs of ordinary work must never trip a guardrail, because a guardrail that
 *    cries wolf gets ignored, and an ignored guardrail is worse than none.
 *
 * 2. Nothing is folded unless it is genuinely volatile. Output signatures keep
 *    digits (a different line number IS different information); only temp paths,
 *    durations and long hex ids are erased. Error signatures are more aggressive
 *    because "the same error" is exactly what must collapse.
 *
 * 3. Direction drift is NOT inferred from keywords. That class of rule misfires
 *    on legitimate work. The half-budget checkpoint asks the model to restate the
 *    goal in one line instead — cheap, cache-neutral, non-interrupting.
 *
 * 4. All model-facing prose lives in `messages.mjs`. This file decides WHEN to
 *    speak; that file decides WHAT is said, per locale.
 */

import { messages } from './messages.mjs'

/** FNV-1a 32-bit, hex. Stable across processes; only used as a map key. */
export function hash32(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Stable argument serialization: sorted keys, depth-bounded, length-bounded. */
export function normalizeArgs(args, limit = 400) {
  const seen = new Set()
  const walk = (value, depth) => {
    if (value === null || typeof value !== 'object') return value
    if (depth > 4) return '[deep]'
    if (seen.has(value)) return '[cycle]'
    seen.add(value)
    if (Array.isArray(value)) return value.slice(0, 12).map((v) => walk(v, depth + 1))
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = walk(value[key], depth + 1)
    return out
  }
  let text
  try {
    text = JSON.stringify(walk(args ?? null, 0))
  } catch {
    text = String(args)
  }
  return text.length > limit ? text.slice(0, limit) : text
}

/** Identity of one call: tool name plus normalized arguments. */
export function fingerprint(name, args) {
  return `${name}|${hash32(normalizeArgs(args))}`
}

/** Erase only genuinely volatile substrings; real content differences survive. */
export function stripNoise(text) {
  return String(text ?? '')
    .replace(/[A-Za-z]:\\[^\s"'<>|]*?\\Temp\\[^\s"'<>|]*/g, '<tmp>')
    .replace(/\/(?:tmp|var\/folders)\/[^\s"'<>|]*/g, '<tmp>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|millis|s|sec|secs|seconds|m|min|mins|minutes)\b/gi, '<dur>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Content blocks → one comparable string.
 *
 * A bare `b.text ?? ''` reads EVERY non-text result as the empty string, so
 * twelve different images from a read_image tool, or twelve different
 * attachments, collapse into one signature and look exactly like a stall.
 * Non-text blocks therefore contribute a stable descriptor (type, mime, size,
 * prefix digest) instead of nothing.
 */
export function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.map((b) => {
    if (typeof b === 'string') return b
    if (b === null || typeof b !== 'object') return ''
    if (typeof b.text === 'string' && b.text !== '') return b.text
    const head = b.data ?? b.url ?? b.path ?? b.file_path ?? b.source ?? ''
    const size = typeof head === 'string' ? head.length : 0
    const digest = typeof head === 'string' && head !== '' ? hash32(head.slice(0, 4096)) : ''
    return `[${b.type ?? b.kind ?? 'block'}:${b.mimeType ?? b.mime ?? ''}:${size}:${digest}]`
  }).join('\n')
}

/**
 * Output identity. Digits are PRESERVED on purpose: treating "case 3 failed" and
 * "case 7 failed" as the same output would manufacture a fake loop.
 */
export function outputSignature(text) {
  const raw = String(text ?? '')
  if (raw === '') return 'empty'
  return hash32(stripNoise(raw).slice(0, 1200))
}

/**
 * Error identity: first meaningful line, digits and paths collapsed, so a retry
 * of the same failure is recognized even when line numbers move.
 */
export function errorSignature(text) {
  const raw = String(text ?? '')
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? raw
  return hash32(stripNoise(line).replace(/\d+/g, '#').slice(0, 300))
}

const READ_TOOLS = /^(read|glob|grep|skill|list_agents|job_list|job_output)$/
const MUTATE_TOOLS = /^(write|edit|apply_patch|replace|str_replace)$/
const EXEC_TOOLS = /^(pwsh|bash|shell|terminal|ssh_exec|ssh_upload|ssh_download|ssh_cluster)$/
const DELEGATE_TOOLS = /^(subagent|subagent_fork|subagent_reviewer|workflow|ralph)$/
const ASK_TOOLS = /^(ask_user_question|guard_report|present)$/
const REPORT_TOOLS = /^guard_report$/

/**
 * Action class of a tool name.
 *
 * The gate blocks exactly three classes — `mutate`, `exec`, `delegate` — because
 * those are the ones that change the world or spawn more autonomous work. It
 * leaves `read`, `ask` and `other` open:
 *
 *   - `ask` stays open because asking the human is precisely what the gate
 *     wants; blocking the question tool would leave escalation no route but the
 *     report form.
 *   - `other` stays open because it is the catch-all for MCP, search and plugin
 *     tools. An allowlist of "known safe" names would silently misjudge every
 *     one of them; the hard stop is the backstop if the model grinds on `other`
 *     instead of reporting.
 */
export function classify(name) {
  // Lowercased on purpose: Claude Code and Codex spell tools `Bash`, `Read`,
  // `Write`, `Edit`, while the Harness spells them `bash`, `read`, `write`,
  // `edit`. A case-sensitive match silently classifies every Claude Code call as
  // `other`, which makes the whole lock a no-op on that harness — found by the
  // hook test asserting a `Bash` call must be denied.
  const n = String(name ?? '').toLowerCase()
  if (REPORT_TOOLS.test(n)) return 'report'
  if (ASK_TOOLS.test(n)) return 'ask'
  if (READ_TOOLS.test(n)) return 'read'
  if (MUTATE_TOOLS.test(n)) return 'mutate'
  if (EXEC_TOOLS.test(n)) return 'exec'
  if (DELEGATE_TOOLS.test(n)) return 'delegate'
  return 'other'
}

/** Whether a class is held back while the report gate is open. */
export function isLocked(action) {
  return action === 'mutate' || action === 'exec' || action === 'delegate'
}

const BIG = /(重构|架构|设计|系统|全面|完整|迁移|升级|从头|整个|全量|architect|refactor|redesign|migrate|overhaul|comprehensive|end-to-end)/i
const BUILD = /(实现|开发|创建|写一个|生成|搭建|做一个|新项目|插件|build|create|implement|develop|generate|scaffold|set up)/i
const DEBUG = /(调试|排查|为什么|报错|失败|崩溃|debug|why|broken|investigate|diagnose)/i

/**
 * Coarse wall-clock estimate for one request, in minutes, rounded to 5.
 *
 * Deliberately crude: its only job is to decide whether the user should be asked
 * for a budget at all. It must never become the budget by itself — a "add unit
 * tests to this module" request estimates at 5min and often takes 15, so using
 * the estimate as a deadline would fire on honest work.
 */
export function estimateMinutes(text) {
  const s = String(text ?? '')
  let m = 5
  if (s.length > 400) m += 5
  if (s.length > 1200) m += 10
  if (BIG.test(s)) m += 15
  if (BUILD.test(s)) m += 10
  if (DEBUG.test(s)) m += 5
  const items = (s.match(/^\s*(?:\d+[.、)]|[-*])\s+/gm) ?? []).length
  if (items >= 3) m += 10
  return Math.min(90, Math.round(m / 5) * 5)
}

const BUDGET_RE = /(?:预算|限时|时间上限|budget|time\s*budget|deadline)\s*[:：=]?\s*(\d{1,3})\s*(?:min|mins|minutes|分钟|m\b)?/i
const BUDGET_RE_2 = /(\d{1,3})\s*(?:分钟|min|mins|minutes)\s*(?:内|之内|上限|budget|limit)?/i

/** Explicit budget in minutes from a user message, or null. 0 means unlimited. */
export function extractBudgetMinutes(text) {
  const s = String(text ?? '')
  const m = BUDGET_RE.exec(s) ?? BUDGET_RE_2.exec(s)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(600, Math.round(n)))
}

const CONTINUE_HEAD = /^\s*(?:继续|接着|往下|往下做|接着做|再来|go on|continue|keep going|resume|ok|okay|yes|嗯|好|可以|行)/i

/**
 * Whether a new user message continues the same task rather than starting a new
 * one. Only a genuinely short acknowledgement counts: the residual after the
 * continuation word must carry no instruction, so "continue, but do not touch the
 * docs" opens a new window while "continue" / "ok go on" does not.
 *
 * The thresholds differ by script on purpose: a CJK character carries roughly a
 * word's worth of meaning, so four Chinese characters is already a clause
 * ("但先别改文档"), while twelve Latin characters is still one word.
 */
export function isContinueMessage(text) {
  const s = String(text ?? '').trim()
  if (s === '') return true
  const rest = s.replace(CONTINUE_HEAD, '').replace(/^[\s，,。.!！~～、:：]+/, '')
  const limit = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(rest) ? 4 : 12
  return rest.length <= limit
}

export const DEFAULTS = Object.freeze({
  /** Budget when the user never states one. 0 = unlimited. */
  budgetDefaultMinutes: 20,
  /** Estimate at or above this asks the user for a budget (non-blocking line). */
  estimateThresholdMinutes: 15,
  /** Same call this many times in a row -> report gate. */
  dupLimit: 3,
  /** Same error signature this many times in a row -> report gate. */
  errLimit: 2,
  /** Consecutive calls producing no new output -> report gate. */
  stallLimit: 12,
  /** Fraction of budget at which one goal-restatement checkpoint is injected. */
  checkpointRatio: 0.5,
  /** A report gate left unanswered this long escalates to turn cancellation. */
  l3AfterMs: 180000,
  /** How often the tool-side timer checks for an ignored gate. */
  sweepIntervalMs: 15000,
  /** Reports per turn before the turn is cancelled outright. */
  maxReports: 5,
  /** JSONL evidence log; empty disables it. */
  logPath: '',
  /** Guard root sessions only; subagents are separate scopes. */
  rootOnly: true,
  /** Message locale: 'en' | 'zh'. Unknown values fall back to English. */
  locale: 'en',
})

/** How many trailing calls the windows look at, before config is applied. */
const MIN_WINDOW = 64

export function normalizeConfig(config) {
  const raw = config ?? {}
  const out = { ...DEFAULTS }
  const num = (key, min, max) => {
    const v = Number(raw[key])
    if (Number.isFinite(v) && v >= min && v <= max) out[key] = v
  }
  num('budgetDefaultMinutes', 0, 600)
  num('estimateThresholdMinutes', 1, 600)
  num('dupLimit', 2, 50)
  num('errLimit', 2, 50)
  num('stallLimit', 3, 200)
  num('checkpointRatio', 0.05, 0.95)
  num('l3AfterMs', 10000, 3600000)
  num('sweepIntervalMs', 1000, 300000)
  num('maxReports', 1, 50)
  if (typeof raw.logPath === 'string') out.logPath = raw.logPath
  if (typeof raw.rootOnly === 'boolean') out.rootOnly = raw.rootOnly
  if (typeof raw.locale === 'string' && raw.locale !== '') out.locale = raw.locale
  // The retained window must be at least as long as the longest tail a rule can
  // ask for. Otherwise `stallLimit: 200` is silently dead configuration: the rule
  // needs 200 trailing records while the buffer keeps 64, so tailAll() always
  // returns null and the trigger can never fire.
  out.windowSize = Math.max(
    MIN_WINDOW,
    out.dupLimit + 1,
    out.errLimit + 1,
    out.stallLimit + 1,
  )
  return out
}

/** Local wall-clock HH:MM:SS. NOT toISOString(): that prints UTC and would show
 *  14:42 to a user whose clock reads 22:42 — the log lines and the model-facing
 *  line would then disagree about the same event. */
export function hhmmss(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function createSessionState(id) {
  return {
    id,
    turnStart: Date.now(),
    windowStart: Date.now(),
    /** Cumulative calls this turn (survives a post-report window restart). */
    calls: 0,
    budgetMs: 0,
    budgetSource: 'none',
    /** Next elapsed-ms mark at which the over-budget trigger fires again. 0 = unarmed. */
    budgetNextFire: 0,
    estimate: 0,
    askedBudget: false,
    /** Trailing call records: newest last. */
    recent: [],
    /** Signatures seen in this window; only used for novelty. */
    seen: new Set(),
    gateSince: 0,
    reportPending: false,
    /** Set by guard_report only when all four answers passed validation. */
    reportAccepted: false,
    reports: 0,
    checkpointDone: false,
    triggers: [],
    cancelled: false,
  }
}

/** Arm the budget clock and its repeat-firing mark from the new budget. */
export function armBudget(st, budgetMs) {
  st.budgetMs = budgetMs
  st.budgetNextFire = budgetMs > 0 ? budgetMs : 0
}

/**
 * Start a fresh measurement window. NOTE: this touches only the guard's own
 * counters — never session history — so it cannot affect the model's context.
 */
export function resetTurn(st, now) {
  st.turnStart = now
  st.calls = 0
  st.reports = 0
  st.checkpointDone = false
  resetWindow(st, now)
}

/**
 * Clear the detection window but keep the turn clock, budget, cumulative call
 * count and report count. Called after an accepted report: the model has new
 * information, so the trailing-call evidence must start over — otherwise the very
 * next call would re-trip on evidence it already explained.
 */
export function resetWindow(st, now) {
  st.recent = []
  st.seen = new Set()
  st.gateSince = 0
  st.reportPending = false
  st.reportAccepted = false
  st.triggers = []
  st.cancelled = false
  st.windowStart = now
}

/**
 * Fold one settled tool call into the session state.
 * @returns {{novel: boolean, action: string}}
 */
export function observe(st, call, cfg, now) {
  const fp = fingerprint(call.name, call.args)
  const action = classify(call.name)
  const sig = outputSignature(call.text)
  // An EMPTY output carries no information about progress. Counting it as
  // stagnation would fire `no-progress` on genuinely productive silent tools
  // (file uploads, writes with a terse result, MCP calls that return nothing), so
  // an empty result is treated as neutral: it never extends the stall streak. A
  // silent infinite loop is still caught by `repeat`, which compares the call
  // fingerprint as well as the output.
  const novel = sig === 'empty' ? true : !st.seen.has(sig)
  if (novel) {
    if (st.seen.size > 4000) st.seen = new Set()
    st.seen.add(sig)
  }
  st.calls++
  st.recent.push({
    name: String(call.name ?? ''),
    action,
    fp,
    sig,
    novel,
    isError: call.isError === true,
    es: call.isError === true ? errorSignature(call.text) : '',
    summary: call.summary,
  })
  const keep = cfg?.windowSize ?? MIN_WINDOW
  if (st.recent.length > keep) st.recent.shift()
  return { novel, action }
}

/** True when the last `n` records all satisfy `pred`; null when the tail is short. */
function tailAll(st, n, pred) {
  if (n <= 0 || st.recent.length < n) return null
  const tail = st.recent.slice(-n)
  for (const r of tail) if (!pred(r)) return null
  return tail
}

/**
 * Collected reasons the report gate should open, strongest first.
 *
 * The asymmetry between the two repeat rules is deliberate:
 *   - `repeat` needs the SAME output as well as the same call, because a call
 *     that returns something new is progress, not a loop.
 *   - `repeat-error` only needs the same error signature, because a different
 *     command hitting the same wall is still the same wall — but the newest call
 *     must have taught nothing (novel === false), otherwise the "same" error came
 *     with different surrounding detail and the diagnosis is moving.
 */
export function collectTriggers(st, cfg, now) {
  const out = []

  const repeat = tailAll(st, cfg.dupLimit, (r) => r.fp !== '')
  if (repeat !== null && repeat.every((r) => r.fp === repeat[0].fp && r.sig === repeat[0].sig)) {
    out.push({ kind: 'repeat', n: repeat.length, sample: repeat[0].summary ?? repeat[0].name })
  }

  const errs = tailAll(st, cfg.errLimit, (r) => r.isError && r.es !== '')
  if (errs !== null && errs.every((r) => r.es === errs[0].es) && errs[errs.length - 1].novel === false) {
    out.push({ kind: 'repeat-error', n: errs.length, sample: errs[0].summary ?? errs[0].name })
  }

  const stalled = tailAll(st, cfg.stallLimit, (r) => r.novel === false)
  if (stalled !== null) {
    out.push({ kind: 'no-progress', n: stalled.length })
  }

  if (st.budgetMs > 0 && st.budgetNextFire > 0 && now - st.turnStart >= st.budgetNextFire) {
    out.push({ kind: 'over-budget', elapsed: now - st.turnStart, budgetMs: st.budgetMs })
  }
  return out
}

export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s}s`
  return s === 0 ? `${m}min` : `${m}min${s}s`
}

/** How the model is told to deliver the report, per deployment shape. */
export const REPORT_HINT_TOOL = 'tool'
export const REPORT_HINT_PROSE = 'prose'

function hintText(M, hint) {
  return hint === REPORT_HINT_PROSE ? M.hintProse : M.hintTool
}

/**
 * The L1 report demand. This is the whole point of the guard: it converts
 * "silently grinding" into four answers that cannot be faked, and the fourth one
 * is exactly where a human decision can save an hour.
 *
 * @param hint - REPORT_HINT_TOOL when a `guard_report` tool exists (the native
 *   plugin), REPORT_HINT_PROSE when the model must answer in its reply (hooks).
 */
export function reportMessage(st, triggers, cfg, now, hint = REPORT_HINT_TOOL) {
  const M = messages(cfg?.locale)
  const elapsed = now - st.turnStart
  const lines = [M.reportHead(hhmmss(now))]
  lines.push(M.reportLine(st, elapsed, fmtDuration))
  for (const t of triggers) {
    const label = M.triggerLabel[t.kind] ?? t.kind
    lines.push(`- ${label}${t.n ? ` x${t.n}` : ''}${t.sample ? `: ${t.sample}` : ''}`)
  }
  lines.push(...M.reportAsk)
  lines.push(hintText(M, hint))
  return lines.join('\n')
}

/** The one-line half-budget checkpoint. ~60 tokens, needs no tool call. */
export function checkpointMessage(st, cfg, now) {
  const M = messages(cfg?.locale)
  return M.checkpoint(fmtDuration(st.budgetMs), fmtDuration(now - st.turnStart))
}

/**
 * The non-blocking budget request shown when the estimate is large.
 *
 * Only ever called when the user did NOT state a budget: asking "no budget means
 * 20min" right after a budget was written is self-contradictory. `effectiveMs` is
 * the budget actually in force, so the text states the same number the guard will
 * enforce.
 *
 * The closing sentence is the point of the whole project: the guard can only
 * react to a budget it was given, so the habit of stating one — not the tool — is
 * what actually saves the user's time.
 */
export function budgetAskMessage(estimate, effectiveMs, cfg) {
  const M = messages(cfg?.locale)
  const shown = effectiveMs === 0 ? 'unlimited' : `${Math.round(effectiveMs / 60000)}min`
  return M.budgetAsk(estimate, shown)
}

/** Model-facing deny reason for the lock. Actionable, not a nag. */
export function lockReason(st, triggers, cfg, now, hint = REPORT_HINT_TOOL) {
  const M = messages(cfg?.locale)
  const parts = triggers.map((t) => {
    const label = M.triggerLabel[t.kind] ?? t.kind
    return `${label}${t.n ? ` x${t.n}` : ''}${t.sample ? ` (${t.sample})` : ''}`
  })
  return M.lock(M.lockDetail(parts), hintText(M, hint)).join('\n')
}

/** Reason handed to the harness's cancel primitive at the hard stop. */
export function cancelReason(st, cfg, now) {
  const M = messages(cfg?.locale)
  return M.cancel(
    now - st.gateSince,
    st.reports,
    st.calls,
    now - st.turnStart,
    fmtDuration,
  )
}

/** Text returned by the `guard_report` tool when the four answers are unusable. */
export function rejectionMessage(missing, cfg) {
  return messages(cfg?.locale).rejected(missing)
}

/** Text returned by the `guard_report` tool when the report was recorded. */
export function recordedMessage(reports, cap, calls, spentMs, budgetMs, cfg) {
  const M = messages(cfg?.locale)
  const spent = fmtDuration(spentMs)
  const budget = budgetMs > 0 ? fmtDuration(budgetMs) : null
  return M.recorded(reports + 1, cap, calls, spent, budget)
}

/** Text returned by the `guard_report` tool in a session the guard does not track. */
export function noStateMessage(cfg) {
  return messages(cfg?.locale).noState
}
