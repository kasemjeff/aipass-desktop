// The facts the shell and the Node side must agree on, in one file.
//
// The Rust shell cannot import JavaScript, so the port, the two supervisor
// exit codes, the app home's name and the root marker live in
// `harness/desktop-contract.json`. The Node side reads it at runtime and
// `desktop/src-tauri/build.rs` compiles it into Rust constants. This file is
// the enforcement: a value kept as a literal in either source tree fails here,
// because the drift is not cosmetic -- the window polls a port the backend did
// not bind, or the supervisor reads a deliberate restart as a crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_HOME_DIR, APP_MARKER, DEFAULT_DESKTOP_PORT, RESTART_EXIT, PORT_BUSY_EXIT,
} from '../harness/desktop-contract.mjs';
import { PORT_BUSY_EXIT as RPC_BUSY_EXIT } from '../harness/rpc.mjs';
import { RESTART_EXIT as RPC_RESTART_EXIT } from '../harness/rpc/update.mjs';
import { MARKER } from '../harness/app-root.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractFile = path.join(repo, 'aipass-bridge', 'harness', 'desktop-contract.json');

test('the shell and the backend read the same contract', () => {
  const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
  assert.deepEqual(
    Object.keys(contract).sort(),
    ['appHomeDir', 'appMarker', 'desktopPort', 'portBusyExit', 'restartExit'],
    'the contract names exactly the facts both halves read',
  );

  assert.equal(DEFAULT_DESKTOP_PORT, contract.desktopPort, 'the default port is the contract\'s');
  assert.equal(RPC_BUSY_EXIT, contract.portBusyExit, 'the backend exits with the contract\'s busy-port code');
  assert.equal(RPC_RESTART_EXIT, contract.restartExit, 'the backend restarts with the contract\'s restart code');
  assert.equal(MARKER, contract.appMarker, 'the app root is found by the contract\'s marker');
  assert.equal(APP_MARKER, contract.appMarker, 'the exported marker is the contract\'s');
  assert.equal(APP_HOME_DIR, contract.appHomeDir, 'the exported home directory is the contract\'s');

  // The supervisor's two numbers are read apart; a contract that made them
  // equal would turn every busy port into a restart loop.
  assert.notEqual(RESTART_EXIT, PORT_BUSY_EXIT, 'a restart and a busy port stay different codes');
});

test('neither half keeps its own copy of the contract', () => {
  // Source-shape on purpose: the Node side reads the contract at runtime, so
  // the only way a literal creeps back in is by being written into a file.
  const read = (...parts) => fs.readFileSync(path.join(repo, ...parts), 'utf8');

  const node = [
    read('aipass-bridge', 'harness', 'launcher.mjs'),
    read('aipass-bridge', 'harness', 'rpc.mjs'),
    read('aipass-bridge', 'harness', 'rpc', 'update.mjs'),
    read('aipass-bridge', 'harness', 'settings.mjs'),
    read('aipass-bridge', 'harness', 'app-root.mjs'),
    read('desktop', 'main.mjs'),
  ].join('\n');
  assert.doesNotMatch(node, /DEFAULT_DESKTOP_PORT\s*=\s*8790/, 'the Node side does not hard-code the desktop port');
  assert.match(
    read('aipass-bridge', 'harness', 'launcher.mjs'),
    /export\s*\{\s*DEFAULT_DESKTOP_PORT\s*\}/,
    'the launcher re-exports the contract\'s port instead of owning a copy',
  );
  assert.doesNotMatch(node, /PORT_BUSY_EXIT\s*=\s*43/, 'the backend does not hard-code the busy-port code');
  assert.doesNotMatch(node, /RESTART_EXIT\s*=\s*42/, 'the backend does not hard-code the restart code');
  assert.doesNotMatch(node, /'\.aipass'/, 'the Node side does not hard-code the home directory');
  assert.doesNotMatch(node, /aipass-bridge\/bridge\/server\.mjs/, 'the Node side does not hard-code the root marker');

  // The entry script is the one Node file that cannot import the contract
  // module — it needs the marker to find the harness at all — so it reads the
  // same JSON itself, and its values come from there.
  const entry = read('desktop', 'main.mjs');
  assert.match(entry, /desktop-contract\.json/, 'the entry script reads the contract');
  assert.match(entry, /contract\.appMarker/, 'the entry script takes the marker from the contract');
  assert.match(entry, /contract\.appHomeDir/, 'the entry script takes the home directory from the contract');

  const rustDir = path.join(repo, 'desktop', 'src-tauri', 'src');
  const rust = fs.readdirSync(rustDir)
    .filter((file) => file.endsWith('.rs'))
    .map((file) => fs.readFileSync(path.join(rustDir, file), 'utf8'))
    .join('\n');
  assert.doesNotMatch(rust, /DEFAULT_DESKTOP_PORT\s*:\s*u16\s*=\s*8790/, 'the shell does not hard-code the desktop port');
  assert.doesNotMatch(rust, /Ok\(8790\)/, 'the fallback port is the contract\'s, not a literal');
  assert.doesNotMatch(rust, /"\.aipass"/, 'the shell does not hard-code the home directory');
  assert.doesNotMatch(rust, /const\s+RESTART_EXIT\s*:\s*i32\s*=\s*42/, 'the shell does not hard-code the restart code');
  assert.doesNotMatch(rust, /const\s+PORT_BUSY_EXIT\s*:\s*i32\s*=\s*43/, 'the shell does not hard-code the busy-port code');

  // And the shell really reads it, rather than agreeing by coincidence.
  assert.match(rust, /crate::shared::DEFAULT_DESKTOP_PORT/, 'the shell takes its port from the contract');
  assert.match(rust, /crate::shared::RESTART_EXIT/, 'the shell takes the restart code from the contract');
  assert.match(rust, /crate::shared::PORT_BUSY_EXIT/, 'the shell takes the busy-port code from the contract');
  assert.match(rust, /crate::shared::APP_MARKER/, 'the shell takes the root marker from the contract');

  const build = read('desktop', 'src-tauri', 'build.rs');
  assert.match(build, /desktop-contract\.json/, 'the build script reads the contract file');
  assert.match(build, /OUT_DIR/, 'and writes the constants where the crate can include them');
});
