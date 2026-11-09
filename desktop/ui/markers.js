// @ts-check
/* What the transcript shows: the model's prose, without the wire traffic.
 *
 * The harness protocol is markers-in-prose: the model says "EDIT file … END"
 * as its way of calling a tool, and the loop answers every call with its own
 * `tool` event. The window renders those events as their own rows, so the
 * bubble must not repeat the markers back at the reader — a live run would
 * otherwise show every change twice, once as raw protocol and once as the row
 * that actually happened.
 *
 * `scan()` walks a reply call for call, mirroring protocol.parse() — the
 * parity test in test/ui-markers.test.mjs drives both against the same corpus,
 * so if the protocol grows a marker and this file does not, the suite fails
 * instead of a bubble quietly showing raw wire. `transcript()` is the same
 * walk with the marker lines (and the bodies of block markers) dropped.
 * Quoted examples in a fenced block stay: inside a fence a marker is a
 * quotation, never a call. One honest gap: a plugin marker is known here only
 * after plugins.list has reported it, and its body is eaten only when the
 * report says takesBody.
 *
 * The keyword list is the window's copy of the harness's MARKER_LINE
 * (protocol.mjs): the protocol grew VERIFY and TASK: and this file did not,
 * so a VERIFY line showed up in the bubble as the raw wire it is. The list is
 * exported and compared with the harness's, keyword for keyword — a marker the
 * harness grows and the window does not is a failed parity test, not a bubble
 * full of protocol.
 */

