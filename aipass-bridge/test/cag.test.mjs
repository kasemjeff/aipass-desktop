// CAG: the standing context pack — built once, reused byte-identically,
// invalidated by source change, secret files never enter it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPack, ensurePack, clearPack, statusPack, renderPack, packHash } from '../harness/cag.mjs';
import { bm25Idf, bm25Term, bm25ScoreAll, tokenize } from '../harness/text.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-cag-home-'));
process.env.AIPASS_HOME = HOME;

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-cag-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('bm25 helpers share the retrieval shape', () => {
  assert.equal(bm25Idf(1, 10), Math.log(1 + (10 - 1 + 0.5) / (1 + 0.5)));
  const scored = bm25ScoreAll(
    [new Map([['token', 2]]), new Map([['token', 1], ['other', 3]])],
    ['token'],
  );
  assert.ok(scored[0] > scored[1], 'higher tf in a shorter doc wins');
  assert.ok(bm25Term(0, 10, 10, 2) === 0, 'no tf, no score');
});

test('build + ensure reuses a fresh pack byte-identically', async () => {
  const dir = tempDir({ 'AGENTS.md': '# Rules\n\nAlways verify with npm test.\n', 'README.md': '# Project\n' });
  const first = await ensurePack(dir);
  assert.equal(first.reused, false);
  assert.ok(first.pack.text.includes('Always verify'));
  assert.ok(first.pack.text.includes('## AGENTS.md'));
  const second = await ensurePack(dir);
  assert.equal(second.reused, true);
  assert.equal(second.pack.text, first.pack.text, 'a reused pack is byte-identical — that is what the prompt cache needs');
  assert.equal(second.pack.packSha, packHash(second.pack.text));
});

test('a changed source rebuilds the pack', async () => {
  const dir = tempDir({ 'AGENTS.md': '# Rules v1\n' });
  await ensurePack(dir);
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, '# Rules v2 — changed\n');
  const bumped = new Date(Date.now() + 5000);
  fs.utimesSync(file, bumped, bumped);
  const afterChange = await ensurePack(dir);
  assert.equal(afterChange.reused, false);
  assert.ok(afterChange.pack.text.includes('Rules v2'));
});

test('a secret source never enters the pack', async () => {
  const dir = tempDir({ 'AGENTS.md': '# Rules\n', '.env': 'TOKEN=secret\n' });
  const { pack } = await ensurePack(dir, { sources: ['AGENTS.md', '.env'] });
  assert.ok(!pack.text.includes('TOKEN=secret'));
  assert.deepEqual(pack.sources.map((s) => s.path), ['AGENTS.md']);
});

test('a binary source is skipped, a missing one is named by its absence', async () => {
  const dir = tempDir({ 'AGENTS.md': 'text\n' });
  fs.writeFileSync(path.join(dir, 'blob.md'), Buffer.from([0x41, 0x00, 0x42]));
  const pack = await buildPack(dir, { sources: ['AGENTS.md', 'blob.md', 'NOPE.md'] });
  assert.deepEqual(pack.sources.map((s) => s.path), ['AGENTS.md']);
});

test('the budget truncates and says so', () => {
  const big = 'x'.repeat(5000);
  const { text, truncated } = renderPack([{ path: 'A.md', text: big, sha256: packHash(big) }], 1000);
  assert.equal(truncated, true);
  assert.ok(text.length <= 1000);
});

test('clear + status round-trip', async () => {
  const dir = tempDir({ 'AGENTS.md': '# Rules\n' });
  await ensurePack(dir);
  const st = await statusPack(dir);
  assert.equal(st.sources, 1);
  assert.ok(st.chars > 0);
  assert.equal(clearPack(dir), true);
  const empty = await statusPack(dir);
  assert.equal(empty.sources, 0);
});

test('tokenize still splits Thai for the shared scorer', () => {
  const toks = tokenize('ระบบค้นคืน');
  assert.ok(toks.includes('ระบบ'));
});
