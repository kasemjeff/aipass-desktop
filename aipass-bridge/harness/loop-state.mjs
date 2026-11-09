// @ts-check
// Loop State Persistence: a run that dies mid-flight used to leave the
// transcript but not the loop. The session JSONL records what the model saw;
// the counters the guards read (tool counts, streaks, the todo state, the
// staged list, the failure counts, the budget tier) lived only in memory —
// so a process that died at step 12 restarted the guards at step 1, and a
// run that was one failure from stopping got a fresh streak.
//
// This module is the bridge: after every step the loop writes a small,
// versioned snapshot of that state outside the project (`~/.aipass/run/<key>/`),
// atomically, so a crash leaves the previous snapshot, never a half one. On
// the next run the same snapshot is read back and restored, so the guards
// continue where they died. The snapshot is advisory — a stale or torn one
// is ignored, never trusted — and it is cleared when the run ends.
//
// Where the file lives follows the projections (`sandbox.mjs`) and the
// checkpoints (`checkpoints.mjs`): outside the project, beside them, so a
// copy of loop state can never be committed by accident. Tests in
// `test/loop-state.test.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, tighten } from './atomic-write.mjs';
import { projectKey } from './project-key.mjs';
import { aipassHome } from './settings.mjs';

/** The snapshot format version. A newer build reads an older one; an older build ignores a newer one. */
export const LOOP_STATE_VERSION = 1;

/** Age past which a snapshot from a dead run is stale and dropped, not restored. */
export const LOOP_STATE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Where loop state for one project lives.
 * @param {string} root
 * @returns {string}
 */
export function loopStateDir(root) {
  const base = process.env.AIPASS_HOME?.trim() ? path.resolve(process.env.AIPASS_HOME) : aipassHome();
  return path.join(base, 'run', projectKey(root));
}

/**
 * The snapshot file for one project.
 * @param {string} root
 * @returns {string}
 */
export function loopStateFile(root) {
  return path.join(loopStateDir(root), 'loop-state.json');
}

/**
 * What a snapshot holds: everything the guards read, as plain JSON.
 *
 * @typedef {object} LoopSnapshot
 * @property {number} version
 * @property {number} savedAt
 * @property {string} root
 * @property {string} [taskText]
 * @property {number} [step]
 * @property {number} [toolsRun]
 * @property {number} [mutations]
 * @property {string[]} [stagedFiles]
 * @property {Array<{ text: string, done: boolean }>} [todoState]
 * @property {{ model?: number, tool?: number, environment?: number, unknown?: number }} [failureCounts]
 * @property {string} [budgetTier]
 * @property {number} [errStreak]
 * @property {string} [errKindKey]
 * @property {number} [nudgeStreak]
 * @property {number} [checks]
 * @property {string} [stopReason]
 */

/**
 * Build a snapshot from a RunContext-shaped object.
 *
 * Only the fields the guards read are carried. Session entries, overlay
 * bytes and conversation ids are not — those live in the session store and
 * the session’s own resume path, and duplicating them here would drift.
 *
 * @param {any} run
 * @param {{ step?: number }} [extra]
 * @returns {LoopSnapshot}
 */
export function snapshotFromRun(run, extra = {}) {
  const staged = [];
  try {
    if (run?.overlay && typeof run.overlay.keys === 'function') {
      for (const abs of run.overlay.keys()) {
        const rel = path.relative(run.overlay.root ?? '', abs).split(path.sep).join('/');
        staged.push(run.overlay.isDeleted?.(abs) ? `${rel} (deleted)` : rel);
        if (staged.length >= 40) break;
      }
    }
  } catch { /* a snapshot that cannot read its own overlay carries no list */ }
  const errKindKey = typeof run?.errKindKey === 'string' ? run.errKindKey : '';
  return {
    version: LOOP_STATE_VERSION,
    savedAt: Date.now(),
    root: String(run?.overlay?.root ?? run?.root ?? ''),
    taskText: String(run?.taskText ?? '').slice(0, 4000),
    step: Number.isFinite(Number(extra?.step)) ? Math.floor(Number(extra.step)) : 0,
    toolsRun: Number(run?.toolsRun ?? 0),
    mutations: Number(run?.mutations ?? 0),
    stagedFiles: staged,
    todoState: Array.isArray(run?.todoState) ? run.todoState.slice(0, 40).map((/** @type {any} */ it) => ({ text: String(it?.text ?? ''), done: Boolean(it?.done) })) : [],
    failureCounts: run?.failureCounts && typeof run.failureCounts === 'object' ? { ...run.failureCounts } : { model: 0, tool: 0, environment: 0, unknown: 0 },
    budgetTier: String(run?.budgetTier ?? 'standard'),
    errStreak: Number(run?.errStreak ?? 0),
    errKindKey: errKindKey.slice(0, 500),
    nudgeStreak: Number(run?.nudgeStreak ?? 0),
    checks: Number(run?.checks ?? 0),
    stopReason: String(run?.stopReason ?? ''),
  };
}

