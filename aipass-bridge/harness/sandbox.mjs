// @ts-nocheck
// A child-visible projection of the pending tree, for the length of one RUN.
//
// The overlay is invisible to a child process by design — that is what makes
// "nothing on disk until apply" true — but it also made RUN a liar: a model
// that staged a fix and ran the check to verify it read the stale disk copy,
// saw the old failure, and concluded the save had failed (the smoke run of
// 2026-10-15). The fix keeps every invariant and makes the check real: before
// a RUN executes, the tree is projected into a throwaway copy under
// `.aipass/run/` with the staged edits written in, the command runs there, and
// the copy is deleted. Nothing is ever written to the real paths.
//
// Source files are copied — they are small, and a copy means a command that
// writes in place cannot touch the real file. Heavy directories (node_modules,
// .git, build outputs) are junctions: the same bytes in any worktree, and
// copying them would turn a two-second check into a minute. A write through a
// junction is exactly the write a RUN on the real tree would have done. The
// sandbox sits inside the project so every path in a stack trace still points
// into the project; restorePaths() puts the project root back in the output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SKIP, realPath } from './overlay.mjs';
import { aipassHome } from './settings.mjs';

// Directories that are junctioned instead of copied. `.aipass` is excluded
// below: it holds the spill directory and the sandbox itself, and a run has no
// business walking either. `.git` too, for a harder reason — a junction into
// the real repository would let a sandboxed `git commit` write it. The walk
// skips `.git` entirely, and a boundary marker is written instead (below).
const HEAVY = new Set([...SKIP].filter((name) => name !== '.aipass' && name !== '.git'));

/**
 * Where a project's sandboxes live.
 *
 * Under the home, NOT under the project: the projection is a copy of the
 * project's source — and of whatever secrets the project holds — and a copy
 * that sits inside the project can be committed by a `git add -A` the user
 * never thought about. The hash keeps two projects with the same folder name
 * apart (the slug alone would not), so one project's sweep can never touch
 * another's live sandbox.
 */
export function sandboxRoot(root) {
  const abs = path.resolve(root);
  const slug = abs.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'root';
  const hash = crypto.createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 8);
  return path.join(aipassHome(), 'run', `${slug}-${hash}`);
}

/**
 * The stamp that says who owns a projection.
 *
 * It sits NEXT to the projection, never inside it: the sandbox is a copy of
 * the user's project, and a file of ours inside it would show up in the
 * command's own `git status` and in the tree it walks.
 */
const OWNER_SUFFIX = '.owner';

/** A fresh sandbox directory for one RUN, stamped with its owner. */
export function createSandbox(root) {
  const dir = sandboxRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(dir, 'run-'));
  // The owner stamp: the pid that made this projection. A janitor reads it to
  // tell a projection a dead backend left behind from one a live run is
  // still using — the difference between "collect it now" and "leave it".
  try {
    fs.writeFileSync(`${sandbox}${OWNER_SUFFIX}`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch { /* the stamp is a hint, not a requirement */ }
  return sandbox;
}

/** Remove a projection and its owner stamp. */
export function removeSandbox(sandbox) {
  if (!sandbox) return;
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* already gone */ }
  try { fs.rmSync(`${sandbox}${OWNER_SUFFIX}`, { force: true }); } catch { /* already gone */ }
}

/** The pid that owns a projection, or null when the stamp is missing or unreadable. */
async function readOwner(stamp) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(stamp, 'utf8'));
    return Number.isInteger(parsed?.pid) ? parsed : null;
  } catch { return null; }
}

/**
 * Is that pid still running?
 *
 * EPERM means it exists and is simply not ours to signal — that is a live
 * process, not a dead one. Everything else (ESRCH, a pid that never existed)
 * means the owner is gone.
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/**
 * Remove the sandboxes no run owns any more.
 *
 * A RUN removes its own sandbox when it ends, but a backend that was killed
 * mid-command leaves the whole copy behind — and nothing else ever collected
 * it. Two margins, because there are two cases:
 *
 *   - the owner is gone (the stamp names a pid that is not running): nobody
 *     can ever finish that projection, so it waits out a short grace and
 *     goes — a crash costs minutes of disk, not six hours of it;
 *   - the owner is alive, or the stamp is missing (an older projection): the
 *     age decides, because a live run's wall-clock budget is half an hour by
 *     default and six hours is well past any run that could still be using
 *     one.
 *
 * Async on purpose: the tree it deletes is a copy of the user's project, and
 * a synchronous removal of it would freeze the backend's event loop — the
 * window's stream, its pings, every other call — for the length of the walk.
 */
