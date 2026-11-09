// @ts-nocheck
// The second axis of a RUN: not "against which tree" (execution.mjs owns
// that) but "with which rights". A command's tree and its rights are two
// different questions, and answering them in one module would make either
// one impossible to test or swap without the other.
//
// This module is the seam. Behind it sit the platform backends (Seatbelt,
// bubblewrap, a Windows helper, or 'none'), and in front of it sit the
// RUN/VERIFY/JOBS tools, which learn one option (`sandbox`) and never which
// backend is answering. A module that has one adapter is a hypothetical
// seam; this one has at least two (a real backend and 'none', plus 'fake'
// for tests), so it earns its keep.
//
// Fail closed is the rule: a sandbox mode that cannot be enforced is
// refused, never silently downgraded to "run anyway". A downgrade is the
// one thing this project does not ship.
import { platform } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** The sandbox modes a run may be given. */
export const SANDBOX_MODES = Object.freeze(['off', 'read-only', 'workspace-write', 'danger-full-access']);

/**
 * Is `name` on PATH? A PATH scan, not a spawn: no process, no shell, so this
 * stays pure enough to call wherever a backend is resolved (rule 9). The
 * PATHEXT half is what makes a `.exe`/`.cmd` shim count on Windows.
 */
export function findOnPath(name, { pathEnv = process.env.PATH ?? '', pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD', win = process.platform === 'win32' } = {}) {
  const exts = win ? ['', ...String(pathExt).split(';').filter(Boolean)] : [''];
  for (const dir of String(pathEnv).split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const abs = path.join(dir, name + ext);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
      } catch { /* unreadable PATH entry: not a backend */ }
    }
  }
  return null;
}

/**
 * Which backend this platform can offer today, probed from PATH. Phase 1
 * shipped none everywhere; the probe names Seatbelt/bubblewrap when the
 * platform tool is actually installed, so a machine that has them is not
 * told its modes refuse. Native Windows stays 'none' on purpose: there is
 * no kernel filesystem boundary without the Windows helper (AppContainer),
 * and claiming one would be the silent downgrade this module forbids — the
 * Windows rung is the projection + shared-dir lock (sandbox.mjs), and
 * enforcing modes refuse here rather than run unsandboxed.
 */
export function backendFor(p = platform(), { onPath = findOnPath } = {}) {
  if (p === 'darwin') return onPath('sandbox-exec') ? 'seatbelt' : 'none';
  if (p === 'linux') return onPath('bwrap') ? 'bubblewrap' : 'none';
  if (p === 'win32') return 'none';  // the Windows helper lands in wave E
  return 'none';
}

/** Resolve the policy for one run. Pure: no I/O, no spawn, so it is tested
 *  without an OS. `backend` may be injected by a test; otherwise it is
 *  derived from the platform. */
export function resolvePolicy({ sandboxMode = 'off', platform: p = platform(), backend = null, allowHosts = [] } = {}) {
  const b = backend ?? backendFor(p);
  // An unknown mode is a refusal, not a downgrade to 'off': a typo
  // ("readonly") that ran unsandboxed would be the one thing this module's
  // header says it never ships.
  if (!SANDBOX_MODES.includes(sandboxMode)) {
    return {
      sandboxMode, backend: b,
      refuse: `unknown sandbox mode "${sandboxMode}" — the command was not run. One of: ${SANDBOX_MODES.join(', ')}.`,
      fs: 'none', needsProjection: false,
      net: { mode: 'off', hosts: [] },
      danger: false,
    };
  }
  const mode = sandboxMode;
  // 'off' and 'danger-full-access' carry no boundary: the command runs with
  // the person's rights, exactly as it did before this module existed.
  if (mode === 'off' || mode === 'danger-full-access') {
    return {
      sandboxMode: mode, backend: b, refuse: null,
      fs: 'none', needsProjection: false,
      net: { mode: 'off', hosts: [] },
      danger: mode === 'danger-full-access',
    };
  }
  // A mode that needs enforcing but has no backend is a refusal, not a
  // silent run. This is the whole point of the row.
  if (b === 'none') {
    return {
      sandboxMode: mode, backend: b,
      refuse: `the sandbox backend is not available on ${p} — the command was not run. Set sandbox: danger-full-access to run it without one.`,
      fs: 'none', needsProjection: false,
      net: { mode: 'off', hosts: [] },
      danger: false,
    };
  }
  // A real backend tool is installed, but its enforcing adapter is not wired
  // into the shell worker in this build (bubblewrap/seatbelt argv lands with
  // the adapters, wave B2). Passing the command through unsandboxed while
  // the policy claims `fs: read/write` would be a mode that only SAYS it is
  // on — the failure FEATURE_GAPS_WAVE3 3.1 forbids. Refuse, and name it.
  const adapterPending = `the sandbox backend "${b}" is installed on ${p} but its enforcing adapter is not wired in this build — the command was not run. Set sandbox: danger-full-access to run it without one.`;
  if (mode === 'read-only') {
    return {
      sandboxMode: mode, backend: b, refuse: adapterPending,
      fs: 'read', needsProjection: false,
      net: { mode: 'off', hosts: [] },
      danger: false,
    };
  }
  // workspace-write
  return {
    sandboxMode: mode, backend: b, refuse: adapterPending,
    fs: 'write', needsProjection: true,
    net: { mode: allowHosts.length ? 'allowlist' : 'off', hosts: [...allowHosts] },
    danger: false,
  };
}

/** Build the adapter a tool will call. `runShell` is the today's runner; a
 *  real backend replaces it. The adapter's interface is the only thing the
 *  tools learn. */
export function makeBoundary(policy, { runShell, projectionRoot = null, tempRoot = null } = {}) {
  const refuse = policy.refuse;
  const passthrough = (command, opts) => runShell(command, opts);

  return {
    mode: policy.sandboxMode,
    backend: policy.backend,
    available: () => ({ ok: !refuse && (policy.sandboxMode === 'off' || policy.sandboxMode === 'danger-full-access' || policy.backend !== 'none'), reason: refuse }),
    // `run` answers with the same shape runShell does: {stdout,stderr} or a
    // thrown Error carrying code/signal/stdout/stderr. A refusal is returned
    // as an `err:` string so the model reads what happened.
    async run(command, opts = {}) {
      if (refuse) return { __refused: true, message: `err: ${refuse}` };
      // The only non-refusing modes are 'off' and 'danger-full-access';
      // both are passthrough by contract. Any mode that needs enforcing
      // carries a refusal above — a passthrough here is never a sandbox.
      return passthrough(command, opts);
    },
  };
}

/** Convenience: resolve + build in one call, for the tools. */
export function boundaryFor({ sandboxMode, platform: p, backend, allowHosts, runShell, projectionRoot, tempRoot } = {}) {
  const policy = resolvePolicy({ sandboxMode, platform: p, backend, allowHosts });
  return { policy, boundary: makeBoundary(policy, { runShell, projectionRoot, tempRoot }) };
}
