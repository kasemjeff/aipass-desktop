// @ts-nocheck
// Plugins — the seam between the harness and whatever it cannot anticipate.
//
// A plugin is one .mjs file in `~/.aipass/plugins` (or a folder with a
// plugin.mjs) that default-exports `{ name, version, setup(ctx) }`. Through
// `ctx` it can:
//
//   rpc.method(name, fn)      answer a new /rpc method — the window calls it
//   tools.register(marker, …) teach the model a new marker, e.g. `NOTE …`
//                             ({risk: 'read'|'write'|'shell'} says what the
//                             marker does, and the marker then rides the same
//                             permission gate a built-in of that kind rides.
//                             Without a declaration it is classified like a
//                             write: a plugin's code runs in this process
//                             with the harness's access, so silence is not a
//                             declaration of trust)
//   panel({id, title, render}) add a section to the window's sidebar
//   settings.define({key, …}) add a setting the window renders for you
//   events.on(type, fn)       watch a run as it happens — every type the
//                             harness emits is named in docs/EVENTS.md, and
//                             test/event-map.test.mjs holds the two equal
//   preamble.section(name, fn) add your own paragraph to the run's first
//                             message — the fn returns the text, fresh per
//                             run, and an empty or failing one is dropped
//
// Everything runs in this process, with the same access the harness has —
// including the filesystem. That is the deal: plugins are code you chose to
// install, not sandboxed. Load only what you have read.
//
// Compatibility: the ctx surface above is `PLUGIN_API` 1. Within one major
// the harness only ever grows ctx — new helpers, never new required fields —
// and a plugin marker can never shadow a built-in one. A plugin may declare
// `apiVersion`; one that needs a newer harness than this build is refused at
// load before setup() runs, and one that declares nothing loads as
// `apiVersion: null` (read: 1). `details()` carries whichever it was.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { aipassHome } from './settings.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PLUGIN_CAPABILITIES, DEFAULT_CAPABILITIES, declaredCapabilities, declaredIsolated } from './plugin-worker.mjs';

export const PLUGIN_API = 1;

/** The forked plugin host (plugin-worker.mjs). */
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugin-worker.mjs');

const positiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const isolationMode = () => {
  const raw = String(process.env.AIPASS_PLUGIN_ISOLATION ?? 'declared').trim().toLowerCase();
  return raw === 'off' || raw === 'all' ? raw : 'declared';
};
const setupTimeoutMs = () => positiveInt(process.env.AIPASS_PLUGIN_TIMEOUT_MS, 30_000);
const callTimeoutMs = () => positiveInt(process.env.AIPASS_PLUGIN_CALL_TIMEOUT_MS, 30_000);
const maxWorkers = () => positiveInt(process.env.AIPASS_PLUGIN_WORKERS, 8);
const memoryMb = () => positiveInt(process.env.AIPASS_PLUGIN_MEMORY_MB, 512);

/**
 * The name a plugin declares, read from its TEXT and never from its code.
 *
 * The enabled-list is a list of names, and a name can only be read by running
 * the file — which is the one thing a disabled plugin must not do. So the name
 * is taken from the source as written: a literal in the object the plugin
 * exports. A name that is computed at runtime cannot be read this way, and
 * such a file then answers to the name it is filed under.
 */
