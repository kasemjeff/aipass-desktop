# AiPASS Desktop — A local-first AI coding agent that lets you inspect every file change before it reaches your project.

[English](./README.md) · [ไทย](./README.th.md)

> **A local-first AI coding agent that lets you inspect every file change before it reaches your project.**
> Open-source · Thai-first · Windows, macOS & Linux · MIT licensed · zero npm runtime dependencies.
>
> **The desktop window and agent harness for [de.aipass.net](https://de.aipass.net/chat)** — a file-editing agent you can watch, approve and resume, running through the community bridge that reaches the site via your own logged-in browser tab.

> **Status: pre-1.0** — Release v0.2.0 is published, but it contains no installer assets yet. Install from source below. The native
> package is verified on **Windows**; macOS and Linux builds are wired and compile per-branch,
> but treat them as **ready-to-try, not ready-to-ship** until someone has run them
> end-to-end on real hardware. See [ROADMAP.md](./ROADMAP.md).

<p align="left">
  <img src="https://img.shields.io/badge/node-%E2%89%A524-blue?logo=node.js&style=flat-square" alt="Node >= 24" />
  <img src="https://img.shields.io/badge/version-0.2.0-blue?style=flat-square" alt="Version 0.2.0" />
  <img src="https://img.shields.io/badge/npm%20runtime%20dependencies-zero-success?style=flat-square" alt="Zero npm runtime dependencies" />
  <img src="https://img.shields.io/badge/tests-npm%20test-blue?style=flat-square" alt="Tests: run npm test" />
</p>

<p align="left">
  🌐 <a href="https://kasemjeff.github.io/aipass-desktop/">Landing page</a> ·
  📦 <a href="https://github.com/kasemjeff/aipass-desktop/releases/latest">Release v0.2.0 (source install; installers are not published yet)</a>
</p>

<p align="left">
  💬 <a href="https://github.com/kasemjeff/aipass-desktop/discussions">Join the discussion</a> ·
  🐛 <a href="https://github.com/kasemjeff/aipass-desktop/issues/new/choose">Report a problem or suggest an idea</a> ·
  ⭐ <a href="https://github.com/kasemjeff/aipass-desktop">Star the repo if it helps you</a>
</p>

## See it in 30 seconds

![AiPASS Desktop in light theme: sessions and project files on the left, conversation with tool rows in the center, composer at the bottom](./public/screenshots/desktop-light.png)

<p align="center">
  <em>Sessions and the project tree on the left, the conversation in the middle, the composer at the bottom — every tool call a row you can open. Edits stay staged until you approve them.</em>
</p>

The whole product is one flow:

| Step | What happens | What you control |
|---|---|---|
| **1. Send work** | Describe the task in chat, Thai or English | — |
| **2. Watch it read** | The agent lists and reads your files, one row per tool call | Open any row to see exactly what it did |
| **3. Review the diff** | Edits pile up in a pending panel — real per-file diffs, not a summary | Tick only the files you trust |
| **4. Approve** | Only the files you ticked are written; the rest stays out of your project | Stop ends the work, not just the chat |

No edit reaches your files without your tick. A 15–30 second demo video
(send → reads → diff → approve) ships with the first release.

## Quick start

```bash
git clone https://github.com/kasemjeff/aipass-desktop.git
cd aipass-desktop
npm run setup     # Node check, token, bridge, browser pages
npm run desktop   # opens the window at http://127.0.0.1:8790
```

> The window is not ready until the browser is set up — **two more steps**:
> [load the Chrome extension and paste the loopback token](#two-browser-steps-once-per-browser),
> then log in at `de.aipass.net` and leave the tab open. The bridge's `/status` tells you
> where you stand; the window header shows the same.

**Who this fits:** Thai-first users on Windows who want a file-editing agent they can
watch, approve and resume. **Who it does not fit (yet):** anyone who needs a signed
macOS/Linux installer today — running the window in a browser works on all three OSs today.

## Install

Release `v0.2.0` is published, but it contains no installer assets yet. Install
from source below; when installers are published, they will appear on
[Releases](https://github.com/kasemjeff/aipass-desktop/releases/latest). See [ROADMAP.md](./ROADMAP.md) for the release criteria and
[`docs/INSTALL.md`](./docs/INSTALL.md) for what each platform ships.

### What you need

| You need | Why |
|---|---|
| **Node ≥ 24** | required to run the local backend |
| **Chrome or Chromium** | the extension is the only thing that touches your session |
| **A de.aipass.net account** | your logged-in browser tab *is* the credential |
| **Nothing else** | no `npm install`, database, or separate API key |

### One command

From a fresh clone, this is the whole machine setup:

```bash
git clone https://github.com/kasemjeff/aipass-desktop.git
cd aipass-desktop
npm run setup
```

`setup` is idempotent — re-run it any time. It checks the Node version, creates
`~/.aipass/` and mints the loopback token, copies the token to the clipboard, starts the
bridge, and opens the browser pages.

### Two browser steps (once per browser)

1. **Load the extension** — `chrome://extensions` → **Developer mode** →
   **Load unpacked** → pick `aipass-bridge/extension`.
2. **Give it the token** — extension popup → **Advanced** → **Loopback token** → paste
   the contents of `~/.aipass/.token` → save. Then open <https://de.aipass.net/chat>,
   log in, and leave the tab open: that tab is what does the talking.

### The native app

The window runs in any browser today — `npm run desktop` serves it on
`127.0.0.1:8790`. For the packaged app, building also needs the Rust toolchain and the
Tauri CLI (`cargo install tauri-cli --version "^2"`); the packaged app carries its own
Node runtime. The whole procedure is in [`docs/INSTALL.md`](./docs/INSTALL.md).

### Uninstall

```bash
rm -f ~/.local/bin/aipass      # or: npm rm -g aipass, if you used npm link (macOS/Linux)
rm -rf ~/.aipass               # only if the sessions and settings go too
```

On Windows: `npm rm -g aipass`, then `Remove-Item -Recurse -Force "$env:USERPROFILE\.aipass"`.
Remove the extension from `chrome://extensions`, and the app from your desktop.

## FAQ

**Is this the official AiPASS client?**
No. An independent community project that talks to `de.aipass.net` through your own
logged-in browser tab — not affiliated with or endorsed by the operator.
See [TRADEMARK.md](./TRADEMARK.md).

**Do I need an API key?**
No, for the default setup. You need a `de.aipass.net` account and a Chrome/Chromium tab
logged in to it. An external provider is optional; that provider may require a key.

**Why Chrome? Why an extension?**
The service authenticates with the browser session cookie. The extension runs the request
as ordinary page JavaScript inside your own tab — no credential is copied out of the browser.

**Where does my data go?**
Prompts and attachments go to `de.aipass.net` through your tab (or to a provider you
configured). Local state lives in `~/.aipass/`. There is no telemetry.
See [PRIVACY.md](./PRIVACY.md).

**Do I need Rust?**
Only to build the native window. `npm run desktop` runs the window in a browser without Rust.

More answers — including offline use, uninstall, and the unsigned-installer question — in
[`docs/FAQ.md`](./docs/FAQ.md).

## Troubleshooting

- **No tab / the extension shows ×0** — log in at `de.aipass.net/chat` and leave the tab open.
- **401 / wrong token** — the backend and the bridge must read the same `~/.aipass/.token`.
- **`port 8790 is busy`** — stop the old backend, or pick another port.
- **A run freezes mid-stream** — Chrome **Settings → Performance → Always keep these
  sites active** → add `de.aipass.net`, so a run is never frozen mid-stream.
- **Something else** — run `/doctor` in the terminal, then read the failure playbook
  in [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md).

## Contributing

The fastest way to help is to try one real task and tell us what happened:

1. **Ask a question or share a workflow** in [Discussions](https://github.com/kasemjeff/aipass-desktop/discussions).
2. **Report a reproducible problem or propose an improvement** through the [issue forms](https://github.com/kasemjeff/aipass-desktop/issues/new/choose).
3. **Test a platform build** and note your OS, Node version and result in [Platform Checklist](./docs/PLATFORM_CHECKLIST.md).
4. **Send a small pull request** after reading [CONTRIBUTING.md](./CONTRIBUTING.md); documentation, tests and translations are welcome.

Please include the task you tried, the expected result and the actual result. Never
post tokens, private project paths or customer data. If the project saves you time,
a star or a short note about what you built helps other people decide whether to try it.

- `npm test` must end green before you push; add a test for every behavior change.
- Zero runtime dependencies — a new package needs human sign-off.
- Markdown links are checked by `node scripts/link-check.mjs`.

The full guide is [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Security

- No credential is copied out of your browser: requests run as ordinary page JavaScript
  inside your own logged-in tab, so the site's cookie rides along by itself.
- The loopback token lives at `~/.aipass/.token` (owner-only); even a command's *output*
  is screened before it goes upstream.
- Report a vulnerability privately — never as a public issue.

The full model is [`SECURITY.md`](./SECURITY.md).

## Documentation

Start at [`docs/README.md`](./docs/README.md) — the full index of every design and
operations doc, with one-line summaries. Component docs sit next to their code:
[`aipass-bridge/README.md`](./aipass-bridge/README.md) (the bridge and the terminal),
[`desktop/README.md`](./desktop/README.md) (the window and native builds), and
[`ide-extension/README.md`](./ide-extension/README.md) (the VS Code panel).

Every environment variable and settings key lives in [`docs/CONFIG.md`](./docs/CONFIG.md) —
if it disagrees with anything here, `CONFIG.md` wins.

## Credits & license

**Our work** — the desktop window (`desktop/`), the harness (`aipass-bridge/harness/`),
the sessions, the agent protocol, the eval and experiment tooling, and the docs.

**Upstream, continued** — the bridge, the Chrome extension and the CLI, from
[niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge) by
[niawjunior](https://github.com/niawjunior). That code stays under niawjunior's
copyright, credited in the [MIT License](./LICENSE).

This continuation is released under the [MIT License](./LICENSE).
