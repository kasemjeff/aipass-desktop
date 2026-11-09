// @ts-check
// Failure classification, adaptive retry, and recovery planning — the three
// pieces that make a retry a different attempt instead of the same bytes again.
//
// The loop used to count failures (`errKindOf` collapses the shape) and, on the
// third, ask for "a different move" in one fixed sentence. The sentence was
// right and the sameness was the problem: a missing file, a missing binary
// and a malformed marker all earned the same advice, and the model retried
// the same shape because the advice never named the shape that would move.
//
// This module keeps the collapse and adds the reading:
//   1. `classifyFailure` — what kind of failure this is, from the call and
//      its `err:` text. Model Error (the model's output shape), Tool Error
//      (a tool answered the call and could not do it), Environment Error
//      (the machine, the edge, the binary, the clock).
//   2. `retryHint` — what to do next for that class, one attempt at a time.
//      Attempt 1 diagnoses; attempt 2 tries a different approach; attempt 3
//      escalates to a blocked report. The hint for attempt 2 is never the
//      hint for attempt 1 — that is what "adaptive" means here.
//   3. `recoveryPlan` — an ordered plan for the step that follows a failure:
//      isolate → diagnose → alternatives → fallback. The chain guard already
//      skips what a failure poisons; the plan says what to do instead.
//
// Pure: no bridge, no tools, no session. The loop owns the counters; this
// owns the reading. Tests in `test/failure-adaptive.test.mjs`.

/** The three classes a failure can fall in, plus the honest unknown. */
export const FAILURE_CLASSES = ['model', 'tool', 'environment', 'unknown'];

/** @typedef {'model'|'tool'|'environment'|'unknown'} FailureClass */

/** @typedef {{ klass: FailureClass, reason: string }} Classification */

/**
 * Classify one failed tool result.
 *
 * Order matters: environment signals (error codes, missing binaries, the
 * edge) win over shape signals, because a spawn that never started is not
 * a marker the model misspelled. Control markers (`plan`, `todo`, `goal`,
 * `subagent`) that fail are model-shaped: the model's body was the problem.
 * Everything else that answers `err:` from a tool is a tool error — the
 * tool heard the call and could not do it.
 *
 * @param {{ kind?: string, arg?: unknown, body?: unknown }} [call]
 * @param {string} [text] the tool result text (starts with `err:` on failure)
 * @param {any} [err] a thrown error, when the failure came as an exception
 * @returns {Classification}
 */
export function classifyFailure(call = {}, text = '', err = null) {
  const kind = String(call?.kind ?? '');
  const raw = String(text ?? '');
  const code = String(err?.code ?? '').toUpperCase();
  const message = String(err?.message ?? '');

  const hay = `${raw}\n${message}`.toLowerCase();
  const codeHit = code && /^(ENOENT|ENOTDIR|EACCES|EPERM|EPIPE|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ENOSPC|EAGAIN|ELOOP|ENAMETOOLONG)$/.test(code);

  // --- environment: the machine, the edge, the clock -----------------------
  if (codeHit) {
    return { klass: 'environment', reason: `error code ${code}` };
  }
  if (/(spawn[^\n]*(enoent|not found)|command not found|executable not found|no such file or directory|not a directory)/.test(hay)) {
    return { klass: 'environment', reason: 'the command or path the call needed does not exist on this machine' };
  }
  if (/(sandbox|boundary)[^\n]*(missing|refuses to run unsandboxed|no backend)/.test(hay)) {
    return { klass: 'environment', reason: 'the sandbox backend is missing' };
  }
  if (/(timed out|timeout[^\n]*(exceeded|expired|killed)|killed after)/.test(hay) && (kind === 'run' || kind === 'git' || kind === 'verify')) {
    return { klass: 'environment', reason: 'the command ran into its clock' };
  }
  if (/(enotfound|econnrefused|econnreset|econnaborted|getaddrinfo|network[^\n]*(unreachable|failed)|fetch failed|dns|ssl|certificate)/.test(hay)) {
    return { klass: 'environment', reason: 'the network or transport failed' };
  }
  if (/(no extension connected|needs_tab|needs a (logged-in )?chat tab|chat tab[^\n]*(gone|closed|not open))/.test(hay)) {
    return { klass: 'environment', reason: 'no chat tab is attached' };
  }
  if (/(\b401\b|\b403\b.*(forbidden|refused)|rate limited|too many requests|\b429\b|\b503\b)/.test(hay)) {
    return { klass: 'environment', reason: 'the edge refused the send (pace or auth)' };
  }
  if (/(enospc|disk full|no space left|eaccfs|permission denied os|operation not permitted)/.test(hay)) {
    return { klass: 'environment', reason: 'the filesystem refused for a system reason' };
  }

  // --- model: the output shape was the problem -----------------------------
  if (/(malformed|did not parse|no marker[^\n]*could|marker[^\n]*(own line|start of its|exact keyword)|invalid[^\n]*(marker|call|shape)|unknown marker|one call per line|takes one|on its own line|a second line is a second call)/.test(hay)) {
    return { klass: 'model', reason: 'the reply did not parse as a marker' };
  }
  if (['plan', 'todo', 'goal', 'subagent'].includes(kind)) {
    return { klass: 'model', reason: `the model’s ${kind} body was not usable` };
  }
  if (/(already made[^\n]*time|repeating it cannot produce|same call[^\n]*same result|stagnation|trading places|circle)/.test(hay)) {
    return { klass: 'model', reason: 'the model repeated a move that cannot change the result' };
  }
  if (/(no helper is available|no check[^\n]*declares|nothing to verify)/.test(hay) && kind === 'verify') {
    return { klass: 'model', reason: 'the run has no check to ask for' };
  }

  // --- tool: the tool heard the call and could not do it -------------------
  if (/^err:/i.test(raw.trimStart()) || err) {
    return { klass: 'tool', reason: `the ${kind || 'tool'} call failed` };
  }

  return { klass: 'unknown', reason: 'the result carries no failure signal' };
}

