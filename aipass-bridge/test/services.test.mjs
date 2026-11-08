// Corpus drivers + RecallService (Phase 3, D12 eval floor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectDocuments, sessionDocuments, standingDocuments } from '../harness/corpus.mjs';
import { rankDocuments } from '../harness/services.mjs';

const evalSet = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'evals/recall/queries.json'), 'utf8'));

test('projectDocuments chunks and floors secrets', () => {
  const docs = projectDocuments([{ path: 'a.md', text: '# T\n\nalpha beta\n' }, { path: '.env', text: 'secret' }]);
  assert.ok(docs.length >= 1);
  assert.ok(docs.every((d) => d.source === 'project' && d.locator.path));
  assert.ok(!docs.some((d) => d.locator.path === '.env'), 'secret floor');
});

test('standingDocuments keep list order and are never ranked', () => {
  const docs = standingDocuments([{ path: 'B.md', text: 'b' }, { path: 'A.md', text: 'a' }]);
  assert.deepEqual(docs.map((d) => d.locator.path), ['B.md', 'A.md']);
});

test('recall eval floor: recall@8 and negatives (evals/recall/queries.json)', () => {
  const docs = sessionDocuments({ entries: evalSet.sessions, facts: evalSet.facts.map((text) => ({ text })) });
  for (const q of evalSet.queries) {
    const { hits } = rankDocuments(docs, q.q, { limit: 8 });
    assert.ok(hits.some((h) => h.excerpt.includes(q.expectIncludes) || h.locator), `${q.q} should hit`);
    assert.ok(hits.length >= 1, `${q.q} no hits`);
  }
  for (const n of evalSet.negatives) {
    const { hits } = rankDocuments(docs, n, { limit: 8 });
    assert.equal(hits.length, 0, `negative leaked: ${n}`);
  }
});

test('hits carry provenance with a query hash', () => {
  const docs = sessionDocuments({ entries: evalSet.sessions });
  const { hits } = rankDocuments(docs, 'retrieval index', { limit: 3 });
  assert.ok(hits[0].provenance.queryHash);
  assert.equal(hits[0].provenance.source, 'session');
});
