// The SSE endpoint (rpc/sse.mjs) as a unit: the integration tests drive
// it over real HTTP (sse-cleanup.test.mjs), but the drain flush, the named
// ping and its error paths only fire on 15 s timers or socket pressure —
// unreachable there. Fake req/res answer here, and the ping timer is
// captured instead of waited for (a real 15 s interval would also keep
// this file's process alive forever).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseHandler } from '../harness/rpc/sse.mjs';

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const timers = [];
const cleared = [];
globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
globalThis.clearInterval = (id) => cleared.push(id);
after(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

function fakePair({ writeImpl } = {}) {
  const req = new EventEmitter();
  req.method = 'GET';
  req.headers = {};
  req.socket = new EventEmitter();
  req.socket.setKeepAlive = () => {};
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.written = [];
  res.head = null;
  res.writeHead = (code, headers) => { res.head = { code, headers }; };
  res.write = writeImpl ?? ((data, cb) => {
    res.written.push(data);
    if (cb) cb();
    return true;
  });
  return { req, res };
}

function fakeDeps(overrides = {}) {
  const sub = { flushed: 0, flush() { this.flushed += 1; } };
  const fanout = {
    subs: [],
    unsubs: [],
    subscribe(fn) { this.subs.push(fn); return sub; },
    unsubscribe(s) { this.unsubs.push(s); },
  };
  const jsonCalls = [];
  return {
    sub,
    fanout,
    jsonCalls,
    deps: {
      fanout,
      replay: [],
      getSeq: () => 7,
      authorized: () => true,
      // `authorizedQuery` is gone from the handler (a token in the URL is
      // refused); the deps carry only what the handler reads.
      
      json: (res, code, body) => jsonCalls.push({ res, code, body }),
      ...overrides,
    },
  };
}

test('a non-events request falls through to the next route', () => {
  const { deps } = fakeDeps();
  const handle = createSseHandler(deps);
  const { req, res } = fakePair();
  assert.equal(handle(req, res, new URL('http://x/run')), false);
  req.method = 'POST';
  assert.equal(handle(req, res, new URL('http://x/events')), false);
});

test('an unauthorized listener gets a 401 and the request is taken', () => {
  const { deps, jsonCalls } = fakeDeps({ authorized: () => false });
  const handle = createSseHandler(deps);
  const { req, res } = fakePair();
  assert.equal(handle(req, res, new URL('http://x/events')), true);
  assert.deepEqual(jsonCalls.map((c) => c.code), [401]);
  assert.match(jsonCalls[0].body.error, /unauthorized/);
  assert.equal(res.head, null, 'no stream was opened');
});

test('a reconnect replays what it missed, then the hello carries the live seq', () => {
  const { deps, fanout } = fakeDeps({
    replay: [
      { seq: 5, event: 'note', data: '{}' },
      { seq: 6, event: 'step', data: '{}' },
      { seq: 9, event: 'note', data: '{}' },
    ],
  });
  const handle = createSseHandler(deps);
  const { req, res } = fakePair();
  const url = new URL('http://x/events?since=6');
  assert.equal(handle(req, res, url), true);
  assert.equal(res.head.code, 200);
  const joined = res.written.join('');
  assert.match(joined, /event: note\nid: 9/, 'only frames after the cursor replay');
  assert.doesNotMatch(joined, /id: 5/, 'frames at or before the cursor do not');
  assert.match(joined, /event: hello\ndata: \{"seq":7\}/, 'and the hello names the live seq');
  assert.equal(fanout.subs.length, 1, 'the window subscribed to the fan-out');
});

test('the subscriber sink answers the write, and a throw answers false', () => {
  const { deps, fanout } = fakeDeps();
  const handle = createSseHandler(deps);
  let mode = 'ok';
  const { req, res } = fakePair({
    writeImpl: (data, cb) => {
      if (mode === 'throw') throw new Error('dropped');
      if (cb) cb();
      return mode === 'full' ? false : true;
    },
  });
  handle(req, res, new URL('http://x/events'));
  const sink = fanout.subs[0];
  assert.equal(sink('frame'), true, 'a written frame keeps the subscriber');
  mode = 'full';
  assert.equal(sink('frame'), false, 'a full buffer pauses the fan-out');
  mode = 'throw';
  assert.equal(sink('frame'), false, 'a dropped socket also pauses it');
});

test('a drain flushes the missed frames to the window', () => {
  const { deps, sub } = fakeDeps();
  const handle = createSseHandler(deps);
  const { req, res } = fakePair();
  handle(req, res, new URL('http://x/events'));
  res.emit('drain');
  assert.equal(sub.flushed, 1);
});

test('the named ping fires, and a dead socket or write error cleans up once', () => {
  const { deps, fanout } = fakeDeps();
  const handle = createSseHandler(deps);
  const { req, res } = fakePair();
  const before = timers.length;
  handle(req, res, new URL('http://x/events'));
  assert.equal(timers.length, before + 1, 'the ping timer is running');
  const ping = timers.at(-1);
  assert.equal(ping.ms, 15_000, 'on the 15 s watchdog budget');
  ping.fn();
  assert.ok(res.written.some((w) => w.includes('event: ping')), 'the ping is a named frame, not a comment');
  // A destroyed response ends the subscriber instead of pinging a ghost.
  res.destroyed = true;
  ping.fn();
  assert.equal(fanout.unsubs.length, 1, 'and the subscriber is taken out');
  assert.ok(cleared.length >= 1, 'and the timer is cleared');
  // A write error from the ping also ends it — and cleanup is idempotent.
  const second = fakePair();
  handle(req, second.res, new URL('http://x/events'));
  second.res.write = (data, cb) => cb(new Error('gone'));
  timers.at(-1).fn();
  assert.equal(fanout.unsubs.length, 2, 'the write error cleaned up the second subscriber');
  req.emit('close');
  res.emit('close');
  assert.equal(fanout.unsubs.length, 2, 'further signals do not clean up twice');
});

test('a stale Last-Event-ID from a dead process still delivers run_interrupted', () => {
  // The backend restarted: the window's cursor (500) is past this process's
  // seq (7), and the startup resume offer sits at seq 1. A plain `seq > since`
  // replay would send nothing and the window would never offer the resume.
  const { deps } = fakeDeps({
    getSeq: () => 7,
    replay: [
      { seq: 1, event: 'run_interrupted', data: '{"seq":1,"id":"s9","title":"crashed"}' },
      { seq: 2, event: 'note', data: '{"seq":2}' },
    ],
  });
  const handle = createSseHandler(deps);
  const { req, res } = fakePair();
  req.headers['last-event-id'] = '500';
  assert.equal(handle(req, res, new URL('http://x/events')), true);
  const joined = res.written.join('');
  assert.match(joined, /event: run_interrupted\nid: 1/, 'the startup alert is replayed to a stale cursor');
  assert.doesNotMatch(joined, /event: note\nid: 2/, 'ordinary frames are not replayed to the stale cursor');
});

test('a fresh listener replays run_interrupted and nothing else', () => {
  const { deps } = fakeDeps({
    getSeq: () => 7,
    replay: [
      { seq: 1, event: 'run_interrupted', data: '{"seq":1,"id":"s9","title":"crashed"}' },
      { seq: 2, event: 'note', data: '{"seq":2}' },
    ],
  });
  const handle = createSseHandler(deps);
  const { req, res } = fakePair();
  assert.equal(handle(req, res, new URL('http://x/events')), true);
  const joined = res.written.join('');
  assert.match(joined, /event: run_interrupted\nid: 1/, 'the startup alert reaches the fresh window');
  assert.doesNotMatch(joined, /event: note\nid: 2/, 'ordinary frames are not backfilled');
});

test('a write that throws during the ping cleans up too', () => {
  const { deps, fanout } = fakeDeps();
  const handle = createSseHandler(deps);
  const { req, res } = fakePair();
  handle(req, res, new URL('http://x/events'));
  res.write = () => { throw new Error('dropped'); };
  timers.at(-1).fn();
  assert.equal(fanout.unsubs.length, 1, 'the throwing ping ended the subscriber');
  res.emit('error', new Error('boom'));
  assert.equal(fanout.unsubs.length, 1, 'the error signal after that is a no-op');
});
