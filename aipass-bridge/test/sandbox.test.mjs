/**
 * The sandbox: the projection a RUN works in, and the boundary around it.
 *
 * Four things are pinned here, each one a measured hole:
 *   - a command's OUTPUT is screened for secrets (the command is screened for
 *     secret FILES; the output is the machine's mouth, and `set` prints the
 *     whole environment);
 *   - the containment is LEXICAL (case, on Windows) and PHYSICAL (a link out
 *     of the project is a link out of the root);
 *   - the projection lives OUTSIDE the project, so a copy of the user's
 *     source — and of whatever secrets it holds — cannot be committed;
 *   - the janitor collects the projections a killed backend left behind.
 *
 * Run: node --test aipass-bridge/test/sandbox.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Overlay } from '../harness/overlay.mjs';
import { createTools } from '../harness/tools.mjs';
import { createSandbox, materializeTree, sweepSandboxes, sandboxRoot, sharedWriteRefusal, lockSharedDirs, unlockSharedDirs, auditSharedDirs } from '../harness/sandbox.mjs';
import { scrubOutput, isSecretName } from '../harness/output-scrub.mjs';
import { aipassHome } from '../harness/settings.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-sandbox-home-'));
process.env.AIPASS_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-sbx-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

/* ------------------------------------------------------- the output screen */

test('a command output is screened for secrets', async () => {
  const dir = tempDir();
  const printer = path.join(dir, 'print.mjs');
  fs.writeFileSync(printer, "console.log('sk-abcdefgh12345678');\nconsole.log('API_KEY=supersecret');\nconsole.log('PORT=3000');\n");
  const tools = createTools({ root: dir, overlay: new Overlay(dir), allowRun: true });

  const out = String(await tools.run('', `node "${printer}"`));
  assert.equal(/sk-abcdefgh12345678/.test(out), false, 'the token shape is redacted');
  assert.equal(/supersecret/.test(out), false, 'the credential assignment is redacted');
  assert.match(out, /PORT=3000/, 'an ordinary assignment is left alone');
  assert.match(out, /\[redacted\]/, 'and the redaction says so');
});

test('the screen knows which names carry a credential', () => {
  assert.equal(isSecretName('API_KEY'), true);
  assert.equal(isSecretName('GITHUB_TOKEN'), true);
  assert.equal(isSecretName('_authToken'), true);
  assert.equal(isSecretName('AWS_SECRET_ACCESS_KEY'), true);
  assert.equal(isSecretName('DB_PASSWORD'), true);
  assert.equal(isSecretName('PORT'), false);
  assert.equal(isSecretName('MONKEY'), false, 'a name that merely contains a word is not one');
  assert.equal(isSecretName('PATH'), false);
});

test('the screen keeps what a query string carries', () => {
  const out = scrubOutput('GET https://example.com/x?api_key=abc123&page=2');
  assert.equal(/abc123/.test(out), false, 'the credential is gone');
  assert.match(out, /page=2/, 'and the rest of the URL is intact');
});

/* -------------------------------------------------------- the containment */

test('a path that differs only in case is inside the project', () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const abs = path.join(dir, 'a.txt');
  // The boundary is lexical, and `path.relative` follows the platform's own
  // rules: Windows does not care about case, so the path is inside there.
  // Every POSIX platform compares case, so the name is a different name - and
  // a different name is not inside the project.
  if (process.platform === 'win32') {
    assert.doesNotThrow(() => overlay.safe(abs.toUpperCase()), 'Windows does not care about case');
    assert.doesNotThrow(() => overlay.safe(abs.toLowerCase()));
  } else {
    const other = abs === abs.toUpperCase() ? abs.toLowerCase() : abs.toUpperCase();
    assert.throws(() => overlay.safe(other), /outside project root/, 'a case-sensitive filesystem does care about case');
  }
  assert.throws(() => overlay.safe(path.join(dir, '..', 'outside.txt')), /outside project root/);
});

test('a link out of the project is a link out of the root', async (t) => {
  const dir = tempDir({ 'inside.txt': 'mine\n' });
  const outside = tempDir({ 'secret.txt': 'not yours\n' });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'link'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(dir, 'link', 'away'), 'junction');
  } catch (err) {
    return t.skip(`links cannot be made here: ${err.code}`);
  }
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });
  await assert.rejects(
    async () => tools.read('link/away/secret.txt'),
    /outside project root/,
    'a path that leaves the project through a link is refused',
  );
  assert.match(String(await tools.read('inside.txt')), /mine/, 'and the project is still readable');
});

