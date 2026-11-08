# CAG — cache-augmented generation for this harness

> **Status: module built (`harness/cag.mjs` + `test/cag.test.mjs`, 8/8),
> wiring into the loop/settings/RPC deferred — the checkout carries
> foreign WIP in `settings.mjs`, `loop.mjs`, `harness.mjs`, `rpc.mjs` and
> `memory-store.mjs`, and those files are read-only this session.**
> This file is the design and the wiring plan. Do not wire it by editing
> another session's dirty hunks; land it after their work commits, in the
> phase order below.

**One line:** build the project's standing context (AGENTS.md, README, goal)
once, cache it on disk keyed by the sources' own hashes, and send the same
bytes on turn 1 and every rotation seed — so the provider's prefix cache
(provider-client.mjs marks message 1 as a prompt-cache breakpoint) actually
hits, and no run re-reads the same standing text.

## What CAG means here

Cache-augmented generation preloads slow-moving context into a cache that
every turn reuses, instead of retrieving it per question. In this harness
that is the opposite pole from RAG:

| | RAG (`RETRIEVE`) | CAG (this design) |
|---|---|---|
| question | "what does the project contain?" | "what must the model always know?" |
| who asks | the model, per task, via a marker | nobody — it rides turn 1 / seeds |
| content | ranked passages, task-shaped | standing sources, fixed order |
| cache | retrieval index (BM25 postings) | the pack itself, hash-verified |
| failure if wrong | a bad passage the model can ignore | stale standing text — hence hash invalidation |

## The pack (built)

- **Sources (default):** `AGENTS.md`, `README.md` at the project root.
  Configurable per project later; the list order is the render order.
- **Render:** `## <path> (sha256 <12>)` + body, sources joined in list
  order, hard budget 16,000 chars (`AIPASS_CAG_BUDGET`, per-file cap
  `AIPASS_CAG_MAX_FILE_BYTES`, default 512 KB). Deterministic: same
  sources → same bytes. A truncated pack says so (`truncated: true`).
- **Cache file:** `~/.aipass/cag/<projectKey>.json` (0700 dir, 0600
  atomic via `writeFileAtomic`), keyed with the same `projectKey` the
  retrieval index and memory store use — one project, one key.
- **Freshness:** `ensurePack()` stats each source and compares
  (mtime, size) with the cached manifest — untouched sources cost a stat,
  a changed `AGENTS.md` rebuilds on the next ensure. `loadPack()`
  re-verifies `packSha` over the stored text, so a half-written or
  hand-edited cache reads as absent, not as truth.
- **Exclusions (same floor as RETRIEVE):** `secretHit` paths, binary
  (NUL byte), files over cap, and symlinks whose real target escapes the
  root never enter the pack. A missing source is skipped, not fatal.

## Why byte-identical matters

`provider-client.mjs` puts `cache_control: {type:'ephemeral'}` on the
first message (the protocol preamble) and on the penultimate message.
Anthropic's prefix cache only pays when the prefix is byte-stable. RAG
passages are task-shaped by design, so they must never sit in that
prefix — the pack is the stable head, RETRIEVE results stay after it.
On the AiPASS path there is no prompt cache to hit (server-side history
holds turn 1 until rotation), and the same bytes still save the
re-read/re-assembly every run.

## Wiring plan (phases, after the dirty WIP lands)

| phase | scope | files |
|---|---|---|
| 1 — turn 1 | `ensurePack(root)` in the turn-1 build, pack as one budget block beside instructions/memory (context-sources.mjs `assemble()`), manifest row `cag` | `harness/loop.mjs`, `harness/context-sources.mjs` (or current assembly site), `test/cag-wiring.test.mjs` |
| 2 — seeds | same pack on rotation seeds (seed budget), so a rotated conversation keeps the standing context without re-reading sources | `harness/harness.mjs` seed builders |
| 3 — surface | settings row `cag: true/false` (default on in desktop, like `retrieve`), RPC `cag.status` / `cag.clear`, `/cag` command, one context-panel row reusing `cag.status` | `harness/settings.mjs`, `harness/rpc/files.mjs`, `harness/rpc/contract.mjs`, `desktop/ui/*` |
| 4 — goal source | add the durable goal text (`harness/goal.mjs`) as an optional pack source — it is standing context by definition | `harness/cag.mjs` |

Phase 1 must keep the pinned replay green: the pack is one more block in
the turn-1 message, so `evals/fixtures/` preamble bytes need the same
treatment VERIFY's flag got (a gate flag, off in replay fixtures).

## Not in this design

- **Per-step auto-injection.** Rejected for the same reason RAG_DESIGN.md
  rejected it: task-shaped context belongs in tool results the model
  asked for (RETRIEVE/RECALL), not in the paid-for prefix.
- **Embeddings / vector pack.** CAG is exact and hash-keyed; semantic
  standing context is RAG Phase 3's job, not a second retrieval system.
- **Cross-project packs.** One root, one pack — same containment rule as
  the retrieval index.

## Checked (2026-11-08)

- `node --test aipass-bridge/test/cag.test.mjs` — 8/8 (reuse is
  byte-identical, changed source rebuilds, secret/binary/missing sources
  excluded, budget truncation named, clear+status round-trip).
- `node --test aipass-bridge/test/retrieval.test.mjs
  aipass-bridge/test/retrieval-bench.test.mjs aipass-bridge/test/recall.test.mjs`
  — 30/30 after moving BM25 into `text.mjs` (`bm25Idf`/`bm25Term`/
  `bm25ScoreAll`); identical math, retrieval now calls the shared helpers.
- `npm run bench:retrieval -- --repo .` — exact recall@8 100% (MRR
  0.958), paraphrase 21.4%, negative 6/6, real-repo 70% (MRR 0.479),
  922 files / 6,928 chunks, cold build 6.9s, query p95 25ms.
