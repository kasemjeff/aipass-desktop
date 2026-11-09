# Documentation

This directory holds the design and operations docs. They are written in
English; the Thai README is at [`../README.th.md`](../README.th.md).

## Start here

| doc | what it answers |
|---|---|
| [`INSTALL.md`](./INSTALL.md) | how to install, what each platform ships, what macOS needs |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | something is broken; run `doctor` and read this |
| [`CONFIG.md`](./CONFIG.md) | every switch: environment variables, settings keys, harness options |
| [`FAQ.md`](./FAQ.md) | short answers to the questions that come up first |
| [`MATURITY.md`](./MATURITY.md) | what is production, experimental, or deliberately not shipped |
| [`RELEASE.md`](./RELEASE.md) | release checklist, signing, rollback |

## Design

| doc | what it holds |
|---|---|
| [`HARNESS_DESIGN.md`](./HARNESS_DESIGN.md) | the harness end to end: loop, tools, protocol, permissions, WAF |
| [`LOOP_DESIGN.md`](./LOOP_DESIGN.md) | the agent loop: stage map, guards, stop reasons, events |
| [`SHELL_BOUNDARY.md`](./SHELL_BOUNDARY.md) | the JS/Rust boundary: what the shell owns, what the harness owns (ADR-001) |
| [`SPEC_CHECKER.md`](./SPEC_CHECKER.md) | the checker: the read-only pass a `DONE` earns |
| [`SPEC_EVALS.md`](./SPEC_EVALS.md) | the eval runner: fixtures, replay, scoring |
| [`EXPERIMENTS.md`](./EXPERIMENTS.md) | the experiment queue and its records |
| [`TECH_STACK.md`](./TECH_STACK.md) | what runs where, and why |
| [`DATA_FORMATS.md`](./DATA_FORMATS.md) | what lands on disk |
| [`EVENTS.md`](./EVENTS.md) | every event the harness emits |
| [`UX.md`](./UX.md) | the CLI, window, extension and first-run design |
| [`PLUGINS_MCP_DESIGN.md`](./PLUGINS_MCP_DESIGN.md) | plugins and MCP servers |
| [`META_HARNESS.md`](./META_HARNESS.md) | the harness tuning itself |
| [`RELIABILITY.md`](./RELIABILITY.md) | SLIs, error budget, degradation modes |
| [`TEST_PLAN.md`](./TEST_PLAN.md) | test layers L1–L5 and what each cannot prove |
| [`UPDATE_DESIGN.md`](./UPDATE_DESIGN.md) | the update feed and the two versioned halves |
| [`REFRESH_DESIGN.md`](./REFRESH_DESIGN.md) | the refresh path |
| [`FEATURE_GAPS.md`](./FEATURE_GAPS.md) | the gap list a batch of work closes |
| [`FEATURE_GAPS_WAVE3.md`](./FEATURE_GAPS_WAVE3.md) | the boundary, the clock and the review — wave 3 of the gap list |
| [`MIGRATION.md`](./MIGRATION.md) | migrating from the upstream bridge |
| [`RAG_DESIGN.md`](./RAG_DESIGN.md) | the project retrieval design (RETRIEVE) |
| [`WORKLOG.md`](./WORKLOG.md) | the work log, kept for provenance |

## Contributing to the docs

- Keep behavior claims tied to code and tests. If a doc says "the suite
  checks this", name the test.
- Do not add a new outbound endpoint or local data store without updating
  [`PRIVACY.md`](../PRIVACY.md) in the same change.
- `node scripts/link-check.mjs` verifies that relative Markdown links resolve. Run it
  before opening a PR.

## Full index

Every design and operations doc, with a one-line summary. (Moved here from the front
README when it was trimmed to the Install / FAQ / Troubleshooting / Contributing /
Security skeleton; the front README now links here.)

