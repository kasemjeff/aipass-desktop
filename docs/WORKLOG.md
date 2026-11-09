## 2026-11-09 — Small-fix batch (11 items, item 9 withdrawn): memory surfacing, marker single-list, checkJs, Rust lock, WAF counter, plugin iframe, session auto-name, sidebar, run-options popover, theme default

*Files*: This session's hunks (disjoint from the foreign WIP already in the tree at start): `.github/workflows/{release,test}.yml` (reusable test workflow), `site/styles.css` (link sed, one file), `aipass-bridge/harness/{memory-store,harness,rpc/settings,protocol,meta/verify,media,session,settings,rpc/core,plugins,plugin-worker,run/context,run/send,execution,output-scrub,bridge/server}.mjs`, `aipass-bridge/jsconfig.json`, `desktop/ui/{jsconfig.json,app.js,banners.js,settings.js,index.html,styles.css,features/misc-commands.js}`, `desktop/src-tauri/src/{shared,backend,main}.rs`, `scripts/agents-lint.mjs` (ratchet ceilings runTask 1338 / createTools 1272 / createRpc 1187), `docs/MATURITY.md` (WAF row), `CHANGELOG.md`, 60 files with `// @ts-nocheck` (checkJs sweep), and tests in `protocol,data-integrity,ssrf,plugins,media,rules,desktop,ui`. Foreign WIP from parallel sessions (untracked harness modules, README rework, WORKLOG entries above, ~85 modified files at session start) was not reverted or restyled — only the hunks above were added on top. Item 9 (session sync-I/O index) was withdrawn after measurement (header memo exists; readdirSync 1.2ms at 3000 sessions) and not built.

