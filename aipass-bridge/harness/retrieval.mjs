// retrieval.mjs — ranked retrieval over a project's own text.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from './cache-store.mjs';
import { secretHit } from './permissions.mjs';
import { loadGitignore } from './gitignore.mjs';
import { SKIP, posix, realPath, isNoisePath } from './overlay.mjs';
import { extractSymbols } from './symbols.mjs';
import { tokenize, excerptOf, bm25Idf, bm25Term } from './text.mjs';
import { chunkFile, rankExt } from './chunker.mjs'; // §9.1 split: chunking lives in chunker.mjs
import { buildView, bodyTokens } from './ranker.mjs'; // §9.1 split: overlay view + ranking live in ranker.mjs
import { toHit } from './services.mjs'; // unified Hit shape (D8, Phase 5)
// Facade (D11): chunkFile stays importable from retrieval.mjs.
export { tokenize } from './text.mjs';
export { chunkFile } from './chunker.mjs';

export const RETRIEVAL_VERSION = 2;
export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_CHUNKS = 20000;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
export const DEFAULT_BUDGET_CHARS = 6000;
export const DEFAULT_MAX_HITS = 6;
export const DEFAULT_INDEX_TTL_MS = 5000;
export const TRIGRAM_WEIGHT = 0.25;
export const EXCERPT_CAPS = [3000, 1800, 1000, 800, 600, 600];

const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|.*\.min\.(js|css)|.*\.map)$/i;

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Persistence rides the shared CacheStore (KNOWLEDGE_ARCHITECTURE §8):
// registry row `retrieval` owns dir/version/memo, this module owns the
// index shape and the build. openStore resolves the home at call time.
const indexStore = () => openStore('retrieval');

// The file read is threadpool work, and the memo is keyed on (mtime, size):
// a lookup on an untouched project pays a stat, not a multi-MB parse. The
// parse itself is one in-process cost per changed index.
export async function loadIndex(root) {
  const real = realPath(root) ?? path.resolve(root);
  return indexStore().load(root, (p) => Array.isArray(p.chunks) && p.postings && typeof p.root === 'string' && p.root === real);
}
export function saveIndex(root, idx) {
  return indexStore().save(root, idx);
}
export function clearIndex(root) {
  // BUILDING is keyed by the real root, not the project key: a clear must
  // cancel the build that is about to write this file, or the build saves it
  // again after the delete.
  const realRoot = realPath(root) ?? path.resolve(root);
  const job = BUILDING.get(realRoot);
  if (job) {
    if (BUILDING.get(realRoot) === job) BUILDING.delete(realRoot);
    try { job.controller.abort(); } catch {}
  }
  indexStore().clear(root);
}
// A status answer from the memo costs no parse — the context panel asks on
// every refresh, and the index can be tens of MB.
export async function status(root) {
  const real = realPath(root) ?? path.resolve(root);
  const store = indexStore();
  const st = await store.stat(root);
  if (!st) return { files: 0, chunks: 0, bytes: 0, builtAt: 0, truncated: false, root: real };
  const idx = await loadIndex(root);
  if (!idx) return { files: 0, chunks: 0, bytes: st.size, builtAt: 0, truncated: false, root: real };
  return { files: Object.keys(idx.files || {}).length, chunks: (idx.chunks || []).length, bytes: st.size, builtAt: idx.builtAt, truncated: !!idx.truncated, root: idx.root };
}

async function walk(root, dir, ign, out, signal, cap, realRoot) {
  if (out.length >= cap) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= cap) return;
    if (signal?.aborted) return;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = posix(path.relative(root, full));
    if (isNoisePath(rel)) continue;
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue;
      if (ign.ignored(rel, true)) continue;
      await walk(root, full, ign, out, signal, cap, realRoot);
      continue;
    }
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.')) continue;
    if (ign.ignored(rel, false)) continue;
    if (secretHit(rel)) continue;
    if (GENERATED.test(rel)) continue;
    if (e.isSymbolicLink()) {
      let target;
      try { target = await fs.promises.realpath(full); } catch { continue; }
      if (target !== realRoot && !target.startsWith(realRoot + path.sep)) continue;
      if (secretHit(target)) continue;
    }
    out.push(rel);
  }
}

