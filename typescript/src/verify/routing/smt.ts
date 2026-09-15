/**
 * The SMT route: libpetri's `SmtVerifier` (IC3/PDR through z3, VER-001/VER-013), asked only
 * where the state-class graph did not decide, and refused outright above the net size where
 * its pre-solver pipeline was measured to abort the process.
 *
 * Nothing here throws on a solver problem: a refusal, a missing z3 or a failed query is an
 * `unknown` carrying the reason (VER-013), and only a programming error is re-thrown
 * (`rethrowIfBug`).
 */
import { performance } from 'node:perf_hooks';
import type { Place } from 'libpetri';
import { SmtVerifier, type SmtProperty, type SmtVerificationResult } from 'libpetri/verification';
import { messageOf } from '../../internal/errors.js';
import { decodeCounterexample } from '../counterexample.js';
import { rethrowIfBug } from '../rethrow-if-bug.js';
import type { CheckVerdict, Counterexample } from '../types.js';
import { cacheInvariants } from './collect-invariants.js';
import type { Context, Decision } from './context.js';

interface QueryOutcome {
  readonly verdict: CheckVerdict;
  readonly reason: string | null;
  readonly method: string | null;
  readonly result: SmtVerificationResult | null;
  readonly elapsedMs: number;
}

/** A sink set that applies only while `marker` holds a token (libpetri VER-014). */
export interface ConditionalSink {
  readonly marker: Place<unknown>;
  readonly places: readonly Place<unknown>[];
}

/** An outcome that decided nothing, with the reason why. */
function undecided(reason: string | null, elapsedMs: number): QueryOutcome {
  return { verdict: 'unknown', reason, method: null, result: null, elapsedMs };
}

/**
 * Runs one SMT query. Never throws: a solver problem, a CORE-043 rejection or any other
 * failure becomes `unknown` with the message as the reason (VER-013). A net above the
 * measured size ceiling is refused outright (`smt-refusal.ts` `smtRefusalFor`).
 */
async function query(
  ctx: Context, property: SmtProperty, sinks: readonly Place<unknown>[],
  conditional: readonly ConditionalSink[] = [],
): Promise<QueryOutcome> {
  if (ctx.smtRefusal !== null) return undecided(ctx.smtRefusal, 0);
  if (!ctx.solver.available) return undecided(ctx.solver.reason, 0);
  const started = performance.now();
  try {
    const result = await verifierFor(ctx, property, sinks, conditional).verify();
    if (ctx.invariants === null && result.invariants.length > 0) cacheInvariants(ctx, result);
    return outcomeOf(result, performance.now() - started);
  } catch (e) {
    rethrowIfBug(e);
    return undecided(`verification failed: ${messageOf(e)}`, performance.now() - started);
  }
}

/** The configured verifier for one query: this report's net, marking, budget and sinks. */
function verifierFor(
  ctx: Context, property: SmtProperty, sinks: readonly Place<unknown>[],
  conditional: readonly ConditionalSink[],
): SmtVerifier {
  const verifier = SmtVerifier.forNet(ctx.compiled.net)
    .initialMarking(ctx.state)
    .semiflowInvariants(semiflowSetting(ctx))
    .timeout(ctx.timeoutMs)
    .property(property);
  if (sinks.length > 0) verifier.sinkPlaces(...sinks);
  for (const c of conditional) verifier.sinkPlacesWhen(c.marker, ...c.places);
  // The quiescence question is a proof attempt, and its inductive invariant needs the
  // ordering laws only the marking equation states (libpetri VER-016, `tasks/todo.md` §4):
  // with firing counters in the rule bodies the agent net at `maxToolCalls` 64 proves in
  // 1.6 s where it was unknown at 120 s. The reachability families are witness hunts on a
  // truncated graph, and counters slow witness search ~1.5×, so they stay without.
  if (property.type === 'deadlock-free') verifier.stateEquation(true);
  // libpetri's bounded enumeration (VER-017) is the attempt this module has *already* made
  // before any query reaches here: `StateSpace` builds the same state-class graph, with a
  // larger budget (`DEFAULT_MAX_CLASSES`, 200 000 against its 50 000) and the classification
  // the report is built on — the pause filter, the truncation cause, the cyclic-run bound.
  // The fallback runs only where that route did *not* close, so a second enumeration under a
  // smaller budget cannot close either: it re-explores up to 50 000 classes per query and
  // then declines. Two things it costs when left on: the wall clock of that attempt (the
  // suite goes from 17 s to 101 s, the agent net at K = 64 from 1.6 s to 2.6 s), and the
  // report's invariants — a verdict read off the graph runs no P-invariant pipeline, so
  // `result.invariants` comes back empty and the structural section this module prints from
  // it goes with it. Turned off here so the enumeration happens once, in the route that
  // reports it properly; raising `maxClasses` is how a caller asks for more of it.
  return verifier.enumerationMaxClasses(0);
}

