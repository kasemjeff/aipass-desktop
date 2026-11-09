// @ts-check
// Independent verification: a DONE is a claim, and the checker is one
// witness. This module is the second one — it reads the evidence the claim
// stands on and refuses to let a verdict stand without it.
//
// `finishCheck` (run/gates.mjs) already runs a read-only child over the
// staged tree and computes its verdict from the child's tool entries: any
// failing run is a `fail`, only passing runs are a `pass`, no runs are a
// `none`. What it cannot do from inside that verdict is ask whether the
// verdict is backed: a `pass` the child reported over zero runs, or over a
// tree that no longer matches the staged one, is a claim without evidence.
//
// `auditCheckResult` is that question, asked independently of the checker:
// it reads the staged set, the declared command, and what the child actually
// ran, and names what is missing. A verdict it does not trust is downgraded
// (`pass` → `none`, with the reason named) — never upgraded. A `fail` is
// always kept: failing on thin evidence is safe, passing on thin evidence
// is the bug.
//
// Pure: no bridge, no shell, no session. The loop calls it after the checker
// returns; tests pin it in `test/verify-evidence.test.mjs`.

/**
 * @typedef {import('./run/context.mjs').RunContext['checkResult']} CheckResult
 */

/** Code file extensions whose staging makes a checker mandatory. The
 *  extension decides the task type, not the file's content: a `.ts` file is
 *  code whatever its bytes say, and a `.md` file is docs ditto. */
const CODE_EXT = /\.(?:mjs|cjs|js|ts|mts|cts|tsx|jsx|py|rb|go|rs|java|cxx?|hpp|h|cs|php|sh|bash|zig|swift|kt|kts|scala|lua|pl|nim|ex|exs|elm|vue|svelte)$/i;

/**
 * What kind of task a staged set implies — the type the verification
 * requirement is graded by.
 *
 *   - `code`: any code file staged. A code change needs an execution behind
 *     its DONE; a verdict over zero runs is refused, and a run with no
 *     execution behind it records `unverified`.
 *   - `docs`: only prose/data staged (`.md`, `.json`, `.mdx`, …). Nothing runs
 *     against docs, so a `none` verdict is honest evidence.
 *   - `none`: nothing staged — a read-only/research run needs no checker.
 *
 * @param {Array<{ path: string, deleted?: boolean }>|string[]} [files]
 * @returns {'code'|'docs'|'none'}
 */
export function classifyTaskType(files) {
  const list = Array.isArray(files) ? files : [];
  const names = list.map((f) => (typeof f === 'string' ? f : String(f?.path ?? ''))).filter(Boolean);
  if (!names.length) return 'none';
  if (names.some((n) => CODE_EXT.test(n))) return 'code';
  return 'docs';
}

/**
 * Audit a checker verdict against the evidence it should stand on.
 *
 * @param {CheckResult} [checkResult] the verdict the checker returned
 * @param {object} [evidence] the surrounding facts
 * @param {Array<{ path: string, deleted?: boolean }>} [evidence.stagedFiles] the staged set the check was over
 * @param {string} [evidence.declaredCommand] the declared check, when the run declares one
 * @param {number} [evidence.stagedCount] overlay size at check time (when files are not listed)
 * @param {{ verdict?: string, ran?: number }} [evidence.lastPass] the last passing verdict, for tree-moved checks
 * @param {'code'|'docs'|'none'} [evidence.taskType] from `classifyTaskType`; derived from stagedFiles when absent
 * @param {string[]} [evidence.acceptanceCriteria] the criteria the run declared; a verdict with no
 *   execution behind it cannot speak for them
 * @returns {{ verdict: 'pass'|'fail'|'none', trustworthy: boolean, issues: string[], taskType: 'code'|'docs'|'none' }}
 */
