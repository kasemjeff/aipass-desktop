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

