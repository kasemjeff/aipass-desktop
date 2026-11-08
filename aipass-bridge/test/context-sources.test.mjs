// Context assembly: the single preamble flag sheet, the turn-1/seed budgets,
// and the manifest that says what the model was shown (docs/LOOP_DESIGN.md).
//
// Before harness/context-sources.mjs the flags were written by hand in four
// places and drifted: retrieve was missing from the live loop's turn-1 build
// while every seed builder sent it, and sandbox was missing everywhere. These
// tests pin the parity (every flag the preamble reads is derived in one
// place), the drop order under the total budget, and the seed truncation that
// keeps a rotation's summary inside its share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preamble } from '../harness/protocol.mjs';
import {
  PREAMBLE_FLAG_KEYS,
  preambleFlags,
  buildPreambleFor,
  turn1BudgetChars,
  seedBudgetChars,
  assemble,
  manifestSummary,
  mergeCrossMemory,
} from '../harness/context-sources.mjs';

const ALL_ON = {
  allowRun: true, plan: true, subagent: true, searchI: true, attach: true,
  allowVerify: true, diagnose: true, recall: true, retrieve: true,
  explore: true, sandbox: 'workspace-write',
};

test('the flag sheet names every flag the preamble reads', () => {
  const flags = preambleFlags(ALL_ON);
  for (const key of PREAMBLE_FLAG_KEYS) {
    assert.ok(key in flags, `preambleFlags is missing ${key}`);
  }
  // And the preamble really reads each one: turning everything on must teach
  // each marker, turning it off must teach none of them.
  const on = preamble(flags);
  assert.match(on, /RETRIEVE where the login token is renewed/);
  assert.match(on, /RECALL what we decided about the login flow/);
  assert.match(on, /TREE src/);
  assert.match(on, /DIAGNOSE src\/foo\.ts/);
  assert.match(on, /sandbox \(mode: workspace-write\)/);
  const off = preamble(preambleFlags({}));
  assert.doesNotMatch(off, /RETRIEVE where/);
  assert.doesNotMatch(off, /sandbox \(mode:/);
});

test('buildPreambleFor is the one door: retrieve and sandbox ride every caller', () => {
  const text = buildPreambleFor(ALL_ON);
  assert.match(text, /RETRIEVE where the login token is renewed/);
  assert.match(text, /sandbox \(mode: workspace-write\)/);
  // Default-off sandbox adds no bytes at all (the tuned replay pins them).
  const off = buildPreambleFor({});
  assert.equal(off, buildPreambleFor({ sandbox: 'off' }));
  assert.doesNotMatch(off, /sandbox \(mode:/);
});

test('the turn-1 budget scales with the model budget and caps hard', () => {
  const wide = { budgetFor: () => 200_000, reserveTokens: 4_096 };
  const narrow = { budgetFor: () => 24_000, reserveTokens: 4_096 };
  assert.ok(turn1BudgetChars(wide) > turn1BudgetChars(narrow), 'a wider window offers a larger first message');
  assert.ok(turn1BudgetChars(wide) <= 48_000, 'and never past the hard cap');
  assert.ok(turn1BudgetChars(narrow) >= 4_000, 'and never below the floor');
  assert.equal(turn1BudgetChars(null), 48_000, 'no compactor means the hard cap');
  assert.ok(seedBudgetChars(wide) < turn1BudgetChars(wide), 'a seed is cheaper than a turn 1');
});

test('assemble keeps display order and drops the lowest priority first', () => {
  const blocks = [
    { id: 'protocol', priority: 100, mandatory: true, text: 'P'.repeat(10) },
    { id: 'instructions', priority: 60, text: 'I'.repeat(10) },
    { id: 'snapshot', priority: 40, text: 'S'.repeat(20) },
    { id: 'task', priority: 100, mandatory: true, text: 'T'.repeat(10) },
  ];
  const { text, manifest, totalChars } = assemble(blocks, 40);
  assert.match(text, /^PPP/, 'order is preserved');
  assert.ok(manifest.find((m) => m.id === 'snapshot')?.dropped, 'snapshot gives way first');
  assert.ok(!manifest.find((m) => m.id === 'instructions')?.dropped, 'instructions survives');
  assert.ok(totalChars <= 40, `total ${totalChars} fits 40`);
});

test('assemble truncates before it drops a mandatory source, and never drops one', () => {
  const blocks = [
    { id: 'protocol', priority: 100, mandatory: true, text: 'P'.repeat(100) },
    { id: 'summary', priority: 50, text: 'S'.repeat(100), maxChars: 30 },
  ];
  // Mandatory (100) + truncated summary (31) + join (2) = 133, so a budget
  // of 140 keeps both: the ceiling truncates, nothing is dropped.
  const { manifest } = assemble(blocks, 140);
  assert.ok(!manifest.find((m) => m.id === 'protocol')?.dropped, 'protocol is mandatory');
  assert.ok(manifest.find((m) => m.id === 'summary')?.truncated, 'the ceiling truncates');
  assert.ok(manifest.find((m) => m.id === 'summary')?.dropped === false, 'truncated, not dropped');
});

test('manifestSummary names what gave way', () => {
  const note = manifestSummary([
    { id: 'snapshot', dropped: true, truncated: false },
    { id: 'listing', dropped: false, truncated: true },
  ]);
  assert.match(note, /snapshot/);
  assert.match(note, /listing/);
  assert.equal(manifestSummary([]), null);
  assert.equal(manifestSummary([{ id: 'a', dropped: false, truncated: false }]), null);
});

test('mergeCrossMemory dedupes case-insensitively and keeps order', () => {
  const merged = mergeCrossMemory(
    ['decision: use tabs', 'file: a.txt'],
    ['DECISION: USE TABS', 'constraint: never block the loop', 'file: a.txt '],
  );
  assert.deepEqual(merged, ['decision: use tabs', 'file: a.txt', 'constraint: never block the loop']);
  assert.deepEqual(mergeCrossMemory([], []), []);
});
