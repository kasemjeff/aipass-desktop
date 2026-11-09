// @ts-nocheck
// The SSE endpoint: GET /events. Extracted from rpc.mjs so the socket
// lifecycle (replay, fan-out subscription, named pings, idempotent cleanup)
// lives in one small module instead of inside the route table.
//
// The handler returns true when it took the request, so the caller can fall
// through to the next route otherwise.

/**
 * @param {{fanout: any, replay: any[], getSeq: () => number, authorized: any, json: (res: any, code: number, body: any) => any}} deps
 */
export function createSseHandler({ fanout, replay, getSeq, authorized, json }) {
  return function handleEvents(req, res, url) {
    if (url.pathname !== '/events' || req.method !== 'GET') return false;
    // EventSource cannot set headers, and the token must never ride a URL:
    // /token minted it into the HttpOnly aipass_token cookie, which the
    // browser attaches to this same-origin request by itself. Header
    // bearers are accepted as before; `?token=` is not anymore.
    if (!authorized(req)) {
      json(res, 401, { ok: false, error: 'unauthorized: missing or wrong loopback bearer token' });
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // A reconnect carries `?since=` (and a browser EventSource reconnect
    // carries Last-Event-ID); replay what that listener missed before the
    // live stream continues. A brand-new listener with no cursor gets
    // nothing replayed — it starts from here, like the wire always did.
    const since = Number(
      req.headers['last-event-id']
      ?? url.searchParams.get('since')
      ?? 0,
    );
    // A stale cursor is a new process: `since` above this process's `seq` can
    // only be a Last-Event-ID carried across a backend restart, where the
    // startup `run_interrupted` sits at seq 1..N and `since` points past it.
    // Treating that listener as brand-new is what delivers the resume
    // offer instead of silently dropping it (the window does not poll for
    // it — the RPC fallback on `snapshot` is the second path, deduped in UI).
    const staleCursor = Number.isFinite(since) && since > getSeq();
    if (Number.isFinite(since) && since > 0 && !staleCursor) {
      for (const frame of replay) {
        if (frame.seq > since) res.write(`event: ${frame.event}\nid: ${frame.seq}\ndata: ${frame.data}\n\n`);
      }
    } else {
      // A brand-new (or stale-cursor) connection: replay startup alerts
      // (e.g. run_interrupted from a crashed predecessor) that were emitted
      // before the client connected.
      for (const frame of replay) {
        if (frame.event === 'run_interrupted') {
          res.write(`event: ${frame.event}\nid: ${frame.seq}\ndata: ${frame.data}\n\n`);
        }
      }
    }
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: getSeq() })}\n\n`);
    // The window is a subscriber of the fan-out now: its sink answers
    // whether it is still keeping up (`write` answers false when the
    // socket's buffer is full), and the fan-out stops writing to it until
    // the socket drains. The frames it missed wait in a bounded queue, and
    // the ones that did not fit are counted and named to it.
    const sub = fanout.subscribe((f) => {
      try { return res.write(f) !== false; } catch { return false; }
    });
    // The socket drained: the window can take the frames it missed.
    res.on('drain', () => sub.flush());
    // A named frame, never a bare `: keepalive` comment: comments are
    // invisible to EventSource, so the window's watchdog (no event for 20 s
    // ⇒ run lost) fired on any long RUN or SEARCH while the backend was
    // perfectly alive. It carries no id — a reconnect's Last-Event-ID still
    // points at the last real frame.
    // The ping is also the probe: a write to a dropped socket does not throw,
    // so a destroyed stream or a write that reports an error ends the
    // subscriber here, and TCP keepalive lets the kernel notice a peer that
    // left without a FIN (the same reasoning as the extension's stream in
    // bridge/server.mjs).
    req.socket?.setKeepAlive?.(true, 15_000);
    const ping = setInterval(() => {
      if (res.destroyed || res.writableEnded) { cleanup(); return; }
      try { res.write('event: ping\ndata: {}\n\n', (err) => { if (err) cleanup(); }); } catch { cleanup(); }
    }, 15_000);
    // One cleanup, from every signal a dropped connection can give.
    //
    // `req.on('close')` alone is not enough. A window that is suspended, a
    // laptop whose lid closes, a proxy that resets the connection — each of
    // those can leave the response half-open, and the subscriber then stays
    // in the fan-out with a socket that will never drain again. The frames
    // it missed keep filling its bounded queue until the oldest are dropped,
    // and the backend pays for a window that is not there.
    //
    // So the cleanup is idempotent and runs on whichever comes first: the
    // request ending, the response erroring, the response closing, or the
    // socket going away. The ping stops, the subscriber is taken out of the
    // fan-out, and nothing is left behind.
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      fanout.unsubscribe(sub);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.socket?.on('error', cleanup);
    req.socket?.on('close', cleanup);
    return true;
  };
}
