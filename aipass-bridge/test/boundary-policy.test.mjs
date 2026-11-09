import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePolicy, backendFor, SANDBOX_MODES } from '../harness/boundary.mjs';

test('SANDBOX_MODES lists the four modes', () => {
  assert.deepEqual(SANDBOX_MODES, ['off', 'read-only', 'workspace-write', 'danger-full-access']);
});

test('off and danger-full-access carry no boundary and never refuse', () => {
  for (const mode of ['off', 'danger-full-access']) {
    const p = resolvePolicy({ sandboxMode: mode, backend: 'none' });
    assert.equal(p.refuse, null, mode);
    assert.equal(p.fs, 'none', mode);
    assert.equal(p.needsProjection, false, mode);
  }
});

test('a mode that needs enforcing refuses when there is no backend', () => {
  for (const mode of ['read-only', 'workspace-write']) {
    const p = resolvePolicy({ sandboxMode: mode, platform: 'win32', backend: 'none' });
    assert.ok(p.refuse, mode);
    assert.match(p.refuse, /not available/);
    assert.match(p.refuse, /danger-full-access/);
  }
});

test('a missing backend is never silently downgraded to a run', () => {
  const p = resolvePolicy({ sandboxMode: 'workspace-write', backend: 'none' });
  assert.equal(p.backend, 'none');
  assert.ok(p.refuse);
  // the policy does not claim it enforced anything
  assert.equal(p.fs, 'none');
});

test('an unknown mode is a refusal, never a silent downgrade to off', () => {
  // A typo ("readonly") that downgraded to 'off' would run unsandboxed — the
  // one thing the module header says it never ships.
  const p = resolvePolicy({ sandboxMode: 'bogus', backend: 'none' });
  assert.equal(p.sandboxMode, 'bogus');
  assert.match(p.refuse, /unknown sandbox mode/);
});

test('backendFor probes the platform tool from PATH and stays none on Windows', () => {
  // Injected onPath: the probe is the only platform input.
  assert.equal(backendFor('darwin', { onPath: () => '/usr/bin/sandbox-exec' }), 'seatbelt');
  assert.equal(backendFor('linux', { onPath: () => '/usr/bin/bwrap' }), 'bubblewrap');
  assert.equal(backendFor('darwin', { onPath: () => null }), 'none');
  assert.equal(backendFor('linux', { onPath: () => null }), 'none');
  assert.equal(backendFor('freebsd', { onPath: () => '/x' }), 'none');
  // Native Windows has no kernel boundary without the helper — never claimed.
  assert.equal(backendFor('win32', { onPath: () => '/x' }), 'none');
});

test('workspace-write with a real backend still refuses until the adapter is wired', () => {
  const p = resolvePolicy({ sandboxMode: 'workspace-write', backend: 'seatbelt', platform: 'darwin', allowHosts: ['example.com'] });
  // The fs/net shape is the adapters' contract; the refusal is fail-closed
  // until an adapter consumes it — a passthrough would only SAY it is on.
  assert.match(p.refuse, /adapter is not wired/);
  assert.match(p.refuse, /danger-full-access/);
  assert.equal(p.fs, 'write');
  assert.equal(p.needsProjection, true);
  assert.equal(p.net.mode, 'allowlist');
  assert.deepEqual(p.net.hosts, ['example.com']);
});

test('read-only with a real backend refuses until the adapter is wired', () => {
  const p = resolvePolicy({ sandboxMode: 'read-only', backend: 'bubblewrap', platform: 'linux' });
  assert.match(p.refuse, /adapter is not wired/);
  assert.equal(p.fs, 'read');
  assert.equal(p.needsProjection, false);
  assert.equal(p.net.mode, 'off');
});