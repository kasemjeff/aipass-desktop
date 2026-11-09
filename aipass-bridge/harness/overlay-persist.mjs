// @ts-check
// Overlay persistence: staged edits that survive a backend death.
//
// The overlay lives in memory. A backend that was killed mid-run
// (a crashed window, a power cut, a stop that became a kill) left the
// session transcript — and the `.running` marker the parallel session's
// `interruptedRuns()` reads — but the STAGED EDITS were gone: reopening the
// session resumed the words the model saw, not the work it had staged.
// This module is the other half: after every step the loop writes the
// overlay's entries beside the session file (`<file>.overlay.json`), atomically,
// so a crash leaves the staged changes on disk; opening the session restores
// them, and a clean apply/discard deletes them.
//
// Rules are the same as loop-state.mjs's: the snapshot is advisory — a stale
// or torn one is ignored, never trusted — and best effort (a write that fails
// must never fail the step). The content is capped: past ~5 MB of staged
// text the snapshot keeps the first files and says so, rather than turning
// every step into a multi-megabyte write.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

/** The snapshot format version. A newer build reads an older one. */
export const OVERLAY_STATE_VERSION = 1;

/** Total staged bytes the snapshot keeps; past it, later files are skipped
 *  (and NAMED in the restore note, so a half-resume is never quiet). */
export const OVERLAY_STATE_CAP_BYTES = 5 * 1024 * 1024;

/** Age past which a dead run's staged edits are dropped, not restored. */
export const OVERLAY_STATE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The snapshot file for one session file.
 * @param {string} sessionFile
 */
export function overlayStateFile(sessionFile) {
  return `${String(sessionFile ?? '')}.overlay.json`;
}

/**
 * Build a snapshot from an Overlay (abs → text | DELETED). Deletes are
 * recorded too: a staged delete is a change a resume owes the person.
 * @param {any} overlay
 */
export function snapshotFromOverlay(overlay) {
  const entries = /** @type {Array<{path: string, deleted: boolean, content?: string}>} */ ([]);
  let bytes = 0;
  const skipped = /** @type {string[]} */ ([]);
  for (const abs of overlay?.keys?.() ?? []) {
    const rel = relOf(overlay.root, abs);
    if (!rel) continue;
    if (overlay.isDeleted?.(abs)) {
      entries.push({ path: rel, deleted: true });
      continue;
    }
    let text = '';
    try { text = overlay.readAt(abs); } catch { continue; }
    const size = Buffer.byteLength(text, 'utf8');
    if (bytes + size > OVERLAY_STATE_CAP_BYTES) { skipped.push(rel); continue; }
    bytes += size;
    entries.push({ path: rel, deleted: false, content: text });
  }
  return { version: OVERLAY_STATE_VERSION, savedAt: Date.now(), root: overlay?.root ?? '', entries, skipped };
}

/** @param {string} root @param {string} abs */
function relOf(root, abs) {
  const rel = path.relative(String(root ?? ''), String(abs ?? '')).split(path.sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return null;
  return rel;
}

/**
 * Write a snapshot atomically. Empty overlay (nothing staged) is recorded
 * as an empty entries list — the file's existence is the "a run ended"
 * marker; the cleanup path deletes it (see clearOverlayState).
 * @param {string} sessionFile
 * @param {any} overlay
 */
export function saveOverlayState(sessionFile, overlay) {
  if (!sessionFile) return false;
  try {
    const snap = snapshotFromOverlay(overlay);
    writeFileAtomic(overlayStateFile(sessionFile), JSON.stringify(snap) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a snapshot back. Returns null when there is none, when it is torn,
 * when its root does not match, or when it is stale.
 * @param {string} sessionFile
 * @param {{root?: string, now?: number}} [opts]
 */
export function loadOverlayState(sessionFile, opts = {}) {
  if (!sessionFile) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(overlayStateFile(sessionFile), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== OVERLAY_STATE_VERSION) return null;
    if (!Array.isArray(parsed.entries)) return null;
    if (opts.root && parsed.root && String(parsed.root) !== String(opts.root)) return null;
    const now = Number(opts.now ?? Date.now());
    if (Number.isFinite(parsed.savedAt) && now - parsed.savedAt > OVERLAY_STATE_STALE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete a snapshot (clean apply / discard / DONE — the work is done).
 * @param {string} sessionFile
 */
export function clearOverlayState(sessionFile) {
  if (!sessionFile) return;
  try { fs.rmSync(overlayStateFile(sessionFile), { force: true }); } catch { /* best effort */ }
}

/**
 * Restore a snapshot into an Overlay. Only confined entries land (a path
 * that escapes the root is dropped, never followed — the same rule as
 * Overlay.safe). Returns what landed, for the run note.
 * @param {any} overlay
 * @param {any} snap
 */
export function restoreOverlayState(overlay, snap) {
  const landed = /** @type {{files: number, skipped: string[]}} */ ({ files: 0, skipped: [] });
  if (!overlay || !snap || !Array.isArray(snap.entries)) return landed;
  for (const entry of snap.entries) {
    const rel = String(entry?.path ?? '').trim();
    if (!rel) continue;
    let abs;
    try { abs = overlay.safe(rel); } catch { landed.skipped.push(rel); continue; }
    if (entry.deleted) {
      overlay.markDeleted(abs);
      landed.files += 1;
      continue;
    }
    overlay.set(abs, String(entry.content ?? ''));
    landed.files += 1;
  }
  for (const rel of snap.skipped ?? []) landed.skipped.push(String(rel));
  return landed;
}

export default {
  OVERLAY_STATE_VERSION,
  OVERLAY_STATE_CAP_BYTES,
  OVERLAY_STATE_STALE_MS,
  overlayStateFile,
  snapshotFromOverlay,
  saveOverlayState,
  loadOverlayState,
  clearOverlayState,
  restoreOverlayState,
};
