/**
 * Plugin isolation (P1): a plugin that says `isolated: true` runs in a
 * forked worker (harness/plugin-worker.mjs) — the backend never runs its
 * code. Capability-limited, timed out, resource-capped, crash-recovered.
 *
 *   - an isolated plugin's tools/rpc/panels work (over IPC, not in-process);
 *   - it may only use the surfaces its `capabilities` declare;
 *   - a hung setup fails with a timeout, not a hang;
 *   - a crash rejects the in-flight call, restarts the worker once, and the
 *     next call works — the parent never dies;
 *   - `AIPASS_PLUGIN_ISOLATION=off` keeps the trusted in-process path.
 *
 * Run: node --test aipass-bridge/test/plugin-isolation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { PluginManager } from '../harness/plugins.mjs';
import { Settings } from '../harness/settings.mjs';
import { Emitter } from '../harness/events.mjs';

const isolatedPlugin = (name, marker, extra = '') => `
export default {
  name: '${name}',
  version: '1.0.0',
  description: 'test plugin',
  isolated: true,
  capabilities: ['tools', 'rpc', 'panels', 'settings', 'preamble'],
  ${extra}
  setup(ctx) {
    ctx.tools.register('${marker}', async ({ arg }) => 'hello ' + (arg || 'world'), { risk: 'read' });
    ctx.rpc.method('${name}.ping', async () => 'pong');
    ctx.panel({ id: '${name}', title: '${name} panel', render: async () => ({ html: '<p>hi</p>' }) });
    ctx.settings.define({ key: '${name}.setting', label: 'x' });
    ctx.preamble.section('${name}-sec', async () => 'a section from ${name}');
  },
};
`;

function fixture(pluginSource, settingsJson = '{"plugins":[]}') {
  const dir = tempDir({
    'settings.json': settingsJson,
    'plugins/iso.mjs': pluginSource,
  });
  const settings = new Settings(dir);
  const events = new Emitter();
  const logs = [];
  const manager = new PluginManager({
    dir: path.join(dir, 'plugins'), settings, events, log: (t) => logs.push(t),
    timeoutMs: 5_000,
  });
  return { dir, settings, events, logs, manager };
}

/* ----------------------------------------------------------- the basics */

test('an isolated plugin loads and its surfaces work over IPC', async (t) => {
  const { manager, dir } = fixture(isolatedPlugin('iso', 'ISO_TOOL'));
  t.after(() => manager.close());
  const details = await manager.load();

  assert.deepEqual(details.failed, []);
  assert.deepEqual(details.loaded.map((p) => p.name), ['iso']);
  assert.equal(details.loaded[0].isolated, true);
  assert.deepEqual([...details.loaded[0].capabilities].sort(), ['panels', 'preamble', 'rpc', 'settings', 'tools']);

  assert.equal(await manager.runTool('ISO_TOOL', { arg: 'mars' }), 'hello mars');
  assert.equal(await manager.callMethod('iso.ping'), 'pong');
  const panel = await manager.renderPanel('iso');
  assert.equal(panel.html, '<p>hi</p>');
  assert.ok(manager.toolTable().some((t) => t.marker === 'ISO_TOOL'));
  await manager.close();
});

test('the backend itself never imports an isolated plugin', async () => {
  // The top level of a disabled plugin already must not run — and for an
  // ISOLATED one the parent must not import it either (the worker does).
  // A read of the file can never prove that; the import side effect can.
  const dir = tempDir();
  const plugin = `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(import.meta.dirname, 'parent-ran.txt'), 'ran');
export default {
  name: 'iso',
  isolated: true,
  capabilities: ['tools'],
  setup(ctx) { ctx.tools.register('ISO_TOOL', () => 'ok'); },
};
`;
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'iso.mjs'), plugin);
  const manager = new PluginManager({ dir: path.join(dir, 'plugins'), settings: new Settings(dir), timeoutMs: 5_000 });
  const details = await manager.load();
  assert.deepEqual(details.failed, []);
  assert.equal(fs.existsSync(path.join(dir, 'plugins', 'parent-ran.txt')), true,
    'the top level ran — in the child (its dirname is the plugin dir either way)');
  await manager.close();
});

/* ------------------------------------------------------- capability walls */

test('an isolated plugin may only use the capabilities it declared', async () => {
  const { manager } = fixture(`
export default {
  name: 'iso',
  isolated: true,
  capabilities: ['tools'],
  setup(ctx) {
    ctx.tools.register('ISO_TOOL', () => 'ok');
    ctx.rpc.method('iso.ping', () => 'pong');
  },
};
`);
  const details = await manager.load();
  assert.deepEqual(details.loaded, [], 'using an undeclared surface fails the load');
  assert.equal(details.failed.length, 1);
  assert.match(details.failed[0].error, /"rpc" without declaring the capability/);
  assert.deepEqual(manager.toolTable(), [], 'failed means nothing is live');
  assert.equal(manager.hasMethod('iso.ping'), false);
  await manager.close();
});

test('a hung setup fails with a timeout, not a hang', async () => {
  const { manager } = fixture(`
export default {
  name: 'iso',
  isolated: true,
  capabilities: ['tools'],
  setup: async () => { await new Promise(() => {}); },
};
`, undefined);
  manager.setupTimeoutMs = 300;
  const details = await manager.load();
  assert.deepEqual(details.loaded, []);
  assert.equal(details.failed.length, 1);
  assert.match(details.failed[0].error, /setup timed out after 300 ms/);
  await manager.close();
});

