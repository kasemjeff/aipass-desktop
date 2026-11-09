// @ts-nocheck
// symbols.mjs — a zero-dependency, regex-based code navigator.
//
// No LSP, no tree-sitter, no native binary: every symbol is found by a
// per-language regular expression over the source text, and the index is a
// JSON file under ~/.aipass/symbols/<project-hash>.json, refreshed when a
// file's mtime changes. It is deliberately approximate — a real language
// server wins on precision — but it is always available, offline, and adds
// no dependency. The three markers it backs (SYMBOLS, DEF, REFS) give the
// model the navigation a grep alone cannot: "where is X defined", "where is
// X used", "what does this file declare".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { aipassHome } from './settings.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { isNoisePath } from './overlay.mjs';

const EXT_LANG = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java', '.kt': 'java', '.kts': 'java', '.scala': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.hpp': 'cpp', '.hh': 'cpp',
  '.rb': 'rb', '.php': 'php', '.swift': 'swift', '.dart': 'dart',
  '.cs': 'cs', '.lua': 'lua', '.sh': 'sh', '.bash': 'sh',
};

function langOf(file) { return EXT_LANG[path.extname(file).toLowerCase()] || 'generic'; }

const PATTERNS = {
  js: [
    { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*class\b/ },
  ],
  py: [
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  ],
  go: [
    { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^\s*type\s+([A-Za-z_]\w*)/ },
    { kind: 'const', re: /^\s*const\s+([A-Za-z_]\w*)/ },
    { kind: 'var', re: /^\s*var\s+([A-Za-z_]\w*)/ },
  ],
  rs: [
    { kind: 'function', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: 'enum', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: 'trait', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/ },
    { kind: 'const', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/ },
  ],
  java: [
    { kind: 'class', re: /^\s*(?:public|private|protected|static|abstract|final|\s)+class\s+([A-Za-z_]\w*)/ },
    { kind: 'interface', re: /^\s*(?:public|private|protected|static|abstract|final|\s)+interface\s+([A-Za-z_]\w*)/ },
    { kind: 'method', re: /^\s*(?:public|private|protected|static|abstract|final|synchronized|\s)+(?:[\w<>\[\],\s]+)\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  rb: [
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'module', re: /^\s*module\s+([A-Za-z_]\w*)/ },
    { kind: 'method', re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/ },
  ],
  php: [
    { kind: 'class', re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/ },
  ],
  swift: [
    { kind: 'class', re: /^\s*(?:public|private|internal|open|final|\s)*class\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', re: /^\s*(?:public|private|internal|\s)*struct\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^\s*(?:public|private|internal|\s)*func\s+([A-Za-z_]\w*)/ },
    { kind: 'enum', re: /^\s*(?:public|private|internal|\s)*enum\s+([A-Za-z_]\w*)/ },
    { kind: 'protocol', re: /^\s*(?:public|private|internal|\s)*protocol\s+([A-Za-z_]\w*)/ },
  ],
  dart: [
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
  ],
  cs: [
    { kind: 'class', re: /^\s*(?:public|private|protected|internal|static|abstract|sealed|partial|\s)+class\s+([A-Za-z_]\w*)/ },
    { kind: 'interface', re: /^\s*(?:public|private|protected|internal|\s)+interface\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', re: /^\s*(?:public|private|protected|internal|\s)+struct\s+([A-Za-z_]\w*)/ },
  ],
  lua: [
    { kind: 'function', re: /^\s*(?:local\s+)?function\s+([A-Za-z_]\w*)/ },
  ],
  sh: [
    { kind: 'function', re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/ },
  ],
  c: [
    { kind: 'struct', re: /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: 'enum', re: /^\s*(?:typedef\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: 'function', re: /^\s*(?:static\s+)?(?:[\w*]+\s+)+([A-Za-z_]\w*)\s*\(/ },
  ],
};
PATTERNS.ts = PATTERNS.js;

function extractJsMethods(lines, out) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s{2,}/.test(line)) continue;
    const m = line.match(/^\s+(?:async\s+|static\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) continue;
    const name = m[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(name)) continue;
    out.push({ name, kind: 'method', line: i + 1 });
  }
}

function extractGeneric(lines) {
  const out = [];
  const re = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|func|struct|interface|type|enum|trait|const|let|var)\s+([A-Za-z_]\w*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) out.push({ name: m[1], kind: 'symbol', line: i + 1 });
  }
  return out;
}

export function extractSymbols(text, file) {
  const lang = langOf(file);
  const pats = PATTERNS[lang];
  const lines = text.split('\n');
  const out = [];
  if (!pats) return extractGeneric(lines);
  for (let i = 0; i < lines.length; i++) {
    for (const { kind, re } of pats) {
      const m = lines[i].match(re);
      if (m && m[1]) { out.push({ name: m[1], kind, line: i + 1 }); break; }
    }
  }
  if (lang === 'js' || lang === 'ts') extractJsMethods(lines, out);
  const seen = new Set();
  return out.filter((s) => { const k = s.name + ':' + s.line; if (seen.has(k)) return false; seen.add(k); return true; });
}

function projectHash(root) { return crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12); }
// The index lives under the state home, and the home is read at call time —
// like every other surface here. AIPASS_HOME can be pointed elsewhere after
// this module is loaded (a test does exactly that), and a module-level
// capture would write the index into the real ~/.aipass instead.
//
// The index names every source file and every symbol in the project: it is
// the user's code, spelled out. The folder and the file are owner-only where
// the OS has modes, like the session store and the credentials file.
const dirReadyFor = new Set();
function indexDir() {
  const dir = path.join(aipassHome(), 'symbols');
  // mkdir/chmod are one-time per home: callers used to pay two syscalls on
  // every index lookup. Keyed on the path, so an AIPASS_HOME pointed
  // elsewhere later still gets its folder.
  if (dirReadyFor.has(dir)) return dir;
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  // The mode is set on creation and pinned again afterwards: a directory
  // that was already there keeps the permissions it had. Windows has no
  // POSIX modes, so the chmod is best effort there.
  try { fs.chmodSync(dir, 0o700); } catch { /* windows has no POSIX modes */ }
  dirReadyFor.add(dir);
  return dir;
}
function indexPath(root) { return path.join(indexDir(), projectHash(root) + '.json'); }

