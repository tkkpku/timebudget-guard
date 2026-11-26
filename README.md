# timebudget-guard

An agent that silently grinds burns your hour, and you find out only when it
either finishes or gives up. This guard makes the overrun an event: it watches a
wall-clock budget plus three stuck-patterns, and when one fires it **locks
writes and shell** until the agent reports four specific things.

Three deployment shapes, one core:

| Shape | For | Strength |
| --- | --- | --- |
| `lib/index.mjs` | DeepSeek Harness (Cordis plugin API) | full: deny calls, inject mid-request lines, cancel the turn |
| `hooks/hook.mjs` | Claude Code, Codex, any Claude Code / Codex dialect hook host | partial: deny calls, attach context to the next request, block `Stop` |
| `rules/AGENTS-snippet.md` | anything else | convention only: no enforcement |

Zero dependencies. No build step. Node 20+.

## The one habit that matters

**State a time budget when you assign the task.**

```
budget 20min: refactor the auth module and add tests
预算 20min：把这几个接口对齐
```

Without a budget the guard defaults to 20 minutes, but it cannot know that *this
particular* task was supposed to take five. A five-minute task that quietly runs
to ten only gets caught when the default budget runs out — the guard has no prior
for "how long this should have taken", and the coarse estimate available to it is
far too crude to use as a deadline.

With a budget, the moment the clock is spent becomes an event the agent has to
answer for. `budget 0` means unlimited. A bare "continue" keeps the previous
budget, so acknowledging the agent never resets the clock.

This habit is worth more than the tool. The tool can only react to a budget it
was given.

## What it watches

Four signals. The first three are **sliding-window** rules over the trailing
calls, never cumulative counters — 500 productive calls cannot add up to a false
positive, because the window only ever holds the tail.

| Signal | Default | Meaning |
| --- | --- | --- |
| `repeat` | same call ×3 with the same output | not moving |
| `repeat-error` | same error ×2 with nothing new in between | same wall, twice |
| `no-progress` | 12 consecutive calls produced no new output | spinning |
| `over-budget` | budget spent (re-arms once per full budget) | out of time |

What does *not* trip it: reading 400 different files, running the same test
command 20 times with different failures, twelve different images. Those are
work. `test/core.test.mjs` B1/B2 and `test/integration.test.mjs` 9 pin those
non-regressions.

Direction drift is deliberately **not** inferred from keywords. That class of
rule misfires on honest work, and a guardrail that cries wolf gets ignored. The
half-budget checkpoint asks the model to restate the goal in one line instead —
about 60 tokens, no interruption, no extra round-trip.

## What happens when it fires

| Level | Action |
| --- | --- |
| checkpoint | one line at half budget: "goal still valid, or where did it drift" |
| L1 | the four questions below, attached to the next request |
| L2 | `write` / `edit` / shell / subagent calls are **denied**; read, ask and unknown/MCP tools stay open |
| unlock | only a complete report; vague answers are rejected |
| hard stop | native plugin only: cancel the turn after the gate goes unanswered |

The four questions, which are the entire point:

1. **Goal** — the one thing you are trying to achieve, in one sentence.
2. **Blocker** — the concrete uncertainty: "X is Y or Z", not "something may be wrong".
3. **Options** — two or three candidate steps, each with one sentence on its cost.
4. **Decision** — which one needs a human, or "none".

The gate blocks exactly three classes: mutations, shell, and subagents — the ones
that change the world or spawn more autonomous work. It leaves the ask tool open,
because asking the human is precisely what the gate wants. It leaves unknown tool
names open too: an allowlist of "known safe" names silently misjudges every MCP
and plugin tool, and the hard stop is the backstop.

## Install

### DeepSeek Harness (native plugin)

Mount by path from a profile patch — no `npm install`, the package imports nothing
bare:

```yaml
- insert:
    - id: timebudget-guard
      name: ../../../timebudget-guard/lib/index.mjs
      config:
        locale: en            # or zh
        budgetDefaultMinutes: 20
        logPath: /path/to/timebudget-guard.jsonl   # optional evidence log
```

Config is validated field by field; out-of-range values fall back to the default
instead of refusing to mount.

### Claude Code / Codex (portable hook)

Point the hook config at `hooks/hook.mjs`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /abs/path/timebudget-guard/hooks/hook.mjs" }] }],
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /abs/path/timebudget-guard/hooks/hook.mjs" }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /abs/path/timebudget-guard/hooks/hook.mjs" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "node /abs/path/timebudget-guard/hooks/hook.mjs" }] }]
  }
}
```

Environment: `TIMEBUDGET_STATE_DIR` (per-session state), `TIMEBUDGET_LOCALE`
(`en` / `zh`), `TIMEBUDGET_DEFAULT_MIN`, `TIMEBUDGET_LOG`.

### Anything else

Paste `rules/AGENTS-snippet.md` into your instructions file. It is a convention,
not enforcement.

## Configuration

| Field | Default | Notes |
| --- | --- | --- |
| `budgetDefaultMinutes` | 20 | used when the task states none; 0 = unlimited |
| `estimateThresholdMinutes` | 15 | ask for a budget only when the estimate reaches this |
| `dupLimit` | 3 | `repeat` window |
| `errLimit` | 2 | `repeat-error` window |
| `stallLimit` | 12 | `no-progress` window |
| `checkpointRatio` | 0.5 | where the half-budget line fires |
| `l3AfterMs` | 180000 | unanswered gate before the turn is cancelled |
| `sweepIntervalMs` | 15000 | how often that is checked |
| `maxReports` | 5 | reports per turn before the turn is cancelled |
| `logPath` | empty | JSONL evidence log; empty disables it |
| `rootOnly` | true | guard root sessions only |
| `locale` | `en` | `en` / `zh` |

The retained window grows with the limits (`windowSize`), so raising
`stallLimit` to 200 works instead of becoming silently dead configuration.

## Tests

```bash
npm test          # core (23) + integration (13)
npm run test:hook # hook dialect, real child processes (9)
node test/messages.test.mjs  # locale parity + leak check (6)
npm run scenarios # prints what a user sees for six task shapes
```

Everything runs on bare `node`, no install, no framework.

## Known limits

- Only tool calls are observed. A model that thinks in circles without calling
  anything is invisible to every signal here.
- The budget is per turn and per message, not per task. A five-minute task will
  not be flagged at ten minutes unless you stated a five-minute budget.
- Empty tool output is treated as neutral rather than progress: a silent but
  productive tool cannot accumulate a false stall, at the cost of `no-progress`
  not catching a silent loop (the same call repeated still trips `repeat`).
- `over-budget` re-arms once per full budget window, so a task that runs to three
  times its budget is reported twice, not continuously.
- The hook shape cannot cancel a turn: the protocol records `{"continue": false}`
  and ignores it. Blocking `Stop` is the closest available lever.
- The native plugin is mounted by path and lives in-process: restart the host
  after changing the code.
- No UI. Evidence goes to `logPath` as JSONL.

## License

MIT
