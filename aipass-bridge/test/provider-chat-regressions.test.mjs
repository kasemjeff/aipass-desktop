// The chat turn's honesty: the four shapes that used to lose silently.
//
//  1. A stream that stalls mid-reply left chat() pending for ever —
//     models() had a deadline, chat() (the call every run makes) did not.
//  2. A reply cut at the token ceiling (`finish_reason: length`) was
//     indistinguishable from a finished one, so a cut file was staged as
//     complete.
//  3. A final SSE frame with no trailing blank line was dropped, and with
//     it the reply's last words.
//  4. Resuming a conversation id the client no longer holds (after a
//     backend restart) silently minted an empty history: one message
//     went out, the whole past was gone.
//
// Plus the two neighbours that carry them: the seed truncation that kept
// the head and dropped the tail (the tail is what the model acts on),
// and the one-fact forget the memory review needs.
//
// Run: node --test aipass-bridge/test/provider-chat-regressions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { ApiProviderClient } from '../harness/provider-client.mjs';
import { sanitizeSpec } from '../harness/providers.mjs';
import { Compactor } from '../harness/compact.mjs';
import { saveMemory, loadMemory, forgetMemory } from '../harness/memory-store.mjs';

const SPEC = {
  id: 'regress', kind: 'openai', baseUrl: 'https://api.example.com/v1',
  models: ['m'], defaultModel: null, headers: {},
};

async function withFetch(handler, what) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(url, init);
  try {
    return await what();
  } finally {
    globalThis.fetch = original;
  }
}

test('a stalled stream rejects with a timeout instead of hanging the run', async () => {
  // A provider that sends one chunk and then stays silent. The stall
  // deadline must fire and name itself; the run's send ladder can then
  // tell a dead transport from a cancelled one (TimeoutError, not
  // AbortError).
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    // Never another byte, never an end.
    req.on('close', () => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new ApiProviderClient(
      { ...SPEC, baseUrl: `http://127.0.0.1:${port}/v1` },
      { key: 'sk-test', stallTimeoutMs: 300 },
    );
    const started = Date.now();
    const err = await client.chat({ message: 'hi', model: 'm' }).then(
      () => { throw new Error('chat resolved from a stalled stream'); },
      (e) => e,
    );
    assert.ok(Date.now() - started < 3_000, 'the stall fired instead of hanging');
    assert.equal(err.name, 'TimeoutError', 'a deadline, not an abort');
    assert.match(err.message, /timed out \(stall, 300 ms\)/, 'and it says which clock fired');
    assert.equal(err.streamed, true, 'bytes were delivered before the stall, so a resend would double them');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a reply cut at the token ceiling is reported truncated, not finished', async () => {
  await withFetch(async () => new Response(
    'data: {"choices":[{"delta":{"content":"CREATE big.mjs\\npartial body"} }]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  ), async () => {
    const client = new ApiProviderClient(SPEC, { key: 'sk-test' });
    const out = await client.chat({ message: 'hi', model: 'm' });
    assert.equal(out.truncated, true, 'the cut is on the result');
    assert.equal(out.finishReason, 'length');
    assert.match(out.text, /partial body/, 'the partial text is still the text');
  });
});

test('a finished reply is not truncated', async () => {
  await withFetch(async () => new Response(
    'data: {"choices":[{"delta":{"content":"done"} }]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  ), async () => {
    const client = new ApiProviderClient(SPEC, { key: 'sk-test' });
    const out = await client.chat({ message: 'hi', model: 'm' });
    assert.equal(out.truncated, false);
    assert.equal(out.finishReason, 'stop');
  });
});

test("a final frame with no blank line still lands — the reply's last words are not dropped", async () => {
  await withFetch(async () => new Response(
    'data: {"choices":[{"delta":{"content":"first part "}}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":"LAST WORDS"}}]}',
    { headers: { 'content-type': 'text/event-stream' } },
  ), async () => {
    const client = new ApiProviderClient(SPEC, { key: 'sk-test' });
    const out = await client.chat({ message: 'hi', model: 'm' });
    assert.equal(out.text, 'first part LAST WORDS', 'the unterminated final frame is flushed, not lost');
  });
});

test('resuming a conversation the client no longer holds is an error, never a silent fresh start', async () => {
  let fetched = false;
  await withFetch(async () => {
    fetched = true;
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }, async () => {
    const client = new ApiProviderClient(SPEC, { key: 'sk-test' });
    const err = await client.chat({ message: 'hi', model: 'm', conversation: 'dead-conversation' }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, 'the dead id is named, so the run can swap and re-seed from the transcript');
    assert.match(err.message, /conversation not found: dead-conversation/);
    assert.equal(fetched, false, 'nothing was sent into the emptiness');

    // A conversation this client made still works.
    const conv = client.createConversation();
    const out = await client.chat({ message: 'hi', model: 'm', conversation: conv.id });
    assert.equal(out.text, 'ok');
  });
});

test("the chat clocks survive the spec, and a broken value never removes a deadline", () => {
  const spec = sanitizeSpec({ ...SPEC, firstByteTimeoutMs: 5000, stallTimeoutMs: 9000 });
  assert.equal(spec.firstByteTimeoutMs, 5000);
  assert.equal(spec.stallTimeoutMs, 9000);
  const broken = sanitizeSpec({ ...SPEC, firstByteTimeoutMs: -1, stallTimeoutMs: 'soon' });
  assert.equal(broken.firstByteTimeoutMs, null, 'a non-positive clock is dropped, so the default still applies');
  assert.equal(broken.stallTimeoutMs, null);
});

test('a seed that must shrink keeps the tail — the handoff — and cuts the middle', () => {
  const c = new Compactor({ keepRecentBytes: 0 });
  const summary = 'HEADMARK ' + 'x'.repeat(6000) + ' OUTSTANDING: the last step failed with error: ENOENT';
  const seed = c.seed({ summary, task: 't', preambleText: 'P', budgetChars: 2000 });
  assert.match(seed, /HEADMARK/, 'the head survives');
  assert.match(seed, /OUTSTANDING: the last step failed with error: ENOENT/, 'the tail — what the model must act on — survives');
  assert.match(seed, /truncated/, 'the cut is marked');
  assert.ok(!seed.includes('x'.repeat(6000)), 'the middle is what gives way');
});

test('forgetting one fact removes it from disk and leaves the rest', () => {
  const dir = tempDir();
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root);
  saveMemory(root, ['decision: keep the old column names', 'constraint: never delete the export', 'file: src/export.ts is the exporter'], dir);
  assert.equal(loadMemory(root, dir).length, 3);

  // The normalised match: case and spacing fold the way saving does.
  assert.equal(forgetMemory(root, '  Decision: keep the old column names ', dir), true);
  assert.deepEqual(loadMemory(root, dir), ['constraint: never delete the export', 'file: src/export.ts is the exporter']);

  // An empty target forgets nothing and says so.
  assert.equal(forgetMemory(root, '   ', dir), false);
  assert.equal(loadMemory(root, dir).length, 2);
});
