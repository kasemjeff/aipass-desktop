// @ts-nocheck
// chunker.mjs — text → passages (split from retrieval.mjs, KNOWLEDGE_ARCHITECTURE §9.1).
// Pure: no IO. Imports only text.mjs + symbols. Chunk shapes are the
// index's vocabulary; changing them bumps RETRIEVAL_VERSION.
import path from 'node:path';
import { tokenize } from './text.mjs';
import { extractSymbols } from './symbols.mjs';

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.css', '.scss', '.sql', '.lua', '.swift', '.kt', '.vue', '.svelte']);
const MD_EXT = new Set(['.md', '.mdx']);
const DATA_EXT = new Set(['.json', '.yaml', '.yml', '.toml', '.csv', '.html', '.htm', '.txt']);
function makeChunk(rel, lines, start, end, kind, symbol, heading) {
  const text = lines.slice(start, end).join('\n').replace(/\s+$/g, '');
  if (!text.trim()) return null;
  return { path: rel, start: start + 1, end: end, kind, symbol: symbol || null, heading: heading || null, text };
}
function chunkLines(rel, text, size, overlap, kind) {
  const lines = text.split('\n');
  const chunks = [];
  if (lines.length <= size) {
    const c = makeChunk(rel, lines, 0, lines.length, kind, null, null);
    if (c) chunks.push(c);
    return chunks;
  }
  for (let i = 0; i < lines.length; i += Math.max(1, size - overlap)) {
    const end = Math.min(lines.length, i + size);
    const c = makeChunk(rel, lines, i, end, kind, null, null);
    if (c) chunks.push(c);
    if (end === lines.length) break;
  }
  return chunks;
}
function chunkCode(rel, text) {
  const lines = text.split('\n');
  const syms = extractSymbols(text, rel).slice().sort((a, b) => a.line - b.line);
  const chunks = [];
  if (!syms.length) return chunkLines(rel, text, 80, 15, 'code');
  const first = syms[0].line - 1;
  if (first > 0) {
    for (const c of chunkLines(rel, lines.slice(0, first).join('\n'), 80, 15, 'code')) chunks.push(c);
  }
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i];
    const symStart = s.line - 1;
    const nextStart = i + 1 < syms.length ? syms[i + 1].line - 1 : lines.length;
    const end = Math.max(symStart + 1, nextStart);
    const sliceText = lines.slice(symStart, end).join('\n');
    const sub = chunkLines(rel, sliceText, 80, 15, 'code');
    for (const c of sub) {
      c.start += symStart;
      c.end += symStart;
      c.symbol = s.name;
      chunks.push(c);
    }
  }
  return chunks.filter((c) => c && c.text.trim());
}
function chunkMarkdown(rel, text) {
  const lines = text.split('\n');
  const sections = [];
  let cur = { heading: null, start: 0, lines: [] };
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) {
      if (cur.lines.length) sections.push(cur);
      cur = { heading: lines[i].replace(/^#+\s*/, '').trim(), start: i, lines: [lines[i]] };
    } else {
      cur.lines.push(lines[i]);
    }
  }
  if (cur.lines.length) sections.push(cur);
  if (sections.length === 0) sections.push({ heading: null, start: 0, lines: lines.slice() });
  const chunks = [];
  for (const sec of sections) {
    const secText = sec.lines.join('\n');
    if (secText.trim().length === 0) continue;
    if (secText.length <= 1200) {
      const c = makeChunk(rel, sec.lines, 0, sec.lines.length, 'markdown', null, sec.heading);
      if (c) { c.start += sec.start; c.end += sec.start; chunks.push(c); }
    } else {
      const sub = chunkLines(rel, secText, 40, 8, 'markdown');
      for (const c of sub) { c.start += sec.start; c.end += sec.start; c.heading = sec.heading; chunks.push(c); }
    }
  }
  return chunks.length ? chunks : chunkLines(rel, text, 60, 10, 'markdown');
}
export function chunkFile(rel, text) {
  const ext = path.extname(rel).toLowerCase();
  if (MD_EXT.has(ext)) return chunkMarkdown(rel, text);
  if (CODE_EXT.has(ext)) return chunkCode(rel, text);
  return chunkLines(rel, text, 60, 10, 'text');
}

export function rankExt(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (CODE_EXT.has(ext)) return 0;
  if (MD_EXT.has(ext)) return 1;
  if (DATA_EXT.has(ext)) return 2;
  return 3;
}