/**
 * The adaptive hint for the next attempt at the same failure.
 *
 * attempt 1 says diagnose (look before retrying); attempt 2 names a
 * different approach; attempt 3 names a fallback (say what blocks the run).
 * Each class gets its own nouns — a binary that does not exist and a marker
 * that did not parse are not fixed the same way, and saying so is the fix.
 *
 * @param {Partial<Classification>} [classification] from `classifyFailure`
 * @param {number} [attempt] 1-based streak count for this failure shape
 * @param {string} [kind] the failing call’s kind
 * @returns {{ strategy: 'diagnose'|'alternative'|'escalate', hint: string }}
 */
export function retryHint(classification = {}, attempt = 1, kind = '') {
  const klass = /** @type {FailureClass} */ (classification?.klass ?? 'unknown');
  const n = Number.isFinite(Number(attempt)) && Number(attempt) > 0 ? Math.floor(Number(attempt)) : 1;
  const k = String(kind ?? '');

  if (klass === 'environment') {
    if (n === 1) return {
      strategy: 'diagnose',
      hint: 'Before retrying, check the environment: does the command or file exist where you expect (list the directory, check the path, confirm the tool is installed)? A retry of the same bytes will fail the same way.',
    };
    if (n === 2) return {
      strategy: 'alternative',
      hint: 'Try a different approach: use an available alternative (the project’s own script, a different command spelling, or a narrower scope — one file instead of a tree). If the step is too big for the clock, split it or start it in the background and poll with JOBS.',
    };
    return {
      strategy: 'escalate',
      hint: 'This environment problem has not moved. Say DONE and name what the machine is missing (the command, the tab, the permission) so the person can fix it — do not keep retrying the same bytes.',
    };
  }

  if (klass === 'model') {
    if (n === 1) return {
      strategy: 'diagnose',
      hint: 'Check the shape before retrying: a marker must start its own line with an exact keyword, one call per line, no indentation or fence. Re-emit the intent with the exact shape.',
    };
    if (n === 2) return {
      strategy: 'alternative',
      hint: 'Take a different move, not the same marker again: open other files, list a directory, or search for what you guessed. Repeating the shape cannot produce a different result.',
    };
    return {
      strategy: 'escalate',
      hint: 'The shape keeps failing. Say DONE and name what you were trying to do and what blocked it — that is more useful than another identical attempt.',
    };
  }

  // tool (and unknown — same nouns: the call itself did not land)
  if (k === 'read' || k === 'list' || k === 'search' || k === 'tree' || k === 'stat' || k === 'glob') {
    if (n === 1) return {
      strategy: 'diagnose',
      hint: `List the parent directory first and read with the exact name shown there (NEED dir <parent>) — a guessed path is the usual cause.`,
    };
    if (n === 2) return {
      strategy: 'alternative',
      hint: 'Find it another way: SEARCH for a word from the file or GLOB for the pattern, instead of guessing the full path. Then read the hit.',
    };
    return {
      strategy: 'escalate',
      hint: 'The file still has not been found. Say DONE and name what you were looking for — the listing or search result you do have is the evidence.',
    };
  }
  if (k === 'write' || k === 'replace' || k === 'delete' || k === 'move' || k === 'create') {
    if (n === 1) return {
      strategy: 'diagnose',
      hint: 'Read the target first (NEED file), then write — and for REPLACE keep the FIND unique and exactly as it is on disk.',
    };
    if (n === 2) return {
      strategy: 'alternative',
      hint: 'Split the change: a smaller unique FIND/NEW pair, or CREATE then REPLACE, instead of one big write. Keep what you already staged.',
    };
    return {
      strategy: 'escalate',
      hint: 'The write keeps failing. Keep what is staged and say DONE naming the file and the refusal — the person can apply or rewrite it by hand.',
    };
  }
  if (k === 'run' || k === 'git' || k === 'verify') {
    if (n === 1) return {
      strategy: 'diagnose',
      hint: 'Read the error’s first line before retrying: a missing command, a bad flag or a syntax error each fix differently. Run the smallest command that proves the cause.',
    };
    if (n === 2) return {
      strategy: 'alternative',
      hint: 'Try a narrower run (one file, one check, a single flag) or the project’s own script — if the step is long, start it in the background and poll with JOBS.',
    };
    return {
      strategy: 'escalate',
      hint: 'The command keeps failing. Say DONE with the exact command and its last lines — that is the evidence the person needs to unblock it.',
    };
  }
  // generic tool fallback
  if (n === 1) return {
    strategy: 'diagnose',
    hint: 'Look at what the tool actually said before retrying — the first line names the cause. Diagnose first, retry second.',
  };
  if (n === 2) return {
    strategy: 'alternative',
    hint: 'Do it a different way: a narrower call, a different file, or a read that proves the state before the next write.',
  };
  return {
    strategy: 'escalate',
    hint: 'The failure keeps repeating. Say DONE and name the call and its refusal — do not spend more steps on the same bytes.',
  };
}

