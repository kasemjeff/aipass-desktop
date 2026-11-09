// @ts-check
// The shell worker: a child process that owns one shell command, and nothing else.
//
// Why it exists (P0 — Harden Execution Sandbox): the backend used to spawn the
// shell itself (`child_process.spawn` in execution.mjs). The shell then ran as a
// direct child of the backend, with the backend's full environment — every token
// the backend holds was one `set` away from the transcript — and a shell that
// hung, leaked, or crashed took the backend's request with it. This worker is
// the separation: the backend forks THIS file, the worker spawns the shell with
// a sanitized environment and a confined cwd, and the backend only ever sees
// the worker's reply. If the worker dies, the backend answers `err:` and stays up.
//
//   - environment: an allowlist of platform/toolchain variables, minus anything
//     whose name says it carries a credential (output-scrub.mjs owns that word
//     list). A command that needs a custom variable sets it in the command
//     itself (`set FOO=bar && ...`); it is not inherited by accident.
//   - cwd: the worker refuses a cwd that is not inside `allowedRoot`, resolved
//     through the filesystem (a junction is followed, so a link out of the root
//     is a link out of the root — the same rule Overlay.safe() holds).
//   - resource limits: a required timeout (the tree is killed, not the shell
//     alone), an output cap (execution.mjs owns the spill; the worker stops
//     accumulating past the cap), and a worker memory ceiling (the parent sets
//     `resourceLimits` at fork time). Concurrency is the parent's gate.
//   - argv mode: a future OS backend (bubblewrap/seatbelt) hands the worker an
//     argv array instead of a shell line — `shell: false`, no shell to escape
//     through. The shell line stays for `off` / `danger-full-access`.
//
// This file is both the worker and its own unit-test surface: imported, it
// exports the pure helpers; forked, it runs one command and answers over IPC.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isSecretName } from './output-scrub.mjs';
import { realPath } from './overlay.mjs';

/** Platform/toolchain variables a shell command may inherit. No secret lives
 *  here by name, and `sanitizeEnv` drops a secret-named one anyway — the two
 *  lists are independent on purpose (defence in depth, not one list trusted). */
export const ENV_ALLOW = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOGNAME',
  'USERNAME', 'USER', 'COMPUTERNAME', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PSModulePath',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'ProgramFiles', 'ProgramFiles(x86)',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NODE_PATH', 'npm_config_prefix',
  'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'JAVA_HOME', 'ANDROID_HOME',
]);

/**
 * The environment a shell child may see: the allowlist, minus secret names.
 * Pure — tested without spawning anything.
 */
export function sanitizeEnv(source = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of ENV_ALLOW) {
    const value = source?.[name];
    if (value == null || value === '') continue;
    if (isSecretName(name)) continue;
    out[name] = String(value);
  }
  return out;
}

/**
 * Is `cwd` inside `allowedRoot`, lexically and physically?
 * Returns the resolved cwd, or an error string. The physical half matters: a
 * junction inside the root that points elsewhere is a way out a resolved
 * string cannot see — the same two-boundary rule as Overlay.safe().
 *
 * @param {string} cwd
 * @param {string} allowedRoot
 * @returns {{ok: true, cwd: string}|{ok: false, error: string}}
 */
export function checkCwd(cwd, allowedRoot) {
  if (!cwd || !allowedRoot) return { ok: false, error: 'a shell cwd and its allowed root are both required' };
  const rootReal = realPath(path.resolve(allowedRoot)) ?? path.resolve(allowedRoot);
  const cwdReal = realPath(path.resolve(cwd)) ?? path.resolve(cwd);
  const rel = path.relative(rootReal, cwdReal);
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (outside) {
    return { ok: false, error: `cwd ${cwd} is outside the allowed root ${allowedRoot} — the command was not run.` };
  }
  return { ok: true, cwd: cwdReal };
}

/** The tree, not the shell alone — a timeout must end the command's own
 *  children (a server it started), or they hold the files the next RUN needs.
 *
 *  @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  if (!child.pid) { try { child.kill(); } catch { /* already gone */ } return; }
  if (process.platform === 'win32') {
    const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    tk.on('close', (code) => { if (code !== 0) { try { child.kill(); } catch { /* already gone */ } } });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { child.kill(); } catch { /* already gone */ }
}

/** Run one request. `send` is the IPC reply; `stream` (background jobs) forwards
 *  chunks as they arrive instead of buffering the whole output.
 *
 *  @param {any} msg
 *  @param {(payload: any) => void} send
 */
function runRequest(msg, send) {
  const { id, command, argv, cwd, allowedRoot, timeoutMs, maxBuffer = 10 * 1024 * 1024, stream = false } = msg ?? {};
  const done = (/** @type {any} */ payload) => send({ type: 'exit', id, ...payload });
  const checked = checkCwd(cwd, allowedRoot);
  if (!checked.ok) return done({ code: null, signal: null, stdout: '', stderr: '', error: checked.error });
  const hasArgv = Array.isArray(argv) && argv.length > 0;
  if (!hasArgv && !String(command ?? '').trim()) return done({ code: null, signal: null, stdout: '', stderr: '', error: 'the command is empty — the command was not run.' });
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) return done({ code: null, signal: null, stdout: '', stderr: '', error: 'a shell timeout is required — the command was not run.' });

  let child;
  try {
    child = hasArgv
      ? spawn(String(argv[0]), argv.slice(1).map(String), { cwd: checked.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: sanitizeEnv() })
      : spawn(String(command), { cwd: checked.cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', env: sanitizeEnv() });
  } catch (err) {
    const e = /** @type {any} */ (err);
    return done({ code: null, signal: null, stdout: '', stderr: '', error: `the command could not start: ${String(e?.message ?? e)}` });
  }
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let stopped = false;
  let settled = false;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  const cap = (/** @type {string} */ s, /** @type {string} */ d) => (s.length >= maxBuffer ? s : s + String(d));
  const onData = (/** @type {string} */ which) => (/** @type {any} */ d) => {
    const text = String(d);
    if (stream) send({ type: 'data', id, stream: which, chunk: text });
    else if (which === 'stdout') stdout = cap(stdout, text);
    else stderr = cap(stderr, text);
  };
  child.stdout?.on('data', onData('stdout'));
  child.stderr?.on('data', onData('stderr'));
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
  timer.unref?.();
  const finish = (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done({ code: stopped ? null : code, signal: signal ?? null, stdout: stream ? '' : stdout, stderr: stream ? '' : stderr, timedOut, stopped });
  };
  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const e = /** @type {any} */ (err);
    done({ code: null, signal: null, stdout, stderr, error: `the command could not start: ${String(e?.message ?? e)}` });
  });
  child.on('close', (code, signal) => finish(code, signal));
  // A stop from the parent: kill the tree, answer with the stopped shape.
  const onStop = (/** @type {any} */ m) => {
    if (m?.type !== 'stop' || m?.id !== id) return;
    stopped = true;
    killTree(child);
  };
  process.on('message', onStop);
  child.on('close', () => process.removeListener('message', onStop));
  send({ type: 'started', id, pid: child.pid ?? null });
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain && typeof process.send === 'function') {
  process.on('message', (/** @type {any} */ msg) => {
    if (msg?.type === 'run') runRequest(msg, (payload) => process.send?.(payload));
    else if (msg?.type === 'ping') process.send?.({ type: 'pong', id: msg?.id ?? null });
  });
}