| doc | summary |
|---|---|
| [`HARNESS_DESIGN.md`](./HARNESS_DESIGN.md) | the harness end to end: loop, tools, protocol, permissions, WAF — and how it sits on the bridge and the window |
| [`LOOP_DESIGN.md`](./LOOP_DESIGN.md) | the agent loop itself: stage map, guards, stop reasons, the event stream |
| [`LOOP_INTELLIGENCE.md`](./LOOP_INTELLIGENCE.md) | six loop upgrades — failure, retry, recovery, verification, budget, state — each with its own off-switch |
| [`SHELL_BOUNDARY.md`](./SHELL_BOUNDARY.md) | the JS/Rust boundary: what the shell owns, what the harness owns (ADR-001) |
| [`SPEC_CHECKER.md`](./SPEC_CHECKER.md) | the checker: the read-only pass a `DONE` earns, verdicts, the declared check |
| [`SPEC_EVALS.md`](./SPEC_EVALS.md) | the eval runner: task fixtures, live and replay modes, scoring |
| [`EXPERIMENTS.md`](./EXPERIMENTS.md) | the experiment queue: sources, records, budgets, when an experiment ends |
| [`TECH_STACK.md`](./TECH_STACK.md) | what runs where, and the reasons each piece is what it is |
| [`DATA_FORMATS.md`](./DATA_FORMATS.md) | what lands on disk: settings, session JSONL, the token, uploads, eval results |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | when something is broken: doctor, the common failures, where the logs are |
| [`FAQ.md`](./FAQ.md) | frequently asked questions: official status, API keys, Chrome, data, offline, Node, Rust, sessions, uninstall |
| [`RELIABILITY.md`](./RELIABILITY.md) | what healthy means: the SLIs and their targets, the error budget, degradation modes |
| [`RELEASE.md`](./RELEASE.md) | versioning, the release checklist, upgrade and rollback, dependency review |
| [`INSTALL.md`](./INSTALL.md) | the install system: what an install guarantees, what each platform ships, what macOS needs |
| [`PLATFORM_CHECKLIST.md`](./PLATFORM_CHECKLIST.md) | what CI proves vs what needs a real machine, per platform |
| [`UPDATE_DESIGN.md`](./UPDATE_DESIGN.md) | the update system: the shell and the content as two versioned halves, the signed feed, the phases |
| [`MATURITY.md`](./MATURITY.md) | capability status — production vs experimental, owners, what changes a status |
| [`TEST_PLAN.md`](./TEST_PLAN.md) | the test design: layers L1–L5, cases, pass criteria, what each layer cannot prove |
| [`CONFIG.md`](./CONFIG.md) | every switch the product reads — env vars, settings keys, harness options — held equal to the code by a test |
| [`EVENTS.md`](./EVENTS.md) | every event the harness emits, who fires it and who reads it — held equal to the code by a test |
| [`UX.md`](./UX.md) | the UX design for the CLI, the window, the extension popup and first-run setup, with what has shipped |
| [`PLUGINS_MCP_DESIGN.md`](./PLUGINS_MCP_DESIGN.md) | how plugins and MCP servers are installed, enabled, updated and removed |
| [`META_HARNESS.md`](./META_HARNESS.md) | the harness tuning itself: the meta loop that turns eval evidence into harness changes |
| [`FEATURE_GAPS.md`](./FEATURE_GAPS.md) | the gap list a batch of work closes — every row names the test that proves it |
| [`FEATURE_GAPS_WAVE3.md`](./FEATURE_GAPS_WAVE3.md) | the boundary, the clock and the review — wave 3 of the gap list |
| [`CAG_DESIGN.md`](./CAG_DESIGN.md) | CAG — cache-augmented generation for this harness (module built, wiring into the loop deferred) |
| [`KNOWLEDGE_ARCHITECTURE.md`](./KNOWLEDGE_ARCHITECTURE.md) | knowledge architecture: one kernel, three corpora, one cache |
| [`RAG_DESIGN.md`](./RAG_DESIGN.md) | the project retrieval design (RETRIEVE) |
| [`REFRESH_DESIGN.md`](./REFRESH_DESIGN.md) | the model catalog's refresh path |
| [`MIGRATION.md`](./MIGRATION.md) | migrating from the upstream bridge |
| [`WORKLOG.md`](./WORKLOG.md) | session handoffs, newest first — kept for provenance |

The behavior-level change history is [`../CHANGELOG.md`](../CHANGELOG.md); it is what
release notes are cut from. Component-level docs sit next to their code:
[`../aipass-bridge/README.md`](../aipass-bridge/README.md) (the upstream bridge and CLI),
[`../aipass-bridge/docs/DOCS.md`](../aipass-bridge/docs/DOCS.md),
[`../desktop/README.md`](../desktop/README.md) (the window and native builds), and
[`../ide-extension/README.md`](../ide-extension/README.md) (the VS Code panel).