export async function sweepSandboxes(root, { maxAgeMs = 6 * 60 * 60 * 1000, deadGraceMs = 10 * 60 * 1000 } = {}) {
  const dir = sandboxRoot(root);
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return 0; }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (name.endsWith(OWNER_SUFFIX)) continue; // a stamp goes with its projection
    if (!name.startsWith('run-')) continue;
    const target = path.join(dir, name);
    const stamp = path.join(dir, `${name}${OWNER_SUFFIX}`);
    let age;
    try { age = now - (await fs.promises.stat(target)).mtimeMs; } catch { continue; }
    const owner = await readOwner(stamp);
    const limit = owner && !alive(owner.pid) ? deadGraceMs : maxAgeMs;
    if (age < limit) continue; // a run may still own it
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      removed++;
    } catch { /* in use, or already gone */ }
    try { await fs.promises.rm(stamp, { force: true }); } catch { /* already gone */ }
  }
  return removed;
}

/**
 * The heavy directories this project has — the ones the projection SHARES
 * with the real tree instead of copying.
 *
 * They are the honest limit of the sandbox: a command that writes into one of
 * them writes into the user's project, because that is the only way to keep a
 * `node_modules` from costing a minute per RUN. The RUN tool says so in its
 * result, so the model is never surprised by a change it did not make.
 */
export function sharedDirs(root) {
  return [...HEAVY].filter((name) => {
    try { return fs.statSync(path.join(root, name)).isDirectory(); } catch { return false; }
  });
}

/**
 * The heavy directory a path sits in — the one the projection LINKS — or null.
 *
 * The projection shares the heavy directories (node_modules, dist, …) with the
 * real tree instead of copying them, so a write into a linked directory is a
 * write into the REAL project (SECURITY.md:385). The question has to be asked
 * before anything is written.
 *
 * Every segment is checked, not only the first: a nested `node_modules`
 * (packages/app/node_modules) is linked exactly like the one at the root.
 *
 * @param {string} root the project the projection is made of
 * @param {string} abs  the path in question
 * @returns {string|null} the name of the shared directory, or null
 */
export function sharedDirFor(root, abs) {
  const base = path.resolve(root);
  const rel = path.relative(base, path.resolve(abs));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  let cur = base;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    if (!HEAVY.has(part)) continue;
    // Only a folder that is really there is linked: a heavy NAME that is not
    // a directory in this project is an ordinary one.
    try { if (fs.statSync(cur).isDirectory()) return part; } catch { return null; }
  }
  return null;
}

/**
 * The refusal for a write into a shared heavy directory.
 *
 * The house shape: a tool failure starts with `err:`. The message names the
 * directory, because the model has to know WHICH folder it may not write to,
 * and it says what the alternative is — the rule the repo holds itself to is
 * that the overlay is the only write surface of a run, and the projection
 * lives OUTSIDE the project so a copy of the source can never be committed.
 *
 * @param {string} root the project the projection is made of
 * @param {string} abs  the path in question
 * @returns {string|null} the refusal, or null when the path may be written
 */
export function sharedWriteRefusal(root, abs) {
  const dir = sharedDirFor(root, abs);
  if (!dir) return null;
  const rel = path.relative(path.resolve(root), path.resolve(abs)).split(path.sep).join('/');
  return `err: ${rel} is inside ${dir}, which the projection SHARES with the real project — a write into it would land in your project, not in the run's copy. Change the source instead, or copy the file out of ${dir} first.`;
}

