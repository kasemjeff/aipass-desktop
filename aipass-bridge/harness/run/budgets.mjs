// @ts-check
// The budgets: what a run may spend before it is stopped.
//
// Three of them, and they are checked at different moments — the wall clock
// before every reply (waiting on a slow model is as real a spend as running a
// command), the credit cap against the bridge's cached quota, and the tool
// count before every call. A budget spent is an ending, and it is recorded
// like one: the session keeps the note, the window keeps the event, run_stats
// keeps the reason.
//
// The stage lives in its own module so the policy can be read — and pinned —
// without a run around it.
//
// Dynamic budget: the shipped numbers (300 tool calls, 30 minutes) are one
// allowance for every task, so a one-file read pays for a migration and a
// migration is stopped like a read. `scoreDifficulty` reads the task and
// splits it into tiers; `budgetsForTier` scales the allowance by tier
// (simple 0.3×, standard 1×, complex 2×, clamped). The adjustment is
// recorded on the run (`budgetTier`/`budgetScore`) and in run_stats, so a
// tier that stopped a run is a fact, not a guess. Off via `dynamicBudget:
// false` — the shipped numbers, exactly as before.
import { RunContext } from './context.mjs';

/**
 * Score a task's difficulty from its text, 0..100.
 *
 * Heuristics, not a model: length, how many files the task names, multi-
 * step verbs, breadth words (all/every/across — the Thai equivalents too),
 * and a discount for a single read/explain task. The score is only used to
 * pick a tier, so it stays coarse on purpose.
 *
 * @param {string} [taskText]
 * @returns {{ score: number, tier: 'simple'|'standard'|'complex' }}
 */
export function scoreDifficulty(taskText = '') {
  const text = String(taskText ?? '');
  let score = 0;
  if (text.length > 2000) score += 30;
  else if (text.length > 500) score += 15;
  else if (text.length > 120) score += 5;
  const files = text.match(/\.[a-z]{1,5}\b/gi) ?? [];
  score += Math.min(30, files.length * 10);
  if (/(refactor|migrate|migration|implement|build|create[^\n]{0,40}(api|endpoint|page|component)|test suite|add[^\n]{0,40}and|fix[^\n]{0,40}and|rewrite)/i.test(text)) score += 15;
  if (/(\ball\b|\bevery\b|\bacross\b|entire|whole project|ทั้งหมด|ทุกไฟล์|ทุกที่|ใหญ่)/i.test(text)) score += 15;
  if (/(plan|todo|step \d|phase)/i.test(text)) score += 5;
  if (/^(read|list|what is|explain|summari|สรุป|อ่าน)/i.test(text.trim()) && files.length <= 1 && text.length < 240) score -= 10;
  score = Math.max(0, Math.min(100, score));
  const tier = score < 30 ? 'simple' : score <= 60 ? 'standard' : 'complex';
  return { score, tier };
}

/**
 * The budgets a tier gets, scaled from the run’s base.
 *
 * simple 0.3× (floor 30 tools / 3 min), standard 1×, complex 2×
 * (cap 2000 tools / 2 h). The base is the user’s own setting, so a
 * person who raised it keeps the raise.
 *
 * @param {'simple'|'standard'|'complex'} tier
 * @param {{ maxToolCalls: number, maxWallClockMs: number }} base
 * @returns {{ maxToolCalls: number, maxWallClockMs: number }}
 */
export function budgetsForTier(tier, base) {
  const tools = Number(base?.maxToolCalls) > 0 ? Number(base.maxToolCalls) : 300;
  const wall = Number(base?.maxWallClockMs) > 0 ? Number(base.maxWallClockMs) : 1_800_000;
  if (tier === 'simple') {
    // Never raise a deliberately small budget: a person who capped a run at
    // 1 tool call gets 1, not 30, back.
    return {
      maxToolCalls: Math.min(tools, Math.max(30, Math.floor(tools * 0.3))),
      maxWallClockMs: Math.min(wall, Math.max(180_000, Math.floor(wall * 0.3))),
    };
  }
  if (tier === 'complex') {
    return {
      maxToolCalls: Math.min(2000, Math.floor(tools * 2)),
      maxWallClockMs: Math.min(7_200_000, Math.floor(wall * 2)),
    };
  }
  return { maxToolCalls: tools, maxWallClockMs: wall };
}

