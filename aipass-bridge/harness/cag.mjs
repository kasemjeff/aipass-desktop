// cag.mjs — Cache-Augmented Generation: a standing context pack, built
// once and reused byte-identically.
//
// RAG (retrieval.mjs) answers "what does the project contain" on demand:
// the model asks RETRIEVE and gets ranked passages. CAG answers the
// opposite question: "what must the model always know, without being
// asked?" — the project's standing instructions, readme and goal are
// slow-moving, small, and needed on turn 1 of every run. Re-reading and
// re-sending them through the normal assembly every time wastes the
// prefix-cache the provider could have reused (provider-client.mjs marks
// the first message as a prompt-cache breakpoint; a byte-identical first
// message is what makes that breakpoint pay).
//
// The pack is a cache, not a source of truth — the same rule as the
// retrieval index (docs/RAG_DESIGN.md D4). It lives under
// ~/.aipass/cag/<projectKey>.json (0700 dir / 0600 file, atomic write),
// is keyed on the real root via projectKey, and is invalidated by the
// sources' own (mtime, size) — a changed AGENTS.md rebuilds the pack on
// the next ensure, an untouched one costs a stat per source, not a read.
//
// What CAG is not: per-step auto-injection. The pack rides turn 1 and
// rotation seeds only (the same moments context-sources.mjs budgets);
// anything task-specific still arrives through RETRIEVE / RECALL / SEARCH,
// so a wrong passage in the first message beats a tool result the model
// asked for — the reason RAG_DESIGN.md rejected auto-injection.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openStore } from './cache-store.mjs';
import { secretHit } from './permissions.mjs';
import { posix, realPath } from './overlay.mjs';

export const CAG_VERSION = 1;
export const DEFAULT_SOURCES = Object.freeze(['AGENTS.md', 'README.md']);
export const DEFAULT_BUDGET_CHARS = 16000;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Persistence rides the shared CacheStore (KNOWLEDGE_ARCHITECTURE §8):
// 0700 dir, atomic 0600 file, projectKey keying, corrupt-as-absent.
// openStore resolves the home at call time, so a re-pointed AIPASS_HOME
// (tests) still lands in the scratch home.
const packStore = () => openStore('cag');

export function packHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

async function outsideRoot(root, full) {
  const realRoot = realPath(root) ?? path.resolve(root);
  let target;
  try { target = await fs.promises.realpath(full); } catch { return true; }
  return target !== realRoot && !target.startsWith(realRoot + path.sep);
}

/** Render the pack. Deterministic for the same sources: source order is the caller's list order, sorted nowhere else. */
export function renderPack(sources, budgetChars = DEFAULT_BUDGET_CHARS) {
  const parts = [];
  let used = 0;
  let truncated = false;
  for (const s of sources) {
    const head = `## ${s.path} (sha256 ${s.sha256.slice(0, 12)})\n`;
    const room = budgetChars - used - head.length;
    if (room <= 0) { truncated = true; break; }
    const body = s.text.length > room ? s.text.slice(0, room) : s.text;
    if (body.length < s.text.length) truncated = true;
    parts.push(head + body);
    used += head.length + body.length;
  }
  return { text: parts.join('\n\n'), truncated, totalChars: parts.join('\n\n').length };
}

export async function buildPack(root, opts = {}) {
  const signal = opts.signal ?? null;
  const sources = Array.isArray(opts.sources) && opts.sources.length ? opts.sources : [...DEFAULT_SOURCES];
  const budgetChars = opts.budgetChars ?? envInt('AIPASS_CAG_BUDGET', DEFAULT_BUDGET_CHARS);
  const maxFileBytes = opts.maxFileBytes ?? envInt('AIPASS_CAG_MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES);
  const realRoot = realPath(root) ?? path.resolve(root);
  const read = [];
  for (const relRaw of sources) {
    if (signal?.aborted) throw new Error('cag build aborted');
    const rel = posix(String(relRaw).replace(/\\/g, '/')).replace(/^\.\//, '');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || secretHit(rel)) continue;
    const full = path.join(root, rel);
    let st;
    try { st = await fs.promises.stat(full); } catch { continue; }
    if (!st.isFile() || st.size > maxFileBytes) continue;
    if (await outsideRoot(root, full)) continue;
    let text;
    try { text = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    read.push({ path: rel, text, sha256: packHash(text), size: st.size, mtime: st.mtimeMs });
  }
  const { text, truncated, totalChars } = renderPack(read, budgetChars);
  const pack = { version: CAG_VERSION, root: realRoot, builtAt: Date.now(), sources: read, text, packSha: packHash(text), truncated, totalChars };
  return pack;
}

export function savePack(root, pack) {
  return packStore().save(root, pack);
}

export async function loadPack(root) {
  const real = realPath(root) ?? path.resolve(root);
  return packStore().load(root, (p) => typeof p.text === 'string' && p.root === real && p.packSha === packHash(p.text));
}

/** Sources all still at the (mtime, size) the pack was built from? A missing source is "changed" — rebuild names it. */
async function fresh(root, pack) {
  for (const s of pack.sources || []) {
    let st;
    try { st = await fs.promises.stat(path.join(root, s.path)); } catch { return false; }
    if (st.mtimeMs !== s.mtime || st.size !== s.size) return false;
  }
  return true;
}

export async function ensurePack(root, opts = {}) {
  const cached = opts.force ? null : await loadPack(root);
  if (cached && (await fresh(root, cached))) return { pack: cached, reused: true, saved: false };
  const pack = await buildPack(root, opts);
  const saved = savePack(root, pack);
  return { pack, reused: false, saved };
}

export function clearPack(root) {
  return packStore().clear(root);
}

/**
 * The one block turn 1 / rotation seeds carry (Phase 4). Returns the
 * rendered pack text, or '' when CAG is off, unbuildable, or the pack is
 * empty. Off in pinned replay (opts.replay) like VERIFY.
 */
export async function cagBlockForRun(root, opts = {}) {
  if (opts.cag === false || opts.replay === true) return '';
  try {
    const { pack } = await ensurePack(root, opts);
    return pack && typeof pack.text === 'string' ? pack.text : '';
  } catch { return ''; }
}

export async function statusPack(root) {
  const pack = await loadPack(root);
  const real = realPath(root) ?? path.resolve(root);
  if (!pack) return { sources: 0, chars: 0, builtAt: 0, truncated: false, root: real };
  return { sources: (pack.sources || []).length, chars: pack.totalChars || 0, builtAt: pack.builtAt || 0, truncated: !!pack.truncated, root: pack.root };
}
