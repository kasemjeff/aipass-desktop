// @ts-check
// The plugin worker: a plugin's `init` + `setup` in a child process, never the
// backend's (P1 — plugin isolation). The backend (plugins.mjs) forks this file,
// hands it the plugin file and the capabilities the plugin DECLARED, and the
// child does the importing — the parent only ever reads the plugin's source as
// text (its name, its `isolated`/`capabilities` literals) and the worker does
// the running. If the plugin crashes, the child dies, the parent says so, and
// the backend stays up; the parent then restarts the worker once.
//
// Why a child process, not a flag: the sandbox row for plugins (docs/
// FEATURE_GAPS_WAVE3.md 3.1's sibling: plugins trusted-not-sandboxed, Oct
// 2026) kept them in-process because "plugins are code you chose to install".
// That is still the default for a plugin that does not say `isolated: true`
// (trusted, in-process, backward compatible). An isolated plugin runs here:
// its registrations must name a capability it declared, its setup and calls
// time out, and its memory is capped. This is a process boundary, not a
// kernel one — the child runs as the same user, and `fs` stays reachable;
// what it buys is: no crash of the backend, no hung setup, no silent
// surface creep, and no inherited secrets unless the plugin asks for `env`.
//
// This file is both the worker and its own test surface: imported, it
// exports the capability table and the manifest readers; forked, it runs
// one plugin and answers over IPC.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { sanitizeEnv } from './shell-worker.mjs';

/** The surfaces an isolated plugin can declare — the capability vocabulary. */
export const PLUGIN_CAPABILITIES = Object.freeze([
  'tools', 'rpc', 'panels', 'settings', 'preamble', 'events', 'env',
]);

/** What an isolated plugin gets when it declares no `capabilities` at all:
 *  every surface except `env` (the environment is the one that needs an
 *  explicit ask). Tightening is opt-in; isolation is the wall. */
export const DEFAULT_CAPABILITIES = Object.freeze([
  'tools', 'rpc', 'panels', 'settings', 'preamble', 'events',
]);

/**
 * The `capabilities` literal from a plugin's source, read WITHOUT running
 * it (like the name — a name can only be read by running the file, and a
 * disabled plugin must not run). Only string literals inside `[...]`
 * count; a computed list reads as "no declaration". Returns the declared
 * subset of the vocabulary, or null when nothing usable was declared.
 *
 * @param {string} source
 */