// (P0) Shared-directory write protection: a projection LINKS the heavy dirs,
// so a RUN command that writes into one lands in the REAL tree — the same
// reason overlay writes there are refused. The shell layer locks them read-only
// for the length of a RUN (write bits cleared, read/exec kept, so `node`
// inside node_modules still runs), audits them afterwards, and restores the
// exact modes it found. Honest limit: this enforces against ordinary writes
// (the kernel returns EPERM/Access Denied); a command running as the same
// user can clear the bits deliberately — the audit then names what changed,
// and the result answers `err:` instead of a quiet success. A kernel boundary
// (AppContainer/bubblewrap/Seatbelt) is the only complete answer; this is the
// Windows rung until that helper exists (docs/FEATURE_GAPS_WAVE3.md 3.1).
// The person may disable the lock explicitly (AIPASS_SANDBOX_LOCK_SHARED=0) —
// a build that writes into dist/ needs that opt-out, and it is never silent.
const lockDisabled = () => process.env.AIPASS_SANDBOX_LOCK_SHARED === '0';
const LOCK_MAX_FILES = () => {
  const n = Number(process.env.AIPASS_SANDBOX_LOCK_MAX_FILES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100_000;
};
// One in-process refcount per project root: two RUNs (a foreground check and
// a background job) share one lock, and only the last one out restores.
const lockRef = new Map();
// The chmods run a bounded number in flight (like the copy gate below):
// locking 30k-80k files one await at a time cost 10-40 s per RUN on a real
// node_modules, before and after the command. Same bound, same shape.
const CHMOD_GATE = 16;

/**
 * Run `fn` over `items` with at most `limit` in flight. Order within the
 * batch is not promised — unlock restores exact modes, so order is irrelevant.
 * @param {Iterable<any>} items
 * @param {number} limit
 * @param {(item: any) => Promise<void>} fn
 */
async function forEachLimited(items, limit, fn) {
  const arr = Array.from(items);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (next < arr.length) {
      const item = arr[next++];
      await fn(item);
    }
  });
  await Promise.all(runners);
}

/** Where the lock manifest lives: beside the projections, never in the project. */
function lockManifestFile(root) {
  return path.join(sandboxRoot(root), 'shared-lock.json');
}

/** Restore modes from a manifest a crashed backend left behind. */
async function restoreManifest(root) {
  const file = lockManifestFile(root);
  let entries;
  try { entries = JSON.parse(await fs.promises.readFile(file, 'utf8')).entries ?? []; } catch { return; }
  await forEachLimited(Array.isArray(entries) ? entries : [], CHMOD_GATE, async (e) => {
    try { await fs.promises.chmod(e.abs, e.mode); } catch { /* gone, or never locked */ }
  });
  try { await fs.promises.rm(file, { force: true }); } catch { /* already gone */ }
}

// Heavy directories whose bytes must never be corrupted by a sandboxed RUN.
// Build output folders (dist, build, target) are kept out of the lock so
// builds in the projection or workspace do not trip over EPERM.
const LOCKABLE_HEAVY = new Set(['node_modules', 'vendor', '.venv', 'venv']);

export function lockableDirs(root) {
  return [...LOCKABLE_HEAVY].filter((name) => {
    try { return fs.statSync(path.join(root, name)).isDirectory(); } catch { return false; }
  });
}

/**
 * Lock every shared heavy directory of `root` read-only for one RUN.
 * Async; resolves to the lock object `unlockSharedDirs`/`auditSharedDirs` take.
 * A crashed predecessor's manifest is restored first (only when its owner is
 * gone), so a killed backend cannot leave the tree read-only forever.
 */
