// The window's backend client, in isolation: token fetch, 401 retry,
// timeout and the refusal shape. Boots the real createRpcClient against
// a scripted fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpcClient } from '../../desktop/ui/rpc.js';

function scriptedFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return calls;
}
const okRes = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const tokenRes = (token) => ({ ok: true, status: 200, json: async () => ({ token }) });

test('fetchToken returns the token or null for every bad shape', async () => {
  let calls = scriptedFetch([tokenRes('abc')]);
  let client = createRpcClient({ getRoot: () => null });
  assert.equal(await client.fetchToken(), 'abc');

  calls = scriptedFetch([{ ok: false, status: 404, json: async () => ({}) }]);
  assert.equal(await client.fetchToken(), null);

  calls = scriptedFetch([{ ok: true, status: 200, json: async () => ({}) }]);
  assert.equal(await client.fetchToken(), null);

  calls = scriptedFetch([{ ok: true, status: 200, json: async () => ({ token: 123 }) }]);
  assert.equal(await client.fetchToken(), null);

  calls = scriptedFetch([new Error('down')]);
  assert.equal(await client.fetchToken(), null);
});

test('rpc carries the token and project headers, and returns the result', async () => {
  const calls = scriptedFetch([tokenRes('tok'), okRes(42)]);
  const client = createRpcClient({ getRoot: () => '/proj', rpcTimeoutMs: 5000 });
  await client.ensureToken();
  assert.equal(client.token(), 'tok');
  const out = await client.rpc('status', { a: 1 });
  assert.equal(out, 42);
  const post = calls.find((c) => c.url === '/rpc');
  assert.equal(post.opts.headers.authorization, 'Bearer tok');
  assert.equal(post.opts.headers['x-aipass-project'], '/proj');
  assert.match(post.opts.body, /status/);
  // ensureToken caches: a second call does not refetch
  const before = calls.length;
  await client.ensureToken();
  assert.equal(calls.length, before);
});

test('rpc without a token and without a root sends no auth headers', async () => {
  const calls = scriptedFetch([okRes('x')]);
  const client = createRpcClient({});
  assert.equal(client.token(), null);
  assert.equal(await client.rpc('credits'), 'x');
  const post = calls[0];
  assert.equal(post.opts.headers.authorization, undefined);
  assert.equal(post.opts.headers['x-aipass-project'], undefined);
});

test('a 401 refetches the token once and retries with the fresh one', async () => {
  const calls = scriptedFetch([
    tokenRes('old'),
    { ok: true, status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) },
    tokenRes('new'),
    okRes('retried'),
  ]);
  const client = createRpcClient({ getRoot: () => null });
  await client.ensureToken();
  assert.equal(await client.rpc('status'), 'retried');
  assert.equal(client.token(), 'new');
  const posts = calls.filter((c) => c.url === '/rpc');
  assert.equal(posts[0].opts.headers.authorization, 'Bearer old');
  assert.equal(posts[1].opts.headers.authorization, 'Bearer new');
});

test('a 401 with the same token does not retry', async () => {
  scriptedFetch([
    tokenRes('same'),
    { ok: true, status: 401, json: async () => ({ ok: true, result: 'still' }) },
    tokenRes('same'),
  ]);
  const client = createRpcClient({ getRoot: () => null });
  await client.ensureToken();
  // The body is ok:true, so rpc returns the result even on a 401 status.
  assert.equal(await client.rpc('status'), 'still');
});

test('a refusal throws with its stage, and a bad body becomes HTTP error', async () => {
  scriptedFetch([{ ok: true, status: 200, json: async () => ({ ok: false, error: 'boom', stage: 'preflight' }) }]);
  const client = createRpcClient({});
  await assert.rejects(() => client.rpc('run'), (e) => e.message === 'boom' && e.stage === 'preflight');

  scriptedFetch([{ ok: true, status: 500, json: async () => { throw new Error('no json'); } }]);
  await assert.rejects(() => client.rpc('run'), /HTTP 500/);
});

test('a timeout names the method and the budget', async () => {
  globalThis.fetch = async (url, opts) => {
    return new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  const client = createRpcClient({ rpcTimeoutMs: 20 });
  await assert.rejects(() => client.rpc('slow.method'), (e) => e.name === 'TimeoutError' && /slow\.method timed out/.test(e.message));
});

test('a caller abort is not rewritten as a timeout', async () => {
  globalThis.fetch = async (url, opts) => {
    return new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('caller stopped')));
    });
  };
  const client = createRpcClient({ rpcTimeoutMs: 5000 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(() => client.rpc('x', {}, ac.signal), (e) => e.message === 'caller stopped');
});
