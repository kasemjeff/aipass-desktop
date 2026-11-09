// @ts-check
// The execution world: what tree a RUN or a VERIFY command sees, and how its
// answer reads as if it had run in the project.
//
// dsh keeps filesystem and subprocess behind one execution world, so pointing
// them at another backend moves everything at once (its capability-seams map).
// This is that seam at this harness's size. The tool layer (`tools.mjs`) owns
// the guards — the shell gate, the secret screen — and the text policy
// (`clipRun`, the spill); this module owns the world itself:
//
//   plain       nothing staged — the command runs in the project, as always
//   projection  anything staged — the staged tree is copied into a throwaway
//               directory OUTSIDE the project (`sandbox.mjs`) and the command
//               runs there; the disk itself is still never written by a run
//
// The world is picked per command, not per run: a reply can stage its first
// edit and RUN in the same step, and the step's later commands must see what
// the earlier ones staged. A second world — a shell inside a worktree (a
// worktree run's root already IS its world, so its RUNs project from there),
// or a remote sandbox — is another branch of `pickWorld`, not a second copy
// of the RUN tool.
import { fork, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, materializeTree, removeSandbox, restorePaths, sandboxRoot, sharedDirs, lockSharedDirs, unlockSharedDirs, auditSharedDirs } from './sandbox.mjs';
import { scrubOutput, collectProjectSecretValues } from './output-scrub.mjs';
import { scrubSecretDiff } from './permissions.mjs';
import { sanitizeEnv } from './shell-worker.mjs';

/** The worker process that actually spawns shells (shell-worker.mjs). */
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shell-worker.mjs');

