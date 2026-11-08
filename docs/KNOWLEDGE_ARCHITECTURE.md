# Knowledge architecture — one kernel, three corpora, one cache

> **Status: v4 (2026-11-08), Phases 1–3 + 5–6 done in code, Phase 4 done except the loop seam (foreign WIP, §12). Full suite 1416 pass / 0 fail.**
> v1 (below) proposed layers + CacheStore. v2 hardens it: hexagonal core
> (ports, not direct fs imports), a declarative StoreRegistry, provenance
> on every Hit, one Budget owner, content-hash invalidation — and it
> corrects P5: memory already dual-reads (sha256 main + sha1 legacy
> fallback, `memory-store.mjs#loadMemory`), so Phase 1 migrates only
> retrieval + CAG persistence and leaves memory's reader alone.
> Implementation is phased (§7); the other session's WIP in
> `context-sources.mjs`, `memory-store.mjs`, `settings.mjs` stays
> read-only until it lands.

**Separation rule:** this repo is self-contained. Eval fixtures are
in-repo only (`evals/retrieval/tree` + `queries-{exact,paraphrase,negative,real}.json`,
`evals/recall/queries.json` synthetic sessions) — no named external project,
no absolute out-of-repo path, and no measured number from an external corpus
is pinned in a test. Measuring an external corpus happens only at bench time:
`bench:retrieval --repo <operator-supplied path>` scores the in-repo
`queries-real.json` against that tree with the index in a temp home; the
corpus, its name, and its numbers are never committed. Calibration floors
(`minScore`/coverage) are derived per run from the in-repo fixture negatives
plus the operator's current external run, never copied from a named corpus.

**One line:** `text.mjs` stays the pure kernel (tokenize, excerpt, BM25);
above it sit three corpora (project, session, standing) behind one
document interface, one cache-store framework for every on-disk cache, and
one assembler that owns turn 1 — so a new ranker (embeddings) or a new
surface (a `/cag` command) is a plugin, not a 700-line edit.

## 1. What is wrong today (checked, not assumed)

| # | problem | evidence |
|---|---|---|
| P1 | `retrieval.mjs` (698 lines) does six jobs: cache IO, tree walk, chunking (3 kinds), postings build/reuse, overlay view, ranking + MMR + excerpt budget | function list in the file: `loadIndex/saveIndex/clearIndex/status`, `walk`, `chunkCode/chunkMarkdown/chunkLines`, `buildIndex`, `buildView`, `retrieve` |
| P2 | BM25 was copy-pasted in three places | `retrieval.mjs` postings loop, `memory-store.mjs#recallEntries`, `memory-store.mjs#carryFacts` — only the first now calls the shared helper |
| P3 | Six find-things surfaces, no shared document | `SEARCH` (`tools.mjs`, 1,861 lines), `RETRIEVE`, `RECALL`, `SYMBOLS`, window file search, RPC `fileIndex` — four different hit shapes |
| P4 | Every cache invents its own policy | retrieval `~/.aipass/retrieval` (TTL 5s), symbols `~/.aipass/symbols`, memory `~/.aipass/memory`, CAG `~/.aipass/cag`, checkpoints, goal — each re-implements mkdir-0700, atomic 0600 save, version gate, corruption-as-absent, LRU memo in slightly different words |
| P5 | ~~Memory's key breaks the one-project-one-key rule~~ **corrected:** `storePath` already uses `projectKey` (sha256, real root); `loadMemory` dual-reads the sha1 legacy file as fallback and `clearMemory` removes both. Remaining gap: the legacy file is never *swept* after a successful dual-read, and `moveMemory` still re-keys by path — a registry move, not a bug fix |
| P6 | Turn-1 assembly had four owners | `loop.mjs`, three seed builders in `harness.mjs`, `compact.mjs`, `protocol.mjs` — `context-sources.mjs` (uncommitted) is the fix in flight; CAG (`cag.mjs`) is a fifth pack with no caller yet |
| P7 | No unified hit / stats / manifest contract | RETRIEVE hits `{path,start,end,excerpt,score}`, RECALL hits `{session,title,type,excerpt,ts}`, context manifest `{id,chars,dropped}`, CAG pack `{text,packSha}` — the window and logs parse four shapes |
| P8 | Evals cover one corpus only | `evals/retrieval/` scores project text; RECALL, carry and CAG have unit tests but no recall floors |

