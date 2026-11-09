/**
 * Verification by task type, acceptance criteria and test evidence —
 * the rest of the P1 list (the independent audit itself is pinned in
 * `verify-evidence.test.mjs`).
 *
 *   - a staged code change is classified `code`: a verdict over zero runs is
 *     untrusted, and with a declared check its DONE is refused entirely
 *     (`requireCheck`) or nudged (`done-unverified` only under requireCheck —
 *     otherwise the model hears the evidence note and can still finish);
 *   - docs runs are classified `docs`: a `none` verdict is honest evidence;
 *   - declared acceptance criteria need an execution behind them — criteria
 *     with `ran: 0` is a false DONE and is downgraded;
 *   - `run_stats` carries the task type, the criteria, and the check's tail
 *     as machine-readable test evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';
import { auditCheckResult, classifyTaskType } from '../harness/verify-evidence.mjs';
import { RunContext } from '../harness/run/context.mjs';
import { createDoneGates } from '../harness/run/gates.mjs';

/* ------------------------------------------------------------- task type */

test('classifyTaskType tells code, docs and empty staged sets apart', () => {
  assert.equal(classifyTaskType([]), 'none');
  assert.equal(classifyTaskType([{ path: 'src/app.mjs' }]), 'code');
  assert.equal(classifyTaskType([{ path: 'lib/util.ts' }]), 'code');
  assert.equal(classifyTaskType(['docs/notes.md']), 'docs');
  assert.equal(classifyTaskType(['docs/notes.md', 'data/shape.json']), 'docs');
  assert.equal(classifyTaskType(['docs/notes.md', 'src/app.mjs']), 'code', 'one code file makes the task code');
});

/* --------------------------------------------------------- the audit side */

test('code staged with a declared check that never ran is untrusted', () => {
  const audit = auditCheckResult({ verdict: 'none', ran: 0, text: 'nothing ran' }, {
    stagedFiles: [{ path: 'app.mjs' }], declaredCommand: 'node check.mjs', stagedCount: 1,
  });
  assert.equal(audit.verdict, 'none');
  assert.equal(audit.trustworthy, false);
  assert.match(audit.issues.join(' '), /declared check never ran/);
  assert.equal(audit.taskType, 'code');
});

test('code staged with no declared check and no runs is recorded unverified, not trusted', () => {
  const audit = auditCheckResult({ verdict: 'none', ran: 0, text: 'nothing ran' }, {
    stagedFiles: [{ path: 'app.mjs' }], declaredCommand: '', stagedCount: 1,
  });
  assert.equal(audit.trustworthy, false);
  assert.match(audit.issues.join(' '), /unverified/);
});

test('docs runs need no execution behind a none verdict', () => {
  const audit = auditCheckResult({ verdict: 'none', ran: 0, text: 'nothing ran' }, {
    stagedFiles: [{ path: 'docs/notes.md' }], declaredCommand: '', stagedCount: 1,
  });
  assert.equal(audit.trustworthy, true);
  assert.deepEqual(audit.issues, []);
  assert.equal(audit.taskType, 'docs');
});

test('declared acceptance criteria with no execution behind them downgrade the pass', () => {
  const audit = auditCheckResult({ verdict: 'pass', ran: 0, text: 'looks fine' }, {
    stagedFiles: [{ path: 'docs/notes.md' }], declaredCommand: '', stagedCount: 1,
    acceptanceCriteria: ['the summary page lists three causes'],
  });
  assert.equal(audit.verdict, 'none');
  assert.equal(audit.trustworthy, false);
  assert.match(audit.issues.join(' '), /acceptance criteria/);
});

test('criteria with an execution behind the verdict are trusted', () => {
  const audit = auditCheckResult({ verdict: 'pass', ran: 1, text: 'ok' }, {
    stagedFiles: [{ path: 'app.mjs' }], declaredCommand: '', stagedCount: 1,
    acceptanceCriteria: ['npm test passes'],
  });
  assert.equal(audit.trustworthy, true);
  assert.deepEqual(audit.issues, []);
});

/* -------------------------------------------------------- the gates side */

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

function statsOf(session) {
  return [...session.entries].reverse().find((e) => e.type === 'run_stats');
}

test('with requireCheck, code staged + declared check never ran refuses the DONE', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay, allowRun: true });
  const bridge = scriptedLoop([
    'CREATE b.mjs\nexport const x = 1;\nEND\nDONE staged it\n',
    'DONE staged it, again\n',
  ]);
  const check = async () => ({ verdict: 'none', text: 'the checker ran nothing', ran: 0 });
  const result = await runTask('add a file', {
    bridge, tools, overlay, session, events: new Emitter(),
    check,
    options: {
      maxSteps: 8, allowRun: true, subagent: true,
      verifyCommand: 'node check.mjs', requireCheck: true,
    },
    first: true,
  });
  assert.equal(result.stopReason, 'done-unverified');
  const stats = statsOf(session);
  assert.equal(stats.taskType, 'code');
  assert.equal(stats.checkVerdict, 'none');
  assert.equal(stats.unverified, true);
  // Test evidence rides run_stats, named by its command.
  assert.equal(stats.checkEvidence.command, 'node check.mjs');
  assert.match(stats.checkEvidence.tail, /checker ran nothing/);
});