const FENCE_LINE = /^\s*(```|~~~)/;

// The single-line calls, mirrored from protocol.parse() in its own order.
// Every rule names the keyword it reads, so the exported list below is the
// walk's own list and cannot drift away from what the walk understands.
/** @type {Array<{marker: string, re: RegExp, pick: (m: RegExpMatchArray) => {kind: string, arg: string}}>} */
const SINGLE = [
  // `dir`/`list`/`ls` all mean the listing; `file` means a read. Mirrors
  // parse()'s alias branch.
  { marker: 'NEED', re: /^\s*NEED\s+(dir|list|ls|file)\s+(.+?)\s*$/, pick: (m) => ({ kind: m[1].toLowerCase() === 'file' ? 'read' : 'list', arg: m[2].trim() }) },
  // A bare listing word with the path forgotten — the project root.
  { marker: 'NEED', re: /^\s*NEED\s+(?:dir|list|ls)\s*$/, pick: () => ({ kind: 'list', arg: '.' }) },
  // The bare file shape — `NEED events.mjs` — mirroring parse()'s fallback.
  { marker: 'NEED', re: /^\s*NEED\s+([^\s]+(?: \d+-\d+)?)\s*$/, pick: (m) => ({ kind: 'read', arg: m[1].trim() }) },
  { marker: 'SEARCH', re: /^\s*SEARCH\s+(.+?)\s*$/, pick: (m) => ({ kind: 'search', arg: m[1].trim() }) },
  // TREE is the shape of a folder; the path is optional (the project root).
  { marker: 'TREE', re: /^\s*TREE\b\s*(.*?)\s*$/, pick: (m) => ({ kind: 'tree', arg: m[1].trim() }) },
  // STAT is one path's metadata; the path is required, like DEF/REFS.
  { marker: 'STAT', re: /^\s*STAT\s+(.+?)\s*$/, pick: (m) => ({ kind: 'stat', arg: m[1].trim() }) },
  { marker: 'GLOB', re: /^\s*GLOB\s+(.+?)\s*$/, pick: (m) => ({ kind: 'glob', arg: m[1].trim() }) },
  // The code-navigation markers — mirrored from parse()'s rules, or the bubble
  // would show raw wire the moment a model used one.
  { marker: 'SYMBOLS', re: /^\s*SYMBOLS\s+(.+?)\s*$/, pick: (m) => ({ kind: 'symbols', arg: m[1].trim() }) },
  { marker: 'DEF', re: /^\s*DEF\s+(.+?)\s*$/, pick: (m) => ({ kind: 'def', arg: m[1].trim() }) },
  { marker: 'REFS', re: /^\s*REFS\s+(.+?)\s*$/, pick: (m) => ({ kind: 'refs', arg: m[1].trim() }) },
  { marker: 'SKILL', re: /^\s*SKILL\s+(.+?)\s*$/, pick: (m) => ({ kind: 'skill', arg: m[1].trim() }) },
  { marker: 'GIT', re: /^\s*GIT\s+(.+?)\s*$/, pick: (m) => ({ kind: 'git', arg: m[1].trim() }) },
  // VERIFY — the model asks for the project's check. The command is optional,
  // so the shape is parse()'s: the keyword may stand alone.
  { marker: 'VERIFY', re: /^\s*VERIFY\s*(.*?)\s*$/, pick: (m) => ({ kind: 'verify', arg: m[1].trim() }) },
  // RECALL — the model asks what this project said before. The question is
  // required, so the shape is parse()'s: the keyword needs its argument.
  { marker: 'RECALL', re: /^\s*RECALL\s+(.+?)\s*$/, pick: (m) => ({ kind: 'recall', arg: m[1].trim() }) },
  { marker: 'RETRIEVE', re: /^\s*RETRIEVE\s+(.+?)\s*$/, pick: (m) => ({ kind: 'retrieve', arg: m[1].trim() }) },
  { marker: 'DIAGNOSE', re: /^\s*DIAGNOSE\s+(.+?)\s*$/, pick: (m) => ({ kind: 'diagnose', arg: m[1].trim() }) },
  { marker: 'FETCH', re: /^\s*FETCH\s+(.+?)\s*$/, pick: (m) => ({ kind: 'fetch', arg: m[1].trim() }) },
  { marker: 'WEB', re: /^\s*WEB\s+(.+?)\s*$/, pick: (m) => ({ kind: 'web', arg: m[1].trim() }) },
  { marker: 'ATTACH', re: /^\s*ATTACH\s+(.+?)\s*$/, pick: (m) => ({ kind: 'attach', arg: m[1].trim() }) },
  { marker: 'DELETE', re: /^\s*DELETE\s+(.+?)\s*$/, pick: (m) => ({ kind: 'delete', arg: m[1].trim() }) },
  { marker: 'MOVE', re: /^\s*MOVE\s+(.+?)\s*$/, pick: (m) => ({ kind: 'move', arg: m[1].trim() }) },
  // GOAL — the model's word on the project's goal. Only DONE and BLOCKED are
  // actions, and the line is wire either way.
  { marker: 'GOAL', re: /^\s*GOAL\s+(.+?)\s*$/, pick: (m) => ({ kind: 'goal', arg: m[1].trim() }) },
];

/**
 * The keywords that are wire even when nothing acts on them.
 *
 * The harness hides these lines from the prose (protocol.MARKER_LINE): a
 * stray END, a TASK: line — they are protocol, not writing, and a bubble that
 * showed them would show the model its own wire. The harness's parse() has no
 * rule for them either, so they make no call here either: the walk drops the
 * line and moves on.
 */
/** @type {Array<{marker: string, re: RegExp}>} */
const WIRE_ONLY = [
  { marker: 'FIND', re: /^\s*FIND\s*$/ },
  { marker: 'NEW', re: /^\s*NEW\s*$/ },
  { marker: 'END', re: /^\s*END\s*$/ },
  { marker: 'TASK', re: /^\s*TASK\s*:/ },
  // A bare GOAL is a mangled call, not prose: the harness hides it too.
  { marker: 'GOAL', re: /^\s*GOAL\s*$/ },
];

const EDIT_LINE = /^\s*EDIT\s+(.+?)\s*$/;
const CREATE_LINE = /^\s*CREATE\s+(.+?)\s*$/;
const RUN_BG_LINE = /^\s*RUN\s+(?:bg|background)\s*$/;
const RUN_LINE = /^\s*RUN\s*$/;
const PLAN_LINE = /^\s*PLAN\s*$/;
const TODO_LINE = /^\s*TODO\s*$/;
const SUBAGENT_LINE = /^\s*SUBAGENT\s*$/;
const JOBS_LINE = /^\s*JOBS\s*$/;
// The line shapes that open a body-consuming block (protocol.mjs
// BODY_OPENERS): a body that never reaches its exact END stops at the
// next opener instead of borrowing its END, and is unterminated.
const BODY_OPENERS = [EDIT_LINE, CREATE_LINE, RUN_BG_LINE, RUN_LINE, PLAN_LINE, TODO_LINE, SUBAGENT_LINE];

// The block markers: a keyword, a body, and the line that ends it. Named here
// so the exported keyword list below is the walk's own list.
/** @type {string[]} */
const BLOCK_MARKERS = ['EDIT', 'CREATE', 'RUN', 'PLAN', 'TODO', 'SUBAGENT', 'JOBS'];
// Mirrors parse()'s ASK tail: the keyword may carry a colon or a dash before
// the question, and the question itself is required — a bare ASK is prose.
const ASK_LINE = /^\s*ASK\b[:\s—–-]*(.+)$/;
// Mirrors parse()'s DONE tail: a heading or emphasis wrapped around the word is
// still a DONE, because the model reaches for "## DONE" the moment it formats.
const DONE_LINE = /^\s*(?:\*{1,3}|#{1,6}\s*)?DONE\b[:\s\u2014\u2013-]*(.*)$/;

/**
 * Plugin reports come as marker strings or {marker, takesBody} records.
 * @param {any[]} [plugins]
 * @returns {Array<{marker: string, takesBody?: boolean}>}
 */
const normalizePlugins = (plugins = []) => plugins
  .map((p) => (typeof p === 'string' ? { marker: p } : p))
  .filter((p) => p?.marker);

// The window re-walks the whole reply on every streamed paint, so the stop
// line regexes and the plugin marker regexes are compiled once and kept here:
// the walk used to build a fresh RegExp per line per marker, which made every
// repaint grow with the reply's length even for text that never changed.
const STOP_RES = new Map();
/** @param {string[]} stops */
const stopRe = (stops) => {
  const key = stops.join('|');
  let re = STOP_RES.get(key);
  if (!re) { re = new RegExp(`^\\s*(?:${key})\\s*$`); STOP_RES.set(key, re); }
  return re;
};
const PLUGIN_RES = new Map();
/** @param {string} marker */
const pluginRe = (marker) => {
  let re = PLUGIN_RES.get(marker);
  if (!re) { re = new RegExp(`^\\s*${marker}\\b\\s*(.*)$`); PLUGIN_RES.set(marker, re); }
  return re;
};

/**
 * One pass over a reply: `kept` is the lines a reader should see, `calls` is
 * what the loop would act on. The consumption rules are copied from
 * protocol.parse() line for line; the parity test is what keeps the copy
 * honest.
 */
/**
 * @param {any} reply
 * @param {any[]} [plugins]
 */
function walk(reply, plugins) {
  const lines = String(reply ?? '').split('\n');
  /** @type {string[]} */
  const kept = [];
  /** @type {Array<{kind: string, arg: string, name?: string, background?: boolean, unterminated?: boolean}>} */
  const calls = [];
  let inFence = false;
  let i = 0;
  const pluginList = normalizePlugins(plugins); // normalised once per walk, not once per line

  // Skip a block body to its exact-case stop line — END, or one of the
  // EDIT block's stops — and report whether it closed. A body that never
  // reaches its stop ends at the next body opener (or at the end of the
  // reply) and is unterminated, exactly as protocol.parse() reports it:
  // the stop line, or the opener, is left unread for the next call. The
  // marker regexes tolerate trailing whitespace (\r included) exactly as
  // the protocol does.
  /** @param {string[]} stops */
  const skipBody = (stops) => {
    const re = stopRe(stops);
    while (i < lines.length) {
      if (re.test(lines[i])) return true;
      if (BODY_OPENERS.some((r) => r.test(lines[i]))) return false;
      if (pluginList.some((p) => pluginRe(p.marker).test(lines[i]))) return false;
      i += 1;
    }
    return false;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Inside a fence the reply is quoting: markers shown as examples are kept
    // as prose and never scanned.
    if (FENCE_LINE.test(line)) { inFence = !inFence; kept.push(line); i += 1; continue; }
    if (inFence) { kept.push(line); i += 1; continue; }

    let hit = null;
    for (const s of SINGLE) {
      const m = s.re.exec(line);
      if (m) { hit = s.pick(m); break; }
    }
    if (hit) { calls.push(hit); i += 1; continue; }

    let m = EDIT_LINE.exec(line);
    if (m) {
      i += 1;
      if (/^\s*FIND\s*$/.test(lines[i] ?? '')) i += 1;
      const beforeClosed = skipBody(['NEW', 'END']);
      if (beforeClosed && /^\s*NEW\s*$/.test(lines[i] ?? '')) i += 1;
      const afterClosed = skipBody(['END']);
      if (afterClosed) i += 1;
      const closed = beforeClosed && afterClosed;
      calls.push({ kind: 'replace', arg: m[1].trim(), ...(closed ? null : { unterminated: true }) });
      continue;
    }
    m = CREATE_LINE.exec(line);
    if (m) {
      i += 1;
      const closed = skipBody(['END']);
      if (closed) i += 1;
      calls.push({ kind: 'write', arg: m[1].trim(), ...(closed ? null : { unterminated: true }) });
      continue;
    }
    if (RUN_BG_LINE.test(line)) {
      i += 1;
      const closed = skipBody(['END']);
      if (closed) i += 1;
      calls.push({ kind: 'run', arg: '', background: true, ...(closed ? null : { unterminated: true }) });
      continue;
    }
    if (RUN_LINE.test(line)) {
      i += 1;
      const closed = skipBody(['END']);
      if (closed) i += 1;
      calls.push({ kind: 'run', arg: '', ...(closed ? null : { unterminated: true }) });
      continue;
    }
    if (PLAN_LINE.test(line)) {
      i += 1;
      const closed = skipBody(['END']);
      if (closed) i += 1;
      calls.push({ kind: 'plan', arg: '', ...(closed ? null : { unterminated: true }) });
      continue;
    }
    if (TODO_LINE.test(line)) {
      i += 1;
      const closed = skipBody(['END']);
      if (closed) i += 1;
      calls.push({ kind: 'todo', arg: '', ...(closed ? null : { unterminated: true }) });
      continue;
    }
    if (SUBAGENT_LINE.test(line)) {
      i += 1;
      const closed = skipBody(['END']);
      if (closed) i += 1;
      calls.push({ kind: 'subagent', arg: '', ...(closed ? null : { unterminated: true }) });
      continue;
    }
    if (JOBS_LINE.test(line)) { i += 1; calls.push({ kind: 'jobs', arg: '' }); continue; }

    m = ASK_LINE.exec(line);
    if (m) { i += 1; calls.push({ kind: 'ask', arg: m[1].trim() }); continue; }

    m = DONE_LINE.exec(line);
    if (m) { i += 1; calls.push({ kind: 'done', arg: m[1].trim() }); continue; }

    // The keywords that are wire and nothing else. The harness hides them from
    // the prose (protocol.MARKER_LINE) and acts on none of them, so the walk
    // drops the line too — and a built-in name is never shadowed by a plugin's.
    let wire = false;
    for (const w of WIRE_ONLY) {
      if (!w.re.test(line)) continue;
      i += 1;
      wire = true;
      break;
    }
    if (wire) continue;

    // Plugin markers last: a built-in name is never shadowed by one.
    let matchedPlugin = false;
    for (const p of pluginList) {
      const pm = pluginRe(p.marker).exec(line);
      if (!pm) continue;
      i += 1;
      let closed = true;
      if (p.takesBody) {
        closed = skipBody(['END']);
        if (closed) i += 1;
      }
      calls.push({ kind: 'plugin', name: p.marker, arg: pm[1].trim(), ...(closed ? null : { unterminated: true }) });
      matchedPlugin = true;
      break;
    }
    if (matchedPlugin) continue;

    kept.push(line);
    i += 1;
  }

  return { kept, calls };
}

/** The calls a reply would make — the same list protocol.parse() returns. */
/**
 * @param {any} reply
 * @param {{plugins?: any[]}} [opts]
 */
export function scan(reply, { plugins = [] } = {}) {
  return walk(reply, plugins).calls;
}

/**
 * Every keyword the window's walk knows.
 *
 * The window's copy of the harness's marker table (protocol.mjs MARKER_LINE),
 * built from the rules above so it cannot claim a keyword the walk does not
 * read. The parity test compares it with the harness's own list: the protocol
 * grew VERIFY and TASK: once, and this file did not — and a marker the window
 * does not know shows up in the bubble as the raw wire it is.
 */
export const MARKER_KEYWORDS = [...new Set([
  ...SINGLE.map((s) => s.marker),
  ...BLOCK_MARKERS,
  ...WIRE_ONLY.map((w) => w.marker),
  'ASK',
  'DONE',
])].sort();

/** The reply's prose, with every marker call (headers and bodies) dropped. */
/**
 * @param {any} reply
 * @param {any[]} [plugins]
 * @returns {string}
 */
export function transcript(reply, plugins = []) {
  return walk(reply, plugins).kept.join('\n').trim();
}
