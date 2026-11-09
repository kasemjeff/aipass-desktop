// @ts-nocheck
// ranker-embed.mjs — embeddings as a Ranker plugin (Phase 6, D9, gated).
//
// OFF by default and inert without (a) explicit consent
// (AIPASS_EMBED_CONSENT=1) and (b) a reachable local provider
// (Ollama, AIPASS_EMBED_BASE default http://127.0.0.1:11434). No provider,
// no network, no model download prompt — the BM25 answer stands alone.
// When both gates pass, this module fuses with BM25 by Reciprocal Rank
// Fusion (k=60) behind the same Hit[] contract; it never forks
// RetrievalService. Paraphrase floor movement is the go/no-go (D9).
const BASE = process.env.AIPASS_EMBED_BASE ?? 'http://127.0.0.1:11434';
const MODEL = process.env.AIPASS_EMBED_MODEL ?? 'nomic-embed-text';

export function embedEnabled() {
  return process.env.AIPASS_EMBED_CONSENT === '1';
}

/** Cosine similarity. Brute-force over ≤20k chunks (design rejects ANN). */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Reciprocal Rank Fusion of two ranked lists (higher rank = better). */
export function rrf(listA, listB, k = 60) {
  const score = new Map();
  listA.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (k + i + 1)));
  listB.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Embed texts via a local Ollama-compatible provider. Returns null when
 * disabled or unreachable — callers treat null as "BM25 only".
 */
export async function embedTexts(texts, { signal } = {}) {
  if (!embedEnabled() || !Array.isArray(texts) || !texts.length) return null;
  try {
    const res = await fetch(`${BASE}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: texts.join('\n') }),
      signal: signal ?? AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.embedding) ? [data.embedding] : null;
  } catch { return null; }
}