/* ------------------------------------------------------------ the sandbox */

test('the projection lives outside the project', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const sandbox = createSandbox(dir);
  try {
    assert.equal(sandbox.startsWith(path.resolve(dir) + path.sep), false, 'not inside the project');
    assert.equal(sandbox.startsWith(path.join(aipassHome(), 'run')), true, 'but under the home');
    assert.ok(fs.existsSync(sandbox), 'and it exists');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('two projects never share a projection folder', () => {
  const a = sandboxRoot('D:/one/project');
  const b = sandboxRoot('D:/one/project-two');
  assert.notEqual(a, b, 'the folder name carries the path, not only the slug');
});

test('the janitor collects what a killed backend left behind', async () => {
  const dir = tempDir();
  const root = sandboxRoot(dir);
  fs.mkdirSync(root, { recursive: true });
  const stale = path.join(root, 'run-stale');
  const fresh = path.join(root, 'run-fresh');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(stale, 'copy.txt'), 'x');
  // The stale one is older than a live run could ever be.
  const old = new Date(Date.now() - 12 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);

  const removed = await sweepSandboxes(dir, { maxAgeMs: 6 * 60 * 60 * 1000 });
  assert.equal(removed, 1, 'the abandoned projection is gone');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true, 'and a live one is left alone');
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('a projection whose owner is gone is collected long before the age margin', async () => {
  // The crash case: the backend died mid-RUN and the copy of the project is
  // still on disk. Waiting six hours for it is six hours of disk for a
  // projection nobody can ever finish — so a dead owner waits out minutes.
  const dir = tempDir();
  const root = sandboxRoot(dir);
  fs.mkdirSync(root, { recursive: true });
  const dead = path.join(root, 'run-dead');
  fs.mkdirSync(dead, { recursive: true });
  fs.writeFileSync(path.join(dead, 'copy.txt'), 'x');
  // A pid that cannot be running: the stamp names a process that is gone.
  fs.writeFileSync(`${dead}.owner`, JSON.stringify({ pid: 0x7ffffffe, at: Date.now() }));
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(dead, old, old);

  const removed = await sweepSandboxes(dir, { maxAgeMs: 6 * 60 * 60 * 1000, deadGraceMs: 10 * 60 * 1000 });
  assert.equal(removed, 1, 'the dead owner\'s projection is gone');
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(`${dead}.owner`), false, 'and so is its stamp');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a projection a live run owns is left alone, however old it looks', async () => {
  const dir = tempDir();
  const root = sandboxRoot(dir);
  fs.mkdirSync(root, { recursive: true });
  const live = path.join(root, 'run-live');
  fs.mkdirSync(live, { recursive: true });
  // This process is the owner, and it is running.
  fs.writeFileSync(`${live}.owner`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  // Older than the dead owner's grace, younger than the age margin: this is
  // the case the dead-owner path must not touch.
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(live, old, old);

  const removed = await sweepSandboxes(dir, { maxAgeMs: 6 * 60 * 60 * 1000, deadGraceMs: 10 * 60 * 1000 });
  assert.equal(removed, 0, 'a live owner keeps its projection');
  assert.equal(fs.existsSync(live), true);
  fs.rmSync(live, { recursive: true, force: true });
  fs.rmSync(`${live}.owner`, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('the projection leaves out a link that points outside the project', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const outside = tempDir({ 'secret.txt': 'not yours\n' });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  try {
    // A directory link, not a file one: on Windows a file symlink needs
    // privileges a normal machine does not have, a junction does not.
    fs.symlinkSync(outside, path.join(dir, 'sub', 'away'), 'junction');
  } catch (err) {
    return t.skip(`links cannot be made here: ${err.code}`);
  }
  const overlay = new Overlay(dir);
  const sandbox = createSandbox(dir);
  try {
    await materializeTree(dir, overlay, sandbox);
    assert.equal(fs.existsSync(path.join(sandbox, 'sub', 'away', 'secret.txt')), false,
      'the outside file is not projected');
    assert.equal(fs.existsSync(path.join(sandbox, 'a.txt')), true, 'and the project is');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a write into a linked heavy directory does not land in the real tree', async () => {
  // The projection LINKS the heavy folders (a copy of a node_modules costs a
  // minute per RUN), so a write through that link lands in the real project.
  // The rule the repo holds itself to is that the overlay is the only write
  // surface of a run — so the write is refused, the folder stays a link, and
  // the reads still work.
  const dir = tempDir({ 'a.txt': 'hello\n' });
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'the real one\n');
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'node_modules', 'dep', 'index.js'), 'the staged one\n');

  const refused = [];
  const sandbox = createSandbox(dir);
  try {
    await materializeTree(dir, overlay, sandbox, {
      onRefuse: (rel, shared) => refused.push({ rel, shared }),
    });

    assert.equal(fs.readFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'the real one\n',
      'the real tree is untouched');
    assert.ok(fs.lstatSync(path.join(sandbox, 'node_modules')).isSymbolicLink(),
      'and the heavy folder is linked, not copied');
    assert.equal(fs.readFileSync(path.join(sandbox, 'node_modules', 'dep', 'index.js'), 'utf8'), 'the real one\n',
      'the reads still work through the link');
    assert.deepEqual(refused, [{ rel: 'node_modules/dep/index.js', shared: 'node_modules' }],
      'the write was refused, and the folder is named');

    // The refusal itself is the house shape, and it names the directory.
    const refusal = sharedWriteRefusal(dir, path.join(dir, 'node_modules', 'dep', 'index.js'));
    assert.match(refusal, /^err: /, 'a tool failure starts with err:');
    assert.match(refusal, /node_modules/, 'and it names the directory');
    assert.equal(sharedWriteRefusal(dir, path.join(dir, 'a.txt')), null, 'an ordinary path may be written');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a RUN says which folders are shared with the real project', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'a.txt'), 'changed\n');
  const tools = createTools({ root: dir, overlay, allowRun: true });

  const out = String(await tools.run('', 'node -e "console.log(1)"'));
  assert.match(out, /node_modules/, 'the shared folder is named');
  assert.match(out, /REAL folders/i, 'and the truth about it is said');
});

test('a file over the cap is left out of the projection, and named', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  fs.writeFileSync(path.join(dir, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024));
  const previous = process.env.AIPASS_SANDBOX_MAX_FILE_MB;
  process.env.AIPASS_SANDBOX_MAX_FILE_MB = '1';
  try {
    const overlay = new Overlay(dir);
    overlay.set(path.join(dir, 'a.txt'), 'changed\n');
    const tools = createTools({ root: dir, overlay, allowRun: true });
    const out = String(await tools.run('', 'node -e "console.log(1)"'));
    assert.match(out, /huge\.bin/, 'the file that was left out is named');
    assert.match(out, /not copied/i, 'and it says why');
  } finally {
    if (previous === undefined) delete process.env.AIPASS_SANDBOX_MAX_FILE_MB;
    else process.env.AIPASS_SANDBOX_MAX_FILE_MB = previous;
  }
});

/* --------------------------------------- shared-directory write protection */

test('lockSharedDirs clears the write bits and unlock restores the exact modes', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  const target = path.join(dir, 'node_modules', 'dep', 'index.js');
  fs.writeFileSync(target, 'the real one\n');
  const before = fs.statSync(target).mode & 0o777;
  const lock = await lockSharedDirs(dir);
  try {
    const during = fs.statSync(target).mode & 0o777;
    assert.equal(during & 0o222, 0, 'no write bit survives the lock');
    assert.notEqual(during & 0o444, 0, 'reads still work');
    const audit = await auditSharedDirs(dir, lock);
    assert.deepEqual(audit, { changed: [], added: [], deleted: [] }, 'an untouched tree audits clean');
  } finally {
    await unlockSharedDirs(dir, lock);
  }
  assert.equal(fs.statSync(target).mode & 0o777, before, 'the mode the lock found is the mode it leaves');
});

test('a RUN cannot write into a shared directory — the real file keeps its bytes', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  const target = path.join(dir, 'node_modules', 'dep', 'index.js');
  fs.writeFileSync(target, 'the real one\n');
  // Staging a.txt forces the projection world (node_modules is a junction
  // into the real tree); the lock must hold across that junction.
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'a.txt'), 'changed\n');
  const writer = path.join(dir, 'write-shared.mjs');
  fs.writeFileSync(writer, [
    "import fs from 'node:fs';",
    `try { fs.writeFileSync(process.argv[2], 'hacked\\n'); console.log('wrote'); }`,
    `catch (e) { console.log('blocked ' + e.code); }`,
    '',
  ].join('\n'));
  const tools = createTools({ root: dir, overlay, allowRun: true });
  const out = String(await tools.run('', `node "${writer}" "${target}"`));
  assert.match(out, /blocked (EPERM|EACCES)/, 'the kernel refused the write');
  assert.equal(fs.readFileSync(target, 'utf8'), 'the real one\n', 'the real tree is untouched');
});