// How many shell workers may run at once. A runaway fan-out (one helper per
// minute, each holding a build) is a process table, not a run — the gate turns
// the excess away with `err:` instead of forking without bound.
const MAX_WORKERS = (() => {
  const n = Number(process.env.AIPASS_SHELL_WORKERS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
})();
let activeWorkers = 0;
const workerWaiters = /** @type {Array<(value?: any) => void>} */ ([]);
async function acquireWorker() {
  if (activeWorkers < MAX_WORKERS) { activeWorkers++; return; }
  await new Promise((r) => workerWaiters.push(r));
  activeWorkers++;
}
function releaseWorker() {
  activeWorkers = Math.max(0, activeWorkers - 1);
  workerWaiters.shift()?.();
}

/**
 * Run one shell command to completion, in a forked WORKER — never in this
 * process (shell-worker.mjs). The worker owns the timeout (tree kill), the
 * output cap, the sanitized environment and the cwd confinement; this process
 * only forwards, and a worker that dies answers `err:` while the backend
 * stays up (crash recovery: respawn per call, no state to lose).
 *
 * Rejects the way `exec` did — an Error carrying `code`, `signal`, `stdout`
 * and `stderr` — so callers keep formatting `err: exit …` the same way.
 *
 * @param {string} cmd   the shell line, run through the platform shell
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string|null} [opts.allowedRoot]  the cwd must stay inside this (default: cwd)
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBuffer]
 * @param {AbortSignal|null} [opts.signal]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function runShell(cmd, { cwd, timeoutMs, maxBuffer = 10 * 1024 * 1024, signal = null, allowedRoot = null } = {}) {
  await acquireWorker();
  try {
    return await new Promise((resolve, reject) => {
      /** @type {import('node:child_process').ChildProcess} */
      let worker;
      try {
        worker = fork(WORKER, [], {
          env: sanitizeEnv(),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          execArgv: ['--max-old-space-size=512'],
        });
      } catch (err) {
        releaseWorker();
        const e = /** @type {any} */ (err);
        reject(Object.assign(new Error(`the shell worker could not start: ${String(e?.message ?? e)}`), { code: null, signal: null, stdout: '', stderr: '' }));
        return;
      }
      let done = false;
      let stopped = false;
      /** @type {NodeJS.Timeout|null} */
      let grace = null;
      const finish = (/** @type {(v: any) => void} */ fn, /** @type {any} */ v) => {
        if (done) return;
        done = true;
        clearTimeout(failsafe);
        if (grace) clearTimeout(grace);
        if (signal) signal.removeEventListener('abort', onAbort);
        releaseWorker();
        try { worker.disconnect(); } catch { /* already gone */ }
        try { if (worker.exitCode === null) worker.kill(); } catch { /* already gone */ }
        fn(v);
      };
      // The worker enforces the timeout itself; the failsafe only covers a
      // worker that never answers (crashed before it could reply).
      const failsafe = setTimeout(() => {
        finish(reject, Object.assign(new Error(`timed out after ${timeoutMs} ms`), {
          code: null, signal: 'SIGTERM', killed: true, timedOut: true, stdout: '', stderr: '',
        }));
        killTree(worker);
      }, (Number(timeoutMs) || 120_000) + 5_000);
      failsafe.unref?.();
      function onAbort() {
        stopped = true;
        try { worker.send({ type: 'stop', id: 'run' }); } catch { /* already gone */ }
        // If the worker does not answer the stop, take it down tree-and-all.
        grace = setTimeout(() => killTree(worker), 3_000);
        grace.unref?.();
      }
      if (signal) {
        if (signal.aborted) {
          // Stopped before it started: never send the run (a stop sent first
          // would race the run message and could be lost).
          finish(reject, Object.assign(new Error('the run was stopped'), { code: null, signal: 'SIGTERM', killed: true, stdout: '', stderr: '' }));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      worker.on('error', (error) => finish(reject, Object.assign(error, { stdout: '', stderr: '' })));
      worker.on('exit', (code, killedBy) => {
        // The worker died without an exit message (killed, OOM, crash): the
        // backend survives and says so — this is the recovery path.
        if (done) return;
        finish(reject, Object.assign(new Error(`the shell worker exited (${code ?? killedBy ?? '?'}) before the command answered`), {
          code: null, signal: killedBy ?? null, stdout: '', stderr: '', workerExited: true,
        }));
      });
      worker.on('message', (/** @type {any} */ msg) => {
        if (msg?.type !== 'exit') return;
        const { stdout = '', stderr = '', code = null, signal: sig = null, error = null, timedOut = false } = msg;
        if (error) {
          finish(reject, Object.assign(new Error(error), { code, signal: sig, stdout, stderr, refused: true }));
          return;
        }
        if (stopped || msg.stopped) {
          finish(reject, Object.assign(new Error('the run was stopped'), { code: null, signal: 'SIGTERM', killed: true, stdout, stderr }));
          return;
        }
        if (timedOut) {
          finish(reject, Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: null, signal: 'SIGTERM', killed: true, timedOut: true, stdout, stderr }));
          return;
        }
        if (code === 0 && !sig) finish(resolve, { stdout, stderr });
        else finish(reject, Object.assign(new Error(`exited with ${code ?? sig}`), { code, signal: sig, stdout, stderr }));
      });
      worker.send({ type: 'run', id: 'run', command: cmd, cwd, allowedRoot: allowedRoot ?? cwd, timeoutMs, maxBuffer });
    });
  } finally {
    // releaseWorker runs in finish(); a fork that threw before finish still
    // owes the gate nothing — the count is only incremented after acquire,
    // and finish() is the single release on every settled path above.
  }
}

/** The tree, not the shell alone — see runShell for why.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  // A pid the child never got (spawn can fail before one is handed out)
  // leaves nothing to address: the direct kill is all that can happen.
  if (!child.pid) { try { child.kill(); } catch { /* already gone */ } return; }
  if (process.platform === 'win32') {
    // Spawned, not run inline: the kill must not block the backend's event
    // loop. /T walks the tree while it is still linked, so the shell is left
    // standing here — killing it first orphans the children that taskkill
    // would otherwise have walked to (the first version did exactly that,
    // and the grandchild outlived its timeout).
    const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    tk.on('close', (code) => { if (code !== 0) { try { child.kill(); } catch { /* already gone */ } } });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the tree is already gone */ }
  try { child.kill(); } catch { /* already gone */ }
}

/**
 * The world one command runs in: where its cwd is, how its output is mapped
 * back to the project, and what the honest limits of that world are.
 *
 * `projection` builds the staged copy through sandbox.mjs and maps the
 * sandbox's paths back to the project root; `plain` runs in the project with
 * nothing to map. A projection that cannot be built refuses the command
 * (`err: …`) rather than degrading to `plain`: with edits staged, the plain
 * world would hide them from the command and let its writes reach the real
 * project over staged work.
 *
 * @param {object} opts
 * @param {string} opts.root      the project root (or a worktree's root — the
 *   run's root is whichever folder the run works in)
 * @param {import('./overlay.mjs').Overlay} opts.overlay   the run's pending-edit filesystem
 * @param {AbortSignal|null} [opts.signal]
 * @returns {Promise<{kind: 'projection'|'plain', cwd: string, scrub: (text: string) => string, notes: () => string, dispose: () => void}>}
 */