/**
 * The budget stage of one run.
 *
 * @param {RunContext} run
 */
export function createBudgets(run) {
  /**
   * The spend observed so far, in credits.
   *
   * The pre-run reading is the baseline, and when that was unavailable the
   * first successful reading becomes one. null until a reading lands — an
   * unknown spend never stops a run.
   *
   * @returns {Promise<number|null>}
   */
  const creditSpent = async () => {
    if (!run.sheet.maxCredits) return null;
    const q = await run.bridge.quota().catch(() => null);
    if (!q || q.available == null) {
      // An unknown spend never stops a run — that is the shipped policy — but
      // a person who set a ceiling expects it to mean something. Say once,
      // on the run, that the ceiling is not being enforced instead of
      // silently not enforcing it.
      if (!run.creditNoticeShown) {
        run.creditNoticeShown = true;
        const line = 'the credit cap is not being enforced: the quota could not be read, so the spend is unknown';
        run.note(line);
        run.emit('note', { text: line });
      }
      return null;
    }
    if (run.creditBaseline == null) run.creditBaseline = q.available;
    run.creditObserved = run.creditBaseline - q.available;
    return run.creditObserved;
  };

  /**
   * Spend a budget: the run is over, and the reason is recorded.
   *
   * @param {'tools-limited'|'time-limited'|'credit-limited'} reason
   */
  const spendBudget = (reason) => {
    run.budgetHit = reason;
    const used = reason === 'tools-limited'
      ? `${run.toolsRun}/${run.sheet.maxToolCalls} tool calls`
      : reason === 'credit-limited'
        ? `≈${run.creditObserved ?? 0} of ${run.sheet.maxCredits} credits`
        : `${Math.round((Date.now() - run.runStart) / 1000)}s of ${Math.round(run.sheet.maxWallClockMs / 1000)}s`;
    run.note(`budget guard: the run has spent its ${reason === 'tools-limited' ? 'tool-call' : reason === 'credit-limited' ? 'credit' : 'wall-clock'} budget (${used}) — stopping the run`);
    run.emit('budget', { reason, used });
  };

  /** Has the wall clock run out? */
  const overTime = () => Date.now() - run.runStart > run.sheet.maxWallClockMs;

  /** Has the optional credit cap been reached? */
  const overCredits = async () => {
    if (!run.sheet.maxCredits) return false;
    const spent = await creditSpent();
    return spent != null && spent >= run.sheet.maxCredits;
  };

  /**
   * Check every budget that applies before the next unit of work.
   *
   * The tool count is checked by the caller — it counts calls, not time — so
   * this one answers for the clock and the credits.
   *
   * @returns {Promise<string|null>} the reason a budget was spent, or null
   */
  const checkBudgets = async () => {
    if (overTime()) return 'time-limited';
    if (await overCredits()) return 'credit-limited';
    return null;
  };

  /**
   * Apply the dynamic budget: score the task, scale the allowance by tier,
   * and record both on the run. Returns the tier that went into force.
   *
   * Only when `dynamicBudget` is on (the shipped default). Off, the sheet
   * is untouched and `budgetTier` stays `standard` — the old numbers.
   *
   * @returns {{ score: number, tier: string }}
   */
  const applyDynamicBudget = () => {
    if (run.options.dynamicBudget === false) {
      run.budgetTier = 'standard';
      run.budgetScore = 0;
      return { score: 0, tier: 'standard' };
    }
    const { score, tier } = scoreDifficulty(run.taskText);
    const scaled = budgetsForTier(tier, run.sheet);
    run.sheet.maxToolCalls = scaled.maxToolCalls;
    run.sheet.maxWallClockMs = scaled.maxWallClockMs;
    run.budgetTier = tier;
    run.budgetScore = score;
    if (tier !== 'standard') {
      run.note(`dynamic budget: task scored ${score} (${tier}) — allowance ${scaled.maxToolCalls} tool calls / ${Math.round(scaled.maxWallClockMs / 60000)} min`);
    }
    return { score, tier };
  };

  return { creditSpent, spendBudget, overTime, overCredits, checkBudgets, applyDynamicBudget, scoreDifficulty, budgetsForTier };
}

export default createBudgets;