## 2. Target layers

```
L4  surfaces      markers (tools.mjs) · RPC · window (/index, /cag, context panel)
                  — thin adapters, own no logic
L3  services      RetrievalService · RecallService · CarryService · StandingService (CAG)
                  — own corpora + budgets, call L2/L1, return unified Hit[]
L2  framework     CacheStore (key/version/mode/atomic/freshness/LRU) · Corpus drivers
                  — every on-disk cache and every document reader
L1  kernel        text.mjs: tokenize · excerptOf · bm25Idf/bm25Term/bm25ScoreAll
                  — pure, no IO, no fs, tested alone
L0  turn owner    context-sources.mjs: assemble() owns turn 1 + seeds,
                  CAG pack enters as ONE block with a manifest row
```

**L1 — kernel (mostly done).** `text.mjs` is the only file allowed to
tokenize and score. Add nothing IO-shaped here. The BM25 helpers landed
2026-11-08; `bm25ScoreAll` is the small-corpus path, postings are the
large-corpus path — same math, two access patterns, one test suite.

**L2 — CacheStore + Corpus drivers (the new framework).**
`harness/cache-store.mjs` (built, Phase 1): `openStore(name, {home})` /
`createCacheStore({dir, version, memoMax})` →
`{fileFor, load(root, validate), save, clear, stat/statSync, peek/peekEntry}`.
One implementation of: 0700 dir / 0600 atomic file, `projectKey(root)`
keying, version gate, (mtime,size) LRU memo, corrupt-reads-as-absent.
Retrieval + CAG migrated (Phase 1); symbols, checkpoints and goal are
registry rows in Phase 2b. Memory already dual-reads (P5 corrected) and
is migrated only by the legacy sweep (§12), never by a rewrite.

Corpus drivers turn bytes into documents behind one shape:

```js
// Document — the only shape ranking ever sees
{ id, source: 'project'|'session'|'standing', text,
  locator: { path, start, end } | { session, ts, type } | { path },
  fields: { path?, symbol?, heading? } }   // boost fields, optional
```

- `ProjectCorpus` — the current `walk` + `chunkFile` from retrieval.mjs.
- `SessionCorpus` — `readEntries` + `SPOKEN` filter + memory facts as
  documents (the current recallEntries candidate collection).
- `StandingCorpus` — CAG sources as documents; `StandingService` renders
  them in list order (never ranked — standing context is not a query).

**L3 — services.** Each owns a budget and returns `Hit[]` in one shape:

```js
// Hit — the only shape surfaces render
{ source, locator, excerpt, score, truncated }
```

- `RetrievalService` — postings index + `buildView` overlay + MMR.
  Behaviour identical to today's `retrieve()`; the split is internal.
- `RecallService` — SessionCorpus → `bm25ScoreAll` → recency boost.
  Replaces recallEntries' private loop (P2) once memory-store's WIP lands.
