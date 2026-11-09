/**
 * SWE-bench-shaped tasks (docs/SPEC_EVALS.md §6): a worktree at a base
 * commit, a test patch applied after the model's fix, failToPass must flip
 * green, passToPass must stay green. Offline proof with a synthetic repo —
 * the same mechanism a SWE-bench Verified instance rides at bench time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTask, runAttempt, replayBridge } from '../../scripts/evals.mjs';

const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

function haveGit() {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** A tiny repo with a bug (subtract instead of add). Base commit first. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-swe-repo-'));
  git(dir, ['init']);
  git(dir, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'bug.mjs'), 'export const add = (a, b) => a - b;\n');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'smoke.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('smoke: module loads', () => { assert.equal(typeof 1, 'number'); });",
    '',
  ].join('\n'));
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base']);
  const { stdout } = git(dir, ['rev-parse', 'HEAD']);
  return { dir, base: stdout.trim() };
}

/** The test patch: adds the failing test (which the base commit lacks). */
const TEST_PATCH = [
  'diff --git a/tests/add.test.mjs b/tests/add.test.mjs',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/tests/add.test.mjs',
  '@@ -0,0 +1,4 @@',
  '+import { test } from \'node:test\';',
  '+import assert from \'node:assert/strict\';',
  '+import { add } from \'../bug.mjs\';',
  '+test(\'add adds\', () => { assert.equal(add(2, 3), 5); });',
  '',
].join('\n');

function makeSweTask({ repoDir, base }) {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-swe-task-'));
  fs.writeFileSync(path.join(taskDir, 'task.md'),
    'add(a, b) in bug.mjs subtracts instead of adding.\n\nFix bug.mjs so add(2, 3) is 5. Tests are provided by the harness (you cannot see them).\n');
  fs.mkdirSync(path.join(taskDir, 'patches'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'patches', 'test.diff'), TEST_PATCH);
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
    swebench: {
      repo: repoDir,
      baseCommit: base,
      testPatch: 'patches/test.diff',
      failToPass: ['node --test tests/add.test.mjs'],
      passToPass: ['node --test tests/smoke.test.mjs'],
    },
    budget: { maxSteps: 5 },
    allowRun: false,
    category: 'swebench',
  }, null, 2));
  return taskDir;
}

const FIX_REPLY = [
  'EDIT bug.mjs',
  'FIND',
  'export const add = (a, b) => a - b;',
  'NEW',
  'export const add = (a, b) => a + b;',
  'END',
  'DONE fixed the comparator',
].join('\n');

test('a swe task loads with its batteries, no check command needed', (t) => {
  if (!haveGit()) return t.skip('git is not installed');
  const { dir, base } = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskDir = makeSweTask({ repoDir: dir, base });
  t.after(() => fs.rmSync(taskDir, { recursive: true, force: true }));
  const task = loadTask(taskDir);
  assert.equal(task.swebench.repo, dir);
  assert.equal(task.swebench.baseCommit, base);
  assert.deepEqual(task.swebench.failToPass, ['node --test tests/add.test.mjs']);
  assert.equal(task.check, null, 'the batteries are the check');
});

test('a swe attempt that applies the fix resolves the f2p battery and keeps p2p', async (t) => {
  if (!haveGit()) return t.skip('git is not installed');
  const { dir, base } = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskDir = makeSweTask({ repoDir: dir, base });
  t.after(() => fs.rmSync(taskDir, { recursive: true, force: true }));
  const task = loadTask(taskDir);

  const row = await runAttempt(task, {
    mode: 'replay',
    bridge: replayBridge([FIX_REPLY]),
    budget: { maxSteps: 5 },
  });
  assert.equal(row.outcome, 'solved', `f2p tail: ${row.check.f2p?.[0]?.tail}`);
  assert.equal(row.check.exit, 0);
  assert.equal(row.check.f2p.length, 1);
  assert.equal(row.check.f2p[0].exit, 0);
  assert.equal(row.check.p2p[0].exit, 0);
  // The worktree was deregistered: the repo did not accumulate metadata.
  const { stdout } = git(dir, ['worktree', 'list']);
  assert.ok(!stdout.includes('aipass-eval'), `worktrees left behind: ${stdout}`);
});

test('a swe attempt that does not fix the bug is unsolved, with a named f2p failure', async (t) => {
  if (!haveGit()) return t.skip('git is not installed');
  const { dir, base } = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskDir = makeSweTask({ repoDir: dir, base });
  t.after(() => fs.rmSync(taskDir, { recursive: true, force: true }));
  const task = loadTask(taskDir);

  const row = await runAttempt(task, {
    mode: 'replay',
    bridge: replayBridge(['DONE did nothing']),
    budget: { maxSteps: 5 },
  });
  assert.equal(row.outcome, 'unsolved', `f2p tail: ${row.check.f2p?.[0]?.tail}`);
  assert.equal(row.check.exit, 1);
  assert.equal(row.check.f2p[0].exit, 1);
});

test('a swe task with a broken test patch is invalid, never unsolved', async (t) => {
  if (!haveGit()) return t.skip('git is not installed');
  const { dir, base } = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskDir = makeSweTask({ repoDir: dir, base });
  fs.writeFileSync(path.join(taskDir, 'patches', 'test.diff'), 'this is not a patch');
  t.after(() => fs.rmSync(taskDir, { recursive: true, force: true }));
  const task = loadTask(taskDir);

  const row = await runAttempt(task, {
    mode: 'replay',
    bridge: replayBridge([FIX_REPLY]),
    budget: { maxSteps: 5 },
  });
  assert.equal(row.outcome, 'invalid');
  assert.match(row.invalidReason, /test patch did not apply/);
  assert.equal(row.scored, false, 'a broken task scores nothing');
});
