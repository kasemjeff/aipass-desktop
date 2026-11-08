// Audit fixes, 2026-11-08 — the four reported items, pinned by tests:
//   1. path confinement: a sibling whose name merely begins with the root's
//      (project2 beside project) must not pass safe(), and a file INSIDE the
//      root whose name begins with ".." (..foo) must not be refused by the
//      old startsWith('..') shape.
//   2. atomic write: a Windows EPERM/EBUSY from the rename is retried, and a
//      persistent one still fails cleanly with no temp left behind.
//   3. chunk decoding: a multi-byte Thai character split across two stdio
//      chunks comes back whole, not mojibake.
//   4. windowsHide: every spawn in the shipped harness carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Overlay } from '../harness/overlay.mjs';
import { writeFileAtomic } from '../harness/atomic-write.mjs';
import { runShell } from '../harness/execution.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-audit-'));

test('safe() refuses a sibling directory whose name begins with the root\'s', () => {
  const parent = scratch();
  const root = path.join(parent, 'project');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(parent, 'project2'));
  fs.writeFileSync(path.join(parent, 'project2', 'secret.txt'), 'outside\n');
  const overlay = new Overlay(root);
  // The /project vs /project2 shape from the report: a string-prefix check
  // would pass ../project2/secret.txt; the path.relative check must not.
  assert.equal(overlay.trySafe('../project2/secret.txt'), null, 'a sibling escape is refused');
  assert.equal(overlay.trySafe('../project2'), null, 'the sibling itself is refused');
  assert.throws(() => overlay.safe('../project2/secret.txt'), /outside project root/, 'and safe() says so in err: words');
  assert.equal(overlay.trySafe('inside.txt'), path.join(root, 'inside.txt'), 'an inside path still passes');
});

test('safe() admits a file inside the root whose name begins with ..', () => {
  const root = scratch();
  const overlay = new Overlay(root);
  // "..foo" is a name, not a parent reference: the old startsWith('..')
  // shape refused it inside every root.
  assert.equal(overlay.trySafe('..foo.txt'), path.join(root, '..foo.txt'), '..foo inside the root is inside');
  assert.equal(overlay.trySafe('..'), null, 'the parent itself is still refused');
  assert.equal(overlay.trySafe('../'), null, 'a parent reference is still refused');
});

test('writeFileAtomic retries a transient EPERM and lands the bytes', () => {
  const dir = scratch();
  const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, 'old\n');
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    calls += 1;
    if (calls <= 2) {
      const err = new Error('blocked by another writer');
      err.code = 'EPERM';
      throw err;
    }
    return realRename(from, to);
  };
  try {
    writeFileAtomic(file, 'new\n');
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(calls, 3, 'the rename was retried until it landed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n', 'the new bytes are in place');
  assert.deepEqual(fs.readdirSync(dir), ['store.json'], 'no temp file is left behind');
});

test('writeFileAtomic gives up on a persistent EBUSY and cleans the temp', () => {
  const dir = scratch();
  const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, 'old\n');
  const realRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('file busy');
    err.code = 'EBUSY';
    throw err;
  };
  try {
    assert.throws(() => writeFileAtomic(file, 'new\n'), /file busy/, 'a persistent lock still fails');
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'old\n', 'the old bytes survive a failed swap');
  assert.deepEqual(fs.readdirSync(dir), ['store.json'], 'the temp file is removed after the failure');
});

test('runShell returns a Thai character split across chunks whole', async () => {
  const dir = scratch();
  // The child writes the first two bytes of ส (3 bytes in UTF-8), waits, then
  // the rest: a per-chunk String() decode mojibakes the straddle.
  const script = path.join(dir, 'split.mjs');
  fs.writeFileSync(script, [
    "const b = Buffer.from('สวัสดีชาวโลก', 'utf8');",
    'process.stdout.write(b.subarray(0, 2));',
    'setTimeout(() => process.stdout.write(b.subarray(2)), 100);',
    '',
  ].join('\n'));
  const { stdout } = await runShell(`"${process.execPath}" "${script}"`, { cwd: dir, timeoutMs: 30_000 });
  assert.equal(stdout, 'สวัสดีชาวโลก', 'no replacement character, no mojibake');
});

test('every spawn in the shipped harness hides its window', () => {
  const harness = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(harness);
  files.push(path.join(harness, '..', 'setup.mjs'));
  // One spawn call, paren-balanced and string-aware: a lazy regex stops at
  // the first ')' inside String(pid) and would call a hidden spawn visible.
  const spawnCalls = (src) => {
    const calls = [];
    let from = 0;
    for (;;) {
      const at = src.indexOf('spawn(', from);
      if (at === -1) return calls;
      let depth = 0;
      let quote = null;
      for (let i = at + 5; i < src.length; i += 1) {
        const ch = src[i];
        if (quote) { if (ch === quote && src[i - 1] !== '\\') quote = null; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === '(') depth += 1;
        if (ch === ')') { depth -= 1; if (depth === 0) { calls.push(src.slice(at, i + 1)); from = i + 1; break; } }
      }
      if (depth !== 0) return calls;
    }
  };
  const offenders = [];
  for (const file of files) {
    for (const call of spawnCalls(fs.readFileSync(file, 'utf8'))) {
      if (!call.includes('windowsHide')) offenders.push(`${path.basename(file)}: ${call.slice(0, 60).replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(offenders, [], `spawns missing windowsHide: ${offenders.join(' | ')}`);
});