test('without requireCheck, the same shape nudges the model and records the evidence', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay, allowRun: true });
  const bridge = scriptedLoop([
    'CREATE b.mjs\nexport const x = 1;\nEND\nDONE staged it\n',
    'DONE staged it, again\n',
  ]);
  // A verdict the audit understands: declared check never ran.
  const check = async () => ({ verdict: 'none', text: 'the checker ran nothing', ran: 0 });
  const result = await runTask('add a file', {
    bridge, tools, overlay, session, events: new Emitter(),
    check,
    options: {
      maxSteps: 8, allowRun: true, subagent: true,
      verifyCommand: 'node check.mjs',
    },
    first: true,
  });
  // The nudge rode back at least once: the model was told, in plain words,
  // that the declared check never ran and the DONE is unverified.
  assert.ok(bridge.received.some((m) => /declared check never ran/i.test(m)), 'the model was told the check never ran');
  // And the DONE still landed afterwards (no requireCheck) — but the stats
  // carry the full evidence of what it stood on.
  const stats = statsOf(session);
  assert.equal(stats.taskType, 'code');
  assert.equal(stats.unverified, true);
  assert.equal(stats.checkEvidence.command, 'node check.mjs');
  assert.equal(result.stopReason, 'done');
});

test('declared acceptance criteria reach the checker brief and the run stats', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay, allowRun: true });
  const seen = [];
  const bridge = scriptedLoop(['CREATE b.mjs\nexport const x = 1;\nEND\nDONE staged it\n']);
  const check = async ({ files }) => {
    seen.push(files);
    return { verdict: 'pass', text: 'criteria verified', ran: 1 };
  };
  const criteria = ['npm test passes', 'the public API shape is unchanged'];
  const result = await runTask('add a file', {
    bridge, tools, overlay, session, events: new Emitter(),
    check,
    options: {
      maxSteps: 8, allowRun: true, subagent: true,
      acceptanceCriteria: criteria,
    },
    first: true,
  });
  assert.equal(result.stopReason, 'done');
  const stats = statsOf(session);
  assert.deepEqual(stats.acceptanceCriteria, criteria);
  // The checker's brief names the criteria — that is the message the child
  // receives, composed by #makeChecker (harness.mjs), and this stub sees the
  // files argument. Whether the brief carries them is asserted structurally
  // by the audit above (criteria + zero runs downgrades).
});

test('a checker that throws is structural: a none verdict, not a fail', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  const tools = createTools({ root: dir, overlay, allowRun: true });
  const bridge = scriptedLoop(['CREATE b.mjs\nexport const x = 1;\nEND\nDONE staged it\n']);
  let calls = 0;
  const check = async () => { calls += 1; throw new Error('conversation unavailable'); };
  const result = await runTask('add a file', {
    bridge, tools, overlay, session, events: new Emitter(), check,
    options: { maxSteps: 8, allowRun: true, subagent: true }, first: true,
  });
  assert.equal(calls, 1, 'the checker was tried once');
  assert.equal(result.stopReason, 'done', 'a structural failure is not a failed check');
  const stats = statsOf(session);
  assert.equal(stats.checkVerdict, 'none');
  assert.match(String(stats.checkEvidence?.tail ?? ''), /could not run/);
});

test('a missing verdict with staged code is unverified under requireCheck', () => {
  // `checkResult` still null (the checker never ran in this run) and
  // `taskType` still 'none' (only finishCheck sets it): the strict gate
  // classifies the staged files itself instead of passing the DONE.
  const dir = tempDir({});
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'app.mjs'), 'export const x = 1;\n');
  const run = new RunContext('add a file', {
    overlay,
    check: async () => ({ verdict: 'pass', text: 'ok', ran: 1 }),
    options: { requireCheck: true, subagent: true, allowRun: true, verifyCommand: 'node check.mjs' },
  });
  run.codeTouched = true;
  run.checkResult = null;
  run.taskType = 'none';
  assert.equal(createDoneGates(run).unverifiedDone(), 'node check.mjs');
});

test('a missing verdict over docs staging is not unverified', () => {
  const dir = tempDir({});
  const overlay = new Overlay(dir);
  overlay.set(path.join(dir, 'notes.md'), '# notes\n');
  const run = new RunContext('write docs', {
    overlay,
    check: async () => ({ verdict: 'pass', text: 'ok', ran: 1 }),
    options: { requireCheck: true, subagent: true, allowRun: true, verifyCommand: 'node check.mjs' },
  });
  run.codeTouched = true; // artificial: the classifier, not the flag, decides here
  run.checkResult = null;
  run.taskType = 'none';
  assert.equal(createDoneGates(run).unverifiedDone(), null);
});