export async function buildIndex(root, opts = {}) {
  const signal = opts.signal ?? null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null; // §9.3: `building index x/y`
  const manifest = crypto.createHash('sha256'); // §9.4: staleness made detectable
  const maxFiles = opts.maxFiles ?? envInt('AIPASS_RETRIEVAL_MAX_FILES', DEFAULT_MAX_FILES);
  const maxChunks = opts.maxChunks ?? envInt('AIPASS_RETRIEVAL_MAX_CHUNKS', DEFAULT_MAX_CHUNKS);
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const realRoot = realPath(root) ?? path.resolve(root);
  const ign = loadGitignore(root);
  const walkCap = Math.min(maxFiles * 4, 20000);
  const collected = [];
  await walk(root, root, ign, collected, signal, walkCap, realRoot);
  if (signal?.aborted) throw new Error('index build aborted');
  collected.sort((a, b) => rankExt(a) - rankExt(b) || a.localeCompare(b));
  let fileCapHit = collected.length >= walkCap;
  const files = collected.length > maxFiles ? collected.slice(0, maxFiles) : collected;
  if (collected.length > maxFiles) fileCapHit = true;

  const old = await loadIndex(root);
  const canReuse = !!(old && old.version === RETRIEVAL_VERSION && old.root === realRoot);

  const idx = { version: RETRIEVAL_VERSION, root: realRoot, builtAt: 0, files: {}, chunks: [], postings: {}, lengths: [], avgLen: 0, truncated: false };
  const termMap = new Map();
  const keepMap = new Map(); // old chunk id -> new chunk id (reused)
  let chunksSoFar = 0;
  let readCount = 0;
  let reusedCount = 0;
  let aborted = false;

  const pushChunk = (chunk, tf, len) => {
    if (chunksSoFar >= maxChunks) { idx.truncated = true; return -1; }
    const id = idx.chunks.length;
    idx.chunks.push(chunk);
    idx.lengths.push(len);
    chunksSoFar++;
    for (const [t, f] of tf) {
      if (!termMap.has(t)) termMap.set(t, new Map());
      termMap.get(t).set(id, f);
    }
    return id;
  };

  const addFileTokens = (rel, text, chunks) => {
    const pathTokens = tokenize(rel);
    const pathTf = new Map();
    for (const t of pathTokens) pathTf.set(t, (pathTf.get(t) || 0) + 2);
    const ids = [];
    for (const c of chunks) {
      if (chunksSoFar >= maxChunks) { idx.truncated = true; break; }
      const tf = new Map();
      for (const t of tokenize(c.text)) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, f] of pathTf) tf.set(t, (tf.get(t) || 0) + f);
      if (c.symbol) for (const t of tokenize(c.symbol)) tf.set(t, (tf.get(t) || 0) + 2);
      if (c.heading) for (const t of tokenize(c.heading)) tf.set(t, (tf.get(t) || 0) + 2);
      let len = 0;
      for (const [t, f] of tf) if (!t.startsWith('t:')) len += f;
      if (len === 0) len = 1;
      const id = pushChunk(c, tf, len);
      if (id === -1) break;
      ids.push(id);
    }
    return ids;
  };

  let doneCount = 0;
  for (const rel of files) {
    if (signal?.aborted) { aborted = true; break; }
    if (onProgress) { try { onProgress({ files: doneCount, total: files.length, chunks: idx.chunks.length }); } catch {} }
    doneCount++;
    if (chunksSoFar >= maxChunks) { idx.truncated = true; break; }
    if (secretHit(rel)) continue;
    const full = path.join(root, rel);
    let st;
    try { st = await fs.promises.stat(full); } catch { continue; }
    if (st.size > maxFileBytes) continue;

    const prevFile = canReuse ? (old.files || {})[rel] : null;
    const prevChunksValid = !!(prevFile && prevFile.mtime === st.mtimeMs && prevFile.size === st.size &&
      Array.isArray(prevFile.chunks) && prevFile.chunks.every((id) => old.chunks[id] && Number.isFinite(old.lengths[id])));
    if (prevChunksValid) {
      const ids = [];
      for (const oldId of prevFile.chunks) {
        if (chunksSoFar >= maxChunks) { idx.truncated = true; break; }
        const newId = idx.chunks.length;
        idx.chunks.push({ ...old.chunks[oldId] });
        idx.lengths.push(old.lengths[oldId]);
        chunksSoFar++;
        keepMap.set(oldId, newId);
        ids.push(newId);
      }
      idx.files[rel] = { mtime: st.mtimeMs, size: st.size, chunks: ids };
      reusedCount++;
      continue;
    }

    // read + chunk + tokenize
    let text;
    try { text = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
    readCount++;
    if (text.includes('\u0000')) continue;
    manifest.update(rel + '\0' + crypto.createHash('sha256').update(text).digest('hex') + '\n');
    const chunks = chunkFile(rel, text);
    const ids = addFileTokens(rel, text, chunks);
    idx.files[rel] = { mtime: st.mtimeMs, size: st.size, chunks: ids };
    await new Promise((r) => setImmediate(r));
  }

  if (aborted || signal?.aborted) {
    throw new Error('index build aborted');
  }

  // copy postings for reused chunks
  if (canReuse && old.postings) {
    for (const [t, arr] of Object.entries(old.postings)) {
      let target = termMap.get(t);
      for (let i = 0; i < arr.length; i += 2) {
        const oldId = arr[i], f = arr[i + 1];
        const newId = keepMap.get(oldId);
        if (newId === undefined) continue;
        if (!target) { target = new Map(); termMap.set(t, target); }
        target.set(newId, f);
      }
    }
  }

  if (fileCapHit) idx.truncated = true;

  // postings
  for (const [t, m] of termMap) {
    const arr = [];
    for (const [id, f] of m) { arr.push(id, f); }
    idx.postings[t] = arr;
  }
  const n = idx.lengths.length;
  idx.avgLen = n ? idx.lengths.reduce((a, b) => a + b, 0) / n : 0;
  idx.chunkCount = n;

  if (signal?.aborted) throw new Error('index build aborted');
  idx.manifestHash = manifest.digest('hex'); // covers files read this build (reused files keep their stat identity)
  idx.builtAt = Date.now();
  const saved = saveIndex(root, idx);
  idx.saved = saved;
  return { index: idx, stats: { files: Object.keys(idx.files).length, chunks: n, truncated: idx.truncated, read: readCount, reused: reusedCount, saved, manifestHash: idx.manifestHash } };
}

