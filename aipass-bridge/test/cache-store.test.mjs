// CacheStore: one framework for every on-disk cache (KNOWLEDGE_ARCHITECTURE §8).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCacheStore, openStore, STORES } from '../harness/cache-store.mjs';
import { projectKey } from '../harness/project-key.mjs';

const dirs = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-cachestore-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('the registry knows retrieval and cag, and rejects anything else', () => {
  assert.equal(STORES.retrieval.dirName, 'retrieval');
  assert.equal(STORES.cag.dirName, 'cag');
  assert.throws(() => openStore('nope'), /unknown cache store/);
});

test('save/load round-trips through one file keyed by projectKey', async () => {
  const home = tempDir();
  const root = tempDir();
  const store = createCacheStore({ dir: path.join(home, 'retrieval'), version: 2, memoMax: 4 });
  assert.equal(store.save(root, { version: 2, root, chunks: [], postings: {} }), true);
  const file = path.join(home, 'retrieval', projectKey(root) + '.json');
  assert.ok(fs.existsSync(file), 'the file is projectKey-named');
  const loaded = await store.load(root);
  assert.equal(loaded.version, 2);
  assert.equal(await store.load(root), loaded, 'a memo hit returns the same object');
});

test('a corrupt or wrong-version file reads as absent, not as truth', async () => {
  const home = tempDir();
  const root = tempDir();
  const store = createCacheStore({ dir: path.join(home, 'x'), version: 2 });
  fs.mkdirSync(path.join(home, 'x'), { recursive: true });
  fs.writeFileSync(store.fileFor(root), 'not json{');
  assert.equal(await store.load(root), null);
  store.save(root, { version: 1, root });
  assert.equal(await store.load(root), null, 'version gate');
  assert.equal(store.save(root, { version: 2, root }), true);
  assert.ok(await store.load(root));
});

test('clear removes the file and the memo entry', async () => {
  const home = tempDir();
  const root = tempDir();
  const store = createCacheStore({ dir: path.join(home, 'x'), version: 1 });
  store.save(root, { version: 1 });
  assert.ok(await store.load(root));
  assert.equal(store.clear(root), true);
  assert.equal(await store.load(root), null);
  assert.equal(store.peek(root), null);
});

test('openStore shares one instance per name+home (the memo lives there)', () => {
  const home = tempDir();
  const a = openStore('cag', { home });
  const b = openStore('cag', { home });
  assert.equal(a, b);
  assert.notEqual(a, openStore('retrieval', { home }));
});
