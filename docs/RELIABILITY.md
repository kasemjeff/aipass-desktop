# Reliability

What "this install is healthy" means, in numbers the commands already print.
There is no server and no fleet — these targets are for one local install, and
the only honest availability is the chain: account → tab → bridge → backend.

## The SLIs, and where each is measured

| signal | what it is | measured by | target |
|---|---|---|---|
| run success | share of runs that end `done` with no guard stop | `npm run evals -- --all --live --attempts 3` (`outcome` + `stop`) | guard-stop share < 25% · tool refusal rate < 30% (read from the eval rows) |
| local API | p95 latency, failed requests, RSS growth of the backend | `npm run loadtest -- --strict` (400 calls at 25 in flight) | p95 ≤ 250 ms · no failures · RSS +≤ 150 MB |
| chain availability | bridge up, extension attached, signed in, one round trip | `npm run verify` (exit 0) · the bridge status line (`extension: 0 connected` means the tab is gone) · the window banner | verify green on the release machine |
| upstream step | seconds per model turn | the eval rows' `wallMs`/`stepMs` median (`npm run evals -- --all --live --attempts 3`) | reported, not targeted — upstream-controlled |
| drift | refusal / guard / cost / firewall signals | `npm run evals:compare` gates on the eval result files (`docs/SPEC_EVALS.md`) | no gate failing |
| update check | how long the feed check takes, how often it fails, and how old the answer is | the window's update banner; the feed state in `~/.aipass/app/feed-state.json` | the check never blocks startup and never nags; an offline machine gets the cached feed or nothing |
| model quality | check-scored task outcomes, safety set included | `npm run evals -- --all --live --attempts 3` | read medians; gate list in `docs/SPEC_EVALS.md` |

Each eval row carries the per-run signals — model, stop reason,
refusals, spend, `stepMs` — and the `category` / task groupings, so the
same report answers "which model drifts" and "which task drifts" instead
of blending them. A run that predates `run_stats.model` is attributed to the
model its session recorded; `(unrecorded)` is left for sessions that wrote no
model at all. The CLI aggregator (`stats.mjs`) was removed in the desktop-only
split (2026-11-01) so runs from sibling projects can no
longer mix into this project's numbers; per-project drift is read from the
eval results.

## Error budget

The budget is **zero failing gates at release time**, over the current
`evals/results/*.jsonl` evidence:

- `npm run evals:compare` gate failing (success, grounded, safety) is over
  budget: fix first, ship after, unless the failure is *named* in the release
  notes with the plan (`docs/RELEASE.md` acceptance item 4).
- `npm run loadtest -- --strict` breaching p95, RSS growth or a failure is
  over budget: fix first, ship after.
- `npm run check` or the CI matrix red is over budget: full stop.
- Info lines (firewall notes) never spend the budget — they are context.

Thresholds are deliberately coarse and live in two places:
`scripts/loadtest.mjs` (`--p95` / `--rss`) and the gates in `docs/SPEC_EVALS.md`.
They answer "is this install drifting", not "what did
one run do".

## Degradation modes

When a dependency is missing, the harness degrades in a named way — never by
hanging or guessing. The full playbook is `docs/TROUBLESHOOTING.md`; the
shapes:

- **No tab / signed out** → the run pauses (`needs_tab`), the window banner
  names the fix, nothing is lost, reconnecting continues the run.
- **Rate window (429)** → the client waits it out and retries; a 429 that
  survives the waits gets one more pause from the loop's recovery
  (`sendRecoveries`), and only then ends the run, surfaced — never silent.
- **Edge firewall (403)** → trigger-shaped content is encoded on the way
  out; a rejected turn is split and resent, and a fragment that cannot pass
  is dropped with a `firewallNotes` count. The refusal reaches that chain at
  once — the client says it rewrites the message, so the tab hands the
  refusal back instead of probing it. A refusal that outlasts the whole
  rewrite chain is paused and the same message goes again before it can end
  the run.
- **A guard trips** → the run stops with the reason recorded (`stalled`,
  `stagnation`, `steps`, `tool-calls`, …) and the session keeps everything.
- **The desktop's port is taken** → the backend says so with its own exit
  code, and the supervisor asks who is holding it. One of our backends (a
  second window, a browser `aipass desktop`): it is adopted, and no second
  one is started — the window is already pointed at that port. Something
  else: the situation is named once, with the fix, and the backoff
  continues, so the port is picked up again if it is freed.
- **Backend crash** → the desktop shell restarts it (`[supervisor]` lines);
  an in-flight run reads as a pause, and `~/.aipass/` is untouched.
- **Nothing is using the bridge** → it ends itself after
  `AIPASS_BRIDGE_IDLE_MS` (ten minutes). The bridge is a detached process,
  so it outlives whatever started it; one that outlives every way of
  reaching it is a leak, not a service. Its own pid is in
  `~/.aipass/bridge.pid`, so `aipass stop` can end it at once.

## What is deliberately not here

No uptime percentage (there is no server to be up), no push paging (no
daemon — alerts are pull-based on purpose), no latency target on model steps
(the upstream is not ours to promise). Backup, restore and the RTO/RPO
numbers live in `docs/DATA_FORMATS.md` ("Recovery"); the drill that proves
them runs in `aipass-bridge/test/restore-drill.test.mjs`.