/**
 * Write a snapshot atomically. Best effort: a snapshot that fails to write
 * must never fail the run — the run continues without persistence.
 *
 * @param {string} root
 * @param {LoopSnapshot} snapshot
 * @returns {boolean} whether the snapshot landed
 */
export function saveLoopState(root, snapshot) {
  try {
    const dir = loopStateDir(root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tighten(dir, 0o700);
    const file = loopStateFile(root);
    writeFileAtomic(file, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a snapshot back. Returns null when there is none, when it is torn,
 * when it belongs to another project, or when it is stale — a dead run’s
 * state a day old is a new run’s confusion, not a resume.
 *
 * @param {string} root
 * @param {{ now?: number }} [opts]
 * @returns {LoopSnapshot|null}
 */
export function loadLoopState(root, opts = {}) {
  try {
    const file = loopStateFile(root);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== LOOP_STATE_VERSION) return null;
    if (parsed.root && path.resolve(parsed.root) !== path.resolve(root)) return null;
    const now = Number(opts.now ?? Date.now());
    if (Number.isFinite(parsed.savedAt) && now - parsed.savedAt > LOOP_STATE_STALE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Remove a snapshot (on a clean end). Best effort.
 * @param {string} root
 */
export function clearLoopState(root) {
  try { fs.rmSync(loopStateFile(root), { force: true }); } catch { /* best effort */ }
}

/**
 * Restore a snapshot into a RunContext-shaped object. Only the guard
 * counters are restored; the overlay and the session are the session’s own
 * resume path. Returns the fields that landed, for the run note.
 *
 * @param {any} run
 * @param {LoopSnapshot} snapshot
 * @returns {{ toolsRun: number, errStreak: number, todo: number, staged: number }}
 */
export function restoreLoopState(run, snapshot) {
  if (!run || !snapshot) return { toolsRun: 0, errStreak: 0, todo: 0, staged: 0 };
  const toolsRun = Number(snapshot.toolsRun);
  if (Number.isFinite(toolsRun)) run.toolsRun = Math.max(0, Math.floor(toolsRun));
  const errStreak = Number(snapshot.errStreak);
  if (Number.isFinite(errStreak)) run.errStreak = Math.max(0, Math.floor(errStreak));
  if (typeof snapshot.errKindKey === 'string') run.errKindKey = snapshot.errKindKey;
  const nudgeStreak = Number(snapshot.nudgeStreak);
  if (Number.isFinite(nudgeStreak)) run.nudgeStreak = Math.max(0, Math.floor(nudgeStreak));
  // `checks` is deliberately NOT restored: the checker budget is per-run, and
  // the snapshot carries no `checkResult` verdict. Restoring a dead run's
  // `checks >= 2` with `checkResult === null` made `finishCheck` skip the
  // checker entirely while `unverifiedDone` passed `requireCheck: true` — a
  // DONE with no execution behind it. The streaks above are what the guards
  // continue; the checker always runs fresh.
  if (snapshot.failureCounts && typeof snapshot.failureCounts === 'object') {
    run.failureCounts = { model: 0, tool: 0, environment: 0, unknown: 0, ...snapshot.failureCounts };
  }
  if (Array.isArray(snapshot.todoState) && snapshot.todoState.length) {
    run.todoState = snapshot.todoState.map((/** @type {any} */ it) => ({ text: String(it?.text ?? ''), done: Boolean(it?.done) }));
  }
  return {
    toolsRun: run.toolsRun,
    errStreak: run.errStreak,
    todo: run.todoState?.length ?? 0,
    staged: snapshot.stagedFiles?.length ?? 0,
  };
}

export default { LOOP_STATE_VERSION, LOOP_STATE_STALE_MS, loopStateDir, loopStateFile, snapshotFromRun, saveLoopState, loadLoopState, clearLoopState, restoreLoopState };