export async function lockSharedDirs(root) {
  if (lockDisabled()) return { disabled: true, entries: new Map(), partial: false, locked: [] };
  const key = realPath(root) ?? path.resolve(root);
  const held = lockRef.get(key);
  if (held) { held.count++; return held.lock; }
  // A manifest from a dead backend: restore before locking anew. A live
  // owner's manifest is left alone — that process is still running a RUN here.
  try {
    const parsed = JSON.parse(await fs.promises.readFile(lockManifestFile(root), 'utf8'));
    if (!parsed?.pid || !alive(parsed.pid)) await restoreManifest(root);
  } catch { /* no predecessor */ }
  const entries = new Map(); // abs -> { mode, size, mtimeMs, isDir }
  const locked = []; // [abs, mode] to restore
  let partial = false;
  const max = LOCK_MAX_FILES();
  const walk = async (dir) => {
    let list;
    try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    const jobs = [];
    for (const e of list) {
      if (entries.size >= max) { partial = true; continue; }
      const abs = path.join(dir, e.name);
      let stat;
      try { stat = await fs.promises.lstat(abs); } catch { continue; }
      // A link is never followed: a junction out of the shared dir is not
      // part of the lock (and not part of the project, per safe()).
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        entries.set(abs, { mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs, isDir: true });
        jobs.push(walk(abs));
      } else if (stat.isFile()) {
        entries.set(abs, { mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs, isDir: false });
      }
    }
    await Promise.all(jobs);
  };
  for (const name of lockableDirs(root)) await walk(path.join(root, name));
  // Manifest BEFORE the chmods: a crash mid-lock still restores cleanly.
  try {
    await fs.promises.mkdir(path.dirname(lockManifestFile(root)), { recursive: true });
    await fs.promises.writeFile(lockManifestFile(root), JSON.stringify({ pid: process.pid, at: Date.now(), entries: [...entries].map(([abs, v]) => ({ abs, mode: v.mode })) }));
  } catch { /* the manifest is crash recovery, not the lock itself */ }
  // Clear write bits only — read and exec survive, so tools still run.
  await forEachLimited(entries, CHMOD_GATE, async ([abs, v]) => {
    try {
      await fs.promises.chmod(abs, v.mode & ~0o222);
      locked.push([abs, v.mode]);
    } catch { /* unreadable: the audit will see it as unchanged */ }
  });
  const lock = { disabled: false, entries, partial, locked };
  lockRef.set(key, { count: 1, lock });
  return lock;
}

/** Restore the modes `lockSharedDirs` found, when the last RUN using them ends. */
export async function unlockSharedDirs(root, lock) {
  if (!lock || lock.disabled) return;
  const key = realPath(root) ?? path.resolve(root);
  const held = lockRef.get(key);
  if (!held || held.lock !== lock) {
    // Already released (or never counted): still restore, best effort.
    await forEachLimited(lock.locked ?? [], CHMOD_GATE, async ([abs, mode]) => { try { await fs.promises.chmod(abs, mode); } catch { /* gone */ } });
    return;
  }
  held.count--;
  if (held.count > 0) return;
  lockRef.delete(key);
  await forEachLimited(lock.locked ?? [], CHMOD_GATE, async ([abs, mode]) => { try { await fs.promises.chmod(abs, mode); } catch { /* gone */ } });
  try { await fs.promises.rm(lockManifestFile(root), { force: true }); } catch { /* already gone */ }
}

/**
 * What changed in the shared dirs since `lock` was taken: files whose bytes
 * moved (size/mtime), files the RUN added, files it deleted. The deliberate
 * escape (clear the read-only bits, then write) lands here, named — a clean
 * RUN returns three empty lists. Reads the tree as it is now; a file the RUN
 * is still writing through another holder reports as changed, which is honest.
 */
