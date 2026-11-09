/**
 * Overlay persistence + idempotent tools + multi-agent budget (P2).
 *
 *   - staged edits survive a backend death: the loop writes them beside the
 *     session file after every step, and opening the session restores them;
 *     a clean apply/discard deletes the snapshot;
 *   - DELETE / MOVE re-executed after a crash resume the same staged state
 *     instead of answering `err:` (idempotent tool execution);
 *   - a helper's steps/ms count against the parent's tool budget and land
 *     in `run_stats.helperSteps` / `helperMs`.
 *
 * Run: node --test aipass-bridge/test/overlay-resume.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import {
  overlayStateFile,
  saveOverlayState,
  loadOverlayState,
  clearOverlayState,
  restoreOverlayState,
} from '../harness/overlay-persist.mjs';

test('staged edits survive a save/restore round trip, deletes included', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n', 'b.txt': 'world\n', 'c.txt': 'old\n' });
  const overlay = new Overlay(dir);
  const storeDir = tempDir();
  const sessionFile = path.join(storeDir, 'session.jsonl');

  overlay.set(path.join(dir, 'a.txt'), 'changed\n');
  overlay.set(path.join(dir, 'new.txt'), 'created this run\n');
  overlay.markDeleted(path.join(dir, 'c.txt'));

  assert.equal(saveOverlayState(sessionFile, overlay), true);
  // Even without a session file existing, the snapshot reads back.
  const snap = loadOverlayState(sessionFile, { root: dir });
  assert.ok(snap, 'the snapshot reads back');
  assert.deepEqual(
    Object.fromEntries(snap.entries.map((e) => [e.path, e.deleted ? 'DELETED' : e.content])),
    { 'a.txt': 'changed\n', 'new.txt': 'created this run\n', 'c.txt': 'DELETED' },
  );

  // A fresh overlay (the next backend) resumes exactly that state.
  const next = new Overlay(dir);
  const landed = restoreOverlayState(next, snap);
  assert.equal(landed.files, 3);
  assert.equal(next.readAt(path.join(dir, 'a.txt')), 'changed\n');
  assert.equal(next.readAt(path.join(dir, 'new.txt')), 'created this run\n');
  assert.equal(next.isDeleted(path.join(dir, 'c.txt')), true);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello\n', 'the disk itself never moved');
});

test('a torn or stale snapshot is ignored, never restored', () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const sessionFile = path.join(tempDir(), 'session.jsonl');
  fs.writeFileSync(overlayStateFile(sessionFile), '{"entries":[{"path":"a.txt"', 'utf8');
  assert.equal(loadOverlayState(sessionFile), null, 'torn JSON reads as nothing');

  saveOverlayState(sessionFile, overlay);
  const stale = loadOverlayState(sessionFile, {
    root: dir,
    now: Date.now() + 25 * 60 * 60 * 1000, // more than the 24h stale window
  });
  assert.equal(stale, null, 'a stale snapshot is dropped');
});

test('clearOverlayState deletes the snapshot — apply/discard leave nothing to resurrect', () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const sessionFile = path.join(tempDir(), 'session.jsonl');
  overlay.set(path.join(dir, 'a.txt'), 'changed\n');
  saveOverlayState(sessionFile, overlay);
  assert.ok(fs.existsSync(overlayStateFile(sessionFile)));
  clearOverlayState(sessionFile);
  assert.equal(loadOverlayState(sessionFile), null, 'gone after a clean end');
});

/* ------------------------------------------------- idempotent tools */

test('DELETE re-run on an already-staged delete answers the same success', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  const first = await tools.delete('a.txt');
  assert.match(String(first), /marked a\.txt for deletion/);
  const retry = await tools.delete('a.txt');
  assert.match(String(retry), /marked a\.txt for deletion/, 'a retry lands the same state, not an error');
  const missing = await tools.delete('missing.txt');
  assert.match(String(missing), /^err: no such file/, 'a genuinely missing file is still an error');
});

test('MOVE re-run on an already-staged move reports the standing state', async () => {
  const dir = tempDir({ 'a.txt': 'content\n' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  const first = await tools.move('a.txt b.txt');
  assert.match(String(first), /marked: move a\.txt → b\.txt/);
  const retry = await tools.move('a.txt b.txt');
  assert.match(String(retry), /already moved/, 'the retry says the move already stands');
  // A different destination is still a genuine conflict.
  const clash = await tools.move('a.txt c.txt');
  assert.match(String(clash), /^err: /);
});

/* --------------------------------------------- multi-agent budget */

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
    async createConversation() { return { id: `conv-${Math.floor(Math.random() * 1e6)}`, temporary: true }; },
  };
}

test('child-over-the-hill: a helper’s steps count against the parent budget', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay });
  const { Emitter } = await import('../harness/events.mjs');
  const bridge = scriptedLoop([
    'SUBAGENT\ntask: summarise the repo\nEND\n',
    'DONE helper done\n',
  ]);
  const subagent = async () => ({ text: 'helper summary', steps: 7, ms: 1234 });
  const { runTask } = await import('../harness/loop.mjs');
  const result = await runTask('do the thing', {
    bridge, tools, overlay, session, events: new Emitter(),
    subagent,
    options: { maxSteps: 8, subagent: true },
    first: true,
  });
  assert.equal(result.stopReason, 'done');
  const stats = [...session.entries].reverse().find((e) => e.type === 'run_stats');
  assert.equal(stats.helperSteps, 7, 'helper steps landed in run_stats');
  assert.equal(stats.helperMs, 1234);
  // The parent budget spent them: `steps` counts the SUBAGENT call (1) plus
  // the helper's own 7.
  assert.equal(result.steps, 8, `steps includes the helper's steps (${result.steps})`);
});
