/**
 * timebudget-guard — make a silently-grinding agent report before it burns the
 * user's hour.
 *
 * Two shapes share one core (`lib/core.mjs`):
 *
 *   - THIS FILE: a native plugin for the DeepSeek Harness (Cordis). It sees the
 *     agent's own behaviour and can act inside the process: deny a call, attach
 *     context to the next request, inject a line into the request being built,
 *     and cancel a turn.
 *   - `hooks/hook.mjs`: one process per call, usable by any harness that speaks
 *     the Claude Code or Codex hook dialect. Weaker by construction (no turn
 *     cancellation, no same-request injection) but portable.
 *
 * Seams used here:
 *
 *   agent/inbox/claimed -> new real user message: open a measurement window
 *   agent/pre-step      -> inject the budget ask / half-budget checkpoint
 *   tools/pre-execute   -> the lock: deny write & exec while the gate is open
 *   tools/post-execute  -> observe settled calls; open the gate on a stuck pattern
 *   interval            -> hard stop when an ignored gate runs too long
 *
 * Zero external imports on purpose: mounted by path from a profile patch, where
 * bare `@deepseek-ai/*` specifiers do not resolve.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  armBudget,
  budgetAskMessage,
  cancelReason,
  checkpointMessage,
  classify,
  collectTriggers,
  contentText,
  createSessionState,
  estimateMinutes,
  extractBudgetMinutes,
  fmtDuration,
  isContinueMessage,
  isLocked,
  lockReason,
  normalizeConfig,
  noStateMessage,
  observe,
  recordedMessage,
  rejectionMessage,
  reportMessage,
  resetTurn,
  resetWindow,
} from './core.mjs'

export const name = 'timebudget-guard'
export const inject = ['tools']

/** Producer source stamped on every message this plugin injects. */
const SOURCE = { kind: 'plugin:timebudget-guard' }