export function declaredCapabilities(source) {
  const text = String(source ?? '');
  const read = (/** @type {string} */ key) => {
    const m = new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(text);
    if (!m) return [];
    return [...m[1].matchAll(/(['"`])([A-Za-z0-9_-]+)\1/g)].map((x) => x[2]);
  };
  // `permissions` is the manifest spelling of the same declaration: a
  // plugin that lists what it may use in its manifest (`permissions:
  // ['tools', 'panels']`) declares the same vocabulary as `capabilities`.
  // Both may be present; the union is what the plugin gets.
  const found = [...read('capabilities'), ...read('permissions')];
  if (!found.length) return null;
  const valid = found.filter((c) => PLUGIN_CAPABILITIES.includes(c));
  return valid.length ? [...new Set(valid)] : null;
}

/** The `permissions` manifest declaration, on its own. Same read as
 *  `capabilities`, so a plugin that declares only `permissions` is read
 *  the same way by every surface that knows the vocabulary.
 * @param {string} source
 */
export function declaredPermissions(source) {
  const text = String(source ?? '');
  const m = /\bpermissions\s*:\s*\[([^\]]*)\]/.exec(text);
  if (!m) return null;
  const found = [...m[1].matchAll(/(['"`])([A-Za-z0-9_-]+)\1/g)].map((x) => x[2]);
  if (!found.length) return null;
  const valid = found.filter((c) => PLUGIN_CAPABILITIES.includes(c));
  return valid.length ? [...new Set(valid)] : null;
}

/** Does the plugin's source say `isolated: true`? The one-word opt-in.
 * @param {string} source
 */
export function declaredIsolated(source) {
  return /\bisolated\s*:\s*true\b/.test(String(source ?? ''));
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain && typeof process.send === 'function') {
  const send = (/** @type {any} */ payload) => { try { process.send?.(payload); } catch { /* parent gone */ } };
  // A dead parent takes its plugin workers with it — otherwise an orphaned
  // backend restart leaks plugin processes nobody can reach.
  process.on('disconnect', () => process.exit(0));

  const requireCap = (/** @type {readonly string[]} */ have, /** @type {string} */ need) => {
    if (!have.includes(need)) throw new Error(`plugin used "${need}" without declaring the capability (declared: ${have.length ? have.join(', ') : 'none'})`);
  };

  let capabilities = DEFAULT_CAPABILITIES;
  let envMode = false;
  const tools = new Map();
  const methods = new Map();
  const panels = new Map();
  const settings = [];
  const preamble = new Map();
  const events = new Map();
  const pending = new Map();

  /** The ctx a plugin sees. Settings are a read-only snapshot (an isolated
   *  plugin reads what the harness knows, never writes it: a write would
   *  need the parent's Settings object, and two writers is drift). */
  const snapshotGet = (/** @type {string} */ key, /** @type {any} */ fallback) => (settingsSnapshot[key] ?? fallback);
  /** @type {Record<string, any>} */
  let settingsSnapshot = {};

  const ctx = {
    name: 'plugin',
    settings: {
      get: (/** @type {string} */ key, /** @type {any} */ fallback) => snapshotGet(key, fallback),
      // define arrives as a registration below; a direct `.get` on the real
      // Settings is never exposed — this is the snapshot reader.
      define: (/** @type {any} */ def) => registerSetting(def),
    },
    events: {
      on: (/** @type {string} */ type, /** @type {(payload: any) => any} */ fn) => {
        if (typeof type !== 'string' || typeof fn !== 'function') throw new Error('events.on(type, fn)');
        requireCap(capabilities, 'events');
        const list = events.get(type) ?? [];
        list.push(fn);
        events.set(type, list);
        send({ type: 'subscribe', event: type });
      },
    },
    log: (/** @type {any} */ text) => send({ type: 'log', text: `[${ctx.name}] ${String(text ?? '')}` }),
    rpc: {
      method: (/** @type {string} */ name, /** @type {(args: any) => any} */ fn) => {
        if (typeof name !== 'string' || typeof fn !== 'function') throw new Error('rpc.method(name, fn)');
        requireCap(capabilities, 'rpc');
        if (methods.has(name)) throw new Error(`rpc method "${name}" is already registered`);
        methods.set(name, fn);
        send({ type: 'register', surface: 'rpc', name });
      },
    },
    tools: {
      register: (/** @type {string} */ marker, /** @type {(call: any) => any} */ impl, { takesBody = false, description = '', risk = null } = {}) => {
        if (!/^[A-Z][A-Z0-9_-]*$/.test(marker)) throw new Error(`marker must be UPPER_SNAKE, got ${marker}`);
        if (typeof impl !== 'function') throw new Error('tools.register(marker, fn)');
        requireCap(capabilities, 'tools');
        if (risk != null && !['read', 'write', 'shell'].includes(risk)) {
          throw new Error(`risk must be 'read', 'write', 'shell' or left out, got: ${JSON.stringify(risk)}`);
        }
        tools.set(marker, { impl, takesBody, description, risk });
        send({ type: 'register', surface: 'tool', marker, takesBody, description, risk });
      },
    },
    panel: (/** @type {any} */ def = {}) => {
      if (!def.id || !def.title) throw new Error('panel({id, title, render})');
      requireCap(capabilities, 'panels');
      panels.set(def.id, def);
      send({ type: 'register', surface: 'panel', id: def.id, title: def.title });
    },
    preamble: {
      section: (/** @type {string} */ sectionName, /** @type {() => any} */ fn) => {
        if (typeof sectionName !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(sectionName)) {
          throw new Error(`preamble.section(name, fn): name must be 1-64 chars of letters, digits, dot, dash or underscore, got ${JSON.stringify(sectionName)}`);
        }
        if (typeof fn !== 'function') throw new Error('preamble.section(name, fn) — fn returns the paragraph text');
        requireCap(capabilities, 'preamble');
        if (preamble.has(sectionName)) throw new Error(`preamble section "${sectionName}" is already owned`);
        preamble.set(sectionName, fn);
        send({ type: 'register', surface: 'preamble', name: sectionName });
      },
    },
  };

  function registerSetting(/** @type {any} */ def = {}) {
    if (!def.key) throw new Error('settings.define({key, …})');
    requireCap(capabilities, 'settings');
    settings.push({ ...def });
    send({ type: 'register', surface: 'setting', setting: def });
  }

  const runHandler = async (/** @type {string} */ kind, /** @type {string} */ name, /** @type {any} */ args) => {
    if (kind === 'tool') {
      const def = tools.get(name);
      if (!def) return { ok: false, error: `no such plugin tool: ${name}` };
      return { ok: true, value: await def.impl({ arg: args?.arg ?? '', body: args?.body ?? '' }) };
    }
    if (kind === 'method') {
      const fn = methods.get(name);
      if (!fn) return { ok: false, error: `no plugin provides ${name}` };
      return { ok: true, value: await fn(args ?? {}) };
    }
    if (kind === 'panel') {
      const def = panels.get(name);
      if (!def) return { ok: false, error: `no panel ${name}` };
      return { ok: true, value: await def.render() };
    }
    if (kind === 'preamble') {
      const fn = preamble.get(name);
      if (!fn) return { ok: false, error: `no preamble section ${name}` };
      return { ok: true, value: await fn() };
    }
    return { ok: false, error: `unknown call kind: ${kind}` };
  };

  const init = async (/** @type {any} */ msg) => {
    capabilities = Array.isArray(msg.capabilities) && msg.capabilities.length
      ? msg.capabilities.filter((/** @type {string} */ c) => PLUGIN_CAPABILITIES.includes(c))
      : [...DEFAULT_CAPABILITIES];
    // `settingsSnapshot`: what the harness says today, read-only. A plugin
    // that needs to WRITE a setting must expose an RPC method that does it
    // through the backend's own path — never a shared Settings object.
    settingsSnapshot = msg.settingsSnapshot && typeof msg.settingsSnapshot === 'object' ? msg.settingsSnapshot : {};
    // The environment: sanitized allowlist by default; `env` widens it to
    // the parent's, still minus secret-named variables (defence in depth —
    // a plugin that wants secrets wants them by name, not by silence).
    if (capabilities.includes('env')) {
      const { isSecretName } = await import('./output-scrub.mjs');
      /** @type {Record<string, string>} */
      const env = {};
      for (const [k, v] of Object.entries(msg.parentEnv ?? {})) {
        if (isSecretName(k)) continue;
        env[k] = String(v ?? '');
      }
      for (const [k, v] of Object.entries(env)) process.env[k] = v;
      void sanitizeEnv();
    } else {
      const clean = sanitizeEnv(msg.parentEnv ?? {});
      for (const k of Object.keys(process.env)) {
        if (!(k in clean)) delete process.env[k];
      }
      Object.assign(process.env, clean);
    }
    try {
      const mod = await import(`${pathToFileURL(msg.file).href}?t=${Date.now()}-${msg.id ?? ''}`);
      const plugin = mod.default ?? mod;
      if (typeof plugin?.setup !== 'function') throw new Error('no default export with a setup(ctx) function');
      ctx.name = plugin.name ?? path.basename(msg.file);
      const api = plugin.apiVersion ?? null;
      if (api !== null && (!Number.isInteger(api) || api < 1 || api > 1)) {
        throw new Error(`plugin apiVersion ${api} needs a newer harness (this build speaks 1)`);
      }
      await plugin.setup(ctx);
      send({
        type: 'ready',
        name: ctx.name,
        version: plugin.version ?? '0.0.0',
        description: plugin.description ?? '',
        apiVersion: api,
        capabilities,
        isolated: plugin.isolated === true || msg.forced === true,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      send({ type: 'setup-error', error: String(e?.message ?? e) });
      process.exitCode = 1;
      // The parent decides: failed plugins do not linger. Give it a beat to
      // read the error, then go.
      setTimeout(() => process.exit(1), 50).unref?.();
    }
  };

  process.on('message', (/** @type {any} */ msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') void init(msg);
    else if (msg.type === 'call') {
      pending.set(msg.id, msg);
      void (async () => {
        try {
          const out = await runHandler(msg.kind, msg.name, msg.args);
          send({ type: 'result', id: msg.id, ok: out.ok, value: out.ok ? (out.value ?? null) : null, error: out.ok ? null : out.error });
        } catch (err) {
          const e = /** @type {any} */ (err);
          send({ type: 'result', id: msg.id, ok: false, error: String(e?.message ?? e) });
        } finally {
          pending.delete(msg.id);
        }
      })();
    } else if (msg.type === 'fire') {
      const list = events.get(msg.event) ?? [];
      void (async () => {
        for (const fn of list) {
          try { await fn(msg.payload ?? {}); }
          catch (err) {
            const e = /** @type {any} */ (err);
            send({ type: 'handler-error', event: msg.event, error: String(e?.message ?? e) });
          }
        }
      })();
    } else if (msg.type === 'stop') {
      process.exit(0);
    }
  });
}
