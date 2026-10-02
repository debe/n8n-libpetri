/**
 * One survey run's outcome, from what the verify CLI left behind (`survey.mjs`). Kept apart from
 * the survey so that `typescript/tests/scripts/survey-outcome.test.ts` can pin it without running
 * the corpus.
 *
 * A report is not a verification: a run verified something only if at least one check came back
 * `proven`, `violated` or `bounded`. A report whose checks are all `unknown` decided nothing and
 * is `undecided`, never `verified` (CLAUDE.md: a run that verified nothing is never mistaken for a
 * clean one). Under engineV2 the CLI exits 3 for exactly those runs; under v1 it exits 0 for them
 * (its exit 3 means no usable z3), so the outcome is read off the report's counts, and the exit
 * code is recorded beside it.
 */

/** The checks `report` decided: proven, violated or bounded. `unknown` is not a decision. */
export function decidedCount(report) {
  const c = report?.counts ?? {};
  return (c.proven ?? 0) + (c.violated ?? 0) + (c.bounded ?? 0);
}

/**
 * The row fields of one finished CLI process: `outcome` is `timeout`, `refused` (no report on
 * stdout), `unparsable`, `undecided` or `verified`.
 *
 * @param {{ killed: boolean, exitCode: number, stdout: string, stderr: string, errorMessage?: string }} run
 */
export function outcomeOf({ killed, exitCode, stdout, stderr, errorMessage }) {
  if (killed) return { outcome: 'timeout' };
  if (!stdout.trim()) {
    const why = (stderr || String(errorMessage ?? '')).trim().split('\n').pop() || 'no output';
    return { outcome: 'refused', why, exitCode };
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { outcome: 'unparsable', exitCode };
  }
  return { outcome: decidedCount(report) > 0 ? 'verified' : 'undecided', report, exitCode };
}
