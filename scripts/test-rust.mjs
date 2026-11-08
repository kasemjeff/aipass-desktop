#!/usr/bin/env node
// The shell's own unit tests: `cargo test` for the Rust half.
//
// `npm test` is the court of record for the Node half, and it cannot reach the
// crate: a separate language, a separate toolchain, a separate build. CI has
// run `cargo test` since the shell had tests, but a person on their own
// machine could break the shell, see a green `npm test`, and hand off. So
// `npm run check` asks this script too.
//
// Two rules:
//   - No cargo on PATH is a SKIP that says so. Pretending the shell passed is
//     worse than saying it was not asked; CI is the lane that always has it.
//   - The sidecar must exist before the crate compiles: `tauri-build` resolves
//     the external Node binary during the build, even for `cargo test`, and a
//     clean checkout has none (a ~90 MB executable, gitignored on purpose).
//     CI puts it in place with `npm run desktop:sidecar`; so does this.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crate = path.join(repo, 'desktop', 'src-tauri');
const sidecar = path.join(repo, 'desktop', 'sidecar');

const version = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) {
  console.log('skipped: cargo is not on PATH - the shell runs in CI (.github/workflows/test.yml, the shell job)');
  process.exit(0);
}

// `node-<triple>` on unix, `node-<triple>.exe` on Windows; `fetch-node.mjs`
// writes whichever the machine needs.
const hasSidecar = fs.existsSync(sidecar)
  && fs.readdirSync(sidecar).some((name) => name.startsWith('node-') && !name.endsWith('.mjs'));
if (!hasSidecar) {
  console.log('the Node sidecar is missing - putting it in place first (npm run desktop:sidecar)');
  const fetched = spawnSync(process.execPath, [path.join(sidecar, 'fetch-node.mjs')], {
    cwd: repo,
    stdio: 'inherit',
  });
  if (fetched.status !== 0) {
    console.error('the sidecar could not be prepared, so the shell cannot be built or tested');
    process.exit(fetched.status ?? 1);
  }
}

const ran = spawnSync('cargo', ['test'], { cwd: crate, stdio: 'inherit' });
if (ran.error) {
  console.error(`cargo test could not start: ${ran.error.message}`);
  process.exit(1);
}
process.exit(ran.status ?? 1);
