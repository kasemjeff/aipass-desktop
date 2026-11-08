# The shell boundary (ADR-001)

> Status: accepted, 2026-11-08. The rule for "which side owns this" — written
> down because the answer kept being rediscovered in review.

The app is four programs (see [TECH_STACK.md](TECH_STACK.md)): a Rust shell, a
Node backend, the bridge and the Chrome extension. One question recurs more
than any other: **should this live in Rust or in JavaScript?**

## The decision

- **Rust owns the window's life.** The window and the tray, single-instance,
  the remembered geometry, and the backend process — spawn, readiness, port
  ownership, backoff, restart, content rollback, installer handover. None of
  it decides anything about the agent.
- **Node owns every agent decision.** The run loop, tools, permissions,
  sessions, compaction, skills, the RPC surface, updates, settings. The same
  modules serve the window and `aipass agent`, which is why they are
  JavaScript (constraint 2 in TECH_STACK): a reimplementation in Rust would be
  a second agent, and the two would drift.
- **The facts both sides compare are one file.**
  `aipass-bridge/harness/desktop-contract.json` holds the desktop port, the
  two supervisor exit codes, the app home's name and the root marker. Node
  reads it at runtime (`harness/desktop-contract.mjs`); `build.rs` compiles it
  into Rust constants (`src/shared.rs`). A literal on either side fails
  `test/desktop-contract.test.mjs`.
- **The root candidates stay duplicated, on purpose.** The
  overlay → bundle → repository order depends on the platform and on Tauri's
  own path API, and it is resolved before anything can be imported. It lives
  in `paths.rs` and `harness/app-root.mjs`; a fixture test ("the shell
  resolves the same root as the Node side") keeps them equal, and a new
  candidate has to be added in both places.

## The test to apply

Ask in this order:

1. **Does it have to outlive the Node child?** Then Rust. A supervisor that
   lives inside the process it supervises cannot restart it.
2. **Does it decide what the agent does, reads or writes?** Then Node. The
   CLI, the window and the suite must see one implementation.
3. **Is it a value both sides compare?** Then the contract file.
4. **Is it platform layout?** Then it may be implemented twice — with a test
   that says the two agree, and a comment saying so.

## Consequences

- Two toolchains and two test lanes: `npm test` for the Node half,
  `npm run test:rust` for the crate. CI runs both; `npm run check` runs both
  locally (the Rust lane skips, loudly, where cargo is absent).
- The installer carries a Node sidecar (~88 MB) because the shell does not
  embed a JS engine. That is the price of sharing the agent with the CLI.
- A cold start waits for the backend (up to 60 s, `main.rs`); the window opens
  only when the port answers, so a blank page never happens.
- Iterating on the agent is edit-and-restart; iterating on the shell is a
  cargo rebuild.

## What would change it

| trigger | change |
|---|---|
| the agent core stops being shared with a CLI | the JS constraint weakens; a Rust core becomes arguable — still a rewrite of ~30k lines and their tests |
| Node stops being shipped (a JS engine embedded in the shell) | the sidecar and the supervisor shrink; the boundary stays |
| a second shell (web, mobile) needs the same logic | the RPC surface is the seam; the shell stays replaceable |
| the upstream offers native tool calls and prompts | the harness shrinks; the boundary does not move |

Electron was considered and rejected: it would collapse the two runtimes into
one, but it adds a Chromium to ship, a large npm dependency tree (the project
keeps zero runtime npm dependencies on purpose) and a JS reimplementation of
the supervisor — more surface for less control, at a similar installer size.
