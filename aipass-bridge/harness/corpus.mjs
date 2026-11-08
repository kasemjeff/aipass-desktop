// corpus.mjs — corpus drivers (KNOWLEDGE_ARCHITECTURE §10, Phase 3).
//
// A driver turns bytes into Documents behind one shape, and owns the
// secret floor (`secretHit`) so a new corpus inherits it instead of
// re-implementing it. Ranking never sees anything but Document:
//
//   { id, source, text, locator, fields? }
//
// Project/Session drivers are thin adapters over the existing readers
// (retrieval's chunker, memory-store's entry reader); Standing is the
// CAG source list in deterministic order (D10: never ranked).
import { chunkFile } from './chunker.mjs';
import { secretHit } from './permissions.mjs';

/** Project files → Documents (chunked by the shared chunker). */
export function projectDocuments(files) {
  // files: [{ path, text }] — the walk stays in retrieval's buildIndex;
  // this driver is the chunk+floor half, testable without a tree.
  const docs = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.text !== 'string') continue;
    if (secretHit(f.path) || f.text.includes('\u0000')) continue; // secret floor
    for (const c of chunkFile(f.path, f.text)) {
      docs.push({
        id: `project:${f.path}:${c.start}-${c.end}`,
        source: 'project',
        text: c.text,
        locator: { path: c.path, start: c.start, end: c.end },
        fields: { symbol: c.symbol ?? null, heading: c.heading ?? null, kind: c.kind },
      });
    }
  }
  return docs;
}

/** Session entries + facts → Documents (RECALL's candidates). */
export function sessionDocuments({ entries = [], facts = [] } = {}) {
  const docs = [];
  for (const e of entries) {
    if (!e || typeof e.text !== 'string' || !e.text.trim()) continue;
    docs.push({
      id: `session:${e.session ?? '?'}:${e.ts ?? 0}`,
      source: 'session',
      text: e.text,
      locator: { session: e.session ?? null, ts: e.ts ?? null, type: e.kind ?? 'spoken' },
      fields: { title: e.title ?? null },
    });
  }
  for (const f of facts) {
    if (!f || typeof f.text !== 'string' || !f.text.trim()) continue;
    docs.push({
      id: `fact:${f.session ?? '?'}:${f.ts ?? 0}`,
      source: 'session',
      text: f.text,
      locator: { session: f.session ?? null, ts: f.ts ?? null, type: 'fact' },
      fields: { title: f.title ?? null },
    });
  }
  return docs;
}

/** Standing sources → Documents, in list order (never ranked, D10). */
export function standingDocuments(sources) {
  return sources.filter((s) => s && typeof s.path === 'string' && typeof s.text === 'string' && !secretHit(s.path))
    .map((s) => ({ id: `standing:${s.path}`, source: 'standing', text: s.text, locator: { path: s.path }, fields: {} }));
}