const DECLARED_NAME = /\bname\s*:\s*(['"`])([^'"`\r\n]{1,64})\1/;

function declaredName(source) {
  const text = String(source ?? '');
  // The export is where the plugin's own object lives; a `name:` before it
  // belongs to something else (an import, a helper), so the search starts
  // there when there is an export to start from.
  const at = text.indexOf('export default');
  const tail = at >= 0 ? text.slice(at) : text;
  const hit = DECLARED_NAME.exec(tail) ?? DECLARED_NAME.exec(text);
  const name = String(hit?.[2] ?? '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : '';
}

/** The name a plugin file is filed under: its own name, or the folder a
 *  folder plugin lives in — that is how aipass installs one. */
function filedName(file) {
  const base = path.basename(file);
  if (base.toLowerCase() === 'plugin.mjs') {
    const folder = path.basename(path.dirname(file));
    return folder && folder !== '.' ? folder : '';
  }
  return base.replace(/\.mjs$/i, '');
}

export class PluginManager {
  /** The cache-buster's counter — every import gets its own module URL. */
  #imports = 0;

  constructor({ dir = path.join(aipassHome(), 'plugins'), settings = null, events = null, log = () => {},
    isolation = null, timeoutMs = null, workers = null, memory = null } = {}) {
    this.dir = dir;
    this.settings = settings;
    this.events = events;
    this.log = log;
    /* Isolation policy overrides (tests and the window). The env stays the
     * default; an explicit argument wins over it. */
    this.isolation = isolation ?? isolationMode();
    this.setupTimeoutMs = timeoutMs ?? setupTimeoutMs();
    this.callTimeoutMs = callTimeoutMs();
    this.maxWorkers = workers ?? maxWorkers();
    this.memoryMb = memory ?? memoryMb();
    this.loaded = [];        // [{name, version, description, file}]
    this.failed = [];        // [{file, error}]
    this._methods = new Map();
    this._panels = [];
    this._tools = new Map(); // marker → {impl, takesBody, description, plugin, risk}
    this._settingDefs = [];
    this._preamble = new Map(); // name → {fn, plugin}
    /** name → isolated host { child, pending, attempts, capabilities, subscriptions } */
    this._hosts = new Map();
    this._callSeq = 0;
  }

  get defaultDir() { return this.dir; }

  /** Every plugin file in the directory: *.mjs and <folder>/plugin.mjs. */
  discover() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      // Dot-entries are the installer's working areas — .staging (a copy being
      // validated), .trash (what a replace moved aside), .registry.json. None
      // is a candidate, by name, not by accident of depth.
      if (entry.name.startsWith('.')) continue;
      const full = path.join(this.dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
      else if (entry.isDirectory()) {
        const nested = path.join(full, 'plugin.mjs');
        if (fs.existsSync(nested)) out.push(nested);
      }
    }
    return out.sort();
  }

  /** Name filter: an empty list in settings means "everything found". */
  #wantedName(name) {
    const list = this.settings?.get('plugins') ?? [];
    return !Array.isArray(list) || list.length === 0 || list.includes(name);
  }

  /**
   * The names a plugin file answers to, read WITHOUT running it.
   *
   * The declared name comes first: it is the name the settings list holds,
   * and reading it from the source as text is the only way to know it before
   * the file runs. A file whose name is computed at runtime cannot be read
   * that way, and answers to the name it is filed under instead — which is
   * how aipass installs a plugin (the folder or the file carries the name).
   */
  #namesOf(file, source) {
    const declared = declaredName(source);
    const filed = filedName(file);
    return {
      name: declared || filed,
      label: declared || filed || path.basename(file),
    };
  }

  /** The five registration tables, copied for a rollback. */
  #snapshot() {
    return {
      methods: new Map(this._methods),
      tools: new Map(this._tools),
      panels: [...this._panels],
      settingDefs: [...this._settingDefs],
      preamble: new Map(this._preamble),
    };
  }

  /** Put the tables back exactly as the snapshot found them. */
  #rollback(tables) {
    this._methods = tables.methods;
    this._tools = tables.tools;
    this._panels = tables.panels;
    this._settingDefs = tables.settingDefs;
    this._preamble = tables.preamble;
  }

  /** Stop every isolated plugin worker (reloads stop them first, so a
   *  stale child never answers for a table that was rebuilt without it). */
  async close() {
    const hosts = [...this._hosts.values()];
    this._hosts.clear();
    for (const host of hosts) {
      for (const sub of host.subscriptions.values()) { try { sub.off?.(); } catch { /* best effort */ } }
      host.subscriptions.clear();
      host.stopped = true;
      for (const pending of host.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`plugin ${host.name} was stopped (reload)`));
      }
      host.pending.clear();
      await this.#stopChild(host.child);
    }
  }

  async load() {
    // A reload is a fresh world: workers from the last world cannot answer
    // anything the new one registered, so they stop here. Their tables drop
    // away with the rebuild below.
    await this.close();
    this.loaded = [];
    this.failed = [];
    this._methods.clear();
    this._panels = [];
    this._tools.clear();
    this._settingDefs = [];
    this._preamble.clear();

    for (const file of this.discover()) {
      // Registrations are live the moment setup() makes them, so a failure
      // anywhere in this iteration must put the four tables back: the window
      // lists the plugin as failed, and "failed" may not leave half a plugin
      // answering the next run. Rollback also restores a marker an earlier
      // plugin owned and this one overwrote before it died.
      const tables = this.#snapshot();
      try {
        // Provenance, not security: a plugin is code the user installed, and
        // the record of what was actually loaded — content hash, size, mtime —
        // is what makes "did that plugin change since it last behaved?" an
        // answerable question without re-reading every file by hand.
        const bytes = fs.readFileSync(file);
        const stat = fs.statSync(file);
        // The enabled-list is read BEFORE the import. A plugin that is
        // disabled must not RUN, and the top level of a plugin is where it
        // does its damage — reading ~/.ssh, reading process.env, spawning a
        // process, fetching out. The old order imported the file first and
        // only then decided not to register it, so "disabled" was a
        // registration filter and never an execution one.
        //
        // The name is read from the source as text (declaredName) because a
        // name can only be known by running the file. A file whose name
        // cannot be read that way answers to the name it is filed under.
        const source = bytes.toString('utf8');
        const names = this.#namesOf(file, source);
        if (!this.#wantedName(names.name)) {
          this.log(`plugin ${names.label} is disabled in settings — not importing it, so its code never runs`);
          continue;
        }
        // (isolation) A plugin that says `isolated: true` — or every plugin
        // when AIPASS_PLUGIN_ISOLATION=all — forks a worker (plugin-
        // worker.mjs) and never runs in this process. 'off' is the
        // explicit opt-out: every plugin in-process, trusted, as before.
        if (this.isolation !== 'off'
          && (this.isolation === 'all' || declaredIsolated(source))) {
          await this.#loadIsolated(file, names, source, bytes, stat);
          continue;
        }
        // A cache-buster that cannot collide: `Date.now()` alone repeats
        // inside one millisecond, and two load() calls that close would then
        // resolve to the same module URL — the ESM cache would hand back the
        // OLD module, and an edited plugin would silently not be reloaded.
        // The counter is what makes every import its own URL.
        const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}-${++this.#imports}`);
        const plugin = mod.default ?? mod;
        if (typeof plugin?.setup !== 'function') throw new Error('no default export with a setup(ctx) function');
        const name = plugin.name ?? path.basename(file);
        // The filter is read before setup runs. Setup is what registers
        // everything: a disabled plugin that was set up first and filtered
        // afterwards would keep its tools, methods and panels live while the
        // listing said the plugin was off — "disabled in settings" has to mean
        // nothing of it is loaded, not that the window forgot to mention it.
        // The name the plugin declares is the name the settings list holds, so
        // it is the name that decides here — and a file whose name could not
        // be read without running it was imported on the strength of the name
        // it is filed under, which the log says out loud.
        if (!this.#wantedName(name)) {
          this.log(`plugin ${name} is disabled in settings — not registering it (the file was imported to learn its name)`);
          continue;
        }
        // A plugin that needs a newer API must not run setup at all: half a
        // plugin registered against a harness it does not understand is
        // worse than a named refusal. Silence means API 1 (the only one).
        const api = plugin.apiVersion ?? null;
        if (api !== null && (!Number.isInteger(api) || api < 1 || api > PLUGIN_API)) {
          throw new Error(`plugin apiVersion ${api} needs a newer harness (this build speaks ${PLUGIN_API})`);
        }
        // The manifest's permissions: what the plugin says it may use, in
        // the capability vocabulary (plugin-worker.mjs). An unknown word is
        // a name the harness does not have — loading anyway would grant a
        // surface nobody reviewed, so it is refused like a bad apiVersion.
        const declaredPerms = plugin.permissions ?? plugin.capabilities ?? null;
        let permissions = null;
        if (declaredPerms !== null) {
          if (!Array.isArray(declaredPerms)) throw new Error('plugin permissions must be an array of capability names');
          const unknown = declaredPerms.filter((c) => !PLUGIN_CAPABILITIES.includes(c));
          if (unknown.length) throw new Error(`plugin declares unknown permissions: ${unknown.join(', ')} (known: ${PLUGIN_CAPABILITIES.join(', ')})`);
          permissions = [...new Set(declaredPerms)];
        }
        const ctx = this.#context(plugin);
        await plugin.setup(ctx);
        this.loaded.push({
          name,
          version: plugin.version ?? '0.0.0',
          description: plugin.description ?? '',
          apiVersion: api,
          permissions,
          file,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
          bytes: stat.size,
          modified: Math.round(stat.mtimeMs),
        });
      } catch (err) {
        this.#rollback(tables);
        this.failed.push({ file, error: String(err.message ?? err) });
        this.log(`plugin ${path.basename(file)} failed to load: ${err.message}`);
      }
    }
    this.events?.emit('plugins', { loaded: this.loaded.length, failed: this.failed.length });
    return this.details();
  }

  #context(plugin) {
    const name = plugin.name ?? 'plugin';
    return {
      name,
      settings: this.settings,
      events: this.events,
      log: (text) => this.log(`[${name}] ${text}`),

      rpc: {
        method: (method, fn) => {
          if (typeof method !== 'string' || typeof fn !== 'function') throw new Error('rpc.method(name, fn)');
          this._methods.set(method, { fn, plugin: name });
        },
      },

      tools: {
        // The model writes `MARKER rest-of-line` (or a block ending in END when
        // takesBody is true) and gets the string back as a tool result.
        // `risk` is the plugin's own word about what the marker does: 'read'
        // keeps it a read, 'write' and 'shell' route it through the same
        // permission gate a built-in of that kind rides (loop.mjs). Left out,
        // the marker is classified like a write (permissions.mjs#classifyPlugin)
        // — trust is what a plugin asks for by name, not what it gets by
        // silence.
        register: (marker, impl, { takesBody = false, description = '', risk = null } = {}) => {
          if (!/^[A-Z][A-Z0-9_-]*$/.test(marker)) throw new Error(`marker must be UPPER_SNAKE, got ${marker}`);
          if (typeof impl !== 'function') throw new Error('tools.register(marker, fn)');
          if (risk != null && !['read', 'write', 'shell'].includes(risk)) {
            throw new Error(`risk must be 'read', 'write', 'shell' or left out, got: ${JSON.stringify(risk)}`);
          }
          this._tools.set(marker, { impl, takesBody, description, plugin: name, risk });
        },
      },

      panel: (def = {}) => {
        if (!def.id || !def.title) throw new Error('panel({id, title, render})');
        this._panels.push({
          id: def.id,
          title: def.title,
          plugin: name,
          // A panel is rendered across the process boundary, so it returns
          // markup (trusted: the plugin is code the user installed), not DOM
          // nodes. `render` may be async.
          render: def.render,
        });
      },

      settings: {
        define: (def = {}) => {
          if (!def.key) throw new Error('settings.define({key, …})');
          this._settingDefs.push({ plugin: name, ...def });
        },
      },

      preamble: {
        // One named paragraph in the run's first message. The name is what
        // the model sees as the section's source, so it must be a word, and
        // a second plugin claiming the same name fails the later load — the
        // first owner keeps the slot, the way a built-in marker cannot be
        // shadowed. The fn is called fresh per run, so the text can read the
        // world; an empty or failing result is dropped at build time.
        section: (sectionName, text) => {
          if (typeof sectionName !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(sectionName)) {
            throw new Error(`preamble.section(name, fn): name must be 1-64 chars of letters, digits, dot, dash or underscore, got ${JSON.stringify(sectionName)}`);
          }
          if (typeof text !== 'function') throw new Error('preamble.section(name, fn) — fn returns the paragraph text');
          if (this._preamble.has(sectionName)) {
            throw new Error(`preamble section "${sectionName}" is already owned by ${this._preamble.get(sectionName).plugin}`);
          }
          this._preamble.set(sectionName, { fn: text, plugin: name });
        },
      },
    };
  }

  /* --------------------------------------------------------- isolated hosts */

  /**
   * Load one plugin in its own process (plugin-worker.mjs). The worker does
   * the importing, so this process never runs the plugin's code — not its
   * top level, not its setup. Failures (timeout, crash, capability misuse)
   * roll back the tables exactly as an in-process failure does.
   */
  async #loadIsolated(file, names, source, bytes, stat) {
    const tables = this.#snapshot();
    // Resource gate first: a forked worker per plugin without a cap is a
    // process table, not a feature.
    if ([...this._hosts.values()].filter((h) => h.child.exitCode === null).length >= this.maxWorkers) {
      this.failed.push({ file, error: `plugin worker limit reached (${this.maxWorkers}) — too many isolated plugins at once` });
      this.log(`plugin ${names.label} failed to load: worker limit reached`);
      return;
    }
    const declared = declaredCapabilities(source);
    const capabilities = declared ?? [...DEFAULT_CAPABILITIES];
    const name = names.name;
    const host = {
      file, name, capabilities, attempts: 1, child: null,
      pending: new Map(), subscriptions: new Map(), stopped: false,
      ready: false, // flips on `ready`; only a READY host earns a restart
    };
    this._hosts.set(name, host);
    try {
      const ready = await this.#spawnHost(host, { forced: this.isolation === 'all' });
      this.loaded.push({
        name: ready.name ?? name,
        version: ready.version ?? '0.0.0',
        description: ready.description ?? '',
        apiVersion: ready.apiVersion ?? null,
        file,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
        bytes: stat.size,
        modified: Math.round(stat.mtimeMs),
        isolated: true,
        capabilities: ready.capabilities ?? capabilities,
        permissions: ready.capabilities ?? capabilities,
      });
    } catch (err) {
      this.#rollback(tables);
      this._hosts.delete(name);
      this.failed.push({ file, error: String(err?.message ?? err) });
      this.log(`plugin ${names.label} failed to load (isolated): ${err?.message ?? err}`);
    }
  }

  /** One forked worker for a host: init, then setup (with the timeout).
   *  Resolves with the worker's `ready` report. */
  #spawnHost(host, { forced = false } = {}) {
    return new Promise((resolve, reject) => {
      let done = false;
      let child;
      const fail = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#stopChild(child);
        reject(err);
      };
      const ok = (ready) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ready);
      };
      try {
        child = fork(WORKER, [], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          resourceLimits: { maxOldGenerationSizeMb: this.memoryMb },
        });
      } catch (err) {
        reject(new Error(`the plugin worker could not start: ${err?.message ?? err}`));
        return;
      }
      host.child = child;
      const timer = setTimeout(() => {
        fail(new Error(`plugin ${host.name} setup timed out after ${this.setupTimeoutMs} ms — the plugin was not loaded`));
      }, this.setupTimeoutMs);
      timer.unref?.();
      child.stdout?.on('data', () => {});
      child.stderr?.on('data', (d) => {
        const text = String(d).trim();
        if (text) this.log(`[${host.name}] ${text.slice(0, 500)}`);
      });
      child.on('error', (err) => fail(new Error(`the plugin worker errored: ${err?.message ?? err}`)));
      child.on('exit', (code, signal) => {
        host.child = null;
        this.#onHostCrash(host, code, signal);
        if (!done) fail(new Error(`the plugin worker exited (${code ?? signal ?? '?'}) before setup finished`));
      });
      child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'register') this.#registerFromHost(host, msg);
        else if (msg.type === 'subscribe') this.#subscribeFromHost(host, msg.event);
        else if (msg.type === 'log') this.log(String(msg.text ?? ''));
        else if (msg.type === 'handler-error') this.log(`[${host.name}] ${msg.event} handler: ${String(msg.error ?? '').slice(0, 300)}`);
        else if (msg.type === 'ready') { host.ready = true; ok(msg); }
        else if (msg.type === 'setup-error') fail(new Error(String(msg.error ?? 'setup failed')));
        else if (msg.type === 'result') {
          const pending = host.pending.get(msg.id);
          if (!pending) return;
          host.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.ok) pending.resolve(msg.value ?? null);
          else pending.reject(new Error(String(msg.error ?? 'plugin call failed')));
        }
      });
      try {
        child.send({
          type: 'init', id: host.name, file: host.file,
          capabilities: host.capabilities, forced,
          parentEnv: { ...process.env },
          settingsSnapshot: this.settings?.values && typeof this.settings.values === 'object'
            ? { ...this.settings.values } : {},
        });
      } catch (err) {
        fail(new Error(`the plugin worker could not start: ${err?.message ?? err}`));
      }
    });
  }

  /** A registration the worker made during setup: it enters the tables with
   *  a remote impl, after the same shape checks the in-process ctx holds. */
  #registerFromHost(host, msg) {
    const name = host.name;
    try {
      if (msg.surface === 'tool') {
        if (!/^[A-Z][A-Z0-9_-]*$/.test(msg.marker)) throw new Error(`marker must be UPPER_SNAKE, got ${msg.marker}`);
        this._tools.set(msg.marker, {
          impl: (call) => this.#hostCall(host, 'tool', msg.marker, call),
          takesBody: Boolean(msg.takesBody), description: String(msg.description ?? ''),
          plugin: name, risk: msg.risk ?? null,
        });
      } else if (msg.surface === 'rpc') {
        this._methods.set(msg.name, { fn: (params) => this.#hostCall(host, 'method', msg.name, params), plugin: name });
      } else if (msg.surface === 'panel') {
        this._panels = this._panels.filter((p) => !(p.plugin === name && p.id === msg.id));
        this._panels.push({
          id: msg.id, title: msg.title, plugin: name,
          render: () => this.#hostCall(host, 'panel', msg.id, {}),
        });
      } else if (msg.surface === 'setting') {
        this._settingDefs = this._settingDefs.filter((d) => !(d.plugin === name && d.key === msg.setting?.key));
        this._settingDefs.push({ plugin: name, ...msg.setting });
      } else if (msg.surface === 'preamble') {
        this._preamble.set(msg.name, { fn: () => this.#hostCall(host, 'preamble', msg.name, {}), plugin: name });
      }
    } catch (err) {
      this.log(`plugin ${name} registered something invalid: ${err?.message ?? err}`);
    }
  }

  /** Forward one bus event to a subscribed isolated plugin. */
  #subscribeFromHost(host, type) {
    if (typeof type !== 'string' || !type) return;
    if (host.subscriptions.has(type)) return;
    // The listener is host-relative: it reads `host.child` live, so it
    // survives a restart (the new child, same subscription) without
    // re-registering.
    const listener = (payload) => {
      if (!host.child) return;
      try { host.child.send({ type: 'fire', event: type, payload: payload ?? {} }); } catch { /* gone */ }
    };
    const off = this.events?.on?.(type, listener);
    host.subscriptions.set(type, { listener, off: typeof off === 'function' ? off : null });
  }

  /** One call against a host, with a per-call timeout. A timed-out call
   *  leaves the plugin alive; a crash rejects every pending call. */
  #hostCall(host, kind, name, args) {
    return new Promise((resolve, reject) => {
      if (!host.child) {
        reject(new Error(`plugin ${host.name} is not running`));
        return;
      }
      const id = `c${++this._callSeq}`;
      const timer = setTimeout(() => {
        host.pending.delete(id);
        reject(new Error(`plugin ${host.name}: ${kind} ${name} timed out after ${this.callTimeoutMs} ms`));
      }, this.callTimeoutMs);
      timer.unref?.();
      host.pending.set(id, { resolve, reject, timer });
      try {
        host.child.send({ type: 'call', id, kind, name, args: args ?? {} });
      } catch (err) {
        host.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`plugin ${host.name} could not be called: ${err?.message ?? err}`));
      }
    });
  }

  /** The child died. An intentional stop (reload/close) is quiet; anything
   *  else is a crash: pending calls reject, and the worker restarts ONCE.
   *  A second death fails the plugin and unregisters it. */
  #onHostCrash(host, code, signal) {
    const pending = [...host.pending.values()];
    host.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`plugin ${host.name} crashed while ${signal ? `signal ${signal}` : `exited ${code}`}`));
    }
    if (host.stopped) return;
    // A worker that died before it ever reported `ready` never loaded: its
    // failure is #loadIsolated's to record (with the rollback). Restarting
    // it here would resurrect a failed load against the rollback.
    if (!host.ready) return;
    host.attempts += 1;
    this.log(`plugin ${host.name} worker exited (${code ?? signal ?? '?'}); restarting`);
    void this.#spawnHost(host, { forced: this.isolation === 'all' }).then(
      () => { this.log(`plugin ${host.name} restarted`); },
      (err) => this.#hostFailed(host, String(err?.message ?? err)),
    );
  }

  /** Stop a child and take its tree down (the execution.mjs pattern). */
  async #stopChild(child) {
    if (!child) return;
    try { child.send?.({ type: 'stop' }); } catch { /* already gone */ }
    await new Promise((resolve) => {
      const done = () => resolve();
      const grace = setTimeout(() => { this.#killTree(child); resolve(); }, 3_000);
      grace.unref?.();
      child.once('exit', () => { clearTimeout(grace); resolve(); });
      child.once('error', done);
      if (child.exitCode !== null) resolve();
    });
  }

  #killTree(child) {
    if (!child?.pid) { try { child?.kill?.(); } catch { /* already gone */ } return; }
    if (process.platform === 'win32') {
      const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.on('error', () => {});
      tk.on('close', () => {});
      return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    try { child.kill(); } catch { /* already gone */ }
  }

  /** A crashed-out plugin: out of every table, in the failed list, said out
   *  loud. Nothing of it answers after this. */
  #hostFailed(host, error) {
    const name = host.name;
    host.stopped = true;
    for (const off of host.subscriptions.values()) { try { off.off?.(); } catch { /* best effort */ } }
    host.subscriptions.clear();
    for (const [marker, def] of this._tools) if (def.plugin === name) this._tools.delete(marker);
    for (const [method, def] of this._methods) if (def.plugin === name) this._methods.delete(method);
    this._panels = this._panels.filter((p) => p.plugin !== name);
    this._settingDefs = this._settingDefs.filter((d) => d.plugin !== name);
    for (const [section, def] of this._preamble) if (def.plugin === name) this._preamble.delete(section);
    this._hosts.delete(name);
    this.loaded = this.loaded.filter((p) => p.name !== name);
    this.failed.push({ file: host.file, error });
    this.log(`plugin ${name} failed: ${error}`);
    this.events?.emit('plugins', { loaded: this.loaded.length, failed: this.failed.length });
  }

  /** What the window shows, and what /rpc answers. */
  details() {
    return {
      dir: this.dir,
      loaded: this.loaded,
      failed: this.failed,
      tools: [...this._tools.keys()],
      // The same table the protocol parser gets, for callers that have to
      // consume a marker's body or not — the window's transcript renderer
      // hides plugin marker blocks, and a body it eats wrongly would be a
      // paragraph the reader never saw.
      toolDefs: this.toolTable(),
      panels: this._panels.map((p) => ({ id: p.id, title: p.title, plugin: p.plugin })),
      settings: this._settingDefs,
      preamble: [...this._preamble.keys()],
    };
  }

  hasMethod(name) { return this._methods.has(name); }
  async callMethod(name, params = {}) {
    const entry = this._methods.get(name);
    if (!entry) throw new Error(`no plugin provides ${name}`);
    return entry.fn(params);
  }

  /** The marker table handed to the protocol parser and the preamble. */
  toolTable() {
    return [...this._tools.entries()].map(([marker, def]) => ({
      marker, takesBody: def.takesBody, description: def.description, plugin: def.plugin, risk: def.risk ?? null,
    }));
  }

  /** The preamble sections, in load order; the loop builds them per run. */
  preambleSections() {
    return [...this._preamble.entries()].map(([name, def]) => ({ name, text: def.fn, plugin: def.plugin }));
  }

  async runTool(marker, { arg = '', body = '' } = {}) {
    const def = this._tools.get(marker);
    if (!def) return `no such plugin tool: ${marker}`;
    // A tool failure answers `err:` like every other tool (rule 3): an
    // isolated plugin that times out or crashes must not throw through the
    // loop — the model reads what happened instead.
    try {
      return String(await def.impl({ arg, body }) ?? '');
    } catch (err) {
      return `err: ${String(err?.message ?? err)}`;
    }
  }

  /** Panels are rendered in the window, across the process boundary. */
  async renderPanel(id) {
    const panel = this._panels.find((p) => p.id === id);
    if (!panel) throw new Error(`no panel ${id}`);
    const out = await panel.render();
    return { id, title: panel.title, plugin: panel.plugin, html: out?.html ?? '' };
  }

  async reload() { return this.load(); }
}

export default PluginManager;
