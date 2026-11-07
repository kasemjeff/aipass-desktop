// @ts-check
// The composer's draft: a typed paragraph that survives a reload, per project.
//
// Split out of app.js. The draft lives in the window's storage and comes back
// on the next boot. It is per project: one global draft meant switching
// project mid-thought left the old project's paragraph in the new project's
// composer. Before a root is known the legacy global key is read — the boot
// sequence replaces it with the adopted project's own draft as soon as it
// lands (restoreDraftForRoot).
//
// Needs from the context: `$` and `state` (for the current root).

/**
 * @param {any} ctx
 * @returns {{ draftKey: Function, loadDraft: Function, saveDraft: Function, saveDraftLater: Function, restoreDraftForRoot: Function }}
 */
export function createDraft(ctx) {
  const { $, state } = ctx;
  const draftKey = () => (state.root ? `aipass.draft:${state.root}` : 'aipass.draft');
  const loadDraft = () => {
    try { return localStorage.getItem(draftKey()) ?? ''; } catch { return ''; }
  };
  let draftLoadedKey = draftKey();
  /**
   * Swap the composer's draft for the project the window is now on.
   * Switching project is an explicit act and the old text was already
   * saved to the old project's key on input, so replacing the composer
   * with the new project's draft is the right swap. At boot nothing has
   * been typed yet, so the same swap just pre-fills the adopted project.
   */
  function restoreDraftForRoot() {
    const key = draftKey();
    if (key === draftLoadedKey) return;
    draftLoadedKey = key;
    const el = $('task');
    if (el) el.value = loadDraft();
  }
  // A keystroke is not worth a synchronous write to storage every time, but
  // the first one after a quiet moment lands at once: a reload that comes
  // right behind it still finds the paragraph. A burst after it coalesces
  // into one trailing write every 150 ms, and pagehide flushes the rest.
  /** @type {any} */
  let draftTimer = null;
  let draftStamp = 0;
  const saveDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = null;
    draftStamp = Date.now();
    try { localStorage.setItem(draftKey(), $('task').value); } catch { /* storage off */ }
  };
  const saveDraftLater = () => {
    if (draftTimer) return;
    const now = Date.now();
    if (now - draftStamp >= 150) {
      draftStamp = now;
      saveDraft();
      return;
    }
    draftTimer = setTimeout(() => {
      draftTimer = null;
      draftStamp = Date.now();
      try { localStorage.setItem(draftKey(), $('task').value); } catch { /* storage off */ }
    }, 150 - (now - draftStamp));
  };
  $('task').addEventListener('input', saveDraftLater);
  if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', saveDraft);
  $('task').value = loadDraft();

  return { draftKey, loadDraft, saveDraft, saveDraftLater, restoreDraftForRoot };
}

export default createDraft;