export function auditCheckResult(checkResult, evidence = {}) {
  const verdict = String(checkResult?.verdict ?? 'none');
  const ran = Number(checkResult?.ran ?? 0);
  const stagedFiles = Array.isArray(evidence.stagedFiles) ? evidence.stagedFiles : null;
  const stagedCount = evidence.stagedCount != null ? Number(evidence.stagedCount) : (stagedFiles ? stagedFiles.length : 0);
  const declaredCommand = String(evidence.declaredCommand ?? '').trim();
  const taskType = evidence.taskType ?? classifyTaskType(stagedFiles ?? []);
  const criteria = Array.isArray(evidence.acceptanceCriteria)
    ? evidence.acceptanceCriteria.map((c) => String(c).trim()).filter(Boolean)
    : [];

  const issues = /** @type {string[]} */ ([]);

  // No staged tree: there is nothing to verify, and a pass over nothing is
  // the one verdict that must never stand.
  if (stagedCount === 0) {
    if (verdict === 'pass') issues.push('a pass was reported over an empty staged tree');
    return { verdict: verdict === 'pass' ? 'none' : /** @type {any} */ (verdict), trustworthy: issues.length === 0, issues, taskType };
  }

  // A pass backed by zero runs is a claim without an execution: the child
  // said it looked and never ran anything that could prove it. Declared
  // criteria name the claim, so the issue names them too.
  if (verdict === 'pass' && ran === 0) {
    return {
      verdict: 'none',
      trustworthy: false,
      issues: criteria.length
        ? [`${criteria.length} acceptance criteria were declared but the pass stands on no check execution (ran: 0) — run a check against each criterion, or say which cannot be run`]
        : ['a pass was reported without any check execution (ran: 0) — treated as none until a real run backs it'],
      taskType,
    };
  }

  // A declared check exists, and the verdict is not about it: two runs that
  // checked different commands are not comparable, and a pass over a
  // different command must not stand in for the declared one.
  if (declaredCommand && (verdict === 'pass' || verdict === 'fail')) {
    const about = String(checkResult?.declared ?? '').trim();
    if (about && about !== declaredCommand) {
      issues.push(`the verdict is about "${about}", not the declared check "${declaredCommand}"`);
      return { verdict: verdict === 'pass' ? 'none' : 'fail', trustworthy: false, issues, taskType };
    }
  }

  // The staged set the verdict claims to cover is empty while the overlay
  // is not: a verdict over nothing cannot judge what is staged.
  if (stagedFiles !== null && stagedFiles.length === 0 && stagedCount > 0) {
    issues.push('the verdict names no staged files while the overlay is non-empty');
    return { verdict: 'none', trustworthy: false, issues, taskType };
  }

  // Verification by task type: code work needs an execution behind it. A
  // `none` verdict over staged code is not trustworthy either — with a
  // declared check it is the declared check that never ran; without one it
  // is an honest "nothing runnable" that the run still has to record as
  // unverified rather than pass. Docs and read-only runs need no execution.
  if (taskType === 'code' && verdict === 'none' && ran === 0) {
    if (declaredCommand) {
      return {
        verdict: 'none',
        trustworthy: false,
        issues: [`code was staged but the declared check never ran ("${declaredCommand}") — a DONE over it is unverified`],
        taskType,
      };
    }
    return {
      verdict: 'none',
      trustworthy: false,
      issues: ['code was staged but the checker ran nothing (no declared check, no inferred run) — this DONE is unverified'],
      taskType,
    };
  }

  // Acceptance criteria need an execution to be checked against: criteria
  // declared and zero runs behind the verdict is the same false DONE in a
  // different shape. Nothing staged is not a case (handled above); docs
  // runs are not either — only criteria force an execution.
  if (criteria.length && ran === 0 && verdict !== 'fail') {
    return {
      verdict: 'none',
      trustworthy: false,
      issues: [`${criteria.length} acceptance criteria were declared but no check execution backs them — run a check against each criterion, or say which cannot be run`],
      taskType,
    };
  }

  return { verdict: /** @type {any} */ (verdict), trustworthy: issues.length === 0, issues, taskType };
}

/**
 * The evidence sentence for a downgrade, as the model and the person read
 * it. Names what was missing and what happens next — never just "failed".
 *
 * @param {{ verdict: string, issues: string[], trustworthy?: boolean }} audit
 * @returns {string}
 */
export function evidenceNote(audit) {
  if (!audit || audit.trustworthy) return '';
  return `Independent verification: ${audit.issues.join('; ')}. The verdict is therefore not trusted as proof — run the declared check (RUN\n<command>\nEND) or read the staged files back, so the next DONE stands on evidence.`;
}

export default { auditCheckResult, evidenceNote };
