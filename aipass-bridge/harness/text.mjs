// text.mjs — shared tokenization, excerpting and BM25 scoring for
// retrieval, recall and the memory carry. One tokenizer and one scoring
// shape (docs/RAG_DESIGN.md D2): a Thai task must rank its facts, its
// past sessions and its project passages the same way, or the three
// surfaces disagree about what a query means.
export const EXCERPT_CAP = 280;

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5)) — retrieval.mjs and memory-store.mjs share this exact shape. */
export function bm25Idf(df, n) {
  const d = Number(df) || 0;
  const total = Number(n) || 0;
  return Math.log(1 + (total - d + 0.5) / (d + 0.5));
}

/** One term's BM25 contribution: idf * (tf*(k1+1)) / (tf + k1*(1-b+b*len/avgLen)). */
export function bm25Term(tf, len, avgLen, idf) {
  const f = Number(tf) || 0;
  if (!f) return 0;
  const avg = Number(avgLen) > 0 ? Number(avgLen) : 1;
  return idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (Number(len) || 1) / avg));
}

/** Document length excludes trigram tokens (t:…): they are a matching aid, not text. */
export function bm25Len(tfMap) {
  let len = 0;
  for (const [t, f] of tfMap) if (!t.startsWith('t:')) len += f;
  return len || 1;
}

/**
 * Score a small document set (tf maps from tokenize) against query tokens.
 * This is the recall/carry shape: an in-memory corpus, no postings.
 * retrieval.mjs scores a large index through postings and calls bm25Idf /
 * bm25Term per term instead — same math, different access path.
 * @param {Array<Map<string, number>>} tfArr
 * @param {string[]} qTokens
 * @returns {number[]} scores aligned with tfArr
 */
export function bm25ScoreAll(tfArr, qTokens) {
  const docs = Array.isArray(tfArr) ? tfArr : [];
  const n = docs.length;
  if (!n) return [];
  const df = new Map();
  for (const m of docs) for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
  const lens = docs.map((m) => bm25Len(m));
  const avgLen = lens.reduce((a, b) => a + b, 0) / n || 1;
  return docs.map((m, i) => {
    let score = 0;
    for (const t of qTokens || []) score += bm25Term(m.get(t) || 0, lens[i], avgLen, bm25Idf(df.get(t) || 0, n));
    return score;
  });
}

const STOP = new Set(['the', 'and', 'for', 'with', 'how', 'what', 'where', 'why', 'is', 'are', 'of', 'to', 'in', 'on', 'a', 'an', 'it', 'this', 'that', 'or', 'be', 'as', 'at', 'by', 'from', 'not', 'but', 'if', 'so', 'do', 'does', 'did', 'has', 'have', 'had', 'was', 'were', 'will', 'can', 'could', 'should', 'would', 'may', 'might', 'about', 'into', 'than', 'then', 'there', 'here', 'when', 'which', 'who', 'whom', 'whose', 'ของ', 'และ', 'ที่', 'การ', 'ความ', 'ให้', 'ได้', 'เป็น', 'มี', 'ใน', 'ว่า', 'จะ', 'ไป', 'มา', 'ไม่', 'นี้', 'นั้น', 'นั่น', 'ด้วย', 'แต่', 'หรือ', 'กับ', 'จาก', 'ถึง', 'เพื่อ', 'ตาม', 'อย่าง', 'คือ', 'เพราะ', 'หาก', 'เมื่อ']);

let SEG_EN = null;
let SEG_TH = null;
try { SEG_EN = new Intl.Segmenter('en', { granularity: 'word' }); } catch {}
try { SEG_TH = new Intl.Segmenter('th', { granularity: 'word' }); } catch {}

export function tokenize(text) {
  const out = [];
  const s = String(text ?? '').normalize('NFKC');
  const hasThai = /[฀-๿]/.test(s);
  const seg = hasThai ? SEG_TH : SEG_EN;
  const segments = seg ? [...seg.segment(s)] : [{ segment: s, isWordLike: true }];
  for (const segObj of segments) {
    if (!segObj.isWordLike) continue;
    const w = segObj.segment;
    const parts = w.split(/[_\-]+/).flatMap((p) => p.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/));
    for (const p of parts) {
      const low = p.toLowerCase().trim();
      if (low.length < 2) continue;
      if (STOP.has(low)) continue;
      out.push(low);
    }
    if (/[฀-๿]/.test(w)) {
      const chars = [...w];
      for (let i = 0; i + 3 <= chars.length; i++) {
        out.push('t:' + chars.slice(i, i + 3).join(''));
      }
    }
  }
  return out;
}

export function queryWords(query) {
  const out = [];
  for (const w of String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (w.length < 2) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

export function excerptOf(text, words, cap = EXCERPT_CAP, opts = {}) {
  const keepLines = !!(opts && opts.keepLines);
  const flat = keepLines
    ? String(text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
    : String(text ?? '').replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  const ws = Array.isArray(words) ? words : [words];
  let at = -1;
  for (const w of ws) {
    const i = low.indexOf(String(w ?? '').toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, cap);
  const before = Math.min(80, Math.floor(cap / 4));
  const start = Math.max(0, at - before);
  // Fill the window: extend to the full cap from `start` rather than
  // stopping at `at + cap - before`, which left the tail short.
  const end = Math.min(flat.length, start + cap);
  const slice = flat.slice(start, end).trim();
  return (start > 0 ? '… ' : '') + slice + (end < flat.length ? ' …' : '');
}
