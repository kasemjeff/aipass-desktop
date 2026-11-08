// @ts-check
// Context assembly: one place that decides what the model reads, at which
// moment, and what it costs.
//
// Before this module the wiring was scattered across loop.mjs, harness.mjs,
// compact.mjs and protocol.mjs: the preamble flags were written by hand in
// four places, the flags drifted (retrieve was missing from the live loop;
// sandbox from every place), and no surface knew the total size of the first
// message or of a rotation seed until the provider refused the send.
//
// The rules this module restores, and the loop/summary in docs/LOOP_DESIGN.md
// assumes:
//
//   - turn 1 and rotation seeds carry the standing context: protocol
//     preamble, task, instructions, listing, snapshot, memory, goal, hooks.
//     Everything else is pull-based (RETRIEVE / RECALL / SEARCH / NEED) —
//     see docs/RAG_DESIGN.md for why per-step auto-injection is not done.
//   - every token injected stays in the server's history until the next
//     rotation, so emptiness is measured against a total budget, not against
//     each source alone. Protocol and task are mandatory and are never
//     dropped; snapshot, listing tail, plugin sections, instructions tail
//     drop first; memory and summary are truncated before they are dropped.
//   - every assembly emits a manifest ({ id, chars, dropped, truncated }) so
//     the window and the session log can say what the model was shown.
import { preamble } from './protocol.mjs';

/**
 * The flags the preamble builder reads, in the order they are documented in
 * protocol.mjs. A parity test holds every call site to this list: a flag the
 * preamble can read but no caller passes is a tool the loop dispatches that
 * the model was never told about.
 */
export const PREAMBLE_FLAG_KEYS = Object.freeze([
  'allowRun',
  'review',
  'plan',
  'subagent',
  'searchI',
  'attach',
  'verify',
  'diagnose',
  'recall',
  'retrieve',
  'explore',
  'sandbox',
]);

/**
 * The single preamble flag sheet. Options are the harness's own sheet
 * (settings.mjs HarnessOptions): every spelling the preamble reads is
 * derived here, so loop.mjs and the three seed builders in harness.mjs
 * cannot drift again.
 *
 * @param {Record<string, any>} [options]
 * @param {{ plugins?: unknown[], sections?: unknown[], instructions?: any, goal?: any, lang?: string }} [extra]
 */
export function preambleFlags(options = {}, extra = {}) {
  return {
    allowRun: Boolean(options.allowRun),
    review: Boolean(options.review),
    plan: Boolean(options.plan),
    subagent: Boolean(options.subagent),
    searchI: Boolean(options.searchI),
    attach: Boolean(options.attach),
    // VERIFY is a power and is taught behind its own flag because the
    // preamble bytes are pinned by the recorded replay (evals/fixtures/).
    verify: Boolean(options.allowVerify),
    diagnose: Boolean(options.diagnose),
    // The reads. A missing flag here means a marker the loop happily
    // dispatches but the model was never told about (retrieve was exactly
    // that in the live turn-1 build).
    recall: Boolean(options.recall),
    retrieve: Boolean(options.retrieve),
    explore: Boolean(options.explore),
    sandbox: typeof options.sandbox === 'string' && options.sandbox ? options.sandbox : 'off',
    plugins: Array.isArray(extra.plugins) ? extra.plugins
      : (Array.isArray(options.pluginTools) ? options.pluginTools : []),
    sections: Array.isArray(extra.sections) ? extra.sections
      : (Array.isArray(options.pluginSections) ? options.pluginSections : []),
    instructions: extra.instructions ?? null,
    goal: extra.goal ?? null,
    lang: extra.lang ?? (options.replyLanguage === 'en' ? 'en' : 'th'),
  };
}

/**
 * Build the preamble from the single flag sheet. The only caller that should
 * know the sheet's shape is this module; everyone else hands options in.
 *
 * @param {Record<string, any>} [options]
 * @param {{ plugins?: unknown[], sections?: unknown[], instructions?: any, goal?: any, lang?: string }} [extra]
 */
export function buildPreambleFor(options = {}, extra = {}) {
  return preamble(/** @type {any} */ (preambleFlags(options, extra)));
}

/**
 * The share of the model's window a single message may occupy. Turn 1 is the
 * most expensive message of a run: preamble + instructions + listing +
 * snapshot + memory + task must leave room for the reply and for the tool
 * results that follow. A rotation seed is the same shape minus listing and
 * snapshot, plus a summary, so it gets a slightly smaller share.
 */
export const TURN1_BUDGET_RATIO = 0.30;
export const SEED_BUDGET_RATIO = 0.25;
// Hard ceiling in characters for the first message, on top of the ratio: a
// 1M-token model would otherwise be offered a 300k-character preamble,
// which the pinned replay and the edge both reject long before that.
export const TURN1_MAX_CHARS = 48_000;
export const SEED_MAX_CHARS = 40_000;

/**
 * Turn-1 budget in characters, from the compactor's own budget for the model
 * in use. Falls back to the compactor's conservative default when no
 * compactor is wired (helpers, tests).
 *
 * @param {{ budgetFor?: (model?: string|null) => number, reserveTokens?: number } | null} compactor
 * @param {string|null} [model]
 */
export function turn1BudgetChars(compactor, model = null) {
  return budgetCharsFor(compactor, model, TURN1_BUDGET_RATIO, TURN1_MAX_CHARS);
}

/** @param {{ budgetFor?: (model?: string|null) => number, reserveTokens?: number } | null} compactor */
export function seedBudgetChars(compactor, model = null) {
  return budgetCharsFor(compactor, model, SEED_BUDGET_RATIO, SEED_MAX_CHARS);
}

