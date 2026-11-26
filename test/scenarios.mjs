/**
 * Scenario simulator: replays six representative task shapes through the REAL
 * core functions on a synthetic clock, and prints what the user would actually
 * see. The point is to make the behaviour falsifiable instead of prose: every
 * number below comes out of the shipped code, not from a description of it.
 *
 * Modelling assumptions (stated so they can be challenged):
 *   - A turn starts on the user's message; the budget is the shipped default
 *     unless the message states one (extracted with the real parser).
 *   - One "tool call" advances the clock by CALL_MS. A 5-minute task at ~20s per
 *     call is 15 calls; a 60-minute task is 180. That ratio is a guess about the
 *     user's machine, NOT a claim from the code.
 *   - pre-step injections are simulated at step boundaries: the budget question
 *     fires on the first call, the checkpoint on the first call after half the
 *     budget. In a real agent run both ride the request being assembled, so they
 *     cost no extra round-trip.
 *
 * Run: node test/scenarios.mjs [en|zh]
 */

import {
  armBudget,
  budgetAskMessage,
  checkpointMessage,
  collectTriggers,
  createSessionState,
  estimateMinutes,
  extractBudgetMinutes,
  fmtDuration,
  normalizeConfig,
  observe,
  reportMessage,
  resetTurn,
  resetWindow,
} from '../lib/core.mjs'

const LOCALE = process.argv[2] ?? 'zh'
const cfg = normalizeConfig({ locale: LOCALE })
const CALL_MS = 20000 // ~20s per tool call
const MIN = 60000

function run(label, { prompt, calls, stuckFrom = null }) {
  const st = createSessionState('sim')
  const t0 = 0
  resetTurn(st, t0)
  const explicit = extractBudgetMinutes(prompt)
  const budgetMs = explicit === null ? cfg.budgetDefaultMinutes * MIN
    : explicit === 0 ? 0 : explicit * MIN
  armBudget(st, budgetMs)
  st.estimate = estimateMinutes(prompt)

  const events = []
  let asked = false
  let checkpointed = false

  for (let i = 0; i < calls; i++) {
    const now = t0 + i * CALL_MS

    if (!asked && st.estimate >= cfg.estimateThresholdMinutes) {
      asked = true
      events.push({ at: now, kind: 'budget ask', text: budgetAskMessage(st.estimate, st.budgetMs, cfg) })
    }
    if (budgetMs > 0 && !checkpointed && now - st.turnStart >= budgetMs * cfg.checkpointRatio) {
      checkpointed = true
      events.push({ at: now, kind: 'checkpoint', text: checkpointMessage(st, cfg, now) })
    }

    // One settled call. Output varies unless the scenario says the work is stuck.
    const stuck = stuckFrom !== null && i >= stuckFrom
    observe(st, {
      name: 'bash',
      args: { command: 'build' },
      text: `step ${stuck ? 0 : i} ok`,
      isError: false,
      summary: 'bash build',
    }, cfg, now)

    if (st.reportPending) continue
    const triggers = collectTriggers(st, cfg, now)
    if (triggers.length === 0) continue

    st.reportPending = true
    st.gateSince = now
    events.push({
      at: now,
      kind: 'L1 gate',
      triggers: triggers.map((t) => t.kind),
      text: reportMessage(st, triggers, cfg, now).split('\n').slice(0, 2).join(' / '),
    })
    if (budgetMs > 0) {
      while (st.budgetNextFire > 0 && now - st.turnStart >= st.budgetNextFire) st.budgetNextFire += st.budgetMs
    }
    // Well-behaved case: the model answers immediately.
    st.reports++
    resetWindow(st, now)
    events.push({ at: now, kind: 'report + unlock', text: 'four answers recorded' })
  }

  console.log(`\n=== ${label} ===`)
  console.log(`prompt: ${prompt.slice(0, 52)}${prompt.length > 52 ? '...' : ''}`)
  console.log(`estimate ${st.estimate}min - budget ${budgetMs === 0 ? 'unlimited' : fmtDuration(budgetMs)} - ${calls} calls ~= ${fmtDuration(calls * CALL_MS)}`)
  if (events.length === 0) console.log('  (silent: no injection, no gate)')
  for (const e of events) {
    const tag = e.triggers ? ` [${e.triggers.join(',')}]` : ''
    console.log(`  ${fmtDuration(e.at).padStart(8)}  ${e.kind}${tag}`)
  }
}

run('1 - 5min task, finishes on time', { prompt: 'rename the variables in this function', calls: 15 })
run('2 - 15min task, finishes on time', { prompt: 'add unit tests to this module and make them pass', calls: 45 })
run('3 - 60min+ task, budget stated', { prompt: 'budget 60min: refactor the whole plugin and add regression coverage', calls: 200 })
run('4 - 5min task that runs to 10min+, no repeats', { prompt: 'rename the variables in this function', calls: 32 })
run('5 - 15min task that runs to 40min+, no repeats', { prompt: 'add unit tests to this module and make them pass', calls: 125 })
run('6 - budget 50min, actually 90min', { prompt: 'budget 50min: align the interfaces of these three subsystems', calls: 270 })
run('7 - control: stuck from call 6', { prompt: 'fix this build error', calls: 20, stuckFrom: 6 })
