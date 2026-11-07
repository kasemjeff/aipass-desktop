// The coverage floors for the backend modules that fell just under:
// run/options (branch clamps), rpc/core (pair.code + schedule errors),
// rpc/files (shell.reveal + extension.install + skills/symbols errors).
// Each test pins a real branch, not a line just to move a number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { normalizeOptions } from '../harness/run/options.mjs';
import { createCoreMethods } from '../harness/rpc/core.mjs';
import { createFilesMethods } from '../harness/rpc/files.mjs';
import { Overlay } from '../harness/overlay.mjs';

// The suite home is shared by every file under the coverage gate: a schedule
// entry written here is due work for the NEXT file's server, and it spawns
// a job for a root that no longer exists. This file's schedule entry lives
// in its own scratch home, like the window boots do.
process.env.AIPASS_HOME = fs.mkdtempSync(path.join(tmpdir(), 'aipass-cov-'));

test('normalizeOptions: every clamp branch', () => {
  // maxSteps: negative, NaN, Infinity string
  assert.equal(normalizeOptions({ maxSteps: -5 }).maxSteps, Infinity);
  assert.equal(normalizeOptions({ maxSteps: 'abc' }).maxSteps, Infinity);
  assert.equal(normalizeOptions({ maxSteps: 2.9 }).maxSteps, 2);
  // maxToolCalls / maxWallClockMs fall back on 0 / negative / NaN
  const d = normalizeOptions({ maxToolCalls: 0, maxWallClockMs: -1 });
  assert.ok(d.maxToolCalls > 0 && d.maxWallClockMs > 0);
  // maxCredits: negative -> 0, positive kept
  assert.equal(normalizeOptions({ maxCredits: -3 }).maxCredits, 0);
  assert.equal(normalizeOptions({ maxCredits: 1.5 }).maxCredits, 1.5);
  // thinking: 'off' in any case -> null, other upper -> lower
  assert.equal(normalizeOptions({ thinking: 'OFF' }).thinking, null);
  assert.equal(normalizeOptions({ thinking: 'off' }).thinking, null);
  assert.equal(normalizeOptions({ thinking: 'Low' }).thinking, 'low');
  assert.equal(normalizeOptions({ thinking: 123 }).thinking, '123');
  // temperature: below 0 clamps to 0, NaN -> null, Infinity -> null
  assert.equal(normalizeOptions({ temperature: -1 }).temperature, 0);
  assert.equal(normalizeOptions({ temperature: NaN }).temperature, null);
  assert.equal(normalizeOptions({ temperature: Infinity }).temperature, null);
  assert.equal(normalizeOptions({ temperature: 0.5 }).temperature, 0.5);
  // replyLanguage: only 'en' is en
  assert.equal(normalizeOptions({ replyLanguage: 'en' }).replyLanguage, 'en');
  assert.equal(normalizeOptions({ replyLanguage: 'EN' }).replyLanguage, 'th');
  assert.equal(normalizeOptions({ replyLanguage: 'fr' }).replyLanguage, 'th');
  // minThaiRatio: below 0 -> 0, NaN -> 0.4
  assert.equal(normalizeOptions({ minThaiRatio: -0.5 }).minThaiRatio, 0);
  assert.equal(normalizeOptions({ minThaiRatio: 'abc' }).minThaiRatio, 0.4);
  assert.equal(normalizeOptions({ minThaiRatio: 0.2 }).minThaiRatio, 0.2);
  // repeatGuardMax: 0 -> 4
  assert.equal(normalizeOptions({ repeatGuardMax: 0 }).repeatGuardMax, 4);
  assert.equal(normalizeOptions({ repeatGuardMax: 3 }).repeatGuardMax, 3);
  // pluginSections non-array -> [], helperPresets null -> {}
  assert.deepEqual(normalizeOptions({ pluginSections: 'x' }).pluginSections, []);
  assert.deepEqual(normalizeOptions({ pluginSections: ['a'] }).pluginSections, ['a']);
  assert.deepEqual(normalizeOptions({ helperPresets: null }).helperPresets, {});
  assert.deepEqual(normalizeOptions({ helperPresets: { x: 1 } }).helperPresets, { x: 1 });
  // model / seedText null defaults, slim truthy
  assert.equal(normalizeOptions({}).model, null);
  assert.equal(normalizeOptions({ model: 'm' }).model, 'm');
  assert.equal(normalizeOptions({ slim: 0 }).useSlim, false);
});

