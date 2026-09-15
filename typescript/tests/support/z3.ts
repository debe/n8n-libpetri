/**
 * Solver gating and the timeouts the solver-backed suites share.
 *
 * Every solver-backed suite goes through {@link describeZ3}, which skips with the reason in
 * the suite name when no usable z3 resolves; `tests/z3-gate.test.ts` turns that skip into a
 * failure under `CI`, so a run whose proofs never ran cannot pass unnoticed.
 */
import { z3Available } from 'libpetri/verification';

/** Whether a usable `z3` resolves (`LIBPETRI_Z3` or `PATH`, >= 4.8.0; VER-013). */
export const Z3_AVAILABLE = z3Available();

/**
 * `describe` for suites that run the solver. Without z3 the suite is skipped with the
 * reason in its name; `tests/z3-gate.test.ts` turns that skip into a failure under `CI`.
 */
export function describeZ3(name: string, fn: () => void): void {
  if (Z3_AVAILABLE) describe(name, fn);
  else describe.skip(`${name} [skipped: no usable z3 >= 4.8.0 on PATH or LIBPETRI_Z3]`, fn);
}

/**
 * Per-query timeout for the solver-backed suites. Every query the tests assert a verdict on
 * returns in < 1 s (measured in `docs/verification.md`); the ones that do not close are
 * asserted only as "not violated", so a short timeout keeps a file fast without weakening
 * anything.
 */
export const TEST_TIMEOUT_MS = 5_000;

/** vitest per-case budget: a handful of queries plus the invariant computation. */
export const CASE_TIMEOUT_MS = 180_000;