export async function auditSharedDirs(root, lock) {
  const changed = [];
  const added = [];
  const deleted = [];
  if (!lock || lock.disabled) return { changed, added, deleted };
  const seen = new Set();
  const walk = async (dir) => {
    let list;
    try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    const jobs = [];
    for (const e of list) {
      const abs = path.join(dir, e.name);
      let stat;
      try { stat = await fs.promises.lstat(abs); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { jobs.push(walk(abs)); continue; }
      if (!stat.isFile()) continue;
      seen.add(abs);
      const before = lock.entries.get(abs);
      const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
      if (!before) added.push(rel);
      else if (before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) changed.push(rel);
    }
    await Promise.all(jobs);
  };
  for (const name of lockableDirs(root)) await walk(path.join(root, name));
  for (const [abs, v] of lock.entries) {
    if (v.isDir) continue;
    if (!seen.has(abs)) deleted.push(path.relative(path.resolve(root), abs).split(path.sep).join('/'));
  }
  return { changed, added, deleted };
}

// Copies run a bounded number in flight: a big tree should saturate the disk,
// not the file-descriptor table.
const COPY_GATE = 16;
let activeCopies = 0;
const copyWaiters = [];

/**
 * The biggest file the projection copies. A check command reads source, not
 * binaries: a 300 MB model file or a video is copied in full for every RUN and
 * is never what the command needed. Over the cap the file is left out and
 * named in the command's result.
 */
const copyCap = () => Number(process.env.AIPASS_SANDBOX_MAX_FILE_MB ?? 64) * 1024 * 1024;
async function gatedCopy(src, dst) {
  if (activeCopies >= COPY_GATE) await new Promise((r) => copyWaiters.push(r));
  activeCopies++;
  try {
    await fs.promises.copyFile(src, dst);
  } finally {
    activeCopies--;
    copyWaiters.shift()?.();
  }
}

/**
 * Project the tree at `root` into `dest`, overlay applied:
 *   - every staged path (except deletes) is written as its staged content
 *   - a staged path inside a SHARED heavy directory is refused: the
 *     projection links those folders, and a write through a link lands in the
 *     real project
 *   - everything else is copied, except HEAVY dirs, which are junctioned
 *   - `.aipass` never enters the projection, and neither does `.git` — a
 *     projected run sees a tree with no repository (the marker below explains)
 *
 * Async and parallel on purpose: this used to be a synchronous walk that froze
 * the backend's event loop — the window's stream, its pings, every other call —
 * for the length of the copy. The bytes on disk are the same, copied through a
 * fixed-width gate, and a command's in-place writes still land in the throwaway
 * copy rather than the project.
 *
 * @param {string} root   the project (or worktree) root the projection mirrors
 * @param {import('./overlay.mjs').Overlay} overlay   the staged edits to write in
 * @param {string} dest   the empty directory to build the projection in
 * @param {object} [opts]
 * @param {AbortSignal|null} [opts.signal]
 * @param {((rel: string, bytes: number) => void)|null} [opts.onSkip]
 * @param {((rel: string, reason: string) => void)|null} [opts.onRefuse]
 */
export async function materializeTree(root, overlay, dest, { signal = null, onSkip = null, onRefuse = null } = {}) {
  // (stop) The projection is the longest wait a RUN has before its command
  // even starts, and the copy used to run to the end while the window said
  // the run was stopping. A stop ends it here, mid-walk.
  const stopped = () => {
    if (!signal?.aborted) return;
    const err = new Error('the run was stopped');
    err.name = 'AbortError';
    throw err;
  };
  stopped();
  const staged = overlay.keys();

  // Staged paths first, creation order: a staged new file whose directory does
  // not exist on disk yet still has to appear.
  for (const abs of staged) {
    stopped();
    const rel = path.relative(root, abs);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue; // outside the tree
    if (rel.split(path.sep)[0] === '.git') continue; // never projected: see below
    const target = path.join(dest, rel);
    if (overlay.isDeleted(abs)) continue; // deleted for this run: not projected
    // A write into a LINKED heavy directory lands in the REAL project: the
    // projection shares those folders with the tree, because a copy of a
    // node_modules costs a minute per RUN. The rule the repo holds itself to
    // is that the overlay is the only write surface of a run — so the write
    // is refused here, the folder stays a link, and the reads still work.
    // (The heavy folder used to be copied whole instead, which was slow and
    // still let the command write into the real tree.)
    const shared = sharedDirFor(root, abs);
    if (shared) {
      onRefuse?.(rel.split(path.sep).join('/'), shared);
      continue;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, overlay.readAt(abs));
  }

  const skip = new Set(staged);
  // Where the project really is, for the link check below: a link that points
  // somewhere else is not part of the project, whatever its name says.
  const realRoot = realPath(root) ?? path.resolve(root);
  const walk = async (srcDir, dstDir) => {
    stopped();
    await fs.promises.mkdir(dstDir, { recursive: true });
    let entries;
    try { entries = await fs.promises.readdir(srcDir, { withFileTypes: true }); } catch { return; }
    const jobs = [];
    for (const e of entries) {
      stopped();
      if (e.name === '.aipass' || e.name === '.git') continue;
      const src = path.join(srcDir, e.name);
      const dst = path.join(dstDir, e.name);
      if (skip.has(src)) continue; // projected already
      if (e.isDirectory()) {
        if (HEAVY.has(e.name)) {
          // Linked, never copied — and always: a heavy folder that held a
          // staged edit used to be copied whole (a minute per RUN), and that
          // edit is refused above, so there is nothing to copy it for.
          try { fs.symlinkSync(src, dst, 'junction'); continue; } catch { /* copy instead */ }
        }
        jobs.push(walk(src, dst));
        continue;
      }
      if (e.isFile()) {
        // (cap) A file this big is not what a check command reads, and
        // copying it costs a RUN seconds every time. It is left out — and
        // named, so the command that trips over its absence says why.
        try {
          const size = fs.statSync(src).size;
          if (size > copyCap()) {
            onSkip?.(path.relative(root, src).split(path.sep).join('/'), size);
            continue;
          }
        } catch { /* unreadable: the copy will report it */ }
        jobs.push(gatedCopy(src, dst));
        continue;
      }
      // Symlinks and anything exotic: recreate what it points at, the cheapest
      // honest shape. A broken link is left out — and so is one that points
      // OUTSIDE the project: the projection mirrors the project, and copying a
      // file from elsewhere into it would put that file where the run can read
      // it (the tools themselves refuse such a path — overlay.safe()).
      try {
        const target = path.resolve(srcDir, fs.readlinkSync(src));
        const realTarget = realPath(target) ?? target;
        const rel = path.relative(realRoot, realTarget);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
        if (fs.statSync(target).isDirectory()) fs.symlinkSync(target, dst, 'junction');
        else jobs.push(gatedCopy(target, dst));
      } catch { /* left out */ }
    }
    await Promise.all(jobs);
  };
  await walk(root, dest);

  // Git discovers a repository by walking UP from the cwd, and this sandbox
  // sits under the project root — so dropping `.git` from the projection is
  // not enough by itself. Verified against git: with no `.git` in the sandbox
  // it climbs the parent chain and finds the real one, and a `git commit`
  // there writes the real repository; an empty `.git` DIRECTORY does not stop
  // it either (git shrugs at the invalid directory and keeps climbing). A
  // `.git` FILE whose `gitdir:` goes nowhere is what halts the search: git
  // reports no repository and exits (the exact wording varies by build — "not
  // a git repository", or "gitfile does not point to a valid repository" on
  // the CI runners). Written only when a repository
  // is actually reachable, so a project with none keeps today's sandbox,
  // `git init` included.
  if (repositoryAbove(root) || repositoryAbove(dest)) {
    try { fs.writeFileSync(path.join(dest, '.git'), 'gitdir: no-repository\n'); } catch { /* the projection still has no .git of its own */ }
  }
  return dest;
}

/** Is a `.git` in this directory or any parent — i.e. could git find a
 *  repository by climbing from the sandbox? */
function repositoryAbove(from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * Put the project root back into the run's own output, so a stack trace reads
 * `D:\proj\check.mjs:5` rather than naming a throwaway directory the model has
 * never seen. Both separator shapes appear in the wild — raw paths and
 * file:/// URLs — so both are swapped, case-insensitively on Windows. This
 * also keeps identical commands byte-identical across steps: without it, every
 * repeat would carry a fresh sandbox name and the stagnation guard (R1) could
 * not recognize the repeat.
 */
export function restorePaths(text, from, to) {
  if (!text) return text;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const swap = (a, b) => {
    const replacement = b.replace(/\$/g, '$$$$'); // a literal string, not $1 groups
    text = text.replace(new RegExp(esc(a), 'gi'), replacement);
  };
  swap(from, to);
  swap(from.split(path.sep).join('/'), to.split(path.sep).join('/'));
  // macOS reports a canonical path to the child (`/private/var/…` for anything
  // under the `/var` symlink), so a plain `process.cwd()` names a spelling the
  // literal `from` never matches. Swap the resolved spelling too; a sandbox
  // that is already gone (or cannot resolve) falls back to the literal swap.
  let resolved = null;
  try { resolved = fs.realpathSync(from); } catch { /* removed, or unresolvable */ }
  if (resolved && resolved !== from) {
    swap(resolved, to);
    swap(resolved.split(path.sep).join('/'), to.split(path.sep).join('/'));
  }
  return text;
}