/**
 * One step of a recovery plan: an ordered action for the step that follows
 * a failure.
 *
 * @typedef {{ step: number, action: string }} RecoveryStep
 */

/**
 * Build a recovery plan for a set of failures in one step.
 *
 * The plan is always four kinds of step, in order, with the failing call
 * named in step 1: isolate (what failed), diagnose (what to look at),
 * alternatives (two different ways), fallback (when to stop). The
 * alternatives are the adaptive hints for attempt 2 of each failure, so a
 * plan that says "try again the same way" cannot be built here.
 *
 * @param {Array<{ call?: { kind?: string, arg?: unknown }, text?: string, classification?: Classification }>} [failures]
 * @returns {RecoveryStep[]}
 */
export function recoveryPlan(failures = []) {
  const list = Array.isArray(failures) ? failures.filter((f) => f && f.call) : [];
  if (!list.length) return [];
  const first = list[0];
  const firstKind = String(first.call?.kind ?? 'tool');
  const firstArg = String(first.call?.arg ?? '').slice(0, 80);
  const named = `${firstKind}${firstArg ? ` ${firstArg}` : ''}`;
  const firstHint = retryHint(first.classification ?? classifyFailure(first.call, first.text ?? ''), 2, firstKind);
  const secondHint = list[1]
    ? retryHint(list[1].classification ?? classifyFailure(list[1].call, list[1].text ?? ''), 2, String(list[1].call?.kind ?? 'tool'))
    : null;

  const steps = [
    { step: 1, action: `Isolate what failed: ${named} — the result above is the evidence, not a guess.` },
    { step: 2, action: 'Diagnose before acting: list, read, or run the smallest check that names the cause.' },
    { step: 3, action: `Try a different approach: ${firstHint.hint}` },
  ];
  if (secondHint) steps.push({ step: 4, action: `For the second failure: ${secondHint.hint}` });
  steps.push({
    step: steps.length + 1,
    action: 'Fallback: if the failure repeats, keep what is staged and say DONE naming the call and its refusal — do not retry the same bytes.',
  });
  return steps;
}

/**
 * The plan as the model reads it: one numbered block, appended to the step
 * that follows a failure. Empty when there is nothing to recover from.
 *
 * @param {Array<{ call?: { kind?: string, arg?: unknown }, text?: string, classification?: Classification }>} [failures]
 * @returns {string}
 */
export function recoveryPlanText(failures = []) {
  const steps = recoveryPlan(failures);
  if (!steps.length) return '';
  return `Recovery plan:\n${steps.map((s) => `${s.step}. ${s.action}`).join('\n')}`;
}

export default { FAILURE_CLASSES, classifyFailure, retryHint, recoveryPlan, recoveryPlanText };
