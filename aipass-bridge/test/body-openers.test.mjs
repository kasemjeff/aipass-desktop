// The body-opener list parse() bounds its terminator search with must never
// drift from the dispatch branches that open body blocks (a block kind
// added to dispatch lines without joining the list restores the "lends its
// END" bug the Ruby probe exposed). The list lives beside the named regexes
// it enumerates, so the sync is pinned by source, the way the MARKERS test
// pins keyword sets.
//
// Read-only by design: this uses no import from protocol.mjs, so a rewrite
// of the parser (like the exact-case one) breaks this loudly only when it
// actually forks the shared constants again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness', 'protocol.mjs'), 'utf8');

test('every body opener is defined once and listed once', () => {
  const defs = [...src.matchAll(/\b([A-Z][A-Z_]*_BLOCK_RE)\s*=\s*\/(\^\\s\*[^\n]*?)\/(?:[gimsuy]*);/g)];
  assert.ok(defs.length >= 6, 'the block openers are still named constants');
  assert.equal(new Set(defs.map((d) => d[1])).size, defs.length, 'no opener constant is defined twice');

  const list = src.match(/BODY_OPENERS\s*=\s*\[([^\]]*)\]/);
  assert.ok(list, 'BODY_OPENERS is still one plain list literal');
  const listed = [...list[1].matchAll(/\b([A-Z][A-Z_]*_BLOCK_RE)\b/g)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), defs.map((d) => d[1]).sort(), 'the boundary list holds exactly the openers parse knows');
});

test('no dispatch branch copies an opener literal inline', () => {
  // Count literal occurrences of each opener's pattern in the whole source:
  // each is defined once; a hand-copied second copy inside the dispatcher
  // would be the drift that lent terminators across blocks (2026-11-09).
  const defs = [...src.matchAll(/\b([A-Z][A-Z_]*_BLOCK_RE)\s*=\s*\/(\^\\s\*[^\n]*?)\/(?:[gimsuy]*);/g)];
  for (const [, name, body] of defs) {
    const count = src.split(body).length - 1;
    assert.equal(count, 1, `${name}'s literal appears once (${name} = /${body}/)`);
  }
});
