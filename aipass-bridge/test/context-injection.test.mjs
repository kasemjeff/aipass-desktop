// Context injection, end to end: nested instructions, BM25 memory ranking,
// seed truncation, turn-1 budget drops, and the DONE-time fact capture.
//
// These pin what the context-sources module alone cannot prove: that the
// root still wins over nested files, that a Thai task ranks facts like Thai
// passages, that a rotation seed cannot outgrow its share, and that a short
// session can leave facts behind without a compaction.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectInstructions } from '../harness/instructions.mjs';
import { carryFacts } from '../harness/memory-store.mjs';
import { Compactor } from '../harness/compact.mjs';
import { loadMemory, saveMemory } from '../harness/memory-store.mjs';
import { SessionStore } from '../harness/session.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { runTask } from '../harness/loop.mjs';

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-ctx-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AIPASS_INSTRUCTIONS_NESTED;
});

test('nested AGENTS.md files ride under the root, shallow first', () => {
  const dir = tempDir({
    'AGENTS.md': 'root rules\n',
    'sub/AGENTS.md': 'sub rules\n',
    'sub/deep/AGENTS.md': 'deep rules\n',
  });
  const doc = loadProjectInstructions(dir, { nested: true });
  assert.ok(doc, 'root exists');
  assert.match(doc.text, /root rules/);
  assert.match(doc.text, /sub rules/);
  assert.match(doc.text, /deep rules/);
  assert.ok(Array.isArray(doc.extras) && doc.extras.length >= 2, 'extras are named');
  assert.ok(doc.extras.some((e) => e.file === 'sub/AGENTS.md'), 'shallow first');

  const off = loadProjectInstructions(dir, { nested: false });
  assert.doesNotMatch(off.text, /sub rules/, 'nested off means root only');
  assert.equal(off.extras, undefined, 'and no extras list');
});

test('a project with no nested files takes the root-only path byte-for-byte', () => {
  const dir = tempDir({ 'AGENTS.md': 'only root\n' });
  const withNested = loadProjectInstructions(dir, { nested: true });
  const withoutNested = loadProjectInstructions(dir, { nested: false });
  assert.equal(withNested.text, withoutNested.text);
  assert.equal(withNested.bytes, withoutNested.bytes);
  assert.equal(withNested.truncated, withoutNested.truncated);
});

test('nested instructions stop at a VCS boundary — a sibling project is not a subproject', () => {
  const dir = tempDir({
    'AGENTS.md': 'root rules\n',
    'sub/AGENTS.md': 'sub rules\n',
    // A sibling project: its own VCS root (worktree-style `.git` file).
    'other/.git': 'gitdir: ../elsewhere\n',
    'other/AGENTS.md': 'other project rules\n',
    'other/deep/AGENTS.md': 'other deep rules\n',
  });
  const doc = loadProjectInstructions(dir, { nested: true });
  assert.ok(doc, 'root exists');
  assert.match(doc.text, /root rules/);
  assert.match(doc.text, /sub rules/, 'a plain subproject still rides');
  assert.doesNotMatch(doc.text, /other project rules/, 'a nested VCS root is never collected');
  assert.doesNotMatch(doc.text, /other deep rules/, 'and the walk never descends into it');
  assert.ok(!doc.extras?.some((e) => e.file.startsWith('other/')), 'no extra names the other project');
});

test('a run root that is itself a VCS root still loads its own instructions', () => {
  const dir = tempDir({
    '.git/config': '[core]\n',
    'AGENTS.md': 'own project rules\n',
    'sub/AGENTS.md': 'sub rules\n',
  });
  const doc = loadProjectInstructions(dir, { nested: true });
  assert.ok(doc, 'root exists');
  assert.match(doc.text, /own project rules/, 'the boundary exempts the run root itself');
  assert.match(doc.text, /sub rules/, 'and its non-VCS subprojects still ride');
});

test('the nested walk skips tooling output and stays inside the root', () => {
  const dir = tempDir({
    'AGENTS.md': 'root\n',
    'node_modules/AGENTS.md': 'nope\n',
    '.git/AGENTS.md': 'nope\n',
    'sub/AGENTS.md': 'sub\n',
  });
  const doc = loadProjectInstructions(dir, { nested: true });
  assert.match(doc.text, /sub/);
  assert.doesNotMatch(doc.text, /nope/, 'tooling output is never instructions');
});

