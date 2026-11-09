/**
 * The shell worker (harness/shell-worker.mjs): the separation between the
 * backend and the shell it starts.
 *
 *   - the worker's environment is an allowlist minus secret names — a token
 *     the backend holds never reaches the shell it forks;
 *   - the worker refuses a cwd outside its allowed root (lexically and
 *     physically — a junction out is out);
 *   - a worker that dies does not take the backend with it: the call answers
 *     `err:` and the next call still works (respawn per call, no state).
 *
 * Run: node --test aipass-bridge/test/shell-worker.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeEnv, checkCwd } from '../harness/shell-worker.mjs';
import { runShell } from '../harness/execution.mjs';

const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-worker-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

/* ------------------------------------------------------- the environment */

test('the shell environment keeps the toolchain and drops secret names', () => {
  const env = sanitizeEnv({
    PATH: 'C:\\bin', PATHEXT: '.COM;.EXE', SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\cmd.exe', TEMP: 'C:\\t',
    API_KEY: 'supersecret', GITHUB_TOKEN: 'ghp_secret', MY_SECRET_TOKEN: 'tok',
    DB_PASSWORD: 'pw', AIPASS_REQUIRE_AUTH: '1', CUSTOM_UNSWEPT: 'x',
  });
  assert.equal(env.PATH, 'C:\\bin', 'the toolchain stays');
  assert.equal(env.COMSPEC, 'C:\\Windows\\cmd.exe');
  for (const gone of ['API_KEY', 'GITHUB_TOKEN', 'MY_SECRET_TOKEN', 'DB_PASSWORD', 'AIPASS_REQUIRE_AUTH', 'CUSTOM_UNSWEPT']) {
    assert.equal(env[gone], undefined, `${gone} is not inherited`);
  }
  assert.equal(Object.values(env).includes('supersecret'), false);
});

/* --------------------------------------------------------------- the cwd */

test('a cwd inside the allowed root is allowed, outside is refused', () => {
  const root = tempDir({ 'a.txt': 'x' });
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  assert.equal(checkCwd(path.join(root, 'sub'), root).ok, true);
  assert.equal(checkCwd(root, root).ok, true);
  const traversal = checkCwd(path.join(root, '..', 'outside'), root);
  assert.equal(traversal.ok, false);
  assert.match(traversal.error, /outside the allowed root/);
});

test('a junction out of the allowed root makes the cwd outside it', async (t) => {
  const root = tempDir({ 'a.txt': 'x' });
  const outside = tempDir({ 'secret.txt': 'nope' });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.symlinkSync(outside, path.join(root, 'away'), 'junction');
  } catch (err) {
    return t.skip(`links cannot be made here: ${err.code}`);
  }
  const checked = checkCwd(path.join(root, 'away'), root);
  assert.equal(checked.ok, false, 'a link out of the root is a link out of the root');
});

test('runShell refuses a cwd outside the allowed root instead of running there', async () => {
  const root = tempDir({ 'a.txt': 'x' });
  const outside = tempDir({ 'secret.txt': 'nope' });
  const script = path.join(root, 'print.mjs');
  fs.writeFileSync(script, "console.log('ran');\n");
  await assert.rejects(
    () => runShell(`node "${script}"`, { cwd: outside, allowedRoot: root, timeoutMs: 10_000 }),
    /outside the allowed root/,
    'the command was not run outside its root',
  );
});

/* ------------------------------------------------------ env through a run */

test('a RUN shell does not inherit the backend secrets', async () => {
  const dir = tempDir();
  const printer = path.join(dir, 'print-env.mjs');
  fs.writeFileSync(printer, [
    "console.log('LEAKED=' + (process.env.MY_TEST_SECRET_TOKEN ?? 'absent'));",
    "console.log('PATH_OK=' + Boolean(process.env.PATH || process.env.Path));",
    '',
  ].join('\n'));
  const previous = process.env.MY_TEST_SECRET_TOKEN;
  process.env.MY_TEST_SECRET_TOKEN = 'topsecret-value';
  try {
    const { stdout } = await runShell(`node "${printer}"`, { cwd: dir, timeoutMs: 15_000, allowedRoot: dir });
    assert.match(stdout, /LEAKED=absent/, 'the secret never reached the shell');
    assert.match(stdout, /PATH_OK=true/, 'and the toolchain still works');
  } finally {
    if (previous === undefined) delete process.env.MY_TEST_SECRET_TOKEN;
    else process.env.MY_TEST_SECRET_TOKEN = previous;
  }
});

/* ------------------------------------------------------- crash recovery */

test('a dead shell worker answers err and the backend still answers the next run', async () => {
  const dir = tempDir();
  // The command kills its parent — the worker — and nothing else. The
  // backend must survive: the NEXT run is the proof.
  const killer = path.join(dir, 'kill-worker.mjs');
  fs.writeFileSync(killer, "setTimeout(() => { try { process.kill(process.ppid, 'SIGKILL'); } catch {} }, 100);\nconsole.log('started');\n");
  const printed = path.join(dir, 'print.mjs');
  fs.writeFileSync(printed, "console.log('still-alive');\n");

  await assert.rejects(
    () => runShell(`node "${killer}"`, { cwd: dir, timeoutMs: 15_000, allowedRoot: dir }),
    // The exact shape varies (worker exited, or the shell died with it) —
    // what must hold is a rejection, not a hang and not a backend death.
    (err) => err instanceof Error && Boolean(err.message),
  );
  const { stdout } = await runShell(`node "${printed}"`, { cwd: dir, timeoutMs: 15_000, allowedRoot: dir });
  assert.match(stdout, /still-alive/, 'the backend answers the next run after a worker died');
});

test('a shell past its timeout rejects from the worker and frees the slot', async () => {
  const dir = tempDir();
  const sleeper = path.join(dir, 'sleep.mjs');
  fs.writeFileSync(sleeper, "await new Promise((r) => setTimeout(r, 30_000));\nconsole.log('slept');\n");
  await assert.rejects(
    () => runShell(`node "${sleeper}"`, { cwd: dir, timeoutMs: 800, allowedRoot: dir }),
    /timed out/,
  );
  // The worker slot is free again: a normal command still runs.
  const printer = path.join(dir, 'print.mjs');
  fs.writeFileSync(printer, "console.log('after-timeout');\n");
  const { stdout } = await runShell(`node "${printer}"`, { cwd: dir, timeoutMs: 15_000, allowedRoot: dir });
  assert.match(stdout, /after-timeout/);
});
