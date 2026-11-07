// The window's heartbeat: is the app still working?
//
// A run takes minutes — a model that reads twenty files does not answer in a
// second — and the window has to keep saying so the whole time. A word that
// appears once and then sits there is not a signal; motion and a clock are.
//
// Three things say it, and they say it at once:
//   - the bar over the foot of the transcript: bouncing dots and a clock,
//   - the pulsing dot under the composer (setHint),
//   - the send button, which becomes the stop.
//
// The bar floats over the transcript rather than sitting at the end of it: a
// marker at the bottom of a long answer cannot answer "is it still working?"
// to a reader who has scrolled up to re-read something. It is decoration for
// the eye — the screen reader gets the same news from the hint line, which
// says it once instead of every second.

/**
 * The heartbeat. Takes the DOM helpers it paints through (`$`, `log`), so a
 * boot can build it before the shared context exists.
 *
 * @param {{ $: (id: string) => any, log: any }} ctx
 */
export function createWorking(ctx) {
  const $ = ctx.$;
  const log = ctx.log;
  let workingSince = 0;
  let workingLabel = 'กำลังทำงาน';
  let workingClock = null;

  /** The bar as it stands: what the run is doing, and for how long. */
  function paintWorking() {
    const text = $('working-text');
    if (text) text.textContent = workingLabel;
    const clock = $('working-time');
    if (clock) {
      const secs = workingSince ? Math.floor((Date.now() - workingSince) / 1000) : 0;
      clock.textContent = `${secs}s`;
    }
  }

  /**
   * Say that the app is working — or that it stopped.
   *
   * @param {boolean} on
   * @param {{label?: string}} [opts] the words, for the moment that is not
   *   plain work (a stop winding down, say).
   */
  function setWorking(on, { label = 'กำลังทำงาน' } = {}) {
    workingLabel = label;
    if (on) {
      // One clock per run: a second run in the same window starts a new one.
      if (!workingClock) {
        workingSince = Date.now();
        workingClock = setInterval(paintWorking, 1000);
      }
    } else if (workingClock) {
      clearInterval(workingClock);
      workingClock = null;
      workingSince = 0;
    }
    $('working')?.classList.toggle('hidden', !on);
    // The log grows a little at the foot while the bar is up, so the bar never
    // sits on top of the last line of the answer.
    log.classList.toggle('busy', Boolean(on));
    if (on) paintWorking();
  }

  return { setWorking, paintWorking };
}

export default createWorking;