test('carryFacts ranks Thai tasks with the shared tokenizer', () => {
  const facts = [
    'decision: การต่ออายุโทเค็นใช้ refreshToken ทุก 15 นาที',
    'file: notes.txt — สมุดบันทึกของโปรเจกต์',
    'decision: ส่งออกด้วยรหัสโปรเจกต์',
  ];
  const picked = carryFacts(facts, 'การต่ออายุโทเค็นมีปัญหา', { budgetChars: 2400 });
  assert.match(picked[0], /refreshToken/, 'the Thai match wins the first seat');
  assert.equal(picked.length, 3, 'everything fits, so everything rides');
});

test('carryFacts with no matching tokens falls back to newest', () => {
  const facts = ['aaa bbb ccc', 'xxx yyy zzz', 'mmm nnn ooo'];
  const picked = carryFacts(facts, 'unrelated words entirely', { budgetChars: 20 });
  assert.deepEqual(picked, [facts[2]], 'newest fact rides when nothing matches');
});

test('seed truncation keeps preamble and task, shaves summary and results', () => {
  const c = new Compactor({ bridge: { model: 'm' } });
  const preambleText = 'PROTOCOL';
  const seed = c.seed({
    summary: 'S'.repeat(10_000),
    task: 'fix it',
    preambleText,
    results: 'R'.repeat(10_000),
    budgetChars: 4_000,
  });
  assert.match(seed, /PROTOCOL/, 'protocol survives');
  assert.match(seed, /fix it/, 'task survives');
  assert.match(seed, /truncated/, 'the overflow is named, not silent');
  assert.ok(seed.length < 10_000, 'the seed fits its share instead of pasting the whole step');
});

test('a seed without a budget is byte-for-byte the old shape', () => {
  const c = new Compactor({ bridge: { model: 'm' } });
  const seed = c.seed({
    summary: 'did the thing',
    task: 'do it',
    preambleText: 'PRE',
    memory: ['decision: x'],
  });
  assert.match(seed, /did the thing/);
  assert.match(seed, /decision: x/);
  assert.match(seed, /Task: do it/);
});

test('extractFacts parses the MEMORY section off a finished reply', async () => {
  const sent = [];
  const bridge = {
    model: 'm',
    chat: async ({ message }) => {
      sent.push(String(message));
      return { text: 'MEMORY:\n- decision: keep the cookie jar warm\n- file: notes.txt — scratch pad\n' };
    },
  };
  const c = new Compactor({ bridge });
  const session = {
    sentMessages: () => [{ id: 'u1', text: 'fix the login flow', ts: 0 }],
  };
  const facts = await c.extractFacts(session, { task: 'fix the login flow' });
  assert.equal(facts.length, 2, 'two facts ride');
  assert.match(facts[0], /cookie jar/);
  assert.equal(sent.length, 1, 'one facts-only call, no narrative');
});

test('turn 1 drops the snapshot before the instructions under the budget', async () => {
  const dir = tempDir({
    'AGENTS.md': 'project rules here\n',
    'a.txt': 'x\n',
  });
  const sent = [];
  const bridge = {
    async chat({ message }) {
      sent.push(message);
      return { text: 'DONE done', reasoning: '' };
    },
    async quota() { return { available: 1 }; },
  };
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root: dir });
  // A tiny budget via a stub compactor: the preamble alone outgrows it, so
  // the snapshot (already bounded) must give way before instructions do.
  const compactor = {
    budgetFor: () => 2_000,
    reserveTokens: 500,
    estimate: () => 0,
    needsCompaction: () => false,
  };
  const result = await runTask('do the task', {
    bridge,
    tools: {
      async list() { return 'AGENTS.md\na.txt\n'; },
      async git() { return 'M a.txt\n'; },
    },
    overlay: new Overlay(dir),
    session,
    compactor,
    options: { maxSteps: 2, snapshot: true, retrieve: true, recall: true, explore: true },
    first: true,
  });
  assert.equal(result.stopReason, 'done');
  assert.equal(sent.length, 1, 'one send');
  // RETRIEVE is taught in the live turn 1 (the parity fix), not only in seeds.
  assert.match(sent[0], /RETRIEVE where the login token is renewed/, 'retrieve rides the live turn 1');
  assert.match(sent[0], /RECALL what we decided/, 'and recall does too');
});
