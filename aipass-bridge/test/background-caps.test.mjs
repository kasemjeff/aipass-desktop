// Background output caps and spill reads — the two ceilings are one contract.
//
// A background job may write up to BACKGROUND_OUTPUT_CAP (20 MB) to its spill
// file; `read` must be able to page through that whole file. When the spill
// ceiling sat at 2 MB, the locator NEED file could name lines the read then
// refused (err:), stranding the tail. The job file itself is also created
// exclusively now: a name another run or process owns is never truncated, so
// two runs' output can never share one file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { createTools, MAX_SPILL_READ } from '../harness/tools.mjs';
import { BACKGROUND_OUTPUT_CAP, startBackgroundRun } from '../harness/execution.mjs';

const toolsAt = (dir, overlay) => createTools({
  root: dir, overlay, skills: new SkillLibrary([]), allowRun: true, maxResult: 6000,
});

test('the spill read ceiling is the background job disk cap', () => {
  assert.equal(MAX_SPILL_READ, BACKGROUND_OUTPUT_CAP, 'a job may write what a read may page');
  assert.equal(BACKGROUND_OUTPUT_CAP, 20 * 1024 * 1024, 'the documented 20 MB');
});

test('a ranged read pages a spill past the old 2 MB ceiling', async () => {
  const dir = tempDir({});
  const spillDir = path.join(dir, '.aipass', 'spill');
  fs.mkdirSync(spillDir, { recursive: true });
  // ~2.5 MB of numbered lines: past the old ceiling, inside the current one.
  const lines = [];
  for (let i = 1; i <= 3000; i++) lines.push(`line-${i} ${'p'.repeat(800)}`);
  fs.writeFileSync(path.join(spillDir, 'big.txt'), lines.join('\n') + '\n');

  const tools = toolsAt(dir, new Overlay(dir));
  const out = await tools.read('.aipass/spill/big.txt 2000-2005');
  assert.match(out, /line-2000/, 'the first asked line came back');
  assert.match(out, /line-2005/, 'the last asked line came back');
  assert.ok(!/^err:/.test(out), `a ranged spill read is not refused: ${out.slice(0, 120)}`);
});

test('a spill past the ceiling without a range is refused with the ranged way through', async () => {
  const dir = tempDir({});
  const spillDir = path.join(dir, '.aipass', 'spill');
  fs.mkdirSync(spillDir, { recursive: true });
  // Sparse: the size is what the guard reads, no 21 MB of real zeroes.
  const fd = fs.openSync(path.join(spillDir, 'huge.txt'), 'w');
  fs.ftruncateSync(fd, MAX_SPILL_READ + 1024 * 1024);
  fs.closeSync(fd);

  const tools = toolsAt(dir, new Overlay(dir));
  const out = await tools.read('.aipass/spill/huge.txt');
  assert.match(out, /^err: .*the read cap is/, 'the refusal carries err:');
  assert.match(out, /NEED file \.aipass\/spill\/huge\.txt 1-250/, 'and names the ranged read that works');
});

test('a background job never truncates a spill file another owner already has', async () => {
  const dir = tempDir({ 'hi.mjs': "console.log('fresh output');\n" });
  const spillDir = path.join(dir, '.aipass', 'spill');
  fs.mkdirSync(spillDir, { recursive: true });
  fs.writeFileSync(path.join(spillDir, 'run1.txt'), 'sentinel: another run\n');

  const started = await startBackgroundRun({
    root: dir, overlay: new Overlay(dir), command: 'node hi.mjs', name: 'run1', knownSecrets: [],
  });
  assert.ok(!started.error, `the job started: ${started.error ?? ''}`);
  assert.notEqual(started.name, 'run1', 'a taken name gets a suffixed one, not a truncate');
  assert.equal(started.outputRel, `.aipass/spill/${started.name}.txt`);
  const done = await started.done;
  assert.equal(done.code, 0, 'the command finished');
  assert.equal(
    fs.readFileSync(path.join(spillDir, 'run1.txt'), 'utf8'),
    'sentinel: another run\n',
    'the other owner\'s file is untouched',
  );
  assert.match(
    fs.readFileSync(path.join(spillDir, `${started.name}.txt`), 'utf8'),
    /fresh output/,
    'this job\'s output is in its own file',
  );
});

test('one endless line cannot hold more than the cap in memory or on disk', async () => {
  const dir = tempDir({ 'loud.mjs': "process.stdout.write('x'.repeat(200 * 1024));\n" });
  const cap = 64 * 1024;
  const started = await startBackgroundRun({
    root: dir, overlay: new Overlay(dir), command: 'node loud.mjs', name: 'run1',
    knownSecrets: [], outputCap: cap,
  });
  assert.ok(!started.error, `the job started: ${started.error ?? ''}`);
  const done = await started.done;
  assert.equal(done.code, 0, 'the command finished');
  const file = path.join(dir, '.aipass', 'spill', `${started.name}.txt`);
  const size = fs.statSync(file).size;
  assert.ok(size <= cap + 200, `the file is the cap plus at most the marker (${size} bytes)`);
  assert.match(fs.readFileSync(file, 'utf8'), /output stopped at 65536 bytes/, 'the marker says the rest was dropped');
});