// The index is parsed at most once per (file, stat): a lookup on an
// untouched project pays a stat, not a multi-MB parse. The working copy is
// the memo — mutation lands on it first, and the file follows on save.
let indexMemo = { key: '', mtimeMs: 0, size: 0, data: null };
// Bumps on every write of the index file. While the tree is quiet it is a
// stable fingerprint of the index content, so caches keyed on it hold.
let indexRev = 0;

async function loadIndex(root) {
  const p = indexPath(root);
  try {
    const st = await fs.promises.stat(p);
    if (indexMemo.key === p && indexMemo.mtimeMs === st.mtimeMs && indexMemo.size === st.size && indexMemo.data) return indexMemo.data;
    const data = JSON.parse(await fs.promises.readFile(p, 'utf8'));
    if (data && data.root === path.resolve(root) && data.files) {
      indexMemo = { key: p, mtimeMs: st.mtimeMs, size: st.size, data };
      return data;
    }
  } catch {}
  indexMemo = { key: p, mtimeMs: 0, size: 0, data: null };
  return { root: path.resolve(root), files: {} };
}

// The swap is atomic, so a crash cannot leave a half-written index behind:
// a broken index reads as "nothing indexed" and the project is re-read. The
// mode is pinned on the new file, so the index is the owner's alone.
async function saveIndex(root, idx) {
  // No index, no write: `JSON.stringify(undefined)` is undefined, and
  // writeFileSync would throw on it - a throw swallowed by the catch below,
  // so the index silently never landed and every run re-read the project.
  if (!idx) return;
  try {
    writeFileAtomic(indexPath(root), JSON.stringify(idx), { mode: 0o600 });
    indexRev += 1;
    const st = await fs.promises.stat(indexPath(root));
    indexMemo = { key: indexPath(root), mtimeMs: st.mtimeMs, size: st.size, data: idx };
  } catch {}
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.aipass', 'dist', 'build', 'coverage', '.next', 'target', 'vendor']);

async function walkFiles(root, dir = root, out = []) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (isNoisePath(rel)) continue;
      await walkFiles(root, full, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (EXT_LANG[ext]) out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

// A build two callers asked for is one build — SYMBOLS/DEF/REFS on a cold
// project used to each walk the tree. The walk and the stats go through the
// threadpool, so a rebuild no longer freezes every other window call.
const buildFlights = new Map();
export async function indexProject(root) {
  const key = path.resolve(root);
  const flying = buildFlights.get(key);
  if (flying) return flying;
  const build = (async () => {
    try { return await buildIndex(key); } finally { buildFlights.delete(key); }
  })();
  buildFlights.set(key, build);
  return build;
}

async function buildIndex(root) {
  const idx = await loadIndex(root);
  const files = await walkFiles(root);
  const fileSet = new Set(files);
  let dirty = false;
  for (const f of Object.keys(idx.files)) if (!fileSet.has(f)) { delete idx.files[f]; dirty = true; }
  for (const rel of files) {
    const full = path.join(root, rel);
    let st;
    try { st = await fs.promises.stat(full); } catch { continue; }
    const prev = idx.files[rel];
    if (prev && prev.mtime === st.mtimeMs) continue;
    let text = '';
    try { text = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
    idx.files[rel] = { mtime: st.mtimeMs, symbols: extractSymbols(text, rel) };
    dirty = true;
  }
  // An index nobody changed is not rewritten — the walk alone used to cost a
  // sync multi-MB write on every lookup. The revision bumps whenever
  // anything was re-read, even if the write fails: caches keyed on it must
  // never serve content from before this rebuild.
  if (dirty) { indexRev += 1; await saveIndex(root, idx); }
  return idx;
}

export async function listSymbols(root, file) {
  const idx = await indexProject(root);
  const rel = path.isAbsolute(file) ? path.relative(root, file).replace(/\\/g, '/') : file.replace(/\\/g, '/');
  const entry = idx.files[rel];
  if (!entry) return [];
  return entry.symbols;
}

export async function findDefinition(root, name) {
  const idx = await indexProject(root);
  const out = [];
  for (const [file, entry] of Object.entries(idx.files)) {
    for (const s of entry.symbols) {
      if (s.name === name) out.push({ file, line: s.line, kind: s.kind, name: s.name });
    }
  }
  return out;
}

// REFS re-reads every indexed file; while the tree is quiet the answer is
// the same bytes, so it is answered from a small bounded memo.
const REFS_MEMO_MAX = 32;
const refsMemo = new Map();

export async function findReferences(root, name) {
  const idx = await indexProject(root);
  const memoKey = `${path.resolve(root)}:${indexRev}:${name}`;
  const hit = refsMemo.get(memoKey);
  if (hit) return hit;
  const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
  const out = [];
  for (const rel of Object.keys(idx.files)) {
    const full = path.join(root, rel);
    let text;
    try { text = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) out.push({ file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 120) });
    }
  }
  if (refsMemo.size >= REFS_MEMO_MAX) refsMemo.delete(refsMemo.keys().next().value);
  refsMemo.set(memoKey, out);
  return out;
}

export function formatSymbols(syms) {
  if (!syms.length) return '(no symbols found)';
  return syms.map((s) => `${s.line}: ${s.kind} ${s.name}`).join('\n');
}

export function formatDefs(defs) {
  if (!defs.length) return 'err: no definition found';
  return defs.map((d) => `${d.file}:${d.line}  ${d.kind} ${d.name}`).join('\n');
}

export function formatRefs(refs, cap = 60) {
  if (!refs.length) return '(no references found)';
  const shown = refs.slice(0, cap);
  const more = refs.length > cap ? `\n… ${refs.length - cap} more` : '';
  return shown.map((r) => `${r.file}:${r.line}: ${r.snippet}`).join('\n') + more;
}
