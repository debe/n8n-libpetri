/**
 * Whether the SMT route may run on a net at all: the measured size ceiling above which
 * libpetri's pre-solver pipeline aborts the process, and the caller's `smtFallback` mode.
 */
import type { FlatNet } from 'libpetri/verification';
import type { SmtFallbackMode } from '../types.js';

/**
 * The net sizes above which the SMT route is refused in mode `'auto'`, measured on this
 * repository's generated workflows (`docs/verification.md`, "The pipeline before z3").
 *
 * The cost driver is **join count**, not node count: a 41-node chain (411 places, no join)
 * runs the pipeline in 1.8 s at 214 MB, while `layers` diamonds in series cost 0.4 s at 6
 * join inputs, 2.8 s at 10, 118 s and 2.4 GB at 14, over 7 minutes at 16, and exhaust the
 * heap at 18 (37 nodes) — where the process **aborts**, because a V8 heap exhaustion is not
 * an exception any `try` here can catch. So the ceiling is a join-input count, and the
 * places ceiling is a second, independent guard for a shape whose blow-up is not joins (the
 * heap died at 452 places on the same family).
 *
 * Both are deliberately conservative, and both are a proxy: they cannot bound what the
 * Farkas enumeration will do on an unmeasured shape. `smtFallback: 'force'` overrides them.
 */
export const SMT_MAX_JOIN_INPUTS = 12;

/** @see SMT_MAX_JOIN_INPUTS */
export const SMT_MAX_FLAT_PLACES = 450;

/**
 * Why this net gets no `SmtVerifier`, or `null` when it may have one.
 *
 * This is checked **before** the builder is constructed rather than around `verify()`,
 * because the failure being guarded against is not catchable: the pipeline libpetri runs
 * before z3 (flatten, structural pre-check, P-invariant and semiflow enumeration) exhausts
 * the V8 heap on a big branchy net, and the process aborts with no report at all — the CLI's
 * exit-code contract included. An `unknown` naming the ceiling is strictly more useful.
 */
export function smtRefusalFor(
  flat: FlatNet, joinInputs: number, mode: SmtFallbackMode,
): string | null {
  if (mode === 'force') return null;
  if (mode === 'off') {
    return 'the SMT route is off (smtFallback: \'off\'), so nothing was asked of z3 and the ' +
      'P-invariant pipeline never ran';
  }
  const places = flat.places.length;
  if (places <= SMT_MAX_FLAT_PLACES && joinInputs <= SMT_MAX_JOIN_INPUTS) return null;
  const over = places > SMT_MAX_FLAT_PLACES
    ? `${places} flat places (ceiling ${SMT_MAX_FLAT_PLACES})`
    : `${joinInputs} join inputs (ceiling ${SMT_MAX_JOIN_INPUTS})`;
  return `the SMT route was not started: this net has ${over}, above the size where libpetri's ` +
    'pre-solver pipeline (flatten, structural pre-check, P-invariants, semiflows) was measured to ' +
    'exhaust the V8 heap — which aborts the process rather than returning a verdict, so it is not ' +
    'attempted. Verify a smaller slice of the workflow, or pass smtFallback: \'force\' ' +
    '(--smt-fallback force) to run it anyway';
}