// The TTL fast path, asked synchronously: a fresh enough index is returned
// without claiming the build slot at all. Any doubt about the cached file's
// identity falls through to the build.
function peekIndex(root, maxAgeMs, force) {
  if (force) return null;
  const store = indexStore();
  const hit = store.peekEntry(root);
  if (!hit) return null;
  // The stat is the same one call the old synchronous loadIndex made — one
  // syscall against tens of MB of parse it is not making.
  const st = store.statSync(root);
  if (!st || st.mtimeMs !== hit.mtimeMs || st.size !== hit.size) return null;
  if (Date.now() - (hit.data.builtAt || 0) >= maxAgeMs) return null;
  store.touch(root, hit);
  return hit.data;
}

const BUILDING = new Map();
export async function ensureIndex(root, opts = {}) {
  const signal = opts.signal ?? null;
  if (signal?.aborted) throw new Error('index build aborted');
  const realRoot = realPath(root) ?? path.resolve(root);
  // Short enough that a disk edit is visible without a restart, long enough
  // that a burst of questions does not walk the tree for each one. Staged
  // edits bypass this: buildView folds them in on every query.
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? Math.max(0, opts.maxAgeMs) : DEFAULT_INDEX_TTL_MS;
  const cached = peekIndex(root, maxAgeMs, !!opts.force);
  if (cached) return cached;

  // The job slot is claimed before the first await: a clear that lands while
  // the index is being read still finds it and still aborts the build — an
  // abort that arrives later must not be lost to a race.
  let job = BUILDING.get(realRoot);
  if (!job) {
    const controller = new AbortController();
    const promise = buildIndex(root, { ...opts, signal: controller.signal }).then((r) => r.index);
    job = { promise, controller, waiters: 0 };
    BUILDING.set(realRoot, job);
    promise.then(
      () => { if (BUILDING.get(realRoot) === job) BUILDING.delete(realRoot); },
      () => { if (BUILDING.get(realRoot) === job) BUILDING.delete(realRoot); }
    );
  }
  job.waiters++;
  try {
    if (!signal) return await job.promise;
    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('index build aborted'));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      job.promise.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
      );
    });
  } finally {
    job.waiters--;
    if (job.waiters === 0) {
      if (BUILDING.get(realRoot) === job) BUILDING.delete(realRoot);
      try { job.controller.abort(); } catch {}
    }
  }
}