*Tests*: `npm test` **pass 1541 / fail 0 / skip 8 of 1549**; `npm run test:rust` 28/28; `agents:lint` ok (180 anchors); `typecheck` + `typecheck:ui` ok; `qa-loop --static` 25 ok. `coverage:gate` run twice: files this session touched pass their floors (`app.js` 67.4/67 after removing one uncovered helper, `banners`, `settings`); the remaining floor failures sit in files this session did not touch and the "suite did not pass" set changes between runs under coverage instrumentation (flaky, pre-existing drift from the parallel sessions' code) — see session report.

*Deferred*: splitting `createTools`/`runTask` into `tools/` + `run/` stages (ratchet only, by design — no rewrite); Thai string table (none exists — strings are inline, nothing to add into); live-app visual check of the run-options popover (markup now pinned by a test reading `index.html`; recording needs the app with an attached extension).

*Open risks*: (1) the tree was dirty at start and is shared with live parallel sessions — review the full diff before committing, not only this session's hunks; (2) plugin iframe height now rides a postMessage resize (clamped 40–1200px) — a plugin spoofing a height can only resize its own frame; (3) sessions written before the `titleAuto` flag fall back to the timestamp-shape check, so a pre-flag user-chosen timestamp title could still be auto-renamed once.

*Cleanup*: no commits (human owns git shape); no temp files left in the repo; `holdout_lock.json` untouched.

## 2026-11-09 — Pin the body-opener list by source, and set the CHANGELOG honest against the landed design

*Files*: `aipass-bridge/test/body-openers.test.mjs` (new — mechanically pins the boundary list to the dispatcher: every body opener's pattern literal must be defined exactly once, and the `BODY_OPENERS` list must hold exactly the defined openers — a new block kind added to dispatch lines without joining the list fails loudly), `CHANGELOG.md` (Fixed bullet rewritten to the semantics actually landed — no case-blind fallback: a block that never reaches exact END is flagged `unterminated` and `validateCall` refuses to stage it), `docs/WORKLOG.md` (this entry).

*Tests*: `body-openers.test.mjs` 2/2; `protocol.test.mjs` 31/31; `tools.test.mjs` 30/1skip; `credit-cap.test.mjs` 4/4; `validate.test.mjs` 6/6; `npm run agents:lint` ok (180 anchors); link-check 0 broken; node-floor ok. A parallel session carried the parser redesign through meanwhile (exact-case markers everywhere + `{body, closed}` + `unterminated` validate gate), replacing my 12:05 exact-first + case-blind-fallback design — every test title that asserted the old fallback got updated by that session; my two CONTRACTS rows survive verbatim and still resolve.

*Deferred*: heredoc/unique-delimiter preamble redesign (preamble change — human decision, as before); CONTRACTS row for the new pin test (file at its 142-line ceiling, so it stays unindexed — it is still enforced by the suite).

*Open risks*: the body-opener pin is source-shaped (def literals, `BODY_OPENERS` list literal) — a rename or restructure of those constants breaks it by design, which invites the same contributor to re-pin it; the exact-case marker doctrine now makes weakly-spelled markers prose everywhere (their owner decision, pinned as such), so loose-spelling kills a request quietly instead of returning a helper nudge; the parallel session's live edits on this shared tree may still churn `npm test` while they work (last full-suite runs ranged fail 5–13 on unrelated foreign in-flight breakage, never in my files).

*Cleanup*: no commits (human owns git shape); this session's edits are confined to the credit-notice layer (budgets.mjs creditSpent), the send stage, their tests, my CHANGELOG bullet, the new pin test, and docs — all disjoint from the parallel session's protocol/validate/loop work.

## 2026-11-09 — Kill the BODY_OPENER drift: boundary derives from the dispatcher's own regexes

*Files*: `aipass-bridge/harness/protocol.mjs` (BODY_OPENER replaced by seven named block regexes `EDIT/CREATE/RUN_BG/RUN/PLAN/TODO/SUBAGENT_BLOCK_RE` + `BODY_OPENERS` list, and the dispatcher below now uses those same constants — the exact-terminator boundary and the blocks it bounds are one list, read once; a hand-copied boundary cannot drift from them), `aipass-bridge/test/protocol.test.mjs` (+1 RUN mixed-boundary test: `a RUN block closed in lowercase does not borrow the next block's END`), `docs/WORKLOG.md` (this entry). No behavior change: same shapes, same case rules.

*Tests*: `protocol.test.mjs` 27/27; `tools.test.mjs` 30/1skip; `credit-cap.test.mjs` 4/4; `npm run agents:lint` ok (180 anchors / 1568 titles); link-check 0 broken; node-floor ok. Full `npm test` stayed non-deterministic during this session (counts wandered 1530–1561 across runs, failures in foreign in-flight areas — `settings.mjs` circular-import TDZ then `runTask` ceiling on `loop.mjs` then a fresh `AIPASS_SHELL_WORKERS` env read with no CONFIG row — one more session editing the shared tree live). The three following failing in THIS session all repro on HEAD-neighbour edits, not this change (plus the agents-docs createTools/runTask ceiling fights churned by the same edits; each resolved itself).

*Deferred*: heredoc/unique-delimiter preamble redesign (RUN heredoc END, README bare END) — human decision, treated as before. New CONTRACTS row for the RUN-boundary test (file at its 142-line ceiling).

*Open risks*: BODY_OPENERS covers built-in blocks; a body-consuming marker added later still needs a line in that list (the sharing does not invent itself) — its cost is now one obvious place plus a behavior test per kind. The other session's live edits on the shared checkout remain a moving target for a clean full-suite pass; last full runs were polluted by foreign broken intermediates, never by these files (no new AIPASS_ reads here — verified by grep on the diff).

*Cleanup*: no commits (human owns git shape); protocol.mjs dispatch region and the two test files touched with disjoint hunks only.

## 2026-11-09 — README front-page rework: outcome first, 543 → under 300 lines, internal notes out

*Files*: `README.md` (rewrite — outcome-first opening `inspect every file change before it reaches your project`, Thai-first + de.aipass.net in the second paragraph, screenshot caption stripped of internal TODO text, 4-step workflow table, Quick-start browser-setup note linking to the browser steps, fixed Install table (`Node ≥ 24 — required to run the local backend`; `Nothing else — no npm install, database, or separate API key`), trimmed to Install / FAQ / Troubleshooting / Contributing / Security + pointer), `README.th.md` (header outcome line mirrored, caption stripped of internal text), `docs/README.md` (new Full index section — every doc with one-line summary, incl. CAG_DESIGN, KNOWLEDGE_ARCHITECTURE, LOOP_INTELLIGENCE, PLATFORM_CHECKLIST), `docs/WORKLOG.md` (this entry). Node ≥ 24 badge kept verbatim (check-node-floor gate).

*Tests*: `node scripts/link-check.mjs` (224 files, 0 broken), `node scripts/check-node-floor.mjs` (ok), `npm run agents:lint`, full `npm test` — see session report for the run.

*Deferred*: 15–30 s demo GIF (send → reads → diff → approve) — needs the app running with the extension attached to a logged-in de.aipass.net tab, so it must be recorded on a machine with a live session; drop at `public/screenshots/demo.gif` and link from `README.md` when recorded. Dark-theme + staged-diff recapture of `public/screenshots/desktop-light.png` caption already shortened; recapture still open.

*Open risks*: front README no longer carries the config table, architecture diagram, or component detail — all moved to `docs/README.md`/`docs/CONFIG.md`; if a linked anchor there changes, the front page loses depth silently (link-check only proves files exist, not anchors). Recovery path is one edit in `docs/README.md`.

*Cleanup*: no commits made (human owns git shape); foreign WIP in `docs/README.md`/`docs/WORKLOG.md` touched only with disjoint hunks; temp files none.

## 2026-11-08 — Loop intelligence: failure, retry, recovery, verification, budget, state

*Files*: `aipass-bridge/harness/failure.mjs` (new — classification, adaptive hints, recovery plan), `aipass-bridge/harness/verify-evidence.mjs` (new — verdict audit), `aipass-bridge/harness/loop-state.mjs` (new — snapshots), `aipass-bridge/harness/run/{context,budgets,options,gates}.mjs` (counters, dynamic budget, switch plumbing, check audit), `aipass-bridge/harness/loop.mjs` (wiring, adaptive correction, save/restore, new run_stats fields), `aipass-bridge/harness/settings.mjs` + `docs/CONFIG.md` (three switches), `docs/LOOP_INTELLIGENCE.md` (new — the account), `docs/LOOP_DESIGN.md` (section + test rows), `CHANGELOG.md` (one bullet, top of Unreleased Added), `aipass-bridge/test/{failure-adaptive,dynamic-budget,verify-evidence,loop-state}.test.mjs` (new — 23 tests).

*Tests*: full suite **fail 0 / pass 1475 / skip 8**. `agents:lint` ok (178 anchors). New tests 23/0; `config-catalog`, `checker`, `desktop` (incl. attempts 3/3), `lang-guard`, `step-cap`, `harness-fixes` green in isolation; `node --check` clean on all touched harness files.

*Deferred*: `docs/HARNESS_DESIGN.md` + `docs/MATURITY.md` rows (both carried foreign WIP at edit time — left for the owner session to add the registry line, status experimental); new event names deferred (none needed — all six ride existing `note`/`budget`/run_stats fields).

*Open risks*: dynamic-budget tiers are heuristics (length, named files, verbs, breadth incl. Thai) — a task that scores wrong just gets the wrong allowance, recorded as `budgetTier` for comparison; loop-state restore matches first 200 chars of the task, so a reworded retry starts fresh by design; independent verification downgrades only `pass`→`none`, never upgrades.

*Cleanup*: debug script removed; no commits made (human owns git shape); foreign WIP (shell-worker, run-interrupted, rpc events, EVENTS.md) untouched except disjoint CHANGELOG hunk.

## 2026-11-08 — Release sequence, hermetic tests, and CI hardening

*Files*: `.github/workflows/{release,test,build,pages,codeql,dco}.yml` (run_number sequence, head-commit notes, publish waits for test, contents:read, SHA pins, checkout v7), `scripts/build-update-feed.mjs` (parseSequence, no default), `aipass-bridge/harness/{update.mjs,tools.mjs,rpc/files.mjs}` (feed URL, fetchResolver), `aipass-bridge/test/{ssrf,tools,gates,data-integrity,rules,update}.test.mjs`, `docs/{CONFIG,RELEASE}.md`, `CHANGELOG.md`, `AGENTS.md`, `scripts/test.mjs`, `ROADMAP.md`, `{SECURITY,SUPPORT,CODE_OF_CONDUCT,TRADEMARK}.md`, `.github/ISSUE_TEMPLATE/*` (kasemjeff/aipass-desktop).

*Tests*: targeted `ssrf` 15/0, `tools` 25/0 (+1 skip), `gates` 15/0, `update` 25/0 (incl. new sequence test); `agents:lint` ok (178 anchors, 1529 titles), `typecheck` + `typecheck:ui` clean, `evals:lint` ok, `node-floor:check` ok. Full `npm test` 1519/2/8 in 98 s — the 2 fails are pre-existing dirty-tree drift (`AIPASS_TAB_DEGRADED_*` read but uncataloged; `provider_failover` documented but no longer emitted), not from this change.

*Deferred*: live safety-set renewal due 2026-11-19 (`docs/MATURITY.md`) — needs a clean tree + logged-in tab: `npm run evals -- --task <id> --live --attempts 3 --keep` for the four tasks, then `evals:compare`; not run on this dirty WIP. Full coverage gate deferred until the 2 pre-existing failures are fixed by the owning session.

*Open risks*: `github.run_number` is monotonic per release workflow only — a manual sequence override must be higher or the app refuses the feed (by design); SHA pins go stale until Dependabot bumps them (comment carries the version).

*Cleanup*: no commits made (human owns git shape); foreign WIP left untouched except disjoint hunks (SECURITY.md, test.yml, tools.mjs, update.mjs, CHANGELOG.md, CONFIG.md).

## 2026-11-05 — subagent visibility, token hygiene, repo tidy

*Files*: `aipass-bridge/harness/harness.mjs` (helper id, tagged events, clip, instructions pointer, session helper flag), `aipass-bridge/harness/loop.mjs` (subagent id pass-through, helper frames tagged, instructions skip for helpers), `aipass-bridge/harness/session.mjs` (create accepts `helper`), `desktop/ui/panels/helpers.js` (new — live Helpers & Jobs panel), `desktop/ui/app.js` (wire panel + event handlers, filter helper frames from main flow), `desktop/ui/panels/sessions.js` (hide helper sessions by default + toggle), `desktop/ui/settings.js` (elision tier toggle), `desktop/ui/index.html` (helpers section + toggle button), `docs/{EVENTS,DATA_FORMATS}.md`, `docs/README.md` (index refresh), `docs/WORKLOG.md` (October rotated to `worklog/2026-10.md`), `CHANGELOG.md`.

*Tests*: full suite **fail 0 / pass 1373 / skip 7** (EXIT=0). `agents:lint` ok (178 anchors). `node --check` clean on every touched file. 2 pre-existing broken links in `link-check` (aipass-bridge README↔docs/DOCS.md) unrelated.

*Deferred*: C5 (delete `desktop/sidecar/` ~88 MB) awaits user confirmation; B2 preamble slimming dropped to avoid breaking the pinned-bytes contract and the read-only test; ide-extension helper rendering deferred.

*Open risks*: tagged helper frames rely on `data.helper` in payloads — any new emit site in the child that forgets the wrapper would leak into the parent flow. The helper-sessions toggle uses localStorage (guarded for the node test harness).

*Cleanup*: temp patch scripts in `%TEMP%/opencode` only; no commits made (human owns git shape).


# Worklog

Session handoffs, newest first. One entry per working session, five items:
**files touched · tests run + result · deferred items with reasons · open
risks · cleanup done**. This is news, not law: the rules live in `AGENTS.md`,
durable behavior changes in `CHANGELOG.md`, and the final word is always the
suite.

> October 2026 entries moved to [`worklog/2026-10.md`](./worklog/2026-10.md).

## 2026-11-04 — the desktop works faster, and the backend stopped freezing on SYMBOLS

*Files*: `desktop/ui/settings.js` (the live pages — git, schedule, media, memory,
goal, providers, health, MCP, plugins — render in parallel and the sheet paints
at once instead of awaiting every tab in turn; `plugins.list`/`mcp.list` ride
together; a page whose render throws says so in its own body), `desktop/ui/
app.js` (boot flies its independent calls in parallel with `Promise.allSettled`,
so one failing refresh no longer aborts the rest; `restoreFromSnapshot` replays
only the newest ~300 rows — the session file still holds everything; the
composer's draft storage writes coalesce — leading write after a quiet moment,
then one per 150 ms, flushed on pagehide; the sidebar drag drops the per-
mousemove layout read; hidden context panel spends no RPCs, refilled on open;
the 2026-10-31 WIP hunk on the `discarded` event is untouched), `desktop/ui/
panels/context.js` (hidden panel early-returns; `git.status` behind a 10 s TTL
with a single shared in-flight call), `desktop/ui/panels/sessions.js` (the
archive scan caches for 60 s; archive/unarchive/prune bypass it), `desktop/
ui/transcript.js` (the bounded-row trim reads `log.children.length`, spreads
only when over the cap), `desktop/src-tauri/src/
main.rs` (the second backend probe is skipped when this process spawned the
child — a live child is the answerer; the adopted path and a died-in-the-gap
child still get the verdict; port wait polls at 100 ms, the fixed 150 ms sleep
is gone), `aipass-bridge/harness/symbols.mjs` (walk/stats/readFile all
`fs.promises`; the parsed index memoized on (mtime, size); single-flight
builds; REFS rides a bounded memo keyed on the index revision — the revision
now bumps on any re-read, even when the atomic save fails; the index is
written only when content changed; the dir mkdir/chmod is once per home),
`aipass-bridge/harness/retrieval.mjs` (`loadIndex` async; `status` answers
from the memo/stat when warm; the build's TTL fast path checks the cache
synchronously before claiming the build slot, and the slot is claimed before
the first await so a `clearIndex` in flight still aborts the build; the dir
mkdir/chmod is once per home), `aipass-bridge/harness/rpc.mjs` (static window
files carry `content-length` and an `etag` (size–mtime) and answer `304` to
`if-none-match` — a reload transfers ~0 bytes after first paint; the `/rpc`
project header validates on a 2 s memo instead of a stat per call; the replay
buffer carries its byte count per frame — no re-encode on overflow; the
per-project file-search cache drops stale entries and caps at eight),
`aipass-bridge/harness/rpc/files.mjs`, `aipass-bridge/harness/tools.mjs` (await
the now-async symbol index), tests — `aipass-bridge/test/retrieval.test.mjs`
(call sites await), `aipass-bridge/test/ui.test.mjs` (the 401-refresh test now
asserts a later call carries the new token — boot is parallel, so the retry is
no longer positional), docs — `CHANGELOG.md`, `docs/RAG_DESIGN.md`. Foreign WIP
(`harness.mjs`, `loop.mjs`, `run/gates.mjs`, `run/preflight.mjs`,
`background-run.test.mjs`, `model-catalog.test.mjs`, `docs/LOOP_DESIGN.md`,
and the `discarded` hunk in `desktop/ui/app.js`) was not touched.

*Tests*: full suite **fail 0 / pass 1373 / skip 7** (EXIT=0). `agents:lint` ok
(178 anchors). `cargo check` exit 0. `coverage:gate` still fails on exactly the
six files it fails on a pristine 85a6ed1 (transcript 82.86 / banners / core /
files / options.mjs) and no longer names `panels/context.js` — the floor was
not met at HEAD either; nothing here lowers a floor. Two suite flakes seen once
in a loaded run (`hooks` "a hook runs when the run ends"; `loopback-surface`
EPERM on a settings.json rename) both pass in isolation and neither touches
these files.

*Deferred*: `session.mjs` keeps its sync `list`/`listArchived` — the CLI, the
status subcommand and ~40 tests call them synchronously, and converting that
surface is a bigger change than the handful of stat calls it would save; the
header memo already absorbs the parse cost. `renderPending` still rebuilds on
every diff frame (correct — the unticked-file rule — but it is O(files) DOM
churn). The paint loop's per-frame walks (0.4–0.8 ms at 1,400 lines) stayed as
is. `writeFileAtomic` stayed sync (its retry is synchronous by design; the
retrieval index write is once per build).

*Open risks*: `coverage:gate`'s six under-floor files are pre-existing at HEAD
(the merge-era numbers), so the human still owns the floor-or-fix decision.
The Rust probe skip trusts a live spawned child — the invariant is "TCP
answers + child alive ⇒ our server", which holds because the backend binds
the port before it answers, but it has not been battle-tested against a
misbehaving backend that listens before it finishes wiring itself up; the
adopted path and dead-child path keep the old verdict. Boot is now parallel,
which widens the set of in-flight calls observed at any instant — a backend
that only answers one call at a time could behave worse, though none has.
The settings sheet renders live tabs without awaiting them, so a person who
types and immediately hits Save before a page lands still gets the old draft
values for that page (all custom tabs' saves re-derive from the un-rendered
draft or answer `saveEmptyTab`) — no data loss, just no mid-flight edit.

*Cleanup*: baseline worktree `aipass-covcheck` (HEAD, for the coverage
comparison) removed; all temp analysis files removed; never committed
(standing policy); foreign WIP read-only throughout; `desktop/sidecar/
node-x86_64-pc-windows-msvc.exe` created by the repo's own `desktop:sidecar`
(93 MB, gitignored) so `cargo check` could run.

