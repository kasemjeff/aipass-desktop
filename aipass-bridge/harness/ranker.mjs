// @ts-nocheck
// ranker.mjs — overlay view + BM25 ranking (split from retrieval.mjs, §9.1).
// Pure over an in-memory index: no fs, no cache. The min-score gate (§9.2)
// lives in retrieve(), which scores through buildView() here.
import path from 'node:path';
import { posix, realPath } from './overlay.mjs';
import { secretHit } from './permissions.mjs';
import { tokenize, bm25Idf } from './text.mjs';
import { chunkFile } from './chunker.mjs';

const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|composer\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|.*\.min\.(js|css)|.*\.map)$/i;

const STATS = new WeakMap();
export function baseStats(idx) {
  let s = STATS.get(idx);
  if (s) return s;
  const df = new Map();
  for (const [term, arr] of Object.entries(idx.postings || {})) df.set(term, arr.length / 2);
  const lengths = (idx.lengths && idx.lengths.length === (idx.chunks || []).length)
    ? idx.lengths : (idx.chunks || []).map(() => 1);
  let total = 0;
  for (const l of lengths) total += (l || 0);
  s = { df, N: (idx.chunks || []).length, lengths, total, avgLen: (idx.avgLen && idx.avgLen > 0) ? idx.avgLen : ((idx.chunks || []).length ? total / (idx.chunks || []).length : 0) };
  STATS.set(idx, s);
  return s;
}

const BODY_TOKENS = new WeakMap();
export function bodyTokens(chunk) {
  let s = BODY_TOKENS.get(chunk);
  if (!s) { s = new Set(tokenize(chunk.text)); BODY_TOKENS.set(chunk, s); }
  return s;
}

export function buildView(idx, root, overlay) {
  const base = baseStats(idx);
  const removed = new Set();
  const staged = [];
  let removedLen = 0;
  if (overlay && typeof overlay.entries === 'function') {
    const realRoot = realPath(root) ?? path.resolve(root);
    const stagedMap = new Map();
    const deleted = new Set();
    for (const [abs, text] of overlay.entries()) {
      const absReal = realPath(String(abs)) ?? path.resolve(String(abs));
      if (absReal !== realRoot && !absReal.startsWith(realRoot + path.sep)) continue;
      const rel = posix(path.relative(realRoot, absReal));
      if (text === '\u0000DELETE\u0000') { deleted.add(rel); continue; }
      if (typeof text !== 'string' || text.includes('\u0000')) continue;
      // The disk walk never indexes a dotfile, a secret name, or a generated
      // file; an overlay edit must not become a side door around that rule.
      if (secretHit(rel) || GENERATED.test(rel) || rel.split('/').some((seg) => seg.startsWith('.'))) continue;
      stagedMap.set(rel, text);
    }
    // removed chunks from deleted + staged paths
    for (const rel of new Set([...deleted, ...stagedMap.keys()])) {
      const cf = (idx.files || {})[rel];
      if (cf && Array.isArray(cf.chunks)) for (const id of cf.chunks) { removed.add(id); removedLen += base.lengths[id] || 0; }
    }
    for (const [rel, text] of stagedMap) {
      const cs = chunkFile(rel, text);
      for (const c of cs) {
        const tf = new Map();
        for (const t of tokenize(c.text)) tf.set(t, (tf.get(t) || 0) + 1);
        const pathTokens = tokenize(rel);
        for (const t of pathTokens) tf.set(t, (tf.get(t) || 0) + 2);
        if (c.symbol) for (const t of tokenize(c.symbol)) tf.set(t, (tf.get(t) || 0) + 2);
        if (c.heading) for (const t of tokenize(c.heading)) tf.set(t, (tf.get(t) || 0) + 2);
        let len = 0;
        for (const [t, f] of tf) if (!t.startsWith('t:')) len += f;
        if (len === 0) len = 1;
        staged.push({ chunk: c, tf, len });
      }
    }
  }

  const baseN = base.N;
  const stagedCount = staged.length;
  const removedCount = removed.size;
  const N = baseN - removedCount + stagedCount;
  let total = base.total - removedLen;
  for (const s of staged) total += s.len;
  const avgLen = N ? total / N : 0;

  const dfOf = (t) => {
    let d = base.df.get(t) || 0;
    // A removed chunk is a posting entry, so count it there rather than
    // walking the removed set for every term.
    const arr = (idx.postings || {})[t];
    if (arr) {
      let rc = 0;
      for (let i = 0; i < arr.length; i += 2) if (removed.has(arr[i])) rc++;
      d -= rc;
    }
    for (const s of staged) if (s.tf.has(t)) d++;
    if (d < 0) d = 0;
    return d;
  };

  const idfCache = new Map();
  const idfOf = (t) => {
    if (idfCache.has(t)) return idfCache.get(t);
    const d = dfOf(t);
    const v = bm25Idf(d, N);
    idfCache.set(t, v);
    return v;
  };

  const chunkAt = (id) => {
    if (id < baseN) return (idx.chunks || [])[id];
    return staged[id - baseN].chunk;
  };
  const lenAt = (id) => {
    if (id < baseN) return base.lengths[id] || 1;
    return staged[id - baseN].len;
  };
  const postings = idx.postings || {};
  const hasRemoved = removed.size > 0;

  return {
    idx, base, baseN, N, avgLen, total, removed, staged, hasRemoved,
    dfOf, idfOf, chunkAt, lenAt, postings, removedCount, stagedCount,
  };
}
