# Loop intelligence — six upgrades that made the loop smarter

Companion to [`LOOP_DESIGN.md`](./LOOP_DESIGN.md). Six behaviours, each
with its own module, its own off-switch, and its own tests. All are on by
default; turn any off in `~/.aipass/settings.json` (`dynamicBudget`,
`independentVerify`, `loopStatePersist`) or per run (`dynamicBudget: false`
and friends). They read evidence, never intent: the loop still runs the call
as written first.

| # | behaviour | module | off-switch | run_stats |
|---|---|---|---|---|
| 1 | **Failure classification** — every `err:` result is read as `model`, `tool`, `environment` or `unknown` | `aipass-bridge/harness/failure.mjs` | — (reading only) | `failureCounts` |
| 2 | **Adaptive retry** — attempt 1 diagnoses, attempt 2 tries a different approach, attempt 3 escalates | `harness/failure.mjs#retryHint` | — (rider on the err-loop correction) | `adaptiveRetries` |
| 3 | **Recovery planning** — after a failure the next step carries an ordered plan: isolate → diagnose → alternatives → fallback | `harness/failure.mjs#recoveryPlan` | — (rider on the same correction) | — (the plan rides the message) |
| 4 | **Independent verification** — the checker’s verdict is audited against staged files, ran executions and the declared command; a `pass` without evidence becomes `none` | `aipass-bridge/harness/verify-evidence.mjs` | `independentVerify: false` | `independentChecks`, `independentVerdict` |
| 5 | **Dynamic budget** — the allowance scales 0.3× / 1× / 2× by task difficulty (simple / standard / complex) | `aipass-bridge/harness/run/budgets.mjs#scoreDifficulty`, `#budgetsForTier` | `dynamicBudget: false` | `budgetTier`, `budgetScore` |
| 6 | **Loop state persistence** — an atomic snapshot of the guard counters after every step, outside the project; a crash leaves it, a clean end clears it | `aipass-bridge/harness/loop-state.mjs` | `loopStatePersist: false` | `loopStateSaved`, `loopStateRestored` |

## 1–3. Failure, retry, recovery (`failure.mjs`)

`classifyFailure(call, text)` orders the reading environment → model →
tool. Error codes and missing binaries are environment; a reply that did
not parse as a marker is a model error; a tool that heard the call and
could not do it is a tool error. The loop counts `failureCounts` by class
and, on the second and third failure of a streak, appends an
`Adaptive retry (<class>, attempt <n>`)` hint from `retryHint` — attempt 2
is a different approach by construction, never the same sentence as
attempt 1. On the third it also appends the `Recovery plan` from
`recoveryPlanText`, so a failed step is followed by what to do instead,
not a bare "try again". The err-loop correction’s old sentence
("third call in a row…") is unchanged; the plan rides after it.

## 4. Independent verification (`verify-evidence.mjs`)

`finishCheck` (run/gates.mjs) runs the checker, then audits the verdict
with `auditCheckResult`: staged files, ran executions, declared command.
Only a `pass` is ever downgraded — to `none`, with the reason named
(`evidenceNote`) — and a `fail` is always kept. The check cap is
unchanged (two verdicts a run); the audit runs inside each one.

## 5. Dynamic budget (`run/budgets.mjs`)

`scoreDifficulty(task)` reads length, named files, multi-step verbs and
breadth words (including Thai: `ทั้งหมด`, `ทุกไฟล์`) into
`simple` / `standard` / `complex`. `budgetsForTier` scales the base
0.3× / 1× / 2× (floors 30 tools / 3 min, caps 2000 / 2 h) and never
raises a deliberately small base. `applyDynamicBudget` writes the scaled
numbers into `run.sheet` before the first send and records them; the
loop reads `run.sheet` each step, so the whole loop sees the scaled
allowance. A tier that is not standard is said once in a session note.

## 6. Loop state persistence (`loop-state.mjs`)

After every executed step the loop writes
`~/.aipass/run/<project-key>/loop-state.json` atomically
(`writeFileAtomic`, mode 0600): tool counts, streaks, todo, staged list,
failure counts, budget tier. On the next run with the same task the
snapshot is restored (`restoreLoopState`) so guards continue; a torn,
stale (>24 h), foreign or newer-version file is ignored. Any run that
actually ran and ended cleanly clears its snapshot — the file only
survives a death that never reached the end. Helpers and the checker are
session-less runs: they never restore or write.

## Tests

- `test/failure-adaptive.test.mjs` — classification, adaptive hints,
  recovery plan, plus loop tests for the streak-2 and streak-3 corrections.
- `test/dynamic-budget.test.mjs` — scoring tiers, scaling, switches.
- `test/verify-evidence.test.mjs` — audit downgrades, plus a lying
  checker (`pass` over zero runs → `none`) end to end.
- `test/loop-state.test.mjs` — round-trip, torn/stale/foreign ignored,
  save-every-step and clear-on-clean-end, restore into a second run.

Status: experimental — shipped on by default, off-switches per row.
Promote when a live run names them in a report.
