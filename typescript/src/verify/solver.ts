/**
 * What a report needs from its environment before any query: a libpetri recent enough for
 * the SMT surface this verifier calls, and a z3 executable to shell out to (VER-013).
 */
import { SmtVerifier, formatZ3Version, resolveZ3, type Z3Solver } from 'libpetri/verification';
import { messageOf } from '../internal/errors.js';
import { rethrowIfBug } from './rethrow-if-bug.js';
import type { SolverInfo } from './types.js';

/**
 * The `SmtVerifier` methods this module calls that libpetri gained in 5.1.0.
 *
 * Presence is checked once per report, before any query, because the alternative is worse than
 * a missing method: each call site would throw a `TypeError` from inside a query, and although
 * `rethrowIfBug` now makes that loud rather than a verdict, the message a reader gets is
 * `verifier.sinkPlacesWhen is not a function` from a stack several frames deep — which reads as
 * a bug in this project rather than as an install that predates the API. The `package.json`
 * range asked for `^5.0.0` until 5.1.0 shipped, and a registry install satisfied it with
 * exactly such a package — so this was the likeliest wrong configuration rather than a
 * hypothetical one. The floor is right now, and this check is what makes a downgrade or a
 * stale lock fail with a sentence instead of with missing proofs.
 *
 * The three named methods stand in for the whole surface: `semiflowInvariants('auto')` — the
 * string argument, not the method, which 5.0.0 already had — and `SmtVerificationResult.route`
 * ship in the same release and cannot be probed without calling or running.
 *
 * **The limit of that proxy**, stated because it is invisible from the code: the five pieces
 * are assumed to ship together, which holds because upstream landed them in one commit. If a
 * future release ever splits them, this check passes while `'auto'` or `route` is missing —
 * and the failure returns to its disguised form, a `TypeError` from inside a query. Add the
 * split piece here if that ever happens.
 *
 * **The phase surface is required even though nothing here calls it.** `stateEquationPhase` and
 * `firingBound` (VER-018 / VER-019) are default-on in libpetri, so this verifier never names
 * them — and that is exactly why they belong here. Measured on 2026-09-16, every fallback proof
 * on every fixture came back with method `state-equation`; without the phase `switch20` and
 * `chain40` return nothing at all above k = 2 (`tasks/libpetri-handover-2026-09-16.md`). An
 * install that predates them therefore does not fail, it just stops proving things, which is
 * the one outcome this module exists to prevent. Their presence is the proxy for the phase.
 *
 * They shipped in libpetri 6.0.0 alongside VER-022 open-net contracts, which is why the floor
 * moved there from 5.1.0. A `^5` install satisfies neither, and the failure it produces without
 * this check is not an error but a report whose proofs are quietly absent.
 */
const REQUIRED_VERIFIER_METHODS = [
  'sinkPlacesWhen', 'stateEquation', 'enumerationMaxClasses', 'stateEquationPhase', 'firingBound',
] as const;

/**
 * Fails with a message naming the gap when the installed libpetri predates the API this
 * module needs (VER-014, VER-016, VER-017).
 */
export function assertLibpetriSurface(): void {
  const proto = SmtVerifier.prototype as unknown as Record<string, unknown>;
  const missing = REQUIRED_VERIFIER_METHODS.filter((m) => typeof proto[m] !== 'function');
  if (missing.length === 0) return;
  throw new Error(
    `the installed libpetri is too old for this verifier: SmtVerifier is missing ${missing.join(', ')}. ` +
    'This surface is VER-014 conditional sinks, VER-016 the state equation, VER-017 bounded ' +
    "enumeration and `semiflowInvariants('auto')`, plus VER-018 / VER-019, the state-equation " +
    'and firing-bound phases. All of it is in libpetri 6.0.0; run `npm install libpetri@^6.0.0` ' +
    'rather than relaxing this check. Without the phases the report does not fail — it closes ' +
    'with the proofs quietly missing.',
  );
}

/** Resolves z3 once per run (VER-013); a failure is a reason string, never a throw. */
export function resolveSolver(env: NodeJS.ProcessEnv = process.env): SolverInfo {
  try {
    const solver: Z3Solver = resolveZ3(env);
    return {
      available: true,
      program: solver.program,
      version: formatZ3Version(solver.version),
      reason: null,
    };
  } catch (e) {
    // "No usable z3" is a real condition and a reason string; a defect in the resolution path
    // is not, and reported as unavailability it would make every report solver-free and
    // quietly weaker rather than failing.
    rethrowIfBug(e);
    return {
      available: false,
      program: null,
      version: null,
      reason:
        'no usable z3 executable resolved: put z3 >= 4.8.0 on PATH or point LIBPETRI_Z3 at one ' +
        `(${messageOf(e)})`,
    };
  }
}
