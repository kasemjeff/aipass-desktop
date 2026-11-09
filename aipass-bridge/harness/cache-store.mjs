// @ts-nocheck
// cache-store.mjs — the one on-disk cache framework (KNOWLEDGE_ARCHITECTURE §8).
//
// Retrieval, CAG, symbols, checkpoints and goal each re-implemented the
// same five lines: mkdir 0700, atomic 0600 save, version gate,
// corrupt-reads-as-absent, and an LRU memo keyed on (mtime, size). Six
// copies is how policies drift (a store that forgets the chmod, a key
// that is not projectKey). This module is the single implementation;
// a new cache is a new row in STORES, not a new copy.
//
// Hexagonal by construction: the store takes its directory explicitly
// (openStore resolves aipassHome() at call time, never at import), so a
// test can point it at a scratch dir without touching the real home.
// No service imports node:fs for cache IO anymore — they hold a store.
import fs from 'node:fs';
import path from 'node:path';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { projectKey } from './project-key.mjs';

/**
 * The registry: name → policy. dirName + version + memoMax are the whole
 * policy; everything else (0700 dir, 0600 atomic file, corrupt-as-absent,
 * projectKey keying) is shared. A cache not in this table does not exist.
 */
export const STORES = Object.freeze({
  retrieval: Object.freeze({ dirName: 'retrieval', version: 2, memoMax: 4 }),
  cag: Object.freeze({ dirName: 'cag', version: 1, memoMax: 0 }),
  // Reserved rows (Phase 2b): policy declared, migration pending — a
  // cache not in this table does not exist (D7), so new caches join here
  // first and migrate second.
  symbols: Object.freeze({ dirName: 'symbols', version: 1, memoMax: 2 }),
  checkpoints: Object.freeze({ dirName: 'run/checkpoints', version: 1, memoMax: 0 }),
  goal: Object.freeze({ dirName: 'goal', version: 1, memoMax: 0 }),
  memory: Object.freeze({ dirName: 'memory', version: 1, memoMax: 2 }),
});

/**
 * Open (or re-open) the store named in the registry.
 * @param {string} name a key of STORES
 * @param {{ home?: string }} [opts] home defaults to aipassHome() at call time
 */
const OPEN = new Map(); // dir+version → store: the LRU memo lives on the instance, so callers must share it
export function openStore(name, opts = {}) {
  const spec = STORES[name];
  if (!spec) throw new Error(`unknown cache store: ${name}`);
  const home = opts.home ?? aipassHome();
  const key = `${path.join(home, spec.dirName)}:${spec.version}:${spec.memoMax}`;
  let store = OPEN.get(key);
  if (!store) { store = createCacheStore({ dir: path.join(home, spec.dirName), version: spec.version, memoMax: spec.memoMax }); OPEN.set(key, store); }
  return store;
}

/**
 * @param {{ dir: string, version?: number, memoMax?: number, fileMode?: number, dirMode?: number }} spec
 */
export function createCacheStore(spec) {
  const dir = spec.dir;
  const version = spec.version ?? null;
  const memoMax = Number(spec.memoMax) > 0 ? Math.floor(Number(spec.memoMax)) : 0;
  const fileMode = spec.fileMode ?? 0o600;
  const dirMode = spec.dirMode ?? 0o700;
  const memo = new Map(); // file → { mtimeMs, size, data }
  const dirsReady = new Set();

  const ensureDir = () => {
    if (dirsReady.has(dir)) return;
    try { fs.mkdirSync(dir, { recursive: true, mode: dirMode }); } catch {}
    try { fs.chmodSync(dir, dirMode); } catch {}
    dirsReady.add(dir);
  };

  const memoPut = (file, entry) => {
    if (!memoMax) return;
    memo.delete(file);
    if (memo.size >= memoMax) memo.delete(memo.keys().next().value);
    memo.set(file, entry);
  };

  return {
    dir: () => dir,
    fileFor: (root) => path.join(dir, projectKey(root) + '.json'),

    async stat(root) {
      try { const st = await fs.promises.stat(path.join(dir, projectKey(root) + '.json')); return { mtimeMs: st.mtimeMs, size: st.size }; }
      catch { return null; }
    },
    statSync(root) {
      try { const st = fs.statSync(path.join(dir, projectKey(root) + '.json')); return { mtimeMs: st.mtimeMs, size: st.size }; }
      catch { return null; }
    },

    /** Memo-only lookup (no parse). Returns the cached object or null. */
    peek(root) {
      const file = path.join(dir, projectKey(root) + '.json');
      return memo.get(file)?.data ?? null;
    },

    /** Memo entry with its (mtime, size) identity, for TTL fast paths. */
    peekEntry(root) {
      const file = path.join(dir, projectKey(root) + '.json');
      const hit = memo.get(file);
      return hit ? { data: hit.data, mtimeMs: hit.mtimeMs, size: hit.size } : null;
    },

    /** LRU-touch a memo entry by file identity (peekEntry callers re-insert). */
    touch(root, entry) {
      const file = path.join(dir, projectKey(root) + '.json');
      memo.delete(file); memo.set(file, entry);
    },

    invalidate(root) { memo.delete(path.join(dir, projectKey(root) + '.json')); },

    /**
     * Load + validate. A missing, corrupt, wrong-version or
     * caller-rejected file reads as absent (null) — a cache must never
     * be a source of truth (RAG_DESIGN D4).
     * @param {string} root
     * @param {(parsed: any) => boolean} [validate]
     */
    async load(root, validate) {
      const file = path.join(dir, projectKey(root) + '.json');
      let st;
      try { st = await fs.promises.stat(file); } catch { return null; }
      const hit = memo.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        memo.delete(file); memo.set(file, hit); // LRU touch
        return hit.data;
      }
      let data = null;
      try {
        const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        if (parsed && (version === null || parsed.version === version) && (!validate || validate(parsed))) data = parsed;
      } catch {}
      if (data) memoPut(file, { mtimeMs: st.mtimeMs, size: st.size, data });
      else memo.delete(file);
      return data;
    },

    /** Atomic 0600 save. Returns true when the bytes landed. */
    save(root, data) {
      ensureDir();
      const file = path.join(dir, projectKey(root) + '.json');
      let saved = false;
      try { writeFileAtomic(file, JSON.stringify(data), { mode: fileMode }); saved = true; } catch { saved = false; }
      if (saved) {
        try { const st = fs.statSync(file); memoPut(file, { mtimeMs: st.mtimeMs, size: st.size, data }); }
        catch { saved = false; }
      }
      return saved;
    },

    clear(root) {
      memo.delete(path.join(dir, projectKey(root) + '.json'));
      try { fs.rmSync(path.join(dir, projectKey(root) + '.json'), { force: true }); return true; } catch { return false; }
    },
  };
}
