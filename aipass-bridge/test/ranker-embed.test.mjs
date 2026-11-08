// Embeddings Ranker plugin: gated, local-first, BM25 fallback (Phase 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, rrf, embedEnabled, embedTexts } from '../harness/ranker-embed.mjs';
import { cagBlockForRun } from '../harness/cag.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('cosine ranks the aligned vector first', () => {
  assert.ok(cosine([1, 0], [1, 0]) > cosine([1, 0], [0, 1]));
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test('RRF puts a top hit of either list first', () => {
  const fused = rrf(['a', 'b', 'c'], ['c', 'a', 'd']);
  assert.ok(fused.includes('a') && fused.includes('c'));
  assert.equal(fused[0], 'a');
});

test('embeddings are inert without consent', async () => {
  delete process.env.AIPASS_EMBED_CONSENT;
  assert.equal(embedEnabled(), false);
  assert.equal(await embedTexts(['hello']), null);
});

test('cagBlockForRun is empty when off or replay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-cagblk-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\nbe nice\n');
  assert.equal(await cagBlockForRun(root, { cag: false }), '');
  assert.equal(await cagBlockForRun(root, { replay: true }), '');
  const on = await cagBlockForRun(root, {});
  assert.ok(on.includes('AGENTS.md'));
  fs.rmSync(root, { recursive: true, force: true });
});
