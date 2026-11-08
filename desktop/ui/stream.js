// @ts-check
// The event transport: the EventSource, the watchdog that writes a run off
// when it goes silent, and the project/session filter every handler shares.
//
// Split out of app.js so the window's wiring is not one 2,800-line file.
// The per-event handlers stay with the view (app.js); this module owns only
// the stream itself and who is allowed to paint from it.

/**
 * Open the event stream and start the watchdog.
 *
 * Needs, from the shared context: `$`, `state`, `rpc`, `client`, `setLogBusy`,
 * `setHint`, `setWorking`, `addNote`, `refreshMeter` and (optionally)
 * `refreshContextPanel`.
 *
 * @param {any} ctx
 * @returns {Promise<{ stream: any, onRun: Function, onAny: Function, sameProject: Function, isOwnProject: Function, foreignProject: Function, beat: Function }>}
 */
export async function createEventStream(ctx) {
  const { $, state, rpc, client, setLogBusy, setHint, setWorking, addNote, refreshMeter } = ctx;

  // EventSource cannot set headers, so the token (when there is one) rides the
  // URL — rpc.mjs accepts `?token=` on /events. This resolves before the stream
  // opens: a window under auth never starts in a 401 reconnect loop.
  const token = await client.ensureToken();
  const stream = new EventSource(token ? `/events?token=${encodeURIComponent(token)}` : '/events');

  // The transport, not the run. When the backend process goes away the stream
  // drops and the window used to sit there with a live spinner on a run that no
  // longer existed. Now it says so, and gives the run a deadline: if nothing
  // arrives for a while, the run is treated as lost rather than hanging forever.
  let lastEventAt = Date.now();
  let quietSince = 0;
  let warnedSilence = false;
  // The silence epoch: when the transport last stopped producing real events.
  // Unlike `quietSince`, it is cleared only by `beat()` — a backend that stays
  // alive but stops streaming must still cross the 60s / 90s / 180s rails.
  let silenceSince = 0;
  let warnedQuiet60 = false;
  let askedQuiet90 = false;
  /** Refresh the watchdog clock: any frame — or the run's own first frame —
   *  is proof the transport is alive. */
  const beat = () => { lastEventAt = Date.now(); quietSince = 0; warnedSilence = false; silenceSince = 0; warnedQuiet60 = false; askedQuiet90 = false; };
  stream.addEventListener('open', beat);
  stream.addEventListener('message', beat);
  // rpc.mjs sends a named ping every 15 s precisely so this watchdog reads
  // "the backend died", not "the model went quiet": a long RUN or SEARCH streams
  // no other frames for a while, and nothing else here refreshes the clock.
  stream.addEventListener('ping', beat);

  stream.onerror = () => {
    if (stream.readyState === EventSource.CONNECTING) {
      addNote('backend ตัดการเชื่อม — กำลังลองเชื่อมใหม่…');
    }
  };

  // Every event refreshes the watchdog; a run that stops sending anything is
  // reported as lost instead of blocking the composer forever.
  //
  // But a quiet stream is not the same as a dead run, and the difference
  // matters: the window used to write the run off AND cancel it upstream after
  // twenty silent seconds. A run whose backend was briefly unreachable — the
  // laptop slept, the stream was reconnecting, the backend was restarting — is
  // still running on the backend, and cancelling it threw away work that was
  // going to finish. The window's own snapshot recovery then showed a run that
  // had been stopped for no reason at all.
  //
  // So the watchdog asks before it cancels: the backend is asked whether it is
  // alive. If it answers, the run is legitimate and the window waits. If it
  // does not, the backend really is gone, and the run is written off.
  //
  // The probe is bounded, and only one flies at a time. A backend that accepts
  // and never answers would otherwise leave a pending fetch behind on every
  // tick, and the browser's per-origin connection cap would stall every other
  // call the window makes — including the ones that would have noticed the
  // backend coming back. An aborted probe means "cannot say": it is not a
  // refusal, so it gets three strikes before the write-off, but a refusal
  // (connection refused, the process gone) is answered at once.
  /** @type {any} */
  let statusProbe = null;
  let probeGen = 0;
  let probeFails = 0;
  const HARD_SILENCE_CEILING_MS = 180_000; // 3 minutes continuous silence ceiling

  setInterval(async () => {
    if (!state.running) {
      quietSince = 0;
      warnedSilence = false;
      silenceSince = 0;
      warnedQuiet60 = false;
      askedQuiet90 = false;
      return;
    }
    const now = Date.now();
    if (now - lastEventAt <= 20_000) {
      // The stream is back, so any strikes the last outage collected mean
      // nothing: the next one starts from zero.
      probeFails = 0;
      quietSince = 0;
      warnedSilence = false;
      return;
    }

    if (!quietSince) quietSince = lastEventAt;
    if (!silenceSince) silenceSince = lastEventAt;
    const silentMs = now - silenceSince;

    // Hard ceiling: three minutes of continuous silence, even with the
    // backend answering, means the run is stalled forever — a spinner here
    // is a lie, and the next submit would only queue behind a ghost run.
    if (silentMs > HARD_SILENCE_CEILING_MS) {
      state.running = false;
      state.stopping = false;
      setLogBusy(false);
      $('send').textContent = 'ส่ง';
      setHint('');
      setWorking(false);
      rpc('cancel', { root: state.root ?? undefined }).catch(() => {});
      addNote('run นี้เงียบเกิน 3 นาทีต่อเนื่อง แม้ backend ยังเปิดอยู่ — ถือว่าหยุดแล้ว · ลองส่งใหม่ หรือเช็ค aipass doctor');
      refreshMeter();
      ctx.refreshContextPanel?.();
      quietSince = 0;
      warnedSilence = false;
      silenceSince = 0;
      warnedQuiet60 = false;
      askedQuiet90 = false;
      return;
    }

    // First rail (60s): say it out loud. A long quiet used to read as a dead
    // composer — the window said nothing for a minute and the human filled
    // the gap with a second submit. This does not touch the run.
    if (silentMs > 60_000 && !warnedQuiet60) {
      warnedQuiet60 = true;
      addNote('สตรีมเงียบ 60 วินาที — backend ยังตอบอยู่ ไม่ได้เขียน run ทิ้ง · กำลังรอสตรีมกลับมา');
    }
    // Second rail (90s): a question, not a cliff. The hard ceiling above is
    // still what ends it; this just gives the human the choice earlier, and
    // the stop below it. The stream may still come back on its own.
    if (silentMs > 90_000 && !askedQuiet90) {
      askedQuiet90 = true;
      addNote('สตรีมเงียบ 90 วินาที — backend ยังตอบอยู่ · รอต่อได้ หรือกดหยุดเพื่อหยุด run นี้');
      setHint('สตรีมเงียบเกิน 90 วินาที — รอต่อได้ หรือกดหยุด run');
    }

    // The transport is down but the backend may not be. A reconnecting
    // EventSource is CONNECTING, and the backend is still running behind it.
    const reconnecting = stream.readyState === EventSource.CONNECTING;
    // Ask the backend whether THIS run is still going, not merely whether it
    // answers: pass root so we check the exact project the window is running.
    if (statusProbe) statusProbe.abort();
    probeGen += 1;
    const gen = probeGen;
    const ctrl = new AbortController();
    statusProbe = ctrl;
    const probeTimer = setTimeout(() => ctrl.abort(), 4_000);
    const st = await rpc('status', { root: state.root ?? undefined }, statusProbe.signal)
      .catch((/** @type {any} */ err) => (err?.name === 'AbortError' ? 'hung' : null))
      .finally(() => clearTimeout(probeTimer));
    if (gen !== probeGen) return; // a newer probe superseded this one
    statusProbe = null;
    const answered = st && st !== 'hung';
    if (answered) {
      probeFails = 0;
    } else if (st === 'hung' && ++probeFails < 3) {
      return; // cannot say yet — the backend may just be slow; wait for the next tick
    }
    const ended = Boolean(answered) && st.running === false && (!state.root || st.root === state.root);
    const alive = Boolean(answered) && !ended;
    if (alive) {
      // The backend answered: the run is still going, and the silence was the
      // transport, not the run. Wait. The clock is refreshed so the watchdog
      // does not fire again on every tick until the stream is back.
      lastEventAt = Date.now();
      if (!reconnecting && !warnedSilence) {
        warnedSilence = true;
        addNote('backend ยังตอบอยู่แต่สตรีมเงียบ — รอสตรีมกลับมา');
      }
      return;
    }
    // The backend does not answer or the run has ended.
    state.running = false;
    state.stopping = false;
    setLogBusy(false);
    $('send').textContent = 'ส่ง';
    setHint('');
    // The run is written off, so the window stops saying it is working: a
    // heartbeat that keeps beating for a run nobody has is a lie.
    setWorking(false);
    // The window has written the run off; the backend is told as well, so the
    // next task does not bump into a run that is still in flight there ("a run
    // is already in flight" was what a lost run looked like from the composer).
    rpc('cancel', { root: state.root ?? undefined }).catch(() => {});
    addNote(ended
      ? 'run นี้จบไปแล้วที่ backend แต่สตรีมไม่ได้ส่งสัญญาณจบมา — ถือว่าหยุดแล้ว'
      : st === 'hung'
        ? 'backend ไม่ตอบสนองสักที (สถานะค้าง) — ถือว่า run หยุดแล้ว · ลองส่งใหม่ หรือเช็ค aipass doctor'
        : 'run นี้เงียบไป 20 วินาที และ backend ไม่ตอบ — ถือว่าหยุดแล้ว · ลองส่งใหม่ หรือเช็ค aipass doctor');
    refreshMeter();
    ctx.refreshContextPanel?.();
    quietSince = 0;
    warnedSilence = false;
  }, 5_000);

  /* Which project an event belongs to ---------------------------------------
   *
   * Every run event carries the project that emitted it (rpc.mjs tags harness
   * events with the project root). A window shows one project at a time; a run
   * left going in another project must not paint here — its `step` would fold
   * this answer, its `done_line` would end this turn, its tool rows would trail
   * prose they never followed. `onRun` drops everything tagged for another
   * project; untagged events come from the backend itself (settings, project
   * list) and always pass.
   *
   * Two families listen with `onAny` instead, because they are not this
   * window's transcript: the chat-tab banner (one shared tab serves every
   * project, and one click fixes all of them) and the permission/plan questions
   * — a dropped question would leave that run waiting on an answer nobody can
   * see. Those name the other project so the answer is never blind.
   */
  const sameProject = (/** @type {any} */ a, /** @type {any} */ b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();

  /**
   * Is this project one of ours?
   *
   * Two, when the window is inside a worktree: the project the worktree was
   * made from, and the worktree itself. The run's frames carry the folder they
   * happened in, and a frame from the worktree is as much ours as one from the
   * project — otherwise the run in the worktree would be invisible.
   */
  const isOwnProject = (/** @type {any} */ project) => !project || !state.root
    || sameProject(project, state.root)
    || (state.runRoot && sameProject(project, state.runRoot));

  /** null when the event belongs to this window's project; otherwise the
   *  project's folder name, for the answer surfaces that show anyway. */
  function foreignProject(/** @type {any} */ project) {
    if (!project || isOwnProject(project)) return null;
    return String(project).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(project);
  }

  function onRun(/** @type {any} */ name, /** @type {any} */ fn) {
    stream.addEventListener(name, (e) => {
      const data = JSON.parse(e.data);
      if (data.project && state.root && !isOwnProject(data.project)) return;
      // A run's frames name the session that run writes to (rpc.mjs tags them
      // at the harness boundary). A window showing a different session must not
      // take them: an `assistant_delta` would write a running task into an old
      // transcript, a `finished` would fold a trail that is not on screen. The
      // `session` announcement is the one exception — adopting the new id is
      // exactly how the window follows a run that opens a session. Untagged
      // frames are backend-level and always pass.
      if (name !== 'session' && data.session && state.sessionId && data.session !== state.sessionId) return;
      fn(data, e);
    });
  }

  function onAny(/** @type {any} */ name, /** @type {any} */ fn) {
    stream.addEventListener(name, (e) => fn(JSON.parse(e.data), e));
  }

  return { stream, onRun, onAny, sameProject, isOwnProject, foreignProject, beat };
}

export default createEventStream;
