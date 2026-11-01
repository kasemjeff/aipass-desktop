#!/usr/bin/env node
// aipass acp — one protocol, any editor.
//
// Newline-delimited JSON-RPC 2.0 over stdio. The harness is the brain; this
// is a transport. It does not add a second one.
import { createInterface } from 'node:readline';
import path from 'node:path';
import { Harness } from './harness/harness.mjs';
import { Emitter } from './harness/events.mjs';
import { Settings, aipassHome, harnessOptions } from './harness/settings.mjs';
import { SessionStore } from './harness/session.mjs';

const sessions = new Map();
let nextId = 1;
const pending = new Map(); // id -> resolve

const rl = createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function reply(id, result) {
  out({ jsonrpc: '2.0', id, result });
}
function notify(method, params) {
  out({ jsonrpc: '2.0', method, params });
}
function errReply(id, code, message) {
  out({ jsonrpc: '2.0', id, error: { code, message } });
}

// server -> client request (permission). The editor answers in the ACP
// shape; the engine answers through permissions.answer with the request id
// the question carried.
function requestPermission(session, question) {
  return new Promise((resolve) => {
    const id = `perm-${nextId++}`;
    pending.set(id, resolve);
    out({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId: session.id,
        tool: question.kind,
        args: question.arg,
        preview: question.preview ?? '',
        risk: question.risk,
      },
    });
    // timeout: default deny
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ outcome: { outcome: 'rejected' } }); }
    }, 30000);
  });
}

// The editor's answer, read into the one word the engine understands. The
// ACP shape nests the decision; a bare word is accepted too. Anything
// unreadable is a deny — the answer that keeps the machine safe.
function permissionDecision(answer) {
  const word = typeof answer === 'string'
    ? answer
    : answer?.outcome?.outcome ?? answer?.outcome ?? answer?.decision ?? '';
  const said = String(word).toLowerCase();
  return said === 'allow' || said === 'always' ? said : 'deny';
}

function makeHarness(root, options = {}) {
  const store = new SessionStore(path.join(aipassHome(), 'sessions'));
  // A real Emitter, not a stub: the permission engine asks whether anyone is
  // listening before it asks a question (isObserved), and a shim without the
  // answer crashed every gated call instead of asking. The session wires its
  // own listeners after the harness exists — they need its id.
  const events = new Emitter();
  const h = new Harness({
    root,
    options: harnessOptions({ ...options, subagent: false }),
    store,
    events,
  });
  return { h, events };
}

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;

  // response to a permission request we sent
  if (id !== undefined && msg.result !== undefined && pending.has(id)) {
    const resolve = pending.get(id);
    pending.delete(id);
    resolve(msg.result);
    return;
  }

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { prompt: true, cancel: true, permission: true },
        serverInfo: { name: 'aipass', version: '0.2.0' },
      });
      return;
    }

    if (method === 'session/new') {
      const root = params.root || process.cwd();
      const { h, events } = makeHarness(root, params.options || {});
      const session = await h.startSession({ title: params.title || null });
      const sid = session?.id || `s-${sessions.size + 1}`;
      const entry = { id: sid, harness: h, root };
      // The notes ride to the editor as updates; a permission question rides
      // out as a request and its answer rides back into the engine, keyed by
      // the id the question carried.
      events.on('note', (payload) => notify('session/update', { sessionId: null, type: 'note', text: payload?.text }));
      events.on('permission_request', (question) => {
        void requestPermission(entry, question).then((answer) => {
          try { h.permissions.answer(question.id, permissionDecision(answer)); } catch { /* already answered */ }
        });
      });
      sessions.set(sid, entry);
      reply(id, { sessionId: sid });
      return;
    }

    if (method === 'session/prompt') {
      const entry = sessions.get(params.sessionId);
      if (!entry) { errReply(id, -32000, 'unknown session'); return; }
      const h = entry.harness;
      let finished = false;
      const onFinished = (payload) => {
        finished = true;
        reply(id, { stopReason: payload?.stopReason ?? 'done', summary: payload?.summary ?? '' });
      };
      h.events.on('finished', onFinished);
      try {
        await h.run(params.task || '', { first: params.first ?? null });
        if (!finished) reply(id, { stopReason: 'done', summary: '' });
      } catch (e) {
        if (!finished) errReply(id, -32000, e?.message ?? String(e));
      } finally {
        h.events.off('finished', onFinished);
      }
      return;
    }

    if (method === 'session/cancel') {
      const entry = sessions.get(params.sessionId);
      if (!entry) { errReply(id, -32000, 'unknown session'); return; }
      // The harness's own cancel is the whole stop: the run in flight, the
      // gates parked behind it, and the stop that lands between two runs —
      // a field nothing read could promise none of that.
      entry.harness.cancel();
      reply(id, { cancelled: true });
      return;
    }

    errReply(id, -32601, `method not found: ${method}`);
  } catch (e) {
    errReply(id, -32603, e?.message ?? String(e));
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
