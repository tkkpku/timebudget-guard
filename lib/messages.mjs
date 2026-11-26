/**
 * Model-facing text, per locale.
 *
 * Why this file exists: the guard's sentences are read by a language model, so
 * they have to match the language the model is working in — and a public package
 * cannot assume one. Every string the model sees lives here; `lib/core.mjs` only
 * decides *when* to say it. Default is English so the package works out of the
 * box for any user; `locale: 'zh'` selects Chinese.
 *
 * Placeholders are plain function arguments. No template engine, no dependency.
 */

const en = {
  reportLine: (st, elapsed, d) => st.budgetMs > 0
    ? `Budget ${d(st.budgetMs)}, elapsed ${d(elapsed)}${elapsed > st.budgetMs ? ' (over)' : ''}; ${st.calls} tool calls this turn.`
    : `${st.calls} tool calls this turn, elapsed ${d(elapsed)}, no budget.`,
  triggerLabel: {
    repeat: 'the same call repeated with the same output',
    'repeat-error': 'the same error repeated with nothing new in between',
    'no-progress': 'consecutive calls produced no new output',
    'over-budget': 'over the time budget',
  },
  reportHead: (clock) => `[timebudget-guard · L1 · ${clock}]`,
  reportAsk: [
    'Stop. Answer these four in order:',
    '(1) Goal: the one thing you are trying to achieve, in one sentence.',
    '(2) Blocker: the concrete uncertainty you are stuck on — "I do not know whether X is Y or Z", not "something may be wrong".',
    '(3) Next: two or three candidate steps, each with one sentence on its cost.',
    '(4) Decision: which one needs a human; write "none" if none does.',
  ],
  hintTool: 'Then call guard_report with the four answers. Until you do, write / edit / shell / subagent calls are refused; read tools and ask tools still work.',
  hintProse: 'Put the four answers directly in your reply — this deployment has no guard_report tool, so the reply IS the report. Until you do, write / edit / shell calls are refused; read tools and ask tools still work.',
  checkpoint: (budget, elapsed) => `[checkpoint] Half the budget is gone (${budget} → ${elapsed}). Ignore this line if the original goal still holds; if the direction has drifted, say where in one sentence and continue.`,
  budgetAsk: (estimate, shown) => `[budget] Rough estimate for this task: ${estimate}min. Current budget: ${shown}.`
    + ' Reply with "budget 30min" to change it ("budget 0" = no limit); otherwise the current one stands.'
    + ' Stating a budget when you assign the task is the single biggest time saver: the guard reports the moment the budget is spent, instead of after the work has already gone sideways.',
  lockDetail: (parts) => parts.length > 0 ? parts.join('; ') : 'the gate is open',
  lock: (detail, hint) => [
    `[timebudget-guard · L2] Write, shell and subagent calls are locked. Trigger: ${detail}.`,
    hint,
    'If the blocker needs a human call, the ask tool still works — now is exactly the time to use it.',
    'read / grep / glob still work for evidence gathering, but repeating them will not unlock the gate.',
  ],
  cancel: (waitMs, reports, calls, elapsed, d) => `timebudget-guard: the report gate went unanswered for ${d(waitMs)}`
    + (reports > 0 ? `, after ${reports} report(s) it was still grinding` : '')
    + `; ${calls} calls / ${d(elapsed)} this turn. Turn stopped, session kept — one line from you resumes it.`,
  rejected: (missing) => `Rejected: ${missing.join(', ')} missing or too short. The four answers are the gate's only evidence; filler does not pass. Fix and call guard_report again.`,
  recorded: (n, cap, calls, spent, budget) => `Recorded (report ${n} this turn, hard cap ${cap}). The gate opens when this call settles; write and exec are available again.\n`
    + `This turn: ${calls} calls / ${spent}${budget !== null ? ` / budget ${budget}` : ' / no budget'}.\n`
    + 'Before continuing: if the decision is not "none", wait for the human. Do not decide it for them.',
  noState: 'timebudget-guard: no session state (subagent, or the plugin is not mounted). This report was not recorded and the gate will not open because of it.',
}

const zh = {
  reportLine: (st, elapsed, d) => st.budgetMs > 0
    ? `预算 ${d(st.budgetMs)}，已用 ${d(elapsed)}${elapsed > st.budgetMs ? '（已超）' : ''}；本轮 ${st.calls} 次工具调用。`
    : `本轮 ${st.calls} 次工具调用，已用 ${d(elapsed)}，不限时。`,
  triggerLabel: {
    repeat: '同一个调用连同输出一起重复',
    'repeat-error': '同一个错误连续出现',
    'no-progress': '连续调用没有产生任何新输出',
    'over-budget': '超出时间预算',
  },
  reportHead: (clock) => `[timebudget-guard · L1 · ${clock}]`,
  reportAsk: [
    '停手，按顺序答完这四问：',
    '(1) 目标：要达成的那一件事，一句话。',
    '(2) 卡点：当前卡在哪个事实上的不确定——不是"可能有问题"，是"我不知道 X 是 Y 还是 Z"。',
    '(3) 下一步：两到三个候选做法，各写一句代价。',
    '(4) 决策：哪一个必须人拍板；一个都不用就写"无需决策"。',
  ],
  hintTool: '然后调用 guard_report 把四项填进去。在此之前 write / edit / 命令执行 / 开子智能体全部被拒；读类工具与询问工具照常可用。',
  hintProse: '把上面四项直接写进回复正文——本形态没有 guard_report 工具，正文就是汇报。在此之前 write / edit / 命令执行会被拒；读类工具与询问工具照常可用。',
  checkpoint: (budget, elapsed) => `[检查点] 预算过半（${budget} 用掉 ${elapsed}）。原目标仍成立就忽略本行继续；若方向已偏，一句话说明偏在哪，再继续。`,
  budgetAsk: (estimate, shown) => `[预算] 本任务粗估约 ${estimate}min，当前按 ${shown} 计。`
    + '下一条消息写「预算 30min」可改（「预算 0」= 不限时）；不写就按现在的继续。'
    + '派任务时先声明预算是最省时间的习惯：预算一到就报到，而不是等跑偏了才发现。',
  lockDetail: (parts) => parts.length > 0 ? parts.join('；') : '报到闸已开',
  lock: (detail, hint) => [
    `[timebudget-guard · L2] 写文件、命令执行与开子智能体已锁定。触发原因：${detail}。`,
    hint,
    '若卡点需要人拍板，询问工具仍然可用——现在正是该问的时候。',
    'read、grep、glob 仍可用，用于取证；但重复取证不会解锁。',
  ],
  cancel: (waitMs, reports, calls, elapsed, d) => `timebudget-guard: 报到闸开启 ${d(waitMs)} 未被回应`
    + (reports > 0 ? `，已交 ${reports} 份汇报后仍在打转` : '')
    + `；本轮 ${calls} 次调用 / ${d(elapsed)}。已停轮，会话保留，回一句话即可续。`,
  rejected: (missing) => `驳回：${missing.join('、')} 没填或太短。四问是闸门的唯一凭据，空话不放行。重填后再调 guard_report。`,
  recorded: (n, cap, calls, spent, budget) => `已入册（本轮第 ${n} 份，硬上限 ${cap}）。闸门在本次调用结算后放开，可继续 write 与执行。\n`
    + `本轮 ${calls} 次调用 / ${spent}${budget !== null ? ` / 预算 ${budget}` : ' / 不限时'}。\n`
    + '继续之前：若决策点不是"无需决策"，等人回话，不要自己替他拍板。',
  noState: 'timebudget-guard: 无会话状态（子智能体或插件未挂载）。汇报未入册，闸门不会因本次调用而开。',
}

/** The two complete tables. Exposed so a test can assert parity. */
export const TABLES = Object.freeze({ en, zh })

/**
 * Pick a message table. An unknown locale falls back to English rather than
 * throwing: a typo in a config file must not take the guard down.
 * @param {string | undefined} locale - 'en' | 'zh' (case-insensitive).
 */
export function messages(locale) {
  const key = String(locale ?? 'en').toLowerCase()
  return TABLES[key] ?? TABLES.en
}

/** Field names each table must define; used by the parity test. */
export const REQUIRED_FIELDS = Object.keys(en)