/**
 * @param {{ budgetFor?: (model?: string|null) => number, reserveTokens?: number } | null} compactor
 * @param {string|null} model
 * @param {number} ratio
 * @param {number} hardCap
 */
function budgetCharsFor(compactor, model, ratio, hardCap) {
  if (!compactor || typeof compactor.budgetFor !== 'function') return hardCap;
  let budgetTokens = 0;
  try { budgetTokens = Number(compactor.budgetFor(model)) || 0; } catch { budgetTokens = 0; }
  if (!budgetTokens) return hardCap;
  const reserve = Number(compactor.reserveTokens) || 0;
  const usable = Math.max(1, budgetTokens - reserve);
  // ~3 chars per token is the conservative middle of the compactor's own
  // divisor (Latin 4, mixed 3, wide-script 2): counting at 3 keeps Thai from
  // overflowing a budget estimated at 4.
  const chars = Math.floor(usable * 3 * ratio);
  return Math.max(4_000, Math.min(hardCap, chars));
}

/**
 * @typedef {object} ContextBlock
 * @property {string} id
 * @property {number} priority higher is kept longer
 * @property {string} text
 * @property {boolean} [mandatory] never dropped, even over budget
 * @property {number} [maxChars] per-source ceiling, truncate before drop
 */

/**
 * Assemble blocks under a character budget.
 *
 * Order is preserved in the output (the caller sends blocks in display
 * order); priority only decides what gives way first. The walk is:
 * truncate each source to its own ceiling, drop the lowest-priority
 * droppable source until the total fits, then truncate the largest
 * remaining summary/results-like block (the caller marks those with a
 * low priority and a ceiling — dropping them wholly would lose the task's
 * evidence). Mandatory sources are never dropped.
 *
 * @param {ContextBlock[]} blocks
 * @param {number} budgetChars
 * @returns {{ text: string, manifest: Array<{id: string, chars: number, dropped: boolean, truncated: boolean}>, totalChars: number, budgetChars: number }}
 */
export function assemble(blocks, budgetChars) {
  const limit = Number(budgetChars) > 0 ? Math.floor(Number(budgetChars)) : Number.POSITIVE_INFINITY;
  const prepared = (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && typeof b.id === 'string' && typeof b.text === 'string')
    .map((b, order) => {
      let text = b.text;
      let truncated = false;
      const cap = Number(b.maxChars);
      if (Number.isFinite(cap) && cap > 0 && text.length > cap) {
        text = `${text.slice(0, cap)}…`;
        truncated = true;
      }
      return {
        id: b.id, priority: Number(b.priority) || 0, text,
        mandatory: b.mandatory === true, truncated, dropped: false, order,
      };
    });
  const size = () => {
    const kept = prepared.filter((b) => !b.dropped);
    const sum = kept.reduce((total, b) => total + b.text.length, 0);
    // The join inserts "\n\n" between kept blocks; it is part of what the
    // server receives, so it is part of the budget.
    return kept.length > 1 ? sum + (kept.length - 1) * 2 : sum;
  };
  // Drop lowest priority first; among equals, the later block gives way
  // (the listing tail is the usual case). Mandatory sources stay.
  while (size() > limit) {
    let victim = null;
    for (const b of prepared) {
      if (b.dropped || b.mandatory) continue;
      if (!victim || b.priority < victim.priority
        || (b.priority === victim.priority && b.order > victim.order)) victim = b;
    }
    if (!victim) break;
    victim.dropped = true;
  }
  // Still over: shave the largest remaining non-mandatory block from its
  // head, which is how a summary or a results paste degrades (the tail
  // carries what the model must act on).
  if (size() > limit) {
    const remaining = prepared.filter((b) => !b.dropped && !b.mandatory)
      .sort((a, b) => b.text.length - a.text.length);
    for (const b of remaining) {
      if (size() <= limit) break;
      const over = size() - limit;
      if (b.text.length <= over) continue;
      const keep = b.text.length - over;
      b.text = `${b.text.slice(0, keep)}…`;
      b.truncated = true;
    }
  }
  const kept = prepared.filter((b) => !b.dropped);
  const text = kept.map((b) => b.text).join('\n\n');
  const manifest = prepared.map((b) => ({
    id: b.id,
    chars: b.dropped ? 0 : b.text.length,
    dropped: b.dropped,
    truncated: b.truncated,
  }));
  return { text, manifest, totalChars: text.length, budgetChars: limit };
}

/**
 * A one-line human summary of a manifest — the node's `note` and the
 * window's row both read it when the assembly had to give something up.
 *
 * @param {Array<{ id?: string, dropped?: boolean, truncated?: boolean }>} [manifest]
 */
export function manifestSummary(manifest = []) {
  const dropped = manifest.filter((m) => m?.dropped).map((m) => m.id);
  const truncated = manifest.filter((m) => m?.truncated && !m?.dropped).map((m) => m.id);
  const parts = [];
  if (dropped.length) parts.push(`dropped ${dropped.join(', ')}`);
  if (truncated.length) parts.push(`truncated ${truncated.join(', ')}`);
  return parts.length ? `context budget: ${parts.join('; ')}` : null;
}

/**
 * One merged, deduped fact list for a seed: cross-session facts survive a
 * rotation. `mergeMemory` in compact.mjs dedupes the same way, so seed
 * construction borrows its shape (oldest first kept, newest last capped).
 *
 * @param {string[]} cross facts persisted across sessions
 * @param {string[]} sessionMemory facts this session's rotations carried
 * @returns {string[]}
 */
export function mergeCrossMemory(cross = [], sessionMemory = []) {
  const seen = new Set();
  const out = [];
  for (const raw of [...(Array.isArray(cross) ? cross : []), ...(Array.isArray(sessionMemory) ? sessionMemory : [])]) {
    const fact = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!fact) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}