async function pickWorld({ root, overlay, signal }) {
  if (!overlay?.size) {
    return { kind: 'plain', cwd: root, scrub: (text) => text, notes: () => '', dispose: () => {} };
  }
  let sandbox = null;
  const tooBig = /** @type {string[]} */ ([]);
  try {
    sandbox = createSandbox(root);
    await materializeTree(root, overlay, sandbox, { signal, onSkip: (rel, bytes) => tooBig.push(`${rel} (${Math.round(bytes / 1024 / 1024)} MB)`) });
  } catch (err) {
    if (sandbox) removeSandbox(sandbox);
    throw err;
  }
  return {
    kind: 'projection',
    cwd: sandbox,
    // The child's own paths are put back to the project's, so the output
    // reads as if it ran where the model thinks it did.
    scrub: (text) => restorePaths(text, sandbox, root),
    // The honest limit of the projection, said out loud: the heavy
    // directories are shared with the real project (a copy of node_modules
    // would cost a minute per RUN), so a write into one of them lands in the
    // user's project. And what the projection left out, said too: a command
    // that trips over a missing file deserves to know it was left out on
    // purpose.
    notes: () => {
      const shared = sharedDirs(root);
      const parts = [];
      if (shared.length) parts.push(`note: ${shared.join(', ')} — in this projection those are the REAL folders, not copies: a write there changes your project.`);
      if (tooBig.length) parts.push(`note: not copied into this projection (too large): ${tooBig.slice(0, 5).join(', ')}${tooBig.length > 5 ? `, and ${tooBig.length - 5} more` : ''}.`);
      return parts.length ? `\n\n${parts.join('\n\n')}` : '';
    },
    dispose: () => { if (sandbox) removeSandbox(sandbox); },
  };
}

/**
 * One command against the run's world — the whole of what RUN and VERIFY
 * execute through, guards aside. The `clip` hook is the tool layer's text
 * policy (head+tail clipping with a spill locator); the world owns
 * everything else: projection, output scrubbing, the shared/too-big notes,
 * and the two stop/exit endings that are not the command's own failure.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {import('./overlay.mjs').Overlay} opts.overlay
 * @param {AbortSignal|null} [opts.signal]
 * @param {string} opts.command   the shell line to run
 * @param {number} [opts.timeoutMs]
 * @param {(text: string) => (string|Promise<string>)} [opts.clip]
 * @param {string[]|null} [opts.knownSecrets]
 * @returns {Promise<string>} the command's result, `err: …` on failure
 */
