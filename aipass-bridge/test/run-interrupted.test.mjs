// Crash-safe resume: a run that ended without anyone reporting it.
//
// A run writes a `.running` marker beside its session file and clears it
// when it ends. A marker still on disk at boot is a backend that died
// mid-run — the session gets a note saying so, the marker is cleared, and
// the caller tells the window so it can offer a resume. A marker whose
// owner pid is still alive is a second backend legitimately running, and is
// left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, writeRunningMarker, clearRunningMarker } from '../harness/session.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-interrupt-'));
const deadPid = () => {
  // A pid that cannot be alive: find one above the current maximum by
  // spawning nothing — use a very large number that kill() rejects with
  // ESRCH rather than EPERM.
  return 999_999_999;
};

test('a run in flight writes a marker and clears it at the end', () => {
  const store = new SessionStore(tempDir());
  const session = store.create({ root: process.cwd(), title: 'marker' });
  writeRunningMarker(session);
  assert.ok(fs.existsSync(`${session.file}.running`), 'the marker exists while running');
  const info = JSON.parse(fs.readFileSync(`${session.file}.running`, 'utf8'));
  assert.equal(info.pid, process.pid);
  assert.equal(info.sessionId, session.id);
  clearRunningMarker(session);
  assert.equal(fs.existsSync(`${session.file}.running`), false, 'the marker is gone when the run ends');
});

test('a leftover marker from a dead pid becomes an interrupted run', () => {
  const store = new SessionStore(tempDir());
  const session = store.create({ root: process.cwd(), title: 'crashed' });
  session.append('user', { text: 'task before the crash' });
  fs.writeFileSync(`${session.file}.running`, JSON.stringify({ pid: deadPid(), startedAt: Date.now() - 60_000, sessionId: session.id }));
  const interrupted = store.interruptedRuns();
  assert.equal(interrupted.length, 1, 'one interrupted run');
  assert.equal(interrupted[0].id, session.id);
  assert.equal(interrupted[0].title, 'crashed');
  assert.equal(fs.existsSync(`${session.file}.running`), false, 'the marker is cleared after the sweep');
  const reloaded = store.load(session.id, { root: process.cwd() });
  assert.ok(reloaded.entries.some((e) => e.type === 'note' && /ไม่มีใครเก็บเสียง/.test(e.text)), 'the session carries the interrupted note');
  // A second sweep finds nothing — the marker is gone, not re-reported.
  assert.equal(store.interruptedRuns().length, 0, 'the sweep reports once, not twice');
});

test('a marker owned by a live pid is left alone', () => {
  const store = new SessionStore(tempDir());
  const session = store.create({ root: process.cwd(), title: 'live' });
  writeRunningMarker(session); // pid is this process — alive
  assert.equal(store.interruptedRuns().length, 0, 'a live owner is not an interrupted run');
  assert.ok(fs.existsSync(`${session.file}.running`), 'the live marker survives the sweep');
});