test('a RUN that clears the read-only bits and writes is named by the audit', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  const target = path.join(dir, 'node_modules', 'dep', 'index.js');
  fs.writeFileSync(target, 'the real one\n');
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'a.txt'), 'changed\n');
  // The deliberate escape: clear the bits, then write. The lock cannot stop
  // a same-user command that insists — the audit must name it, loudly.
  const writer = path.join(dir, 'write-shared.mjs');
  fs.writeFileSync(writer, [
    "import fs from 'node:fs';",
    `fs.chmodSync(process.argv[2], 0o644);`,
    `fs.writeFileSync(process.argv[2], 'hacked\\n');`,
    `console.log('wrote');`,
    '',
  ].join('\n'));
  const tools = createTools({ root: dir, overlay, allowRun: true });
  const out = String(await tools.run('', `node "${writer}" "${target}"`));
  assert.match(out, /err: the run changed a shared directory/, 'the audit answers err:');
  assert.match(out, /node_modules\/dep\/index\.js/, 'and names the file');
  assert.equal(fs.readFileSync(target, 'utf8'), 'hacked\n', 'the audit names it — it does not pretend to revert it');
});

/* -------------------------------------------------- traversal & symlink escape */

test('a path with .. segments that leaves the project is refused', () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  for (const p of ['../outside.txt', 'sub/../../outside.txt', '..\\outside.txt', path.join(dir, '..', 'outside.txt').replace(/\\/g, '/')]) {
    assert.throws(() => overlay.safe(p), /outside project root/, `${p} is refused`);
  }
  assert.doesNotThrow(() => overlay.safe('sub/inside.txt'));
});

