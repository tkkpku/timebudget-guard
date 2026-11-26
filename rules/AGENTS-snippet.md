# Time-budget discipline — drop-in rule pack

For harnesses where you cannot install a plugin or a hook: paste the block below
into your global agent instructions (`AGENTS.md`, `CLAUDE.md`, `system prompt`,
custom instructions — whichever your tool reads). It is a convention, not
enforcement. Use the plugin or the hook when you want the guardrail to actually
stop the run.

---

## The one habit that matters

**State a time budget when you assign the task.** One clause, on the same line:

```
budget 20min: refactor the auth module and add tests
预算 20min：把这几个接口对齐
```

Without a budget, the agent has no clock to run against and cannot tell you when
it is overrunning — it only knows when it has *finished*, which is exactly the
case where the hour is already gone. With a budget, the overrun becomes an
event the agent can be made to report.

`budget 0` means unlimited. A bare "continue" keeps the previous budget rather
than starting a fresh one, so acknowledging the agent does not reset the clock.

## What the agent must do

Paste this into the instructions file:

```
## Time budget

1. Read the time budget from the task. Forms: "budget 20min", "预算 20min",
   "20min limit", "20 分钟内". A stated budget always wins over any default.
2. If no budget is stated and the task looks larger than ~15 minutes of work,
   ask for one in a single line, then continue with a default.
3. Report progress at the halfway mark in one line: goal still valid, or where
   the direction drifted.
4. When the budget is spent, stop and report before continuing. Report exactly:
   - goal: the one thing you are trying to achieve, in one sentence
   - blocker: the concrete uncertainty (X is Y or Z, not "something may be wrong")
   - options: two or three candidate next steps, each with its cost
   - decision: which one needs a human, or "none"
5. Do not silently exceed the budget. Going over is allowed only as an explicit,
   stated decision in that report.
6. The same three stuck-patterns count as an overrun even before the clock runs
   out: the same call with the same output three times in a row, the same error
   twice in a row with nothing new in between, or twelve consecutive calls that
   produced no new output.
```

## Why the four questions

The point of stopping is not to confess, it is to hand the human a decision they
can make in ten seconds. "I'm stuck" costs a round-trip and produces nothing.
"Goal is X, I don't know whether the config resolves from dist or src, options
are A / B with these costs, you pick" lets the human answer in one line and the
work continues. That is the entire time saving.

## What this pack does not do

Nothing here is enforced. A model that ignores the instruction will keep going,
and you will find out at the same time you would have without it. If you want the
run to actually stop, use the native plugin (harnesses with a Cordis-style
in-process plugin API) or the hook (any harness that speaks the Claude Code /
Codex hook dialect).
