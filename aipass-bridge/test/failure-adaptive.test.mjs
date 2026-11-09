// Failure classification, adaptive retry, and recovery planning
// (harness/failure.mjs + the loop wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { classifyFailure, retryHint, recoveryPlan, recoveryPlanText } from '../harness/failure.mjs';

test('a missing binary is an environment error, not a tool error', () => {
  const cls = classifyFailure({ kind: 'run' }, 'err: spawn node ENOENT — command not found');
  assert.equal(cls.klass, 'environment');
  const timed = classifyFailure({ kind: 'run' }, 'err: command timed out after 120s');
  assert.equal(timed.klass, 'environment');
  const noTab = classifyFailure({ kind: 'read' }, 'err: no extension connected — open a chat tab');
  assert.equal(noTab.klass, 'environment');
});

test('a malformed marker is a model error', () => {
  const cls = classifyFailure({ kind: 'read' }, 'err: NEED takes one file on its own line — a second line is a second call');
  assert.equal(cls.klass, 'model');
  const goal = classifyFailure({ kind: 'goal' }, 'err: GOAL takes DONE or BLOCKED');
  assert.equal(goal.klass, 'model');
});

test('a file the tool could not read is a tool error', () => {
  const cls = classifyFailure({ kind: 'read' }, 'err: no1.txt does not exist');
  assert.equal(cls.klass, 'tool');
  const write = classifyFailure({ kind: 'write' }, 'err: FIND did not match once — nothing written');
  assert.equal(write.klass, 'tool');
});

test('the adaptive hint for attempt 2 is never the hint for attempt 1', () => {
  const cls = { klass: 'tool', reason: 'x' };
  const first = retryHint(cls, 1, 'read');
  const second = retryHint(cls, 2, 'read');
  const third = retryHint(cls, 3, 'read');
  assert.equal(first.strategy, 'diagnose');
  assert.equal(second.strategy, 'alternative');
  assert.equal(third.strategy, 'escalate');
  assert.notEqual(first.hint, second.hint);
  assert.notEqual(second.hint, third.hint);
  for (const klass of ['model', 'tool', 'environment', 'unknown']) {
    const a = retryHint({ klass, reason: 'x' }, 1, 'run');
    const b = retryHint({ klass, reason: 'x' }, 2, 'run');
    assert.notEqual(a.hint, b.hint, `${klass} attempt 2 differs from attempt 1`);
  }
});

test('a recovery plan names the failing call and orders isolate → diagnose → alternative → fallback', () => {
  const steps = recoveryPlan([{
    call: { kind: 'run', arg: 'node check.mjs' },
    text: 'err: spawn node ENOENT',
    classification: { klass: 'environment', reason: 'missing binary' },
  }]);
  assert.ok(steps.length >= 4);
  assert.match(steps[0].action, /run/);
  assert.match(steps[1].action, /Diagnose/);
  assert.match(steps[2].action, /different approach/);
  assert.match(steps[steps.length - 1].action, /Fallback/);
  assert.deepEqual(recoveryPlan([]), []);
  assert.equal(recoveryPlanText([]), '');
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
  const call = (task = 'do the task') => runTask(task, {
    bridge, tools, overlay, session, events,
    options: { maxSteps: 8, ...options },
    first: true,
  });
  const stats = () => [...session.entries].reverse().find((e) => e.type === 'run_stats');
  return { call, stats, bridge, session, overlay, events, dir };
}

test('three failures in a row carry the class and the adaptive plan to the model', async () => {
  const dir = tempDir({});
  const b = boot(dir, ['NEED file no1.txt', 'NEED file no2.txt', 'NEED file no3.txt', 'DONE named three misses']);
  const result = await b.call();
  assert.equal(result.stopReason, 'done');
  const third = b.bridge.received[3] ?? '';
  assert.match(third, /third call in a row to fail the same way/);
  assert.match(third, /Adaptive retry \(tool, attempt 3\)/);
  assert.match(third, /Recovery plan:/);
  const stats = b.stats();
  assert.equal(stats.errLoops, 1);
  assert.ok(stats.failureCounts?.tool >= 3, 'failures are counted by class');
});

test('a second failure already earns an adaptive hint, not silence', async () => {
  const dir = tempDir({});
  const b = boot(dir, ['NEED file no1.txt', 'NEED file no2.txt', 'DONE recovered']);
  const result = await b.call();
  assert.equal(result.stopReason, 'done');
  assert.match(b.bridge.received[2] ?? '', /Adaptive retry \(tool, attempt 2\)/);
});
