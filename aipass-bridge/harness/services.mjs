// services.mjs — Recall/Carry/Standing services (Phase 3, §10).
//
// Each service owns a budget and returns Hit[] in the one shape surfaces
// render (D8):
//
//   { source, locator, excerpt, score, coverage, provenance }
//
// RecallService and CarryService score through text.mjs#bm25ScoreAll —
// the same kernel as retrieval's postings (P2 closed for RECALL; carry's
// private loop in memory-store keeps working until its next rewrite).
// RetrievalService is retrieval.mjs itself (already a service); Standing
// renders deterministically and is never ranked (D10).
import crypto from 'node:crypto';
import { bm25ScoreAll, tokenize, excerptOf } from './text.mjs';

const provenance = (source) => ({ source, corpusVersion: 1, builtAt: Date.now(), queryHash: null });

/**
 * Rank documents by BM25. Pure over the given docs.
 * @param {Array} docs Documents from corpus.mjs
 * @param {string} query
 * @param {{ limit?: number, budgetChars?: number }} [opts]
 */
export function rankDocuments(docs, query, opts = {}) {
  const limit = opts.limit ?? 8;
  const budgetChars = opts.budgetChars ?? 6000;
  const qTokens = [...new Set(tokenize(query))];
  const hits = [];
  if (!qTokens.length || !docs.length) return { hits, provenance: provenance(docs[0]?.source ?? 'session') };
  const tfs = docs.map((d) => { const m = new Map(); for (const t of tokenize(d.text)) m.set(t, (m.get(t) || 0) + 1); return m; });
  const raw = bm25ScoreAll(tfs, qTokens); // number[] aligned with docs
  const scored = raw.map((score, index) => ({ index, score, terms: new Set(qTokens.filter((t) => tfs[index].has(t))) }));
  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit * 2);
  let used = 0;
  for (const s of ranked) {
    if (hits.length >= limit) break;
    const d = docs[s.index];
    const cap = [3000, 1800, 1000][hits.length] ?? 600;
    const excerpt = excerptOf(d.text, qTokens, cap);
    const cost = excerpt.length + 40;
    if (used + cost > budgetChars && hits.length) continue;
    used += cost;
    hits.push({
      source: d.source,
      locator: d.locator,
      excerpt,
      score: Math.round(s.score * 100) / 100,
      coverage: qTokens.filter((t) => s.terms.has(t)).length,
      provenance: { ...provenance(d.source), queryHash: crypto.createHash('sha256').update(String(query)).digest('hex').slice(0, 12) },
    });
  }
  return { hits, provenance: hits[0]?.provenance ?? provenance(docs[0]?.source ?? 'session') };
}

export const RecallService = { rank: rankDocuments };
export const CarryService = { rank: rankDocuments };

/**
 * Adapt a retrieval hit to the unified Hit shape (D8). Additive: the
 * original fields stay, `source`/`locator`/`provenance` are added so
 * markers, RPC and the window parse one shape.
 */
export function toHit(hit, { builtAt = null, query = '' } = {}) {
  return {
    ...hit,
    source: 'project',
    locator: { path: hit.path, start: hit.start, end: hit.end },
    provenance: {
      source: 'project', corpusVersion: 2, builtAt,
      queryHash: query ? crypto.createHash('sha256').update(String(query)).digest('hex').slice(0, 12) : null,
    },
  };
}
