// Loop state persistence: the guard counters survive a dead process
// (harness/loop-state.mjs + the loop wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { snapshotFromRun, saveLoopState, loadLoopState, clearLoopState, restoreLoopState, loopStateFile } from '../harness/loop-state.mjs';
import { RunContext } from '../harness/run/context.mjs';

const HOME = fs.mkdtempSync(path.join(tmpdir(), 'aipass-state-home-'));
process.env.AIPASS_HOME = HOME;

test('a snapshot round-trips through the disk', () => {
  const root = tempDir({ 'a.txt': 'hello\n' });
  const run = new RunContext('do it', { overlay: new Overlay(root), bridge: { quota: async () => null } });
  run.toolsRun = 7;
  run.errStreak = 2;
  run.failureCounts = { model: 1, tool: 2, environment: 0, unknown: 0 };
  run.todoState = [{ text: 'step one', done: true }];
  const snap = snapshotFromRun(run, { step: 3 });
  assert.equal(saveLoopState(root, snap), true);
  const back = loadLoopState(root);
  assert.equal(back.toolsRun, 7);
  assert.equal(back.errStreak, 2);
  assert.deepEqual(back.failureCounts, { model: 1, tool: 2, environment: 0, unknown: 0 });
  assert.equal(back.todoState.length, 1);
});

test('restore puts the counters back', () => {
  const root = tempDir({});
  const run = new RunContext('task', { overlay: new Overlay(root), bridge: { quota: async () => null } });
  restoreLoopState(run, { toolsRun: 11, errStreak: 3, errKindKey: 'k', nudgeStreak: 1, checks: 1, failureCounts: { model: 0, tool: 3, environment: 0, unknown: 0 }, todoState: [{ text: 't', done: false }], stagedFiles: ['a.txt'] });
  assert.equal(run.toolsRun, 11);
  assert.equal(run.errStreak, 3);
  assert.equal(run.todoState.length, 1);
});

test('a torn, stale, or foreign snapshot is ignored, never trusted', () => {
  const root = tempDir({});
  const file = loopStateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  assert.equal(loadLoopState(root), null);
  // Stale: a day old.
  const other = tempDir({});
  saveLoopState(other, { version: 1, savedAt: Date.now() - 25 * 60 * 60 * 1000, root: other, taskText: 'x', toolsRun: 5 });
  assert.equal(loadLoopState(other), null);
  // Foreign: another project’s root.
  saveLoopState(root, { version: 1, savedAt: Date.now(), root: '/somewhere/else', taskText: 'x', toolsRun: 5 });
  assert.equal(loadLoopState(root), null);
  // Newer version: ignored.
  saveLoopState(root, { version: 999, savedAt: Date.now(), root, taskText: 'x', toolsRun: 5 });
  assert.equal(loadLoopState(root), null);
});

function scriptedLoop(replies) {
  let turn = 0;
  return {
    async chat() { return { text: replies[Math.min(turn++, replies.length - 1)], reasoning: '' }; },
    async quota() { return { available: 1 }; },
  };
}

test('a run snapshots after every step, and a done run clears it', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay });
  const bridge = scriptedLoop(['NEED file a.txt', 'DONE read it']);
  const events = new Emitter();
  const result = await runTask('read a.txt', {
    bridge, tools, overlay, session, events,
    options: { maxSteps: 8 }, first: true,
  });
  assert.equal(result.stopReason, 'done');
  assert.equal(loadLoopState(dir), null, 'a clean done clears the snapshot');
  const stats = session.entries.find((e) => e.type === 'run_stats');
  assert.ok(stats.loopStateSaved >= 1, 'steps were snapshotted');
});

test('a second run with the same task restores the guards a dead run left', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  // Manually leave a snapshot as a dead run would (a done run clears it, so
  // plant it directly): 11 tool calls and an err streak of 2.
  saveLoopState(dir, {
    version: 1, savedAt: Date.now(), root: dir, taskText: 'read a.txt',
    step: 2, toolsRun: 11, mutations: 0, stagedFiles: [], todoState: [],
    failureCounts: { model: 0, tool: 2, environment: 0, unknown: 0 },
    budgetTier: 'simple', errStreak: 2, errKindKey: 'read::x', nudgeStreak: 0, checks: 0, stopReason: '',
  });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay });
  const bridge = scriptedLoop(['NEED file a.txt', 'DONE read it']);
  const events = new Emitter();
  const result = await runTask('read a.txt', {
    bridge, tools, overlay, session, events,
    options: { maxSteps: 8 }, first: true,
  });
  assert.equal(result.stopReason, 'done');
  assert.ok(session.entries.some((e) => e.type === 'note' && /loop state restored/.test(e.text)), 'the restore was said');
  assert.equal(result.steps, 12, '11 restored + 1 new read');
});

test('restore does not resurrect a dead run checker budget', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  // A dead run that already spent both checker rounds, verdict lost with
  // the process (`checkResult` is not in the snapshot). Restoring `checks`
  // would make the next run skip the checker and pass `requireCheck`.
  saveLoopState(dir, {
    version: 1, savedAt: Date.now(), root: dir, taskText: 'add a file',
    step: 3, toolsRun: 0, mutations: 1, stagedFiles: [], todoState: [],
    failureCounts: { model: 0, tool: 0, environment: 0, unknown: 0 },
    budgetTier: 'standard', errStreak: 0, errKindKey: '', nudgeStreak: 0, checks: 2, stopReason: '',
  });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay, allowRun: true });
  const bridge = scriptedLoop(['CREATE b.mjs\nexport const x = 1;\nEND\nDONE staged it\n']);
  let calls = 0;
  const check = async () => { calls += 1; return { verdict: 'pass', text: 'ok', ran: 1 }; };
  const result = await runTask('add a file', {
    bridge, tools, overlay, session, events: new Emitter(), check,
    options: { maxSteps: 8, allowRun: true, subagent: true }, first: true,
  });
  assert.equal(calls, 1, 'the checker ran fresh — the restored budget did not starve it');
  assert.equal(result.stopReason, 'done');
});

