// @ts-check
// The window's client for the backend.
//
// Every call the window makes goes through here, so three things live in one
// place: the loopback token, the project header every call carries, and the
// shape of a refusal.
//
// The client is a factory, not a module-level object: the window's tests
// boot the page again and again, and a token that survived from the boot
// before would be the wrong token.

/**
 * The window's backend client.
 *
 * @param {object} ctx
 * @param {() => (string|null)} [ctx.getRoot] the project this window is showing
 * @param {number} [ctx.rpcTimeoutMs] per-call timeout; 30s when absent
 */
export function createRpcClient(ctx) {
  // When the backend asks for one — AIPASS_REQUIRE_AUTH, the default — every
  // /rpc and /events call needs the loopback token. The window is a same-origin
  // page served by that same backend, so it asks /token for it once at boot.
  /** @type {string|null} */
  let authToken = null;
  const defaultTimeoutMs = Number(ctx.rpcTimeoutMs) > 0 ? Number(ctx.rpcTimeoutMs) : 30_000;

  async function fetchToken() {
    try {
      const res = await fetch('/token');
      if (!res.ok) return null;
      const body = /** @type {any} */ (await res.json());
      return typeof body.token === 'string' && body.token ? body.token : null;
    } catch {
      return null;
    }
  }

  /**
   * One backend call. Resolves with the result, rejects with the
   * backend's refusal as an Error (its `stage` rides along when the
   * backend sent one), or a TimeoutError when the deadline passes.
   *
   * @param {string} method
   * @param {object} [params]
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  async function rpc(method, params = {}, signal) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), defaultTimeoutMs);
    const deadline = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const root = ctx.getRoot?.();
    const send = () => fetch('/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        ...(root ? { 'x-aipass-project': root } : {}),
      },
      body: JSON.stringify({ method, params }),
      signal: deadline,
    });
    try {
      let res = await send();
      // A 401 can mean the backend restarted between page load and this call.
      if (res.status === 401) {
        const fresh = await fetchToken();
        if (fresh && fresh !== authToken) { authToken = fresh; res = await send(); }
      }
      const body = /** @type {any} */ (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })));
      if (!body.ok) {
        const err = new Error(body.error ?? 'rpc failed');
        if (body.stage) /** @type {any} */ (err).stage = body.stage;
        throw err;
      }
      return body.result;
    } catch (err) {
      if (timeoutController.signal.aborted && !signal?.aborted) {
        const timeoutError = new Error(`rpc ${method} timed out after ${defaultTimeoutMs}ms`);
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function ensureToken() {
    if (!authToken) authToken = await fetchToken();
    return authToken;
  }

  return {
    rpc,
    fetchToken,
    ensureToken,
    token: () => authToken,
  };
}

export default createRpcClient;
