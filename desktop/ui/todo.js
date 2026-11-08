// @ts-check
// The PLAN/TODO card: the run's checklist, one element for the whole session.
//
// Split out of app.js. The card is built on the first todo, re-tallied after
// that, and removed when the session changes. It lives outside #log (directly
// before #pending), so folding the run's trail never swallows it — and its
// list scrolls inside a bounded box (styles.css), so a plan of fifty items no
// longer pushes the conversation off the screen.
//
// Needs from the context: `$` and `el`.

/**
 * @param {any} ctx
 * @returns {{ clearTodo: Function, renderTodo: Function }}
 */
export function createTodo(ctx) {
  const { $, el } = ctx;
  /** @type {any} */
  let todoPanel = null;
  /** @type {any} */
  let todoHead = null;
  /** @type {any} */
  let todoList = null;
  /** @type {any} */
  let todoRows = []; // [{ li, text }] — lets an unchanged row stay put across updates

  /** Drop the plan/todo card — a new session must not show the old one's plan. */
  function clearTodo() {
    if (!todoPanel) return;
    todoPanel.remove();
    todoPanel = null;
    todoHead = null;
    todoList = null;
    todoRows = [];
  }

  function renderTodo(/** @type {any} */ items) {
    // A todo frame is wire data; a malformed one is dropped, never a crash in
    // the middle of the run's stream.
    if (!Array.isArray(items)) return;
    const list = items.map((it) => ({ text: String(it?.text ?? ''), done: Boolean(it?.done) }));
    if (!todoPanel) {
      todoPanel = el('div', 'panel');
      todoPanel.id = 'todo-panel';
      todoHead = el('h4', null, 'plan & todo');
      todoList = el('ul');
      todoPanel.append(todoHead, todoList);
      // #chat contains #pending, so this is the same slot as "before #pending" —
      // spelled with insertBefore because the test suite's fake DOM has no before().
      $('chat').insertBefore(todoPanel, $('pending'));
    }
    const total = list.length;
    const done = list.filter((it) => it.done).length;
    todoHead.textContent = `plan & todo · ${done}/${total}`;
    todoPanel.classList.toggle('complete', total > 0 && done === total);
    // Ticks move constantly while a run works. When the same rows are still
    // there, update them where they stand — a full rebuild on every step makes
    // the card flicker and resets the list's scroll position.
    const same = todoRows.length === list.length && list.every((it, i) => todoRows[i].text === it.text);
    if (same) {
      list.forEach((it, i) => {
        todoRows[i].li.classList.toggle('done', it.done);
        todoRows[i].li.children[0].textContent = it.done ? '☑' : '☐';
      });
      return;
    }
    const keepScroll = todoList.scrollTop;
    todoList.textContent = '';
    todoRows = list.map((it) => {
      const li = el('li', it.done ? 'done' : '');
      li.append(el('span', 'box', it.done ? '☑' : '☐'), el('span', null, it.text));
      todoList.append(li);
      return { li, text: it.text };
    });
    todoList.scrollTop = keepScroll;
  }

  return { clearTodo, renderTodo };
}

export default createTodo;
