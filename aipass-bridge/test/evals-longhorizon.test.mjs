/**
 * The long-horizon fixture (`evals/tasks/long-horizon/`): three small bugs
 * in three files, each worth fixing and none alone passing — a multi-step
 * task whose check only passes when the whole sequence lands, scored
 * offline through recorded replies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTask, runAttempt, replayBridge } from '../../scripts/evals.mjs';

const FIXES = [
  // No DONE yet: a stage-and-DONE ends the run (that is what the checker
  // exists for), so a multi-step task only reaches its last fix by keeping
  // the marker off until the work is done.
  [
    'EDIT src/avg.mjs',
    'FIND',
    'export const average = (list) => (list.reduce((a, b) => a + b, 0) + list.length) / list.length;',
    'NEW',
    'export const average = (list) => list.reduce((a, b) => a + b, 0) / list.length;',
    'END',
  ].join('\n'),
  [
    'EDIT src/max.mjs',
    'FIND',
    'export const maximum = (list) => list[list.length - 1];',
    'NEW',
    'export const maximum = (list) => Math.max(...list);',
    'END',
  ].join('\n'),
  [
    'EDIT src/dup.mjs',
    'FIND',
    'export const firstDuplicate = (list) => list[0];',
    'NEW',
    'export const firstDuplicate = (list) => {',
    '  const seen = new Set();',
    '  for (const x of list) { if (seen.has(x)) return x; seen.add(x); }',
    '  return -1;',
    '};',
    'END',
    'DONE fixed dup',
  ].join('\n'),
];

test('a long-horizon attempt that fixes all three modules is solved', async () => {
  const task = loadTask('long-horizon');
  const row = await runAttempt(task, {
    mode: 'replay',
    bridge: replayBridge(FIXES),
    budget: { maxSteps: 14 },
  });
  assert.equal(row.outcome, 'solved', `tail: ${row.check.tail}`);
  assert.equal(row.check.exit, 0);
});

test('a long-horizon attempt that stops after one fix is unsolved', async () => {
  const task = loadTask('long-horizon');
  const row = await runAttempt(task, {
    mode: 'replay',
    bridge: replayBridge([FIXES[0], 'DONE fixing only one']),
    budget: { maxSteps: 14 },
  });
  assert.equal(row.outcome, 'unsolved', `tail: ${row.check.tail}`);
  assert.match(row.check.tail, /FAIL:/);
});