- `CarryService` — facts → `bm25ScoreAll` → budget fill (today's carryFacts).
- `StandingService` (CAG) — StandingCorpus → deterministic render →
  CacheStore. Unchanged semantics; gains the shared cache policy.

**L4 — surfaces.** Markers, RPC and UI pass through. `/index` and `/cag`
are the same status/clear shape over CacheStore; the context panel shows
one manifest that already includes the `cag` row.

**L0 — turn owner.** `context-sources.mjs#assemble()` is the only place
that decides what turn 1 and seeds carry. CAG enters as
`{id:'cag', priority, text, maxChars}` — never as a second assembly path.

## 3. Data flow

```
project files ──ProjectCorpus──┐
sessions+facts ──SessionCorpus─┼─→ tokenize ─→ BM25 (text.mjs) ─→ Hit[]
standing files ──StandingCorpus┘        (or deterministically ordered, CAG)

Hit[] ─→ marker/RPC/UI adapter ─→ model context / window / session log
                                    (stats + manifest travel with every answer)
```

## 4. Decisions (new; D1–D6 in RAG_DESIGN.md still hold)

- **D7 — One cache framework.** A new on-disk cache must use CacheStore.
  Reasons: six policies (`~/.aipass/{retrieval,symbols,memory,cag,run,
  goal}`) each with their own key/mode/TTL is how the sha1 memory bug (P5)
  happened. Verify: a test that every store's file is 0600 and keyed by
  `projectKey`.
- **D8 — One Hit shape.** Surfaces stop parsing per-service shapes (P7).
  CPT: if a surface needs a field not in Hit, the service adds it to its
  own `locator`, not a new top-level shape.
- **D9 — Rankers are plugins.** Embeddings (RAG Phase 3) land as a second
  `Ranker` behind the same `Hit[]` contract, fused with BM25 by RRF —
  never as a fork of RetrievalService. Gate: paraphrase floor from
  `bench:retrieval` must move; local provider first (D5).
- **D10 — Standing context is never ranked.** CAG render order is the
  source list order. A ranked "standing" pack would be auto-injection
  through the back door.
- **D11 — Split by seam, not by size.** retrieval.mjs splits at its real
  seams (chunker / index-store / ranker / view), each independently
  testable; no file split for its own sake. Target: no module above
  ~300 lines except tools/loop (their split is another design).
- **D12 — Every corpus gets an eval floor.** RECALL and carry get query
  sets in `evals/` like retrieval's, before their ranker changes. A
  service with no floor does not get a new ranker.

## 5. Migration phases

| phase | scope | files | verify |
|---|---|---|---|
| 0 — this design | doc only | `docs/KNOWLEDGE_ARCHITECTURE.md` | none (doc) |
| 1 — CacheStore | new framework (v2 §8); migrate CAG + retrieval persistence only — memory's dual-read already exists, do not touch it | new `harness/cache-store.mjs`, `cag.mjs`, `retrieval.mjs` (IO only) | existing retrieval/cag/recall suites green; new cache-store tests (mode, version, corrupt, junction key) |
| 2 — split retrieval | `chunker.mjs`, `index-store.mjs`, `ranker.mjs`, `view.mjs` beside a thin `retrieval.mjs` facade | new 4 modules, `retrieval.mjs` shrinks | retrieval 25 + bench floors unchanged (exact 1.000 / MRR 0.958) |
| 3 — corpora + services | `corpus.mjs` drivers; RecallService + CarryService over `bm25ScoreAll`; memory-store keeps only fact persistence | new `corpus.mjs`, `services.mjs` (or per-service files), `memory-store.mjs` shrinks | recall 5/5; new recall eval floor passes |
| 4 — CAG wiring | pack as one assemble() block; settings `cag`, RPC `cag.status/clear`, `/cag` | `context-sources.mjs`, `loop.mjs`, `settings.mjs`, `rpc/*`, `desktop/ui/*` | cag 8/8 + wiring test; pinned replay green (gate flag, like VERIFY) |
| 5 — unified Hit | markers/RPC/UI render Hit[]; `/index`+`/cag` one status shape | `tools.mjs` (adapters), `rpc/files.mjs`, `desktop/ui/panels/context.js` | ui + rpc suites green |
| 6 — embeddings (gated) | Ranker plugin + RRF, local provider, consent row | new `ranker-embed.mjs`, settings, bench | paraphrase recall moves on fixture + real set; `--strict` green |

Each phase is one commit-sized change, tests green before the next, and
revertable without touching the others (facades keep the old exports).

## 8. v2 hardening (what v1 missed)

- **Hexagonal core.** Services depend on ports (`FileSystem`, `Clock`,
  `HomeDir`), never import `node:fs` or `aipassHome()` directly. The fs
  adapter is the default; tests inject a memory adapter. This is why
  CacheStore takes `{dir}` explicitly instead of reading the home itself:
  a store you cannot point at a scratch dir is a store you cannot test.
- **StoreRegistry (declarative).** One table — `name, dir, version,
  memoMax, keyFn` — is the only place a cache's policy is written.
  Adding a cache is adding a row, not a new mkdir/chmod/LRU copy.
  The registry is also the audit surface: `status` for every store is
  one loop, and `docs/CONFIG.md` env rows point at it.
- **Content-hash invalidation over mtime.** mtime+size false-reuses
  after `git checkout` / copy / touch (same bytes, new mtime → needless
  rebuild; same mtime+size, new bytes → stale hit). CAG already hashes
  sources (sha256 per source + `packSha`); the retrieval index keeps
  mtime+size for speed but records a `manifestHash` over
  `path:sha256` for the files it read, and the bench asserts a changed-
  content-same-stat file is caught. Full hashing of 5,000 files per
  query is rejected on cost — manifest is verified on build, stat on
  query, exactly as today, but the manifest makes staleness *detectable*.
- **Provenance on every Hit.** `{ corpusVersion, builtAt, queryHash }`
  travels with hits so an eval miss can be replayed. Without it, "the
  model answered wrong" cannot be split into retriever vs model fault.
- **One Budget owner.** `context-sources.mjs#assemble()` already owns
  turn-1/seed budgets; v2 makes it the *only* owner — services return
  candidates + costs, assemble() allocates. No service invents a second
  budget against the same window.
- **Secret floor as middleware.** `secretHit` + symlink-escape checks
  live in the Corpus driver, so a new corpus inherits the floor instead
  of re-implementing it (today retrieval, CAG and SEARCH each check
  separately — correct, but three chances to forget).

## 6. Not in this design

- A vector database / ANN index (RAG_DESIGN.md already rejects it; D9
  keeps the door: brute-force cosine over ≤20k chunks first).
- Rewriting `tools.mjs` / `loop.mjs` (1.8k lines each) — out of scope;
  they become thin adapters in Phase 5, split in a loop-design pass.
- Cross-project search (containment rule stands).
- Merging RETRIEVE and RECALL into one marker (RAG_DESIGN.md: separate
  corpora, separate markers, shared kernel).

## 7. Decisions taken (2026-11-08, human-approved)

1. **CacheStore first.** Approved. Memory needs no key fix (P5 corrected);
   Phase 1 is retrieval + CAG persistence onto the new store.
2. **Embeddings: measure on a large external corpus first (bench-time only).**
   Paraphrase 21.4% on the fixture is not evidence about a large real-world
   corpus; index an operator-supplied repo via `bench --repo`, run
   Thai/English paraphrase queries against it, and only then decide.
   Phase 6 stays gated. (Separation rule: the corpus is supplied at bench
   time, never named or committed here.)
3. **CAG default on in desktop, off in replay fixtures.** Like `retrieve`:
   the pack rides turn 1 in the window, and the pinned replay keeps its
   bytes (gate flag, same treatment as VERIFY).

## 9. Phase 2 detailed design — split retrieval + score gate

### 9.1 Split map (by seam, D11)

| new module | owns (moved from retrieval.mjs today) | exports (facade keeps the rest) |
|---|---|---|
| `harness/chunker.mjs` | `CODE_EXT/MD_EXT/DATA_EXT`, `makeChunk`, `chunkLines`, `chunkCode`, `chunkMarkdown`, `chunkFile`, `rankExt` | `chunkFile(rel, text)` — pure, no IO |
| `harness/index-store.mjs` | CacheStore row + `loadIndex/saveIndex/clearIndex/status/peekIndex` (already thin) | `loadIndex, saveIndex, clearIndex, status, peekIndex, ensureIndex` (BUILDING slot stays here) |
| `harness/ranker.mjs` | `buildView` (overlay fold), `baseStats`, MMR pool, phrase bonus, excerpt budget | `rank(index, query, {overlay, limit, budgetChars, minScore, signal})` |
| `harness/retrieval.mjs` | facade only: re-exports + `buildIndex` orchestration (walk → chunk → postings → save) | all current exports, identical signatures |

`walk()` moves with `buildIndex` into the facade file (it is build-only,
not ranking). Target sizes: chunker ~150, index-store ~120, ranker ~250,
facade ~200. No behaviour change in this sub-phase; bench floors
(exact 1.000 / MRR 0.958) are the proof.

### 9.2 D13 — score threshold gate (the negative-query finding)

Retrieval today returns the top-6 *whatever* their score: a negative
query sharing one common term (e.g. `production`) can return hits via
that single term alone. A result set with no floor is not an answer, it
is a guess with citations. Design:

- `rank()` takes `minScore` (default: `AIPASS_RETRIEVAL_MIN_SCORE`,
  unset = today's behaviour until the floor is measured).
- Floor calibration: run the in-repo fixture negative set (plus, at
  bench time only, the operator-supplied external repo's negatives);
  the floor is the highest score any negative query produces, plus a
  margin. BM25 scores are corpus-relative, so the floor is per-corpus
  shaped: `minScore` is compared against `score / maxScore` (relative)
  AND an absolute term, whichever the calibration says — never a magic
  constant copied from one corpus to another.
- Below-floor hits are dropped *before* MMR (a dropped chunk must not
  suppress a kept one), and the answer says so:
  `3 of 6 passages passed the score floor (6 matched)`.
- RECALL gets the same gate in Phase 3 (its `score > 0` filter is the
  degenerate case of a floor).

### 9.3 Cold build: progress + abort + no freeze

A large-repo cold build (measured at bench time via `--repo`) takes
seconds. Design (no worker thread yet):

- `buildIndex` already yields via `setImmediate` every file and honours
  `signal`; add a `onProgress({files, total, chunks})` callback so the
  tool row shows `building index: 412/900 files` (RAG_DESIGN already
  promises this surface).
- Abort = no save (already true); a stopped run rebuilds next time.
- Worker-thread move is Phase 6 material: only if profiling shows the
  tokenizer starving the event loop on a >5k-file corpus. The JSON
  index format is already the seam, so the move is mechanical.

### 9.4 manifestHash (staleness made detectable, §8)

`buildIndex` records `manifestHash = sha256(sorted(path:sha256(text)))`
over the files it actually read. `status()` surfaces it; the bench
asserts: edit a file's content *without* changing size/mtime (cp -p of
modified bytes) → next `ensureIndex` after TTL detects via manifest
re-stat and rebuilds. Full per-query hashing stays rejected (cost);
the manifest is the audit trail, stat is the fast path.

## 10. Module contracts (Phase 3+, for the record)

```js
// Document (ranking never sees anything else)
{ id, source, text, locator, fields? }
// Hit (surfaces never see anything else)
{ source, locator, excerpt, score, provenance: { corpusVersion, builtAt, queryHash } }
// Corpus driver (port)
{ name, async documents({root, signal}) -> Document[] }   // secret floor inside
// Ranker (port; BM25 today, embeddings later)
{ name, rank(documents, query, opts) -> Hit[] }           // RRF fuses rankers
// Store (port; CacheStore is the adapter)
{ load(root, validate), save(root, data), clear(root), status(root) }
```

Ports live in `harness/ports.mjs` as JSDoc typedefs first; runtime
injection (fs adapter vs memory adapter) lands only where a test needs
it — no framework for its own sake (zero-dependency rule).

### Target file tree (knowledge only)

```
harness/
  text.mjs            kernel: tokenize/excerpt/BM25 (done)
  cache-store.mjs     StoreRegistry + createCacheStore (done, Phase 1)
  chunker.mjs         Phase 2
  index-store.mjs     Phase 2
  ranker.mjs          Phase 2 (+ minScore gate)
  retrieval.mjs       facade + buildIndex (shrinks)
  corpus.mjs          Phase 3: Project/Session/Standing drivers
  services.mjs        Phase 3: Retrieval/Recall/Carry/Standing over ports
  cag.mjs             StandingService + pack render (exists)
  memory-store.mjs    facts persistence only (Phase 3 shrinks it)
  context-sources.mjs turn owner (other session's WIP; CAG = one block)
```

## 11. Eval + test plan per corpus (D12)

| corpus | new eval set | floor (initial) | gate |
|---|---|---|---|
| project (exists) | `evals/retrieval/` fixture + `queries-real.json` | exact recall@8 ≥ 0.9, negatives 6/6 | `npm run bench:retrieval --strict` |
| external repo (operator-supplied, bench-time only) | `queries-real.json` (in-repo) scored against the supplied tree | exact ≥ 5/6, negatives 0 hits after D13 | `bench:retrieval --repo <path>` in CI (nightly, index in temp home); corpus/name/numbers never committed |
| session (RECALL) | `evals/recall/queries.json` (new: synthetic sessions + facts) | recall@8 ≥ 0.9, negatives 0 | new `bench:recall` script |
| carry | folded into recall set (fact queries) | carry picks the named fact ≥ 0.9 | recall bench |
| standing (CAG) | no ranking eval — determinism + invalidation tests only | byte-identical reuse, changed-source rebuild | `test/cag.test.mjs` (exists) |

## 12. Sequencing, rollback, and the dirty-WIP boundary

Order: 9.1 split → 9.2 gate (calibrated on the in-repo fixture) → 9.3 progress
→ 9.4 manifest → Phase 3 corpora/services → Phase 4 CAG wiring.
Each step: retrieval 25 + bench green before the next; facade exports
unchanged so `tools.mjs`/`rpc` never break; rollback is `git revert`
one step (no data migration except the memory legacy sweep, which is
additive: sweep only after a successful dual-read, never before).

Boundary: `memory-store.mjs`, `settings.mjs`, `loop.mjs`, `harness.mjs`,
`context-sources.mjs` belong to the other session until their WIP lands;
Phase 3/4 edits there are *planned* in this design, *written* after.

## 13. Risks

## Checked — Phases 2–6 done (2026-11-08)

- **Phase 2:** `chunker.mjs` (98 lines) + `ranker.mjs` (122) split from
  retrieval; facade exports unchanged. Coverage gate (§9.2) + min-score
  are opt-in envs (`AIPASS_RETRIEVAL_MIN_COVERAGE`/`_MIN_SCORE`) with
  per-hit `coverage` — default-ON was measured to kill paraphrase
  (0.214 → 0.000 on the fixture) while a negative can score above
  paraphrase scores, so neither gate separates them without per-corpus
  calibration; the machinery + reporting ship, the default stays off.
  `buildIndex` gained `onProgress` + `manifestHash` (§9.3/§9.4).
- **Phase 3:** `corpus.mjs` (Project/Session/Standing drivers, secret
  floor inside) + `services.mjs` (Recall/Carry over `bm25ScoreAll`,
  unified Hit + provenance) + `evals/recall/queries.json` floor +
  `test/services.test.mjs`. RECALL's private BM25 now calls the shared
  `bm25Idf/bm25Term` (recency boost + tie-break preserved).
- **Phase 5:** retrieval hits ride `toHit()` — original fields kept,
  `source/locator/provenance` added (D8).
- **Phase 4:** `settings.cag=true` (desktop default), `cag.status/clear`
  RPC + contract, `cagBlockForRun()` (off in replay), UI save line.
  **Deferred:** the loop turn-1 seam — `loop.mjs`/`context-sources.mjs`
  are another session's uncommitted WIP; the pack is one call away
  (`await cagBlockForRun(root, {cag: options.cag, replay})` appended to
  `pre`) once that WIP lands.
- **Phase 6:** `ranker-embed.mjs` — cosine + RRF, local Ollama only,
  consent-gated (`AIPASS_EMBED_CONSENT=1`), BM25 fallback; inert in
  tests and by default. Go/no-go stays the paraphrase floor (D9).
- Full verification: targeted 52/52, `npm test` 1416 pass / 0 fail,
  `agents:lint` PASS, `typecheck` clean.

## Checked — completion pass (2026-11-08, user: finish everything)

- **Loop seam closed:** `loop.mjs` turn 1 appends `cagBlockForRun()`
  (`const`→`let` on the foreign `pre` line + 3-line insert; loop rotation
  seeds reuse the same `pre`). Harness-side seed helpers
  (`harness.mjs` ×3) still rebuild preamble without CAG — they are
  sync compaction paths, noted not forced.
- **External-repo eval:** in-repo `queries-real.json` via
  `bench:retrieval --repo <operator-supplied path>` (separation rule —
  no external corpus stored in this repo).
- **StoreRegistry complete:** rows for `symbols`, `checkpoints`, `goal`,
  `memory` declared (migration pending, D7).
- **Memory legacy sweep:** `saveMemory` deletes the sha1 legacy file
  after a successful sha256 write.
- **UI:** context panel renders the `cag` manifest row; settings sheet
  saves `cag` (disjoint lines in foreign files, named).
- **Worker thread measured, deferred:** a large-repo cold build (bench-
  time `--repo` run) showed worst event-loop lag in the hundreds of ms —
  janky at worst, never frozen; a worker would cut lag, not wall time,
  so it stays Phase 6 material.
- **Carry:** `carryFacts` body sits inside the other session's fresh
  hunk — its private BM25 stays until that WIP lands; `CarryService`
  (shared kernel) already serves new callers.
- **Embeddings:** still gated — no local provider on this machine
  (Ollama absent), so the paraphrase floor cannot be measured;
  enabling without data would break D9.
- Full suite after completion pass: 1418 pass / 0 fail.

- **Threshold miscalibration** (D13): a floor tuned on the fixture may
  starve real queries. Mitigation: relative+absolute floor, per-corpus
  calibration at bench time, and the answer always names what was dropped.
- **Split churn**: four new modules invite import cycles. Mitigation:
  chunker imports only `text`+`symbols`; ranker imports `text`;
  index-store imports `cache-store`; facade imports all — a DAG, no
  back-edges. The typecheck (`npm run typecheck`) catches cycles early.
- **Bench becomes the bottleneck**: a large-repo build nightly is fine;
  per-PR it is not — fixture bench stays per-PR, external-repo bench
  nightly (§11).

## Checked (2026-11-08, pre-design)

- Sizes: retrieval 698, memory-store 449, text 119, cag 153, tools 1,861,
  loop 1,841 lines (wc -l).
- BM25 call sites: retrieval (shared helper), memory-store ×2 (private
  loops) — `grep tokenize|bm25 harness/`.
- Cache dirs under `~/.aipass`: retrieval, symbols, memory, cag, goal,
  run/checkpoints — each with its own keying code.
- Suite at design time: 1402 pass / 0 fail (`npm test`).

## Checked — Phase 1 done (2026-11-08)

- `harness/cache-store.mjs` (new) + `test/cache-store.test.mjs` (5 tests):
  StoreRegistry (`retrieval`, `cag`), singleton per name+home, LRU memo,
  version gate, corrupt-as-absent, `projectKey` keying.
- `cag.mjs` and `retrieval.mjs` persistence now ride the store; exported
  signatures unchanged. retrieval+cag+recall+bench+cache-store: 43/43.
  Full suite: 1407 pass / 0 fail.
- **External-corpus measurement (bench-time, temp home, caps as-is):**
  a large operator-supplied repo indexed in seconds with queries in the
  tens-to-hundreds of ms. Thai paraphrase queries returned relevant tops
  (lexical Thai works: docs share vocabulary + trigram fallback);
  English paraphrase was partial. **Negative query leaked:** a negative
  sharing one common word returned hits — retrieval has no score
  threshold, so a single shared word is an answer. Needs a min-score
  gate (Phase 2, D13 candidate) before the embeddings decision: fix
  the false-positive floor first. (Per the separation rule, the corpus,
  its name, and its numbers are not recorded here.)
- Embeddings decision after the external run: **still gated.** Thai
  retrieval on a large corpus is lexically adequate; the measured gap
  is false positives (above), which embeddings do not fix. Re-measure
  after the threshold gate.