test('a file link out of the project is a link out of the root', async (t) => {
  const dir = tempDir({ 'inside.txt': 'mine\n' });
  const outside = tempDir({ 'secret.txt': 'not yours\n' });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'leak.txt'), 'file');
  } catch (err) {
    return t.skip(`links cannot be made here: ${err.code}`);
  }
  const tools = createTools({ root: dir, overlay: new Overlay(dir) });
  await assert.rejects(
    async () => tools.read('leak.txt'),
    /outside project root/,
    'a file link to outside is refused',
  );
});

test('the projection leaves out a file link that points outside the project', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const outside = tempDir({ 'secret.txt': 'not yours\n' });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'leak.txt'), 'file');
  } catch (err) {
    return t.skip(`links cannot be made here: ${err.code}`);
  }
  const overlay = new Overlay(dir);
  const sandbox = createSandbox(dir);
  try {
    await materializeTree(dir, overlay, sandbox);
    assert.equal(fs.existsSync(path.join(sandbox, 'leak.txt')), false, 'the outside file is not projected');
    assert.equal(fs.existsSync(path.join(sandbox, 'a.txt')), true, 'and the project is');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a staged path outside the tree is not projected and writes nothing outside', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const outside = tempDir({ 'target.txt': 'original\n' });
  const outsideFile = path.join(outside, 'target.txt');
  const overlay = new Overlay(dir);
  overlay.set(outsideFile, 'staged escape\n');
  const sandbox = createSandbox(dir);
  try {
    await materializeTree(dir, overlay, sandbox);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'original\n', 'nothing outside the tree was written');
    assert.equal(fs.existsSync(path.join(sandbox, 'target.txt')), false, 'and nothing escaped into the sandbox either');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
