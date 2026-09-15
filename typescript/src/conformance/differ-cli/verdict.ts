/**
 * What a differential run tells its caller: the one-line tally on stderr and the exit code
 * ({@link verdictOf}).
 */
import { novelMechanismsOf, type DiffResult } from '../differ.js';

export interface DifferVerdict {
  /** `N pass, N divergent, N fail…`, newline-terminated. */
  readonly summary: string;
  readonly exitCode: number;
}

/**
 * Exit 0 when no run failed (a `divergent` run — every difference attributed to a
 * `docs/divergences.md` row — is not a failure) **and** no run produced an ordering
 * mechanism the register does not name, 1 otherwise. A novel mechanism is not a `fail`
 * verdict, but it is a behaviour with no row, so a CI leg must not go green on one.
 */
export function verdictOf(results: readonly DiffResult[]): DifferVerdict {
  const failed = results.filter((r) => r.verdict === 'fail');
  const divergent = results.filter((r) => r.verdict === 'divergent');
  const novel = novelMechanismsOf(results);
  const failures = failed.length > 0 ? `: ${failed.map((r) => `${r.fixture}@k=${r.requestedBudget}`).join(', ')}` : '';
  const unnamed = novel.length > 0
    ? `; ${novel.length} ordering mechanism(s) with no row in docs/divergences.md: ${novel.join(', ')}`
    : '';
  return {
    summary: `${results.length - failed.length - divergent.length} pass, ${divergent.length} divergent, ` +
      `${failed.length} fail${failures}${unnamed}\n`,
    exitCode: failed.length === 0 && novel.length === 0 ? 0 : 1,
  };
}