const pad = (n, w = 2) => String(n).padStart(w, '0')

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** One-line description of a call for the report evidence list. */
function summarizeCall(toolName, args) {
  const a = args ?? {}
  const pick = a.command ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? a.description ?? a.task
  if (typeof pick !== 'string' || pick === '') return String(toolName)
  const one = pick.replace(/\s+/g, ' ').trim()
  return one.length > 120 ? `${one.slice(0, 120)}...` : one
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  /** session id -> guard state. */
  const states = new Map()
  /** session id -> live Agent handle, used only for cancellation. */
  const agents = new Map()

  function log(record) {
    if (cfg.logPath === '') return
    try {
      mkdirSync(dirname(cfg.logPath), { recursive: true })
      appendFileSync(cfg.logPath, `${JSON.stringify({ ts: stamp(), ...record })}\n`, 'utf8')
    } catch {
      // evidence logging must never break a tool call
    }
  }

  function stateOf(agent) {
    const session = agent?.session
    if (session === undefined || session === null) return undefined
    let st = states.get(session.id)
    if (st === undefined) {
      st = createSessionState(session.id)
      states.set(session.id, st)
    }
    agents.set(session.id, agent)
    return st
  }

  function isChild(agent) {
    return agent?.session?.header?.parentSession !== undefined
  }

  // ── new real user message: a fresh measurement window ──────────────────────
  // This touches ONLY the guard's own counters - never session history - so it
  // cannot affect the model's context, plan, or files. Nothing the model sees
  // changes; only the budget clock restarts.
  //
  // Budget carry-over: a bare "continue" is the same task, so it keeps the
  // previous budget instead of handing out a fresh window on every reply.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message?.source?.kind !== 'user') return
    if (cfg.rootOnly && isChild(agent)) return
    const st = stateOf(agent)
    if (st === undefined) return

    const text = contentText(message.content)
    const explicit = extractBudgetMinutes(text)
    const carry = st.budgetMs
    const budgetMs = explicit === null
      ? (isContinueMessage(text) && carry > 0 ? carry : cfg.budgetDefaultMinutes * 60000)
      : explicit === 0 ? 0 : explicit * 60000

    resetTurn(st, Date.now())
    armBudget(st, budgetMs)
    st.budgetSource = explicit === null ? 'default' : explicit === 0 ? 'unlimited' : 'user'
    st.estimate = estimateMinutes(text)
    st.askedBudget = false
    log({ ev: 'turn', sid: st.id, budgetMs, source: st.budgetSource, estimate: st.estimate })
  })

  // ── pre-step: budget ask and the cheap half-budget checkpoint ──────────────
  // Both ride the SAME request as the user message (near-field, cache-neutral,
  // zero extra round-trips) - the only way to say anything mid-turn for free.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    if (cfg.rootOnly && isChild(agent)) return decision
    const st = stateOf(agent)
    if (st === undefined) return decision

    const now = Date.now()
    const extra = []

    // Ask only when the user did not state a budget - otherwise the line would
    // report a default the guard is not actually enforcing. The number and the
    // sentence must come from the same source, so the message takes the
    // effective budget.
    if (!st.askedBudget && st.budgetSource === 'default' && st.estimate >= cfg.estimateThresholdMinutes) {
      st.askedBudget = true
      extra.push(budgetAskMessage(st.estimate, st.budgetMs, cfg))
    }
    if (st.budgetMs > 0 && !st.checkpointDone && now - st.turnStart >= st.budgetMs * cfg.checkpointRatio) {
      st.checkpointDone = true
      extra.push(checkpointMessage(st, cfg, now))
    }
    if (extra.length === 0) return decision

    const messages = Array.isArray(decision.messages) ? decision.messages : []
    const added = extra.map((text, i) => ({
      id: `timebudget-pre-${st.id.slice(0, 12)}-${now}-${i}`,
      role: 'user',
      source: SOURCE,
      content: [{ type: 'text', text }],
    }))
    return { ...decision, messages: [...messages, ...added] }
  })

  // ── the lock: the deliverable is a report, not a permission prompt ─────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec?.agent
    if (agent === undefined) return next()
    if (cfg.rootOnly && isChild(agent)) return next()
    // Lazy: a resumed session never re-fires `agent/inbox/claimed`, and a guard
    // that silently stops working after a resume is worse than no guard.
    const st = stateOf(agent)
    if (st === undefined || !st.reportPending) return next()

    const action = classify(exec.name)
    if (!isLocked(action)) return next()

    const now = Date.now()
    const triggers = collectTriggers(st, cfg, now)
    log({ ev: 'deny', sid: st.id, tool: exec.name, action, triggers: triggers.map((t) => t.kind) })
    return { kind: 'deny', reason: lockReason(st, triggers, cfg, now) }
  })

  // ── observe settled calls; open the gate on a stuck pattern ────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const agent = exec?.agent
    if (agent === undefined) return downstream
    if (cfg.rootOnly && isChild(agent)) return downstream
    // Lazy: resume never re-fires `agent/inbox/claimed`; without this the guard
    // would quietly stop observing after a reload.
    const st = stateOf(agent)
    if (st === undefined) return downstream

    const now = Date.now()
    const { action } = observe(st, {
      name: exec.name,
      args: exec.arguments,
      text: contentText(result?.content),
      isError: result?.isError === true,
      summary: summarizeCall(exec.name, exec.arguments),
    }, cfg, now)

    // guard_report is the ONLY unlock, and only when it validated the answers.
    if (action === 'report') {
      if (!st.reportAccepted) return downstream
      st.reports++
      resetWindow(st, now)
      log({ ev: 'report-accepted', sid: st.id, reports: st.reports })
      return downstream
    }

    if (st.reportPending || st.cancelled) return downstream

    const triggers = collectTriggers(st, cfg, now)
    if (triggers.length === 0) return downstream

    st.reportPending = true
    st.gateSince = now
    st.triggers = triggers.map((t) => t.kind)
    log({ ev: 'gate-open', sid: st.id, triggers: st.triggers, calls: st.calls, reports: st.reports })

    // Over-budget must not re-arm on every later call: advance the mark past now,
    // so the next firing is a full budget window later.
    if (st.budgetMs > 0) {
      while (st.budgetNextFire > 0 && now - st.turnStart >= st.budgetNextFire) {
        st.budgetNextFire += st.budgetMs
      }
    }

    if (st.reports >= cfg.maxReports) {
      st.cancelled = true
      const reason = cancelReason(st, cfg, now)
      log({ ev: 'cancel-max-reports', sid: st.id, reports: st.reports })
      try { agent.cancel({ kind: 'hook', reason }) } catch { /* already settling */ }
      return downstream
    }

    const message = {
      id: `timebudget-l1-${st.id.slice(0, 12)}-${st.calls}-${now}`,
      role: 'user',
      source: SOURCE,
      content: [{ type: 'text', text: reportMessage(st, triggers, cfg, now) }],
    }
    return { ...downstream, additionalContexts: [message, ...(downstream?.additionalContexts ?? [])] }
  })

  // ── hard stop: a gate nobody answered ─────────────────────────────────────
  // A tool-side timer, not a model-side one: if the model keeps reading, no
  // pre-step happens, and the turn must still stop.
  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [sid, st] of states) {
        if (!st.reportPending || st.cancelled || st.gateSince === 0) continue
        if (now - st.gateSince < cfg.l3AfterMs) continue
        st.cancelled = true
        const reason = cancelReason(st, cfg, now)
        log({ ev: 'cancel-l3', sid, sinceMs: now - st.gateSince })
        try { agents.get(sid)?.cancel({ kind: 'hook', reason }) } catch { /* already settling */ }
      }
    }, cfg.sweepIntervalMs)
    // Never hold the process (or a test run) alive just to watch for a gate.
    timer.unref?.()
    return () => clearInterval(timer)
  })

  // ── the report tool: the only unlock ──────────────────────────────────────
  // Registered globally (one definition, one schema slot in every session). In a
  // subagent session it is a no-op: guard state is keyed by root sessions only,
  // so a subagent cannot report on - or unlock - its parent's gate.
  ctx.effect(() => ctx.tools.register({
    name: 'guard_report',
    description: 'The only unlock for the time-budget gate. Stop and answer all four questions: goal, the concrete uncertainty you are stuck on, two or three candidate next steps each with its cost, and which decision needs a human. Vague answers are rejected.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The one thing you are trying to achieve, in one sentence.' },
        blocker: { type: 'string', description: 'The concrete uncertainty you are stuck on: "I do not know whether X is Y or Z", not "something may be wrong".' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Two or three candidate next steps, each with one sentence on its cost.',
        },
        decision: { type: 'string', description: 'The decision a human must make; write "none" when there is none.' },
      },
      required: ['goal', 'blocker', 'options', 'decision'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute(args, exec) {
      const agent = exec?.agent
      const st = agent === undefined ? undefined : states.get(agent.session?.id)
      if (st === undefined) return noStateMessage(cfg)

      const goal = String(args?.goal ?? '').trim()
      const blocker = String(args?.blocker ?? '').trim()
      const decision = String(args?.decision ?? '').trim()
      const options = Array.isArray(args?.options) ? args.options.map((o) => String(o).trim()).filter(Boolean) : []

      const missing = []
      if (goal.length < 4) missing.push('goal')
      if (blocker.length < 6) missing.push('blocker')
      if (options.length < 2) missing.push('at least two candidate steps')
      if (decision.length < 2) missing.push('decision')
      if (missing.length > 0) return rejectionMessage(missing, cfg)

      st.reportAccepted = true
      log({ ev: 'report', sid: st.id, goal, blocker, options, decision, calls: st.calls })
      return recordedMessage(st.reports, cfg.maxReports, st.calls, Date.now() - st.turnStart, st.budgetMs, cfg)
    },
  }))
}

// `fmtDuration` is imported for the type of the recorded message only; keep the
// import list honest about what this file uses.
void fmtDuration
