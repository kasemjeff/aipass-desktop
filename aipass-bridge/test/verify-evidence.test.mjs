// Independent verification: a checker verdict is audited against the
// evidence underneath it (harness/verify-evidence.mjs + the gates wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { auditCheckResult, evidenceNote } from '../harness/verify-evidence.mjs';

test('a pass without any execution is not evidence', () => {
  const audit = auditCheckResult({ verdict: 'pass', ran: 0, text: '', declared: '' }, {
    stagedFiles: [{ path: 'a.txt' }], declaredCommand: '', stagedCount: 1,
  });
  assert.equal(audit.verdict, 'none');
  assert.equal(audit.trustworthy, false);
  assert.ok(audit.issues.length);
  assert.match(evidenceNote(audit), /Independent verification/);
});

test('a pass backed by runs stands, and a fail is always kept', () => {
  const pass = auditCheckResult({ verdict: 'pass', ran: 2, text: 'ok' }, {
    stagedFiles: [{ path: 'a.txt' }], declaredCommand: '', stagedCount: 1,
  });
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.trustworthy, true);
  assert.equal(evidenceNote(pass), '');
  const fail = auditCheckResult({ verdict: 'fail', ran: 0, text: 'bad' }, {
    stagedFiles: [{ path: 'a.txt' }], declaredCommand: '', stagedCount: 1,
  });
  assert.equal(fail.verdict, 'fail');
});

test('a pass over an empty tree is not trusted', () => {
  const audit = auditCheckResult({ verdict: 'pass', ran: 1, text: 'ok' }, {
    stagedFiles: [], stagedCount: 0,
  });
  assert.equal(audit.verdict, 'none');
});

test('a verdict about a different command than the declared check is not trusted as a pass', () => {
  const audit = auditCheckResult({ verdict: 'pass', ran: 1, text: 'ok', declared: 'node other.mjs' }, {
    stagedFiles: [{ path: 'a.txt' }], declaredCommand: 'node check.mjs', stagedCount: 1,
  });
  assert.equal(audit.verdict, 'none');
  assert.equal(audit.trustworthy, false);
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
    async createConversation() { return { id: `conv-${Math.floor(Math.random() * 1e6)}`, temporary: true }; },
  };
}

test('a checker pass with no runs is audited down to none and the model is asked for evidence', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay, allowRun: true });
  const bridge = scriptedLoop([
    'CREATE b.mjs\nexport const x = 1;\nEND\nDONE staged it\n',
    'DONE still staged it\n',
  ]);
  const events = new Emitter();
  // The checker lies: a pass over zero runs.
  const check = async () => ({ verdict: 'pass', text: 'looks fine', ran: 0 });
  const result = await runTask('add a file', {
    bridge, tools, overlay, session, events,
    check,
    options: { maxSteps: 8, allowRun: true, subagent: true },
    first: true,
  });
  assert.equal(result.stopReason, 'done');
  const stats = [...session.entries].reverse().find((e) => e.type === 'run_stats');
  assert.equal(stats.independentChecks, 1);
  assert.equal(stats.independentVerdict, 'none');
  assert.equal(stats.checkVerdict, 'none');
  // The audit rode back as a correction asking for a real run.
  assert.ok(bridge.received.some((m) => /Independent verification/.test(m)), 'the downgrade reached the model');
});

test('a checker pass backed by runs is trusted and costs no extra message', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay, allowRun: true });
  const bridge = scriptedLoop([
    'CREATE b.mjs\nexport const x = 1;\nEND\nDONE staged it\n',
  ]);
  const events = new Emitter();
  const check = async () => ({ verdict: 'pass', text: 'node check.mjs passed', ran: 1 });
  const result = await runTask('add a file', {
    bridge, tools, overlay, session, events,
    check,
    options: { maxSteps: 8, allowRun: true, subagent: true },
    first: true,
  });
  assert.equal(result.stopReason, 'done');
  const stats = [...session.entries].reverse().find((e) => e.type === 'run_stats');
  assert.equal(stats.independentVerdict, 'pass');
  assert.equal(stats.checkVerdict, 'pass');
});

test('a verdict naming no staged files over a non-empty overlay is not trusted', () => {
  // The dead-branch pin: `stagedFiles: []` with `stagedCount: 3` used to be
  // unreachable when the count was derived from the (empty) list — the
  // verdict slipped through as trustworthy. The count now wins when given.
  const audit = auditCheckResult({ verdict: 'pass', ran: 1, text: 'ok' }, {
    stagedFiles: [], stagedCount: 3, declaredCommand: '',
  });
  assert.equal(audit.verdict, 'none');
  assert.equal(audit.trustworthy, false);
  assert.match(audit.issues.join(' '), /names no staged files/);
});