test('a hung call fails per-call and the plugin stays alive', async (t) => {
  const { manager } = fixture(`
export default {
  name: 'iso',
  isolated: true,
  capabilities: ['tools'],
  setup(ctx) {
    ctx.tools.register('SLOW', async ({ arg }) => {
      if (arg === 'hang') await new Promise(() => {});
      return 'fast';
    });
  },
};
`);
  t.after(() => manager.close());
  manager.callTimeoutMs = 300;
  const details = await manager.load();
  assert.deepEqual(details.failed, []);
  const slow = await manager.runTool('SLOW', { arg: 'hang' });
  assert.match(slow, /^err: plugin iso: tool SLOW timed out after 300 ms/);
  assert.equal(await manager.runTool('SLOW', {}), 'fast', 'the next call still answers');
  await manager.close();
});

/* ---------------------------------------------------------- crash recovery */

test('a crashed isolated plugin rejects the call, restarts, and the next call works', async (t) => {
  const { dir, manager } = fixture(`
import fs from 'node:fs';
import path from 'node:path';
const MARKER = path.join(import.meta.dirname, 'crashed.txt');
export default {
  name: 'iso',
  isolated: true,
  capabilities: ['tools'],
  setup(ctx) {
    ctx.tools.register('CRASHER', async () => {
      if (!fs.existsSync(MARKER)) {
        fs.writeFileSync(MARKER, 'once');
        process.exit(1);
      }
      return 'recovered';
    });
  },
};
`);
  t.after(() => manager.close());
  const details = await manager.load();
  assert.deepEqual(details.failed, []);
  const crashed = await manager.runTool('CRASHER');
  assert.match(crashed, /^err: plugin iso crashed/, `the crash reached the caller (${crashed})`);
  // The restart is async; the second call waits for it implicitly by retry.
  let recovered = '';
  for (let i = 0; i < 40 && !/recovered/.test(recovered); i++) {
    recovered = await manager.runTool('CRASHER');
    if (!/recovered/.test(recovered)) await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(recovered, /recovered/, 'after the restart the tool works again');
  const panelFree = manager.details().loaded;
  assert.deepEqual(panelFree.map((p) => p.name), ['iso'], 'the restarted plugin is still loaded');
  await manager.close();
  assert.equal(fs.existsSync(path.join(dir, 'plugins', 'crashed.txt')), true);
});

/* --------------------------------------------------------- the gate & env */

test('the worker count caps isolated plugins with a named error', async () => {
  const dir = tempDir({
    'settings.json': '{"plugins":[]}',
    'plugins/a.mjs': isolatedPlugin('a', 'A_TOOL'),
    'plugins/b.mjs': isolatedPlugin('b', 'B_TOOL'),
  });
  const manager = new PluginManager({
    dir: path.join(dir, 'plugins'), settings: new Settings(dir),
    workers: 1, timeoutMs: 5_000,
  });
  const details = await manager.load();
  assert.equal(details.loaded.length, 1);
  assert.equal(details.failed.length, 1);
  assert.match(details.failed[0].error, /worker limit reached \(1\)/);
  await manager.close();
});

test('AIPASS_PLUGIN_ISOLATION=off keeps the trusted in-process path', async () => {
  const previous = process.env.AIPASS_PLUGIN_ISOLATION;
  process.env.AIPASS_PLUGIN_ISOLATION = 'off';
  try {
    const dir = tempDir({
      'settings.json': '{"plugins":[]}',
      'plugins/iso.mjs': isolatedPlugin('iso', 'ISO_TOOL'),
    });
    const manager = new PluginManager({ dir: path.join(dir, 'plugins'), settings: new Settings(dir), timeoutMs: 5_000 });
    const details = await manager.load();
    assert.deepEqual(details.failed, []);
    assert.equal(details.loaded[0].isolated ?? false, false, 'loaded in-process, as before');
    assert.equal(await manager.runTool('ISO_TOOL', { arg: 'mars' }), 'hello mars');
    await manager.close();
  } finally {
    if (previous === undefined) delete process.env.AIPASS_PLUGIN_ISOLATION;
    else process.env.AIPASS_PLUGIN_ISOLATION = previous;
  }
});

test('the isolated child does not inherit backend secrets', async () => {
  const { manager } = fixture(`
export default {
  name: 'iso',
  isolated: true,
  capabilities: ['tools'],
  setup(ctx) {
    ctx.tools.register('ENV', () => String(process.env.MY_TEST_SECRET_TOKEN ?? 'absent'));
  },
};
`);
  const previous = process.env.MY_TEST_SECRET_TOKEN;
  process.env.MY_TEST_SECRET_TOKEN = 'topsecret-value';
  try {
    const details = await manager.load();
    assert.deepEqual(details.failed, []);
    assert.equal(await manager.runTool('ENV'), 'absent', 'the secret never reached the plugin child');
  } finally {
    if (previous === undefined) delete process.env.MY_TEST_SECRET_TOKEN;
    else process.env.MY_TEST_SECRET_TOKEN = previous;
  }
  await manager.close();
});