export async function runInProjectWorld({ root, overlay, signal = null, command, timeoutMs = 120_000, clip = (text) => text, knownSecrets = null }) {
  let secrets = knownSecrets;
  if (!secrets) { try { secrets = await collectProjectSecretValues(root); } catch { secrets = []; } }
  // (P0) The shared heavy dirs are locked read-only for the command and
  // audited after it — a write into one must not land in the real tree
  // quietly. The lock is taken before the projection is built (the
  // projection links those dirs) and released after the audit, on every path.
  // In plain mode (no staged overlay), shared dirs are not locked so normal
  // builds and commands in the workspace run unimpeded.
  let lock = null;
  if (overlay?.size) {
    try { lock = await lockSharedDirs(root); } catch { lock = null; }
  }
  let world;
  try {
    world = await pickWorld({ root, overlay, signal });
  } catch (err) {
    try { await unlockSharedDirs(root, lock); } catch { /* best effort */ }
    const e = /** @type {any} */ (err);
    // A stop during the projection ends the run: the copy is the longest
    // wait a RUN has, and it used to finish while the window said the
    // run was stopping.
    if (e?.name === 'AbortError') return 'err: the run was stopped before the command could start';
    // A projection that cannot be built is the one failure the plain world
    // cannot absorb: with edits staged in the overlay, the plain world hides
    // them from the command — the stale-tree lie the projection exists to fix
    // — and a write would land on the real project over staged work. The
    // honest answer is a refusal the model can act on.
    const why = String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 200);
    return `err: the projection could not be built (${why || 'unknown reason'}) — the command was not run, and nothing on disk changed. Retry once; if it fails again, tell the person to check disk space and permissions under ${sandboxRoot(root)}.`;
  }
  let result;
  try {
    const { stdout } = await runShell(command, { cwd: world.cwd, timeoutMs, signal });
    result = (await clip(scrubSecretDiff(world.scrub(scrubOutput(stdout, secrets))))) + world.notes();
  } catch (err) {
    const e = /** @type {any} */ (err);
    // A stop that killed the command says so: "exit SIGTERM" would read as
    // the command's own failure, and the person did ask for it.
    if (e?.killed && /stopped/i.test(String(e.message ?? ''))) {
      result = await clip(scrubSecretDiff(world.scrub('err: the run was stopped before the command finished')));
    } else {
      result = await clip(scrubSecretDiff(world.scrub(scrubOutput(`err: exit ${e.code ?? e.signal ?? '?'}\n${String(e.stdout ?? '')}${String(e.stderr ?? '')}`, secrets))));
    }
  } finally {
    world.dispose();
  }
  // The audit runs after the world is gone (its junction is not needed) and
  // before the lock is released — both on the success and failure paths, so
  // a failed command that still wrote is still named.
  let auditNote = '';
  try {
    const audit = await auditSharedDirs(root, lock);
    const bad = [
      ...audit.changed.map((f) => `${f} (changed)`),
      ...audit.added.map((f) => `${f} (added)`),
      ...audit.deleted.map((f) => `${f} (deleted)`),
    ];
    if (bad.length) {
      auditNote = `\n\nerr: the run changed a shared directory — ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? `, and ${bad.length - 10} more` : ''} — a write into a shared folder lands in your project, and this run was not allowed to do that. The change is left on disk; review it, or restore the folder.`;
    } else if (lock?.partial) {
      auditNote = '\n\nnote: the shared-directory lock stopped at its file cap — later files were not locked. Set AIPASS_SANDBOX_LOCK_MAX_FILES higher for very large trees.';
    } else if (lock?.disabled) {
      auditNote = '\n\nnote: shared-directory locking is off (AIPASS_SANDBOX_LOCK_SHARED=0) — a write into a shared folder changes your project.';
    }
  } catch { /* the audit is a second layer; its own failure must not fail the RUN */ }
  try { await unlockSharedDirs(root, lock); } catch { /* best effort — the manifest covers a crash */ }
  return result + auditNote;
}

export default { runShell, runInProjectWorld, startBackgroundRun };

/** How much of a background command's output is kept on disk. */
export const BACKGROUND_OUTPUT_CAP = 20 * 1024 * 1024;

// Live background spill files, by absolute path. Two tool tables (the main
// run and a helper/checker) each start their ids at run1, so without this
// a helper's run1 truncates the main run's live run1.txt. A name is freed
// only when its job settles, so a finished file is still reused next run.
const liveSpillFiles = new Set();

/**
 * Start one command as a job: same world as a RUN, output streamed to a file.
 *
 * A background command cannot borrow `runShell`: that one holds the output in
 * memory and kills the tree at a timeout, which is the opposite of what a
 * build or a dev server needs. This one streams complete lines through the
 * same screen a foreground RUN's output gets, to a spill file the `read` tool
 * can reach while the job is still running. The world (a projection when
 * anything is staged) lives until the job ends and is removed with it.
 *
 * The promise never rejects: the job's own end condition is the result.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {import('./overlay.mjs').Overlay} opts.overlay
 * @param {AbortSignal|null} [opts.signal]
 * @param {string} opts.command
 * @param {string} opts.name   file name (without .txt) under `.aipass/spill`
 * @param {string[]|null} [opts.knownSecrets]
 * @param {number} [opts.outputCap]  disk cap for this job's output file
 *   (default BACKGROUND_OUTPUT_CAP; a test passes a small one)
 * @returns {Promise<{name: string, outputRel: string, done: Promise<{code: number|null, signal: string|null, stopped: boolean}>, stop: () => Promise<any>}|{error: string}>}
 */
