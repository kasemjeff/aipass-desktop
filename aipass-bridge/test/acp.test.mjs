import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const BIN = path.resolve('aipass-bridge/acp.mjs');
const NODE = process.execPath;

/**
 * Drive one acp process. A step may carry a `wait`: the server reads lines
 * as they come, and session/new answers only after its harness is built — a
 * cancel written ahead of that reply reads "unknown session". `until` ends
 * the drive the moment the responses satisfy it.
 */
function drive(steps, until = null) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [BIN], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    const responses = [];
    const finish = () => { try { child.kill(); } catch {} resolve(responses); };
    const queue = [...steps];
    const trySend = () => {
      while (queue.length && (!queue[0].wait || queue[0].wait(responses))) {
        const step = queue.shift();
        // A plain step IS the message; a step with `msg` carries it (a
        // function reads its answer out of the replies so far).
        const payload = typeof step.msg === 'function' ? step.msg(responses) : (step.msg ?? step);
        try { child.stdin.write(JSON.stringify(payload) + '\n'); } catch { /* gone */ }
      }
    };
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      let answered = false;
      for (const p of parts) {
        if (!p.trim()) continue;
        try { responses.push(JSON.parse(p)); answered = true; } catch { /* ignore */ }
      }
      if (answered) trySend();
      if (until && until(responses)) finish();
    });
    child.stderr.on('data', () => {});
    trySend();
    setTimeout(finish, 60000);
  });
}

test('initialize + session/new works over stdio', async () => {
  const res = await drive([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'session/new', params: { root: process.cwd() } },
  ], (all) => all.some((r) => r.id === 2));
  const init = res.find((r) => r.id === 1);
  const neu = res.find((r) => r.id === 2);
  assert.ok(init && init.result && init.result.capabilities, JSON.stringify(res));
  assert.ok(neu && neu.result && neu.result.sessionId, JSON.stringify(res));
});

test('session/cancel answers for the session it was given', async () => {
  // One process, the real session id, the cancel sent only after session/new
  // answered it. The old test started a second process where the id could
  // never exist and asserted only that an array came back — a test that
  // could not fail said nothing about cancel at all.
  const res = await drive([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'session/new', params: { root: process.cwd() } },
    {
      // The real session id, read from the reply it waits for.
      msg: (all) => {
        const sid = all.find((r) => r.id === 2)?.result?.sessionId;
        return { jsonrpc: '2.0', id: 3, method: 'session/cancel', params: { sessionId: sid } };
      },
      wait: (all) => all.some((r) => r.id === 2),
    },
  ], (all) => all.some((r) => r.id === 3));
  const sid = res.find((r) => r.id === 2)?.result?.sessionId;
  assert.ok(sid, JSON.stringify(res));
  const answer = res.find((r) => r.id === 3);
  assert.ok(answer && answer.result?.cancelled === true, JSON.stringify(res));
});
