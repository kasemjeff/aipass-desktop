// @ts-check
// The project's own standing instructions: the file an agent finds at the
// root and is expected to read before touching anything.
//
// Every peer harness loads one of these into the model's first message
// (codex and opencode: AGENTS.md; Claude Code: CLAUDE.md; Gemini CLI:
// GEMINI.md). This module keeps the smallest version that is still useful:
// one file at the run's root, a byte budget, and a shallow nested walk.
//
// The root is the boundary the run already keeps. A file above it, or a link
// that points above it, is not read -- a project can hand the model its own
// conventions, never the machine's other files. Below the root, the nested
// AGENTS.md files a monorepo keeps per subproject are discovered (bounded,
// outside-root safe): the root file still wins, nested files ride as labelled
// extras under the same total budget.
//
// A nested directory that is its own VCS root (`.git` / `.hg` / `.svn`,
// directory or worktree file) is a different project, not a subproject:
// the walk neither collects its instruction file nor descends into it.
// Without that boundary, a run rooted at a folder that merely contains
// several projects (a home directory, a parent folder) would silently
// paste every sibling project's standing rules into one chat. The run's
// own root is exempt -- opening a project still loads that project's
// instructions, which is the feature, not the leak.
//
// The text is project content, not a new protocol: the preamble says whose
// instructions they are and that they lose to the task and the permission
// rules. The switch is AIPASS_INSTRUCTIONS=off; nested discovery is off with
// AIPASS_INSTRUCTIONS_NESTED=off.
import fs from 'node:fs';
import path from 'node:path';

// The order peers use, newest convention first. Only one is read: a project
// that keeps both AGENTS.md and CLAUDE.md usually has the second import the
// first, and pasting both would say everything twice.
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
export const DEFAULT_MAX_BYTES = 8_000;

const disabled = () => /^(0|off|false|no)$/i.test(String(process.env.AIPASS_INSTRUCTIONS ?? '').trim());

const budget = () => {
  const n = Number(process.env.AIPASS_INSTRUCTIONS_MAX_BYTES);
  return Number.isFinite(n) && n >= 256 ? Math.min(64_000, Math.round(n)) : DEFAULT_MAX_BYTES;
};

/**
 * Is `file` inside `root`? Lexical, after both were resolved.
 * @param {string} root
 * @param {string} file
 */
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === '' || (!(rel === '..' || rel.startsWith(`..${path.sep}`)) && !path.isAbsolute(rel));
};

/**
 * Read one instruction file under the budget, on a whole line. Shared by the
 * root read and the nested walk so the two cannot disagree about the cap.
 *
 * @param {string} realRoot resolved root
 * @param {string} full candidate path
 * @param {number} max remaining budget in bytes
 * @returns {{ name: string, text: string, bytes: number, read: number, truncated: boolean } | null}
 */
function readInstructionFile(realRoot, full, max) {
  const name = path.basename(full);
  if (!INSTRUCTION_FILES.includes(name)) return null;
  if (!fs.existsSync(full)) return null;
  let real;
  try { real = fs.realpathSync(full); } catch { return null; }
  if (!inside(realRoot, real)) return null;
  let bytes = 0;
  try { bytes = fs.statSync(real).size; } catch { return null; }
  if (bytes === 0 || max <= 0) return null;
  let text = '';
  let read = 0;
  const fd = fs.openSync(real, 'r');
  try {
    const buf = Buffer.alloc(Math.min(max, bytes));
    read = fs.readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, read).toString('utf8').replace(/^﻿/, '');
  } finally {
    fs.closeSync(fd);
  }
  let truncated = bytes > read;
  if (truncated) {
    const cut = text.lastIndexOf('\n');
    if (cut > 0) {
      text = text.slice(0, cut);
      read = Buffer.byteLength(text, 'utf8');
    }
    truncated = text.trim().length > 0;
  }
  text = text.trim();
  if (!text) return null;
  return { name, text, bytes, read, truncated };
}

const nestedDisabled = () => /^(0|off|false|no)$/i.test(String(process.env.AIPASS_INSTRUCTIONS_NESTED ?? '').trim());

// Directories the walk never descends into: tooling output and VCS state
// cannot hold a project's conventions, and walking them would spend the
// budget (and the backend's clock) on files nobody wrote for an agent.
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.aipass', '.opencode', 'dist', 'build', 'out', '.next', '.turbo', 'coverage']);
const NESTED_MAX_DEPTH = 2;
const NESTED_MAX_FILES = 8;
const NESTED_MAX_DIRS = 120;

// Marker names that make a directory its own VCS root. `.git` may be a
// file (worktree / submodule) as well as a directory, so existence alone
// is the test -- its contents are never read.
const VCS_MARKERS = ['.git', '.hg', '.svn'];

/** Is `dir` the root of its own version-controlled project? */
const isVcsRoot = (dir) => VCS_MARKERS.some((m) => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } });

/**
 * The nested instruction files under `root`: one per directory, shallow
 * first (a nearer file shadows a deeper one for the same directory), inside
 * root only, bounded in count and bytes. The root file itself is not
 * included — the caller already holds it.
 *
 * @param {string} realRoot resolved root
 * @param {number} remaining budget in bytes, shared with the root read
 * @returns {Array<{ name: string, rel: string, text: string, bytes: number, read: number, truncated: boolean }>}
 */
function discoverNestedInstructions(realRoot, remaining) {
  if (nestedDisabled()) return [];
  const out = [];
  let scanned = 0;
  const queue = [{ dir: realRoot, depth: 0 }];
  while (queue.length && out.length < NESTED_MAX_FILES && scanned < NESTED_MAX_DIRS) {
    const next = /** @type {{ dir: string, depth: number }} */ (queue.shift());
    if (!next) break;
    const { dir, depth } = next;
    if (depth > NESTED_MAX_DEPTH) continue;
    // A nested VCS root is another project: hard boundary, enforced before
    // any read or descent. The run root (depth 0) is exempt by construction.
    if (depth > 0 && isVcsRoot(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    scanned += 1;
    // One file per directory, newest convention first — the same rule the
    // root uses, so a directory keeping both AGENTS.md and CLAUDE.md pastes
    // one. The root directory itself is skipped: the caller already holds
    // its file, and reading it twice would spend the nested budget on bytes
    // the preamble already carries.
    let found = null;
    if (depth > 0) {
      for (const candidate of INSTRUCTION_FILES) {
        const full = path.join(dir, candidate);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) { found = full; break; }
        } catch { /* unreadable is uninteresting */ }
      }
    }
    if (found) {
      const doc = readInstructionFile(realRoot, found, remaining);
      if (doc) {
        const rel = path.relative(realRoot, found).split(path.sep).join('/');
        out.push({ name: doc.name, rel, text: doc.text, bytes: doc.bytes, read: doc.read, truncated: doc.truncated });
        remaining -= doc.read;
        if (remaining <= 0) break;
      }
    }
    if (depth >= NESTED_MAX_DEPTH) continue;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      queue.push({ dir: path.join(dir, name), depth: depth + 1 });
    }
  }
  return out;
}

/**
 * The project's instruction file, read and bounded.
 *
 * @param {string} root the run's project root
 * @param {{ max?: number, enabled?: boolean, nested?: boolean }} [opts]
 * @returns {{ file: string, text: string, bytes: number, read: number, truncated: boolean, extras?: Array<{ file: string, text: string }> } | null}
 *   null when the switch is off, no candidate exists, or the file is empty or
 *   resolves outside the root.
 */
export function loadProjectInstructions(root, opts = {}) {
  const enabled = opts.enabled ?? !disabled();
  const max = opts.max ?? budget();
  const nested = opts.nested ?? !nestedDisabled();
  if (!enabled || !root) return null;

  const base = path.resolve(root);
  let file = null;
  let name = null;
  for (const candidate of INSTRUCTION_FILES) {
    const full = path.join(base, candidate);
    if (!fs.existsSync(full)) continue;
    file = full;
    name = candidate;
    break;
  }
  if (!file) return null;

  let realRoot;
  try { realRoot = fs.realpathSync(base); } catch { return null; }

  const primary = readInstructionFile(realRoot, file, max);
  if (!primary) return null;

  let text = primary.text;
  let bytes = primary.bytes;
  let read = primary.read;
  let truncated = primary.truncated;
  const extras = [];
  // Nested files ride under the same total budget, shallow first — the root
  // read already took its share, which is how the root keeps priority. A
  // project with no nested files takes exactly the root-only path above.
  if (nested && max - read > 0) {
    for (const extra of discoverNestedInstructions(realRoot, max - read)) {
      // discover walks from the root; the root's own file is already held,
      // so its entry is skipped (the same file pasted twice says nothing).
      if (extra.rel === primary.name) continue;
      extras.push(extra);
      text += `\n\n--- ${extra.rel} (nested instructions) ---\n${extra.text}\n--- end ${extra.rel} ---`;
      bytes += extra.bytes;
      read += extra.read;
      truncated = truncated || extra.truncated;
    }
  }
  return {
    file: /** @type {string} */ (name),
    text,
    bytes,
    read,
    truncated,
    ...(extras.length ? { extras: extras.map((e) => ({ file: e.rel, text: e.text })) } : {}),
  };
}