export async function startBackgroundRun({ root, overlay, signal = null, command, name, knownSecrets = null, outputCap = BACKGROUND_OUTPUT_CAP }) {
  let secrets = knownSecrets;
  if (!secrets) { try { secrets = await collectProjectSecretValues(root); } catch { secrets = []; } }
  // (P0) The shared dirs stay locked for the job's whole life — a background
  // command is a RUN that outlives the turn, and its writes must not land in
  // the real tree either. Released on the job's end, after the audit.
  // In plain mode (no staged overlay), shared dirs are not locked.
  let lock = null;
  if (overlay?.size) {
    try { lock = await lockSharedDirs(root); } catch { lock = null; }
  }
  let world;
  try {
    world = await pickWorld({ root, overlay, signal });
  } catch (err) {
    try { await unlockSharedDirs(root, lock); } catch { /* best effort */ }
    const e = /** @type {any} */ (err);
    if (e?.name === 'AbortError') return { error: 'the run was stopped before the command could start' };
    const why = String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 200);
    return { error: `the projection could not be built (${why || 'unknown reason'}) — the command was not started` };
  }

  let finalName = name;
  let rel = `.aipass/spill/${finalName}.txt`;
  let file = path.join(root, '.aipass', 'spill', `${finalName}.txt`);
  let attempt = 1;
  while (liveSpillFiles.has(file)) {
    attempt++;
    finalName = `${name}-${attempt}`;
    rel = `.aipass/spill/${finalName}.txt`;
    file = path.join(root, '.aipass', 'spill', `${finalName}.txt`);
  }
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // Exclusive create ('wx'), never a truncate ('w'): a file that already
    // exists may belong to a live job in ANOTHER process (a second backend
    // on the same project — liveSpillFiles only sees this one's), or to a
    // finished job whose output a session note still points at. Truncating
    // either would mix two runs' output in one file, so a taken name gets a
    // random suffix instead. A fresh name is still exactly `${name}.txt`.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.writeFile(file, '', { flag: 'wx' });
        break;
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (e?.code !== 'EEXIST' || attempt >= 8) throw err;
        finalName = `${name}-${Math.random().toString(16).slice(2, 8)}`;
        rel = `.aipass/spill/${finalName}.txt`;
        file = path.join(root, '.aipass', 'spill', `${finalName}.txt`);
        if (liveSpillFiles.has(file)) continue;
      }
    }
    liveSpillFiles.add(file);
  } catch (err) {
    world.dispose();
    try { await unlockSharedDirs(root, lock); } catch { /* best effort */ }
    const e = /** @type {any} */ (err);
    return { error: `the output file could not be created: ${String(e?.message ?? e).slice(0, 200)}` };
  }

  // The job runs in a forked worker (shell-worker.mjs), like a foreground RUN
  // — the backend never spawns the shell itself. If the worker cannot start,
  // the job answers `err:` and nothing runs.
  await acquireWorker();
  /** @type {import('node:child_process').ChildProcess} */
  let worker;
  try {
    worker = fork(WORKER, [], {
      env: sanitizeEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--max-old-space-size=512'],
    });
  } catch (err) {
    releaseWorker();
    liveSpillFiles.delete(file);
    world.dispose();
    try { await unlockSharedDirs(root, lock); } catch { /* best effort */ }
    const e = /** @type {any} */ (err);
    return { error: `the command could not start: ${String(e?.message ?? e).slice(0, 200)}` };
  }

  let stopped = false;
  let settled = false;
  let written = 0;
  let clipped = false;
  let pending = '';
  const out = fs.createWriteStream(file, { flags: 'a' });
  const capLabel = outputCap >= 1024 * 1024
    ? `${Math.round(outputCap / 1024 / 1024)} MB`
    : `${outputCap} bytes`;
  const clipMarker = `\n… output stopped at ${capLabel} — the rest was dropped.\n`;
  const write = (/** @type {string} */ text) => {
    if (!text || settled) return;
    if (written >= outputCap) {
      if (!clipped) { clipped = true; out.write(clipMarker); }
      return;
    }
    // Slice to the room left, not past it: a single long line must not
    // overshoot the cap by its whole length (the marker rides after it).
    const room = outputCap - written;
    if (text.length > room) {
      out.write(text.slice(0, room));
      written = outputCap;
      if (!clipped) { clipped = true; out.write(clipMarker); }
      return;
    }
    written += text.length;
    out.write(text);
  };
  // The worker streams raw chunks over IPC; the line split and the screen
  // happen here, as before — a split multi-byte character is whole again by
  // the time the line is written (the worker decodes per stream, not per
  // chunk, the same rule runShell held).
  const feed = (/** @type {string} */ chunk) => {
    pending += String(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) write(world.scrub(scrubSecretDiff(scrubOutput(line, secrets))) + '\n');
    // The unsplit tail is held until its newline arrives — a command that
    // prints one endless line would hold its whole output in memory while
    // the disk cap above already said "stop". Past the cap, flush the
    // tail through the same write (cap + marker own the ending), so memory
    // stays bounded by outputCap, not by the longest line.
    if (pending.length > outputCap) {
      write(world.scrub(scrubSecretDiff(scrubOutput(pending, secrets))));
      pending = '';
    }
  };
  const finishJob = (/** @type {number|null} */ code, /** @type {string|null} */ sig) => /** @type {Promise<void>} */ (new Promise((resolve) => {
    if (settled) return resolve();
    // `settled` flips only after the audit line is written: write() drops
    // text once settled, and the audit line is the last thing the job says.
    if (pending) write(world.scrub(scrubSecretDiff(scrubOutput(pending, secrets))));
    pending = '';
    const notes = world.notes();
    if (notes) write(`\n${notes}\n`);
    if (signal) signal.removeEventListener('abort', onAbort);
    // The shared-dir audit rides the job's end, like a foreground RUN's.
    void (async () => {
      try {
        const audit = await auditSharedDirs(root, lock);
        const bad = [
          ...audit.changed.map((f) => `${f} (changed)`),
          ...audit.added.map((f) => `${f} (added)`),
          ...audit.deleted.map((f) => `${f} (deleted)`),
        ];
        if (bad.length) {
          write(`\nerr: the run changed a shared directory — ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? `, and ${bad.length - 10} more` : ''} — the change is left on disk; review it, or restore the folder.\n`);
        }
      } catch { /* the audit is a second layer */ }
      settled = true;
      try { await unlockSharedDirs(root, lock); } catch { /* best effort */ }
      try { worker.disconnect(); } catch { /* already gone */ }
      try { if (worker.exitCode === null) worker.kill(); } catch { /* already gone */ }
      // The stream is closed after every line is written, and the job is only
      // settled when the file is: a model that reads the locator the same
      // second must not find a half-written file.
      out.once('error', () => { liveSpillFiles.delete(file); releaseWorker(); world.dispose(); resolve(); });
      out.end(() => { liveSpillFiles.delete(file); releaseWorker(); world.dispose(); resolve(); });
    })();
  }));
  const onAbort = () => {
    stopped = true;
    try { worker.send({ type: 'stop', id: 'job' }); } catch { /* already gone */ }
    const grace = setTimeout(() => killTree(worker), 3_000);
    grace.unref?.();
  };
  if (signal) {
    if (signal.aborted) { onAbort(); }
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const done = new Promise((resolve) => {
    worker.on('error', (err) => {
      write(`\nerr: the command could not start: ${String(err?.message ?? err)}\n`);
      void finishJob(null, null).then(() => resolve({ code: null, signal: null, stopped }));
    });
    worker.on('exit', (code, sig) => {
      // The worker died without an exit message: the job ends, the backend
      // stays up, and the spill file says what happened.
      if (settled) return;
      write(`\nerr: the shell worker exited (${code ?? sig ?? '?'}) before the command answered\n`);
      void finishJob(null, sig ?? null).then(() => resolve({ code: null, signal: sig ?? null, stopped }));
    });
    worker.on('message', (/** @type {any} */ msg) => {
      if (msg?.type === 'data') { feed(String(msg.chunk ?? '')); return; }
      if (msg?.type !== 'exit') return;
      if (msg.error) write(`\nerr: ${String(msg.error)}\n`);
      void finishJob(msg.code ?? null, msg.signal ?? null).then(() => resolve({ code: stopped ? null : (msg.code ?? null), signal: msg.signal ?? null, stopped }));
    });
  });
  worker.send({ type: 'run', id: 'job', command, cwd: world.cwd, allowedRoot: world.cwd, timeoutMs: 24 * 60 * 60 * 1000, maxBuffer: outputCap, stream: true });

  return {
    name: finalName,
    outputRel: rel,
    done,
    stop: async () => {
      stopped = true;
      try { worker.send({ type: 'stop', id: 'job' }); } catch { /* already gone */ }
      const grace = setTimeout(() => killTree(worker), 3_000);
      grace.unref?.();
      await done;
      return { stopped: true };
    },
  };
}