/** A finished query's verdict, reason and method. */
function outcomeOf(result: SmtVerificationResult, elapsedMs: number): QueryOutcome {
  const verdict = result.verdict;
  return {
    verdict: verdict.type,
    reason: verdict.type === 'unknown' ? verdict.reason : null,
    method: methodOf(verdict),
    result,
    elapsedMs,
  };
}

/** What decided: libpetri's own method name for a proof, IC3/PDR for a counterexample. */
function methodOf(verdict: SmtVerificationResult['verdict']): string | null {
  switch (verdict.type) {
    case 'proven': return verdict.method;
    case 'violated': return 'IC3/PDR';
    default: return null;
  }
}

/** An SMT query as a {@link Decision}. */
export async function smtDecision(
  ctx: Context, property: SmtProperty, sinks: readonly Place<unknown>[] = [],
  conditional: readonly ConditionalSink[] = [],
): Promise<Decision> {
  const outcome = await query(ctx, property, sinks, conditional);
  return {
    verdict: outcome.verdict,
    reason: outcome.reason,
    route: 'smt',
    method: outcome.method,
    elapsedMs: outcome.elapsedMs,
    counterexample: counterexampleFor(outcome, ctx),
  };
}

function counterexampleFor(outcome: QueryOutcome, ctx: Context): Counterexample | null {
  if (outcome.result === null || outcome.verdict !== 'violated') return null;
  return decodeCounterexample(outcome.result, ctx.map);
}

/**
 * How the semiflow union is asked for: `'auto'` when the caller wants it, `false` when not.
 *
 * The option means "strengthen the encoding with the P-semiflows", and `'auto'` is how libpetri
 * does exactly that and nothing more: it unions them when the null-space basis lost a law to
 * the H1 guard — a non-linear place, which on these nets means the OR gadget's `all()` arc —
 * and skips them when the basis is already complete, where they are provably redundant. That
 * is the rule this project measured its way to and libpetri then made first-class, and it
 * decides in one pass from a fact phase 3 already has.
 *
 * Why not plain `true`, which is what this passed before: the enumeration is worst-case
 * exponential in branching, and on the shapes that matter here it *is* the pipeline. Measured
 * 2026-09-09 on `layers` diamonds in series, phases 1-3 only: 81 nodes and 870 places cost
 * 135.1 s with the union forced on and 2.6 s with `'auto'`, which chose to skip it and returned
 * 144 of the 145 invariants — the one it left behind having moved no verdict on any fixture.
 * `ifBothOutputs` is the net that does lose a law, and there `'auto'` turns the union on and
 * returns the full 12 where `false` returns 10. So `'auto'` is `true`'s invariants where they
 * exist and `false`'s cost everywhere else. libpetri pins that its verdict never differs from
 * whichever explicit setting it chose.
 *
 * This is also what made `SMT_MAX_JOIN_INPUTS` / `SMT_MAX_FLAT_PLACES` necessary: the abort
 * they guard was the union's cost, not the net's size (`tasks/todo.md`, and re-measure before
 * removing them).
 */
function semiflowSetting(ctx: Context): 'auto' | false {
  return ctx.semiflowInvariants ? 'auto' : false;
}
