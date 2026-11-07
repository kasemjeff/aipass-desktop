// @ts-check
// The window's own ask: a confirm and a text field, answered in the sheet.
//
// window.confirm and window.prompt answer nothing on WKWebView and WebKitGTK
// — the call returns without showing anything, and the action behind it
// silently never happens (one install dialog even read a missing confirm as
// a yes). Both questions go through the modal the window already owns
// instead: the answer comes back as a promise, on every platform that can
// run the window, and the look is the sheet's own.

/**
 * The ask factory: confirm and prompt, promised, over the window's sheet.
 *
 * @param {any} ctx the window it draws into — needs `$`, `el`,
 *   `openModal`, `hideModal`, and `setModalCloseHook` (app.js wires the
 *   sheet's every close path to it)
 */
export function createAsk(ctx) {
  const { $, el, openModal, hideModal } = ctx;

  // One ask at a time — the sheet is one dialog. Opening a second settles
  // the first as its own kind of "no" and hands the sheet back first, so the
  // second borrow sees the sheet, not the first ask's leftovers.
  /** @type {any} */
  let pending = null;

  // Hand the sheet back the way it was taken. An ask that opens from inside
  // an open sheet — a settings page, the git tab, the install dialog —
  // borrows the one #modal the window has: the title, body and actions it
  // replaces are LIVE nodes with their handlers on them, so putting them
  // back is the sheet again, not a copy of it. A bare hideModal here would
  // close the sheet under the person and paint the next error into nodes
  // nobody can see.
  /** @param {any} borrowed */
  function giveBack(borrowed) {
    if (!borrowed) {
      hideModal();
      return;
    }
    const modal = $('modal');
    modal.className = borrowed.className;
    $('modal-title').textContent = borrowed.title;
    const body = $('modal-body');
    body.textContent = '';
    body.append(...borrowed.body);
    const actions = $('modal-actions');
    actions.textContent = '';
    actions.append(...borrowed.actions);
    if (borrowed.focus) borrowed.focus.focus?.();
  }

  /** @param {{title: string, message: string, note?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean, kind?: string, value?: string, placeholder?: string, inputLabel?: any}} opts */
  function ask({ title, message, note, confirmLabel = 'ยืนยัน', cancelLabel = 'ยกเลิก', danger = false, kind = 'confirm', value = '', placeholder = '', inputLabel = null }) {
    return new Promise((resolve) => {
      if (pending) {
        const old = pending;
        pending = null;
        ctx.setModalCloseHook(null);
        old.settle(old.kind === 'text' ? null : false);
        giveBack(old.borrowed);
      }
      const modal = $('modal');
      const hosting = !modal.classList.contains('hidden');
      const borrowed = hosting ? {
        className: modal.className,
        title: $('modal-title').textContent,
        body: [...$('modal-body').children],
        actions: [...$('modal-actions').children],
        focus: document.activeElement,
      } : null;
      pending = { settle: resolve, kind, borrowed };
      /** @param {any} answer */
      const give = (answer) => {
        const done = pending;
        pending = null;
        ctx.setModalCloseHook(null);
        done?.settle(answer);
        giveBack(borrowed);
      };
      // The sheet closing under the ask is an answer too: Escape, or another
      // surface taking the modal, reads as "no" — a dialog nobody clicked
      // must not leave a button dead forever.
      ctx.setModalCloseHook(() => {
        const done = pending;
        pending = null;
        done?.settle(kind === 'text' ? null : false);
        giveBack(borrowed);
      });

      $('modal-title').textContent = title;
      const body = $('modal-body');
      body.textContent = '';
      if (message) body.append(el('p', null, message));
      if (note) body.append(el('p', 'dim', note));
      /** @type {any} */
      let field = null;
      if (kind === 'text') {
        field = el('input');
        field.type = 'text';
        field.value = value;
        if (placeholder) field.placeholder = placeholder;
        field.setAttribute('aria-label', inputLabel ?? title);
        // Enter says yes, like the prompt it replaces: the hand is already
        // on the keyboard, and sending it to the button is a detour.
        field.addEventListener('keydown', (/** @type {KeyboardEvent} */ ev) => {
          if (ev.key === 'Enter') { ev.preventDefault?.(); give(field.value); }
        });
        body.append(field);
      }
      const actions = $('modal-actions');
      actions.textContent = '';
      // Cancel sits first, so the focus a fresh sheet puts on the first
      // control lands on the safe answer — a dialog about deleting
      // something must not need aim.
      const cancel = el('button', null, cancelLabel);
      cancel.onclick = () => give(kind === 'text' ? null : false);
      const yes = el('button', danger ? 'danger-btn' : 'primary', confirmLabel);
      yes.onclick = () => give(kind === 'text' ? field.value : true);
      actions.append(cancel, yes);
      openModal();
      // A text ask takes the keyboard when the sheet takes the screen.
      if (field) field.focus?.();
    });
  }

  /** True only when the person said so. Cancel, Escape and an outside close all read as no. */
  /** @param {any} opts */
  const askConfirm = (opts) => ask({ ...opts, kind: 'confirm' });
  /** The typed text, or null when the ask went unanswered; an empty confirm is ''. */
  /** @param {any} opts */
  const askText = (opts) => ask({ ...opts, kind: 'text' });

  return { askConfirm, askText };
}