const STATS = new WeakMap();
export async function retrieve(query, opts = {}) {
  const root = opts.root;
  const overlay = opts.overlay ?? null;
  const limit = opts.limit ?? DEFAULT_MAX_HITS;
  const budgetChars = opts.budgetChars ?? envInt('AIPASS_RETRIEVAL_BUDGET', DEFAULT_BUDGET_CHARS);
  const signal = opts.signal ?? null;
  const qTokensAll = [...new Set(tokenize(query))];
  if (!qTokensAll.length) return { hits: [], stats: await status(root), words: [] };
  if (signal?.aborted) throw new Error('retrieve aborted');
  let idx;
  try { idx = await ensureIndex(root, { signal, force: opts.force, maxAgeMs: opts.maxAgeMs }); } catch (err) { throw err; }
  if (!idx) return { hits: [], stats: await status(root), words: qTokensAll };
  if (signal?.aborted) throw new Error('retrieve aborted');

  const view = buildView(idx, root, overlay);
  const chunks = view; // not an array; use chunkAt
  const N = view.N;
  if (!N) return { hits: [], stats: { files: Object.keys(idx.files || {}).length, chunks: 0, builtAt: idx.builtAt, truncated: !!idx.truncated, matches: 0, saved: idx.saved !== false }, words: qTokensAll };

  const primary = qTokensAll.filter((t) => !t.startsWith('t:'));
  const trigrams = qTokensAll.filter((t) => t.startsWith('t:'));
  const scoreTokens = primary.length ? primary : trigrams;

  const scores = new Map();
  const coverage = new Map(); // id → Set of query terms that hit it (§9.2 gate)
  const k1 = 1.2;
  const avg = view.avgLen || 1;
  const weightFor = (t) => (t.startsWith('t:') ? TRIGRAM_WEIGHT : 1);
  const addToken = (t, wMul) => {
    const idfVal = view.idfOf(t);
    const arr = view.postings[t];
    if (arr) {
      for (let i = 0; i < arr.length; i += 2) {
        const id = arr[i], f = arr[i + 1];
        if (view.removed.has(id)) continue;
        const len = view.lenAt(id);
        const add = wMul * weightFor(t) * bm25Term(f, len, avg, idfVal);
        scores.set(id, (scores.get(id) || 0) + add);
        if (!t.startsWith('t:')) { let s = coverage.get(id); if (!s) { s = new Set(); coverage.set(id, s); } s.add(t); }
      }
    }
    for (let j = 0; j < view.staged.length; j++) {
      const s = view.staged[j];
      const f = s.tf.get(t) || 0;
      if (!f) continue;
      const id = view.baseN + j;
      const len = s.len;
      const add = wMul * weightFor(t) * bm25Term(f, len, avg, idfVal);
      scores.set(id, (scores.get(id) || 0) + add);
      if (!t.startsWith('t:')) { let s = coverage.get(id); if (!s) { s = new Set(); coverage.set(id, s); } s.add(t); }
    }
  };

  for (const t of scoreTokens) addToken(t, 1);

  // trigram supplement when primary present. The weight is applied once here
  // via weightFor(t), so do not multiply by TRIGRAM_WEIGHT again (that would
  // square it to 0.0625).
  if (primary.length && trigrams.length) {
    for (const t of trigrams) addToken(t, 1);
  }

  if (signal?.aborted) throw new Error('retrieve aborted');

  // phrase bonus (non-trigram tokens only)
  const phrase = String(query).trim().toLowerCase();
  if (phrase.length >= 3 && scores.size) {
    const bonusTokens = primary.length ? primary : qTokensAll;
    const bonus = 0.5 * bonusTokens.reduce((a, t) => a + view.idfOf(t), 0);
    for (const id of scores.keys()) {
      const c = view.chunkAt(id);
      if (String(c.text).toLowerCase().includes(phrase)) scores.set(id, scores.get(id) + bonus);
    }
  }

  // §9.2 coverage gate: a chunk matching only one query term is not an
  // answer (***REMOVED*** measured `kubernetes helm chart production` returning 6
  // hits via the single word `production`). Require ≥2 distinct primary
  // terms, or all of them when the query has fewer. Env override 0/1 off.
  // Measured 2026-11-08: default-ON coverage kills paraphrase recall
  // (0.214 -> 0.000 on the fixture; paraphrases are single-term by
  // nature and the ***REMOVED*** negative's score 9.34 beats paraphrase scores
  // 3-3.5, so neither coverage nor an absolute floor separates them).
  // The gate is therefore opt-in (AIPASS_RETRIEVAL_MIN_COVERAGE=2) until
  // a per-corpus calibration exists; hits always report their coverage.
  const minCoverageEnv = Number(process.env.AIPASS_RETRIEVAL_MIN_COVERAGE);
  const minCoverage = Number.isFinite(minCoverageEnv) ? Math.max(0, Math.floor(minCoverageEnv)) : 0;
  let droppedByCoverage = 0;
  let scored = [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
  if (minCoverage > 1 && primary.length > 1) {
    const before = scored.length;
    scored = scored.filter(({ id }) => (coverage.get(id)?.size ?? 0) >= minCoverage);
    droppedByCoverage = before - scored.length;
  }
  const minScoreEnv = Number(process.env.AIPASS_RETRIEVAL_MIN_SCORE);
  if (Number.isFinite(minScoreEnv) && minScoreEnv > 0) scored = scored.filter(({ score }) => score >= minScoreEnv);
  const chosen = [];
  const chosenSets = [];
  const chosenFiles = new Map();
  const pool = scored.slice(0, 40);
  while (chosen.length < limit && pool.length) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const c = view.chunkAt(cand.id);
      if ((chosenFiles.get(c.path) || 0) >= 2) continue;
      const toks = bodyTokens(c);
      let maxSim = 0;
      for (const s of chosenSets) {
        let inter = 0;
        for (const t of toks) if (s.has(t)) inter++;
        const union = toks.size + s.size - inter;
        const sim = union ? inter / union : 0;
        if (sim > maxSim) maxSim = sim;
      }
      const val = 0.7 * cand.score - 0.3 * maxSim * cand.score;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    if (best === -1) break;
    const pick = pool.splice(best, 1)[0];
    chosen.push(pick);
    chosenSets.push(bodyTokens(view.chunkAt(pick.id)));
    const p = view.chunkAt(pick.id).path;
    chosenFiles.set(p, (chosenFiles.get(p) || 0) + 1);
  }

  const hits = [];
  let used = 0;
  const words = primary.length ? primary : qTokensAll;
  for (let i = 0; i < chosen.length; i++) {
    const { id, score } = chosen[i];
    const c = view.chunkAt(id);
    const cap = EXCERPT_CAPS[i] ?? 600;
    const overhead = c.path.length + 20;
    const remaining = budgetChars - used - overhead;
    if (remaining <= 0 && hits.length) break;
    const actualCap = Math.min(cap, Math.max(0, remaining));
    if (actualCap < 80 && hits.length) break;
    const excerpt = excerptOf(c.text, words, actualCap, { keepLines: c.kind === 'code' });
    const cost = excerpt.length + overhead;
    if (used + cost > budgetChars && hits.length) break;
    used += cost;
    hits.push(toHit({ score: Math.round(score * 100) / 100, path: c.path, start: c.start, end: c.end, kind: c.kind, symbol: c.symbol, heading: c.heading, coverage: coverage.get(id)?.size ?? 0, excerpt }, { builtAt: idx.builtAt, query }));
  }

  if (signal?.aborted) throw new Error('retrieve aborted');

  return {
    hits,
    stats: { files: Object.keys(idx.files || {}).length, chunks: N, builtAt: idx.builtAt, truncated: !!idx.truncated, matches: scored.length, droppedByCoverage, saved: idx.saved !== false },
    words: qTokensAll,
  };
}
