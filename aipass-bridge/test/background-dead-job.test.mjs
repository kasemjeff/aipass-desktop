// A job that dies is a result, not a silence.
//
// Only a `done` helper ever rode the next turn: a background helper that
// threw and a background command that exited non-zero left no trace the model
// could read, so the run could say DONE over a failed build without knowing.
// The dying helper's `subagent_end` also carried no `id`, so the window
// painted a second, finished row and left the first one "running" forever.
// These tests pin the death paths: the next turn carries the failure, the end
// frame carries the id and the error, and the run-end sweep reports a helper
// that failed on its last step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { createTools } from '../harness/tools.mjs';
import { Emitter } from '../harness/events.mjs';
import { runTask } from '../harness/loop.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toolsAt = (dir, overlay) => createTools({
  root: dir, overlay, skills: new SkillLibrary([]), allowRun: true, maxResult: 6000,
});

// A scripted bridge. `waitFor` gives a background child time to die before
// the model goes on: the scripted bridge has no round-trip, so a delay on
// the clock flaps on a loaded machine. The reply pauses until the child's
// own death marker exists instead — the wait is about the child, not the
// clock, so a slow machine only makes the test slower, never wrong.
function scripted(replies, sent, waitFor = null) {
  let turn = 0;
  return {
    async chat({ message }) {
      sent.push(message);
      const reply = replies[Math.min(turn++, replies.length - 1)];
      if (waitFor && waitFor.match.test(reply)) {
        for (let i = 0; i < 100 && !fs.existsSync(waitFor.file); i++) await sleep(50);
        // The marker lands while the child is still leaving: give the
        // `close` event its moment, so the next step reads a settled job,
        // not one that is still marked running.
        await sleep(500);
      }
      return { text: reply, reasoning: '' };
    },
    async quota() { return { available: 10 }; },
  };
}

test('a background helper that throws rides the next turn as a failure', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  const events = new Emitter();
  const ends = [];
  events.on('subagent_end', (p) => ends.push(p));
  const sent = [];
  const replies = ['SUBAGENT\nbackground: true\ntask: read a.txt\nEND\n', 'DONE handled\n'];

  const result = await runTask('read the file in the background', {
    bridge: scripted(replies, sent),
    tools, overlay, events,
    subagent: async () => { throw new Error('helper blew up'); },
    options: { maxSteps: 3, subagent: true }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  // The death itself was reported, not just the fact of a failure: the model
  // reads the error that killed the helper.
  assert.ok(sent.length >= 2, 'the run sent a second turn');
  assert.match(sent[1], /Background helper bg1 failed/, 'the next turn carries the failure');
  assert.match(sent[1], /helper blew up/, 'and names what killed it');
  // The end frame closes the row the start opened: same id, and the error.
  assert.equal(ends.length, 1, 'the end frame arrived');
  assert.equal(ends[0].id, 'bg1', 'the end frame carries the start frame\'s id');
  assert.equal(ends[0].error, 'helper blew up', 'and it carries the error');
});

test('a background command that exits non-zero rides the next turn as a failure', async () => {
  // The failing command writes its own death marker right before exiting:
  // the scripted bridge waits for the marker, so the wait is about the
  // child, not a clock that a busy machine can outrun.
  const dir = tempDir({
    'fail.mjs': "import fs from 'node:fs';\nfs.writeFileSync('died.txt', 'x');\nprocess.exit(1);\n",
  });
  const overlay = new Overlay(dir);
  const events = new Emitter();
  const rows = [];
  events.on('tool', (p) => rows.push(p));
  const sent = [];
  // The JOBS poll is the pause: the injection is read at the step start, so
  // the death must have landed before the turn that carries it.
  const replies = ['RUN background\nnode fail.mjs\nEND\n', 'JOBS\n', 'DONE handled\n'];

  const result = await runTask('run the failing build in the background', {
    bridge: scripted(replies, sent, { match: /JOBS/, file: path.join(dir, 'died.txt') }),
    tools: toolsAt(dir, overlay),
    overlay, events,
    options: { maxSteps: 4, allowRun: true }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  assert.ok(sent.length >= 3, 'the run sent a third turn');
  // The death rides as what it is: a command, its exit, and where its output
  // is — never an empty "helper" line claiming a summary was there. It is
  // carried by the turn after the poll, the first one that sees it dead.
  const carried = sent.slice(2).join('\n');
  assert.match(carried, /Background command run1 failed/, 'the next turn carries the failure');
  assert.match(carried, /exit 1/, 'and says how it died');
  assert.match(carried, /\.aipass\/spill\/run1\.txt/, 'and points at the output file');
  assert.ok(!/Background helper run1/.test(carried), 'a command is not mislabeled a helper');
  const polled = rows.find((p) => p.kind === 'jobs');
  assert.ok(polled, 'JOBS was a call of its own');
});

test('a background helper that fails on the final step is reported after the run', async () => {
  const dir = tempDir({ 'a.txt': 'hello\n' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay });
  const events = new Emitter();
  const notes = [];
  events.on('note', (p) => notes.push(p?.text ?? p?.message ?? ''));
  const sent = [];
  const replies = ['SUBAGENT\nbackground: true\ntask: read a.txt\nEND\n', 'DONE now\n'];

  const result = await runTask('read the file in the background, then finish', {
    bridge: scripted(replies, sent),
    tools, overlay, events,
    // The helper settles only after the run has already ended, so the
    // run-end sweep has to say, once, that the model never saw the death.
    subagent: async () => { await sleep(400); throw new Error('late failure'); },
    options: { maxSteps: 3, subagent: true }, first: true,
  });

  assert.equal(result.stopReason, 'done');
  for (let i = 0; i < 40 && !notes.some((n) => /failed \(error\) after the run ended/.test(n)); i++) {
    await sleep(50);
  }
  assert.ok(
    notes.some((n) => /failed \(error\) after the run ended/.test(n)),
    `the post-run note says the helper failed and the model never saw it:\n${JSON.stringify(notes)}`,
  );
});
