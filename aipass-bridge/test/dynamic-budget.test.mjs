// Dynamic budget: the allowance scales with the difficulty of the task
// (harness/run/budgets.mjs + the loop wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { scoreDifficulty, budgetsForTier } from '../harness/run/budgets.mjs';
import { normalizeOptions } from '../harness/run/options.mjs';

test('a single read scores simple; a migration across many files scores complex', () => {
  const simple = scoreDifficulty('read a.txt');
  assert.equal(simple.tier, 'simple');
  assert.ok(simple.score < 30);
  const complexTask = 'refactor app.mjs and fix utils.js and add tests for all files across the project and migrate config.json and src/index.ts and package.json and the test suite. ' + 'please handle every module across the whole project. '.repeat(12);
  const complex = scoreDifficulty(complexTask);
  assert.equal(complex.tier, 'complex');
  assert.ok(complex.score > 60);
  const standard = scoreDifficulty('fix the bug in src/app.js and check utils.js');
  assert.equal(standard.tier, 'standard');
});

test('budgets scale by tier from the base, clamped', () => {
  const base = { maxToolCalls: 300, maxWallClockMs: 1_800_000 };
  assert.deepEqual(budgetsForTier('simple', base), { maxToolCalls: 90, maxWallClockMs: 540_000 });
  assert.deepEqual(budgetsForTier('standard', base), base);
  assert.deepEqual(budgetsForTier('complex', base), { maxToolCalls: 600, maxWallClockMs: 3_600_000 });
  // A person who raised the base keeps the raise.
  assert.equal(budgetsForTier('complex', { maxToolCalls: 1000, maxWallClockMs: 3_600_000 }).maxToolCalls, 2000);
});

test('the new switches default on, and off stays off', () => {
  assert.equal(normalizeOptions({}).dynamicBudget, true);
  assert.equal(normalizeOptions({ dynamicBudget: false }).dynamicBudget, false);
  assert.equal(normalizeOptions({}).independentVerify, true);
  assert.equal(normalizeOptions({ independentVerify: false }).independentVerify, false);
  assert.equal(normalizeOptions({}).loopStatePersist, true);
  assert.equal(normalizeOptions({ loopStatePersist: false }).loopStatePersist, false);
});

function scriptedLoop(replies) {
  const received = [];
  let turn = 0;
  return {
    received,
    async chat({ message }) {
      received.push(message);
      return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' };
    },
    async quota() { return { available: 1 }; },
  };
}

function boot(dir, replies, options = {}) {
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay });
  const bridge = scriptedLoop(replies);
  const events = new Emitter();
  const call = (task) => runTask(task, {
    bridge, tools, overlay, session, events,
    options: { maxSteps: 8, maxToolCalls: 300, maxWallClockMs: 1_800_000, ...options },
    first: true,
  });
  const stats = () => [...session.entries].reverse().find((e) => e.type === 'run_stats');
  return { call, stats, bridge, session, overlay, dir };
}

test('a simple task runs in the simple tier, and off keeps the shipped numbers', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const b = boot(dir, ['NEED file a.txt', 'DONE read it']);
  const result = await b.call('read a.txt');
  assert.equal(result.stopReason, 'done');
  assert.equal(b.stats().budgetTier, 'simple');

  const dir2 = tempDir({ 'a.txt': 'hello\n' });
  const b2 = boot(dir2, ['NEED file a.txt', 'DONE read it'], { dynamicBudget: false });
  await b2.call('read a.txt');
  assert.equal(b2.stats().budgetTier, 'standard');
});

test('a migratory task runs in the complex tier', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const b = boot(dir, ['NEED file a.txt', 'DONE done it']);
  const complexTask = 'refactor app.mjs and fix utils.js and add tests for all files across the project and migrate config.json and src/index.ts and package.json and the test suite. ' + 'please handle every module across the whole project. '.repeat(12);
  await b.call(complexTask);
  assert.equal(b.stats().budgetTier, 'complex');
});