function fakeHarness(root) {
  const overlay = new Overlay(root);
  return {
    root,
    overlay,
    running: false,
    options: { mode: 'ask', allowRun: false, maxSteps: 0, plan: false, subagent: false },
    bridge: {
      model: 'm1',
      async status() { return { ok: true, extensions: 1, defaultModel: 'm1' }; },
      async models() { return { data: [] }; },
      async quota() { return { available: 1 }; },
    },
    providerId: 'aipass',
    session: null,
    skills: { list: () => [], index: () => ({}), load: () => ({}) },
    pendingChanges: () => [],
    pendingAsks: () => ({}),
    contextUsage: () => ({}),
  };
}

function fakeCtx(root) {
  const h = fakeHarness(root);
  const ctx = {
    appSettings: { projectList: () => [{ path: root, current: true }], values: {} },
    plugins: {},
    harnesses: new Map([[path.resolve(root), h]]),
    staged: new Map(),
    targetFor: () => h,
    decoratedPlugins: () => [],
    root,
    model: 'm1',
    bridgeURL: 'http://127.0.0.1:1',
    APP_ROOT: path.resolve('aipass-bridge/..'),
    current: h,
    methods: {},
  };
  ctx.methods = createCoreMethods(ctx);
  return { ctx, h, methods: ctx.methods };
}

test('rpc/core: pair.code failure paths and schedule.remove guard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-cov-core-'));
  const { methods } = fakeCtx(dir);
  // bridge unreachable -> ok:false with reason, not a throw
  const res = await methods['pair.code']();
  assert.equal(res.ok, false);
  assert.ok(res.reason);
  // schedule.remove without id throws the house sentence
  await assert.rejects(() => methods['schedule.remove']({}), /no schedule entry given/);
  // schedule.add with explicit project root
  const added = await methods['schedule.add']({ task: 't', project: dir, at: '09:00' });
  assert.ok(added);
  // models/credits delegate to the harness bridge
  assert.deepEqual(await methods.models({}), { data: [] });
  assert.deepEqual(await methods.credits({}), { available: 1 });
  // snapshot reuses status
  const snap = await methods.snapshot({});
  assert.ok(snap.status && Array.isArray(snap.entries));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpc/files: shell.reveal guard, extension.install, skills/symbols errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-cov-files-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  const h = fakeHarness(dir);
  const ctx = {
    appSettings: { get: () => 'https://de.aipass.net/chat' },
    staged: new Map(),
    targetFor: () => h,
    stageAttachment: async () => ({ ok: true }),
    dropAttachment: () => {},
    fileIndex: async () => [],
    dropIndex: () => {},
    root: dir,
    model: 'm1',
  };
  const m = createFilesMethods(ctx);
  // shell.reveal without path
  assert.deepEqual(await m['shell.reveal']({}), { ok: false, reason: 'no path' });
  assert.deepEqual(await m['shell.reveal']({ path: 123 }), { ok: false, reason: 'no path' });
  // extension.install returns url even when browser open fails (no Chrome)
  const inst = await m['extension.install']();
  assert.equal(inst.ok, true);
  assert.match(inst.url, /github\.com/);
  // checkpoints guards
  await assert.rejects(() => m['checkpoints.restore']({}), /which checkpoint/);
  await assert.rejects(() => m['checkpoints.remove']({}), /which checkpoint/);
  // symbols guards
  await assert.rejects(() => m['symbols.list']({}), /which file/);
  await assert.rejects(() => m['symbols.def']({}), /which name/);
  await assert.rejects(() => m['symbols.refs']({}), /which name/);
  // skills.load error surfaces
  h.skills.load = () => ({ error: 'no such skill' });
  await assert.rejects(() => m['skills.load']({ name: 'x' }), /no such skill/);
  // fs guards
  await assert.rejects(() => m['fs.list']({ dir: '../outside' }), /outside project root/);
  assert.deepEqual(await m['fs.search']({ query: '' }), []);
  assert.deepEqual(await m['fs.grep']({ query: '' }), []);
  await assert.rejects(() => m['fs.read']({ file: '../outside' }), /outside project root/);
  await assert.rejects(() => m['fs.read']({ file: 'nope.txt' }), /no such file/);
  // retrieval + attachment passthroughs
  assert.equal((await m['retrieval.clear']({})).cleared, true);
  assert.ok(await m['retrieval.status']({}));
  assert.deepEqual(await m['attachment.list'](), []);
  assert.deepEqual(await m['attachment.remove']({ id: 'x' }), { ok: true });
  assert.deepEqual(await m['attachment.stage']({}), { ok: true });
  // fs.list on a real dir returns entries with size/mtime for files
  const list = await m['fs.list']({ dir: '.' });
  assert.ok(list.some((e) => e.name === 'a.txt' && typeof e.size === 'number'));
  const read = await m['fs.read']({ file: 'a.txt' });
  assert.match(read.text, /hello/);
  fs.rmSync(dir, { recursive: true, force: true });
});
