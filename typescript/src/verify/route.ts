/**
 * The two routes a reachability-safety question can take, the order they are asked in, and
 * the per-report {@link Context} both read.
 *
 * The **solver-free route** is libpetri's state-class graph (VER-010, `state-class.ts`),
 * explored once per report; {@link graphBound}, {@link graphUnreachable} and
 * {@link graphStranding} read a verdict off it, or return `null` when it did not decide. The
 * **SMT route** is libpetri's `SmtVerifier` (IC3/PDR through z3, VER-001/VER-013), run through
 * {@link query} only where the graph truncated or failed to build — the order NU-053
 * prescribes. {@link boundedOrUnknown} is the last step of that order on a cyclic workflow,
 * and {@link decideStranding} is the whole of it for the proper-completion family.
 *
 * Nothing here throws on a solver problem: a refusal, a missing z3 or a failed query is an
 * `unknown` carrying the reason (VER-013), and only a programming error is re-thrown
 * (`state-class.ts` `rethrowIfBug`).
 */
import { performance } from 'node:perf_hooks';
import type { Place } from 'libpetri';
import {
  SmtVerifier, deadlockFree, placeBound,
  type FlatNet, type MarkingState, type PInvariant, type SmtProperty, type SmtVerificationResult,
} from 'libpetri/verification';
import type { CompiledWorkflow, NetMapView, PlaceRole } from '../compiler/index.js';
import { messageOf } from '../internal/errors.js';
import { decodeCounterexample } from './counterexample.js';
import { unionedSemiflows } from './invariants.js';
import {
  TERMINAL_WITNESS_REASON, boundedReason, completionUnknownReason, smtFallbackNote, undecidedReason,
} from './reasons.js';
import {
  HALT_REST_ROLES, PAUSE_REST_ROLES, REST_ROLES, restRolesFor, rethrowIfBug, terminalKindOf,
  witnessCounterexample,
} from './state-class.js';
import type { StateSpace, TruncationShape } from './state-class.js';
import type {
  CheckRoute, CheckVerdict, Counterexample, PropertyCheck, QueryRecord, SmtFallbackMode, SolverInfo,
} from './types.js';

interface QueryOutcome {
  readonly verdict: CheckVerdict;
  readonly reason: string | null;
  readonly method: string | null;
  readonly result: SmtVerificationResult | null;
  readonly elapsedMs: number;
}

/**
 * A decided (or undecided) question, whichever route answered it. `verdict` is libpetri's
 * own polarity — the polarity inversion the dead-nodes family applies happens at the call
 * site, so {@link PropertyCheck.query} can record what was actually asked.
 */
export interface Decision {
  readonly verdict: CheckVerdict;
  readonly reason: string | null;
  readonly route: CheckRoute;
  readonly method: string | null;
  readonly elapsedMs: number;
  readonly counterexample: Counterexample | null;
}

/** Everything one report's families share: the net, both routes, and the checks recorded so far. */
export interface Context {
  readonly compiled: CompiledWorkflow;
  readonly map: NetMapView;
  readonly state: MarkingState;
  readonly flat: FlatNet;
  readonly timeoutMs: number;
  readonly semiflowInvariants: boolean;
  readonly solver: SolverInfo;
  /** How far the SMT route may go (`VerifyOptions.smtFallback`). */
  readonly smtFallback: SmtFallbackMode;
  /** Why no `SmtVerifier` may be constructed for this net; `null` when it may. */
  readonly smtRefusal: string | null;
  /** What the workflow's shape is, for the truncation cause. */
  readonly shape: TruncationShape;
  /** The solver-free route, explored once and shared by every family (`state-class.ts`). */
  readonly space: StateSpace;
  /** Node → the alternative entry point that is the only reason it cannot run here. */
  readonly entryReach: ReadonlyMap<string, string>;
  /** The whole-net completion question's sink declaration, built once per report ({@link completionSinksOf}). */
  readonly completion: CompletionSinks;
  readonly checks: PropertyCheck[];
  readonly onCheck: ((check: PropertyCheck) => void) | undefined;
  /** The invariant list of the first result that carried one: what the encoder actually saw. */
  invariants: readonly PInvariant[] | null;
  /** That result's report, for the two canonical count lines. */
  invariantReport: string | null;
  /**
   * Whether {@link invariants} came from a run that actually unioned the semiflows. A query's
   * run asks `'auto'`, which *skips* the union whenever the basis is complete, and
   * {@link collectInvariants} needs the union's non-negative form. Without this flag the cache
   * hands it a basis-only list and the budget semiflow is reported missing on a net that has
   * one — see the comment in `collectInvariants`, and "reports the same semiflow whether or not
   * the class cap let the graph close" in `tests/verify/properties.test.ts`.
   *
   * Set from `unionedSemiflows` (`invariants.ts`), which tests for the *presence* of libpetri's
   * `Semiflows encoded as invariants:` line rather than for a non-zero count: the line appears
   * exactly when the union ran, and a count of zero means the basis already covered it.
   */
  invariantsUnionedSemiflows: boolean;
  /**
   * The whole-net `deadlockFree` fallback, memoised for this report ({@link smtFallbackCompletion}):
   * **one** query per workflow, not one per place — that was M4's shape and it is what made the
   * family cost (places x timeout). `null` until a completion row first needs it. Held on the
   * context, so concurrent `verifyCompiled` calls never share an entry.
   */
  completionFallback: Promise<Decision> | null;
}

// ==================== the SMT route ====================

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

/**
 * Runs one SMT query. Never throws: a solver problem, a CORE-043 rejection or any other
 * failure becomes `unknown` with the message as the reason (VER-013). A net above the
 * measured size ceiling is refused outright ({@link smtRefusalFor}).
 */
async function query(
  ctx: Context, property: SmtProperty, sinks: readonly Place<unknown>[],
  conditional: readonly ConditionalSink[] = [],
): Promise<QueryOutcome> {
  if (ctx.smtRefusal !== null) {
    return { verdict: 'unknown', reason: ctx.smtRefusal, method: null, result: null, elapsedMs: 0 };
  }
  if (!ctx.solver.available) {
    return { verdict: 'unknown', reason: ctx.solver.reason, method: null, result: null, elapsedMs: 0 };
  }
  const started = performance.now();
  try {
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
    verifier.enumerationMaxClasses(0);
    const result = await verifier.verify();
    if (ctx.invariants === null && result.invariants.length > 0) {
      ctx.invariants = result.invariants;
      ctx.invariantReport = result.report;
      ctx.invariantsUnionedSemiflows = unionedSemiflows(result.report);
    }
    return {
      verdict: result.verdict.type,
      reason: result.verdict.type === 'unknown' ? result.verdict.reason : null,
      method: result.verdict.type === 'proven' ? result.verdict.method : result.verdict.type === 'violated' ? 'IC3/PDR' : null,
      result,
      elapsedMs: performance.now() - started,
    };
  } catch (e) {
    rethrowIfBug(e);
    return {
      verdict: 'unknown',
      reason: `verification failed: ${messageOf(e)}`,
      method: null,
      result: null,
      elapsedMs: performance.now() - started,
    };
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

/**
 * The solver budget for the invariant-only run. **One millisecond, on purpose**: the
 * invariants come out of phases 1-3 of the pipeline, not out of z3 — `no-z3.test.ts` pins
 * that they are computed with no solver at all — so this run wants the pipeline and nothing
 * else. Its verdict is discarded; the budget bound itself was already decided (by the graph,
 * or by the family's own query).
 */
const INVARIANT_SOLVER_TIMEOUT_MS = 1;

/**
 * One invariant-only pipeline run, for a report that ran no query that produced invariants.
 *
 * This is the expensive half of the SMT route — flatten, structural pre-check, P-invariant
 * and semiflow enumeration — and since M5 it is the *only* reason a report whose graph
 * closed pays it: it is run once, lazily, and only for the budget family's semiflow check,
 * which is the one claim the solver-free route cannot make. A report that does not select
 * `budget` never touches it, and neither does one whose net is above
 * {@link SMT_MAX_JOIN_INPUTS} / {@link SMT_MAX_FLAT_PLACES} — where running it would abort
 * the process.
 */
export async function collectInvariants(ctx: Context): Promise<readonly PInvariant[] | null> {
  // A cache filled by {@link query} came from a `'auto'` run, and `'auto'` skips the union
  // whenever the basis is complete — the very case this run exists for. Reusing it then reports
  // "no law giving _budget and every X/running the same positive weight" on a net that has one,
  // and *which* it reports depends on whether some other family happened to need the solver
  // first: measured, a nested agent at `maxToolCalls` 3 loses the law at the default class cap
  // and keeps it at a cap large enough to close, on one net with one marking. So the cache is
  // honoured only when it carries the union, or when semiflows are switched off and the basis
  // is all there is to have.
  if (ctx.invariants !== null && (ctx.invariantsUnionedSemiflows || !ctx.semiflowInvariants)) {
    return ctx.invariants;
  }
  // Same guard as {@link query}: this *is* the pipeline, so on a net above the ceiling it is
  // the call that would abort the process.
  // `null`, where the two failure paths below return `ctx.invariants` instead. Not an
  // inconsistency: `smtRefusal` is decided once when the context is built and never changes, and
  // `query()` returns on it before it can touch the cache — so on this path `ctx.invariants` is
  // provably still `null` and the two spellings agree. Stated because the reasoning is not
  // local: a future `smtRefusal` set lazily would turn this line into silent data loss.
  if (ctx.smtRefusal !== null) return null;
  try {
    const result = await SmtVerifier.forNet(ctx.compiled.net)
      .initialMarking(ctx.state)
      // **Not `'auto'` here, and this is the one place the distinction bites.** `'auto'` unions
      // the semiflows when the basis lost a law to the H1 guard, which is a test of
      // *deficiency*; this run needs a law of a particular *form* — non-negative, weighting
      // `_budget` and every `X/running` positively — and `computePInvariants` returns a signed
      // null-space basis, which may span that law without containing it. Measured: with
      // `'auto'` on `diamond` the basis is complete, the semiflows are skipped, and
      // `budgetSemiflow` comes back null, so the budget family reports "no law giving _budget
      // and every X/running the same positive weight" on a net that has one. The union is what
      // produces it in non-negative form (`computePSemiflows`), so this run always asks for it.
      // It is lazy and runs only for the `budget` family, so the cost lands only on a report
      // that selects it.
      .semiflowInvariants(ctx.semiflowInvariants)
      .timeout(INVARIANT_SOLVER_TIMEOUT_MS)
      // This run exists *for* the pipeline's invariants, and libpetri's bounded enumeration
      // (VER-017) is a route around the pipeline: it reads the verdict off a state-class graph
      // and returns no invariants at all, which empties the report's structural section on
      // every net small enough to enumerate. The verdict here is discarded anyway.
      .enumerationMaxClasses(0)
      .property(placeBound(ctx.map.shared.budget, ctx.compiled.effectiveBudget))
      .verify();
    // An *empty* invariant list is only meaningful from the SMT route, the one that runs the
    // pipeline (VER-003's route criterion): from any other it means "not computed" rather
    // than "none exist", and caching it would make the report state the pipeline found no law
    // when it never ran. A non-empty list is real whatever the route — with no solver at all
    // the pipeline still runs and the route reports `unavailable`, which is exactly what
    // `no-z3.test.ts` pins. Both call sites disable enumeration, so this guards against a
    // future default answering here without the pipeline rather than against today.
    if (result.invariants.length === 0 && result.route !== 'smt') return ctx.invariants;
    ctx.invariants = result.invariants;
    ctx.invariantReport = result.report;
    // A run that asked for the union and got no line back means libpetri's wording drifted, and
    // `unionedSemiflows` would then read `false` forever — a repeated pipeline rather than a
    // wrong answer, so nothing at run time would show it. `tests/verify/libpetri-surface.test.ts`
    // pins the line instead, which fails on upgrade rather than degrading quietly in production.
    ctx.invariantsUnionedSemiflows = unionedSemiflows(result.report);
    return result.invariants;
  } catch (e) {
    // Same rule as {@link query}: an invariant pipeline that failed is `null`, a bug is not.
    // This catch was bare, so a `TypeError` here emptied the report's structural section and
    // took the budget family's semiflow with it, silently.
    rethrowIfBug(e);
    return ctx.invariants;
  }
}

// ==================== the solver-free decisions ====================

/** A verdict read straight off the graph. */
export function graphDecision(
  verdict: CheckVerdict, counterexample: Counterexample | null = null, reason: string | null = null,
): Decision {
  return {
    verdict,
    reason,
    route: 'state-class-graph',
    method: verdict === 'bounded' ? 'state-class graph (bounded)' : 'state-class graph',
    elapsedMs: 0,
    counterexample,
  };
}

/**
 * `placeBound(place, bound)` from the graph. `null` when the graph decided nothing — it
 * truncated with no violation in the prefix, or failed to build — in which case the caller
 * runs the SMT fallback and then {@link boundedOrUnknown}.
 *
 * A complete graph decides this **exactly**: the peak token count over every reachable class
 * either exceeds the bound or does not. There is no abstraction gap on the bound itself; the
 * gap is the one every verdict here carries (priority-blind, value-blind, atomic firing).
 *
 * A peak *above* the bound is a verdict at any completeness: the class holding it was
 * genuinely reached, so a truncated graph that finds one has found a real violation. Only
 * the *absence* of one needs the graph to have closed.
 */
export function graphBound(ctx: Context, place: Place<unknown>, bound: number): Decision | null {
  if (!ctx.space.usable) return null;
  if (ctx.space.peak(place) > bound) {
    const witness = ctx.space.peakWitness(place);
    return graphDecision('violated', witness === null ? null : witnessCounterexample(witness));
  }
  return ctx.space.complete ? graphDecision('proven') : null;
}

/**
 * `unreachable({place})` from the graph, for the dead-nodes family.
 *
 * A class marking `place` is a real witness whether or not the graph closed, so *reachable*
 * (libpetri's `violated`) is decided from a truncated graph too — which matters, because the
 * family's fallback is one SMT query per node and a truncated graph is exactly the big
 * workflow where that is unaffordable. **Unreachable** needs a complete graph and gets no
 * `bounded` arm: "the node did not run within `k` cyclic-node runs" is not evidence that it
 * is dead, and reporting it as the family's finding would send a reader after a non-bug.
 */
export function graphUnreachable(ctx: Context, place: Place<unknown>): Decision | null {
  if (!ctx.space.usable) return null;
  if (ctx.space.everMarked(place)) return graphDecision('violated');
  return ctx.space.complete ? graphDecision('proven') : null;
}

/**
 * The route order for a question the graph examined and found nothing wrong with, over a
 * graph that then truncated: the SMT fallback first (a `proven` from it would be a real
 * proof and outranks any bound), and the bounded verdict only if the solver did not decide.
 *
 * `bounded` is offered only when {@link StateSpace.boundedCyclicRuns} is non-null, i.e. only
 * on a workflow with a cycle whose explored prefix closes at least one whole cyclic-node run.
 * The other truncation shapes — heavy independent parallelism (NU-053), or a cap set too
 * low — have nothing to count and stay `unknown`, which is the honest answer there.
 */
export function boundedOrUnknown(ctx: Context, decision: Decision, note: string | null = decision.reason): Decision {
  if (decision.verdict !== 'unknown') return decision;
  const iterations = ctx.space.boundedCyclicRuns;
  if (iterations === null) return decision;
  // "The SMT route:" and not "the fallback did not close it either": the note may say the
  // query was never asked, and stacking a false claim on top of that was the shape of the
  // reason strings this route had to stop producing.
  const reason = note === null || note === ''
    ? boundedReason(ctx, iterations)
    : `${boundedReason(ctx, iterations)}. The SMT route: ${note}`;
  return { ...graphDecision('bounded', null, reason), elapsedMs: decision.elapsedMs };
}

/**
 * The weaker of two verdicts, for a claim that is the conjunction of several checks.
 *
 * `violated` dominates: one counterexample refutes the conjunction whatever the rest say. Among
 * the others the order is `unknown` < `bounded` < `proven`, because `bounded` carries a real
 * statement (it holds within the explored bound) where `unknown` carries none.
 *
 * Written as a rank rather than a chain of ternaries: the chain this replaced kept the *last*
 * non-proven verdict instead of the weakest, so an `unknown` attempt followed by a `bounded` one
 * reported `bounded` for the pair and over-claimed.
 */
export function weakerVerdict(a: CheckVerdict, b: CheckVerdict): CheckVerdict {
  if (a === 'violated' || b === 'violated') return 'violated';
  const rank: Record<CheckVerdict, number> = { violated: 0, unknown: 1, bounded: 2, proven: 3 };
  return rank[a] <= rank[b] ? a : b;
}

// ==================== proper completion's route ====================

/**
 * Does any reachable quiescent marking leave pending work on `place`?
 *
 * Complete graph: exact — `violated` with the stuck marking and the firing path, or
 * `proven`. Truncated graph: a stranding actually found is still a real one (a quiescent
 * class of the explored prefix is quiescent and reachable), so it is reported; the absence
 * of one is **not** a proof and returns `null` so the caller falls back.
 */
export function graphStranding(ctx: Context, place: Place<unknown>): Decision | null {
  if (!ctx.space.usable) return null;
  const stranding = ctx.space.strandedAt(place);
  if (stranding !== null) return graphDecision('violated', witnessCounterexample(stranding));
  if (!ctx.space.complete) return null;
  return graphDecision('proven');
}

/** A sink set that applies only while `marker` holds a token (libpetri VER-014). */
export interface ConditionalSink {
  readonly marker: Place<unknown>;
  readonly places: readonly Place<unknown>[];
}

/** A check's sink declaration by name, exactly as {@link QueryRecord} records it. */
export type SinkRecord = Pick<QueryRecord, 'sinks' | 'conditionalSinks'>;

/**
 * The whole-net completion question's sink declaration (VER-002, VER-014).
 *
 * It is a property of the net, not of any one check, so it is computed once when the context
 * is built rather than rescanned for every completion row, and every proper-completion row's
 * {@link QueryRecord} references the same {@link recorded} name lists rather than copying them.
 * The serialised report is unchanged: each row still carries both lists.
 */
export interface CompletionSinks {
  /**
   * The structural rest set as `Place` objects: the unconditional sink declaration the
   * whole-net `deadlockFree` fallback is asked with (VER-002). It is exactly `REST_ROLES` read
   * off `NetMap`, so the SMT question and the graph's classification start from the same set.
   */
  readonly sinks: readonly Place<unknown>[];
  /**
   * The pause filter as a sink declaration: while `_pause` is marked a token may rest on the
   * places `PAUSE_REST_ROLES` adds to the rest set, and while `_halt` is marked on those
   * `HALT_REST_ROLES` adds. `terminalKindOf` also treats a marked `waiting` / `stopped` place
   * as a pause, and `_pause` alone reproduces that because every branch that produces one
   * produces `_pause` beside it and nothing ever consumes `_pause` (`compiler/gadget.ts`, the
   * waiting and stopped branches). `HALT_REST_ROLES ⊇ PAUSE_REST_ROLES`, so libpetri's union
   * across markers is the graph's halt-over-pause precedence. A net without the marker
   * declares nothing for it.
   */
  readonly conditional: readonly ConditionalSink[];
  /** Both declarations by name, shared by reference by every completion row's query record. */
  readonly recorded: SinkRecord;
}

/** Builds {@link CompletionSinks} from the net map, once per report. */
export function completionSinksOf(map: NetMapView): CompletionSinks {
  const sinks = map.places.filter((p) => REST_ROLES.has(p.role)).map((p) => p.place);
  const marker = (role: PlaceRole): Place<unknown> | null =>
    map.places.find((p) => p.role === role)?.place ?? null;
  const widened = (roles: ReadonlySet<PlaceRole>): readonly Place<unknown>[] =>
    map.places.filter((p) => roles.has(p.role) && !REST_ROLES.has(p.role)).map((p) => p.place);
  const conditional: ConditionalSink[] = [];
  const pause = marker('pause');
  if (pause !== null) conditional.push({ marker: pause, places: widened(PAUSE_REST_ROLES) });
  const halt = marker('halt');
  if (halt !== null) conditional.push({ marker: halt, places: widened(HALT_REST_ROLES) });
  return {
    sinks,
    conditional,
    recorded: {
      sinks: sinks.map((p) => p.name),
      conditionalSinks: conditional.map((c) => ({ marker: c.marker.name, places: c.places.map((p) => p.name) })),
    },
  };
}

/** True when the witness marking holds `_pause` or `_halt`. */
function witnessIsExcusedTerminal(cex: Counterexample | null): boolean {
  if (cex === null) return false;
  const rest = restRolesFor(terminalKindOf(cex.stuckMarking.map((p) => p.role)));
  return !cex.stuckMarking.some((p) => p.role === null || !rest.has(p.role));
}

/** Whether the fallback's witness marking holds a token on this very place. */
function witnessMarks(cex: Counterexample | null, place: Place<unknown>): boolean {
  return cex !== null && cex.stuckMarking.some((p) => p.place === place.name);
}

/** The graph first (NU-053); the whole-net `deadlockFree` query only where it truncated. */
export async function decideStranding(ctx: Context, place: Place<unknown>): Promise<Decision> {
  const fromGraph = graphStranding(ctx, place);
  if (fromGraph !== null) return fromGraph;
  const fallback = await smtFallbackCompletion(ctx);
  if (fallback.verdict === 'proven') return fallback;
  // A `violated` that reached here is a stranding the solver found and the pause filter did
  // *not* excuse (`smtFallbackCompletion` downgrades a designed-terminal witness). It is
  // about the whole net, so it becomes this row's finding only when its own witness marking
  // holds this place; otherwise the whole-net row carries it and this row stays undecided —
  // with a reason that says so rather than claiming the fallback decided nothing.
  if (fallback.verdict === 'violated') {
    if (witnessMarks(fallback.counterexample, place)) return fallback;
    return {
      ...fallback,
      verdict: 'unknown',
      reason: undecidedReason(ctx, 'the whole-net deadlockFree fallback found a stranding elsewhere in ' +
        'this net (see the whole-net row), which decides nothing about this place'),
    };
  }
  return boundedOrUnknown(ctx, {
    ...fallback,
    verdict: 'unknown',
    reason: completionUnknownReason(ctx, fallback),
    counterexample: fallback.counterexample,
  }, smtFallbackNote(fallback));
}

/**
 * The whole-net `deadlockFree` fallback with the rest set as sinks and the pause / halt
 * widenings as conditional sinks (VER-002, VER-014), a designed-terminal witness downgraded
 * to `unknown` (`reasons.ts` `TERMINAL_WITNESS_REASON`). Asked at most once per report
 * ({@link Context.completionFallback}).
 *
 * It is asked wherever the graph did not close: with the widenings declared (VER-014) the
 * question is the graph's own, so a reachable designed terminal no longer makes it false,
 * and the gate that skipped it on that ground is gone with the reason it gave.
 */
export function smtFallbackCompletion(ctx: Context): Promise<Decision> {
  ctx.completionFallback ??= (async (): Promise<Decision> => {
    const decision = await smtDecision(ctx, deadlockFree(), ctx.completion.sinks, ctx.completion.conditional);
    if (decision.verdict === 'violated' && witnessIsExcusedTerminal(decision.counterexample)) {
      return { ...decision, verdict: 'unknown', reason: TERMINAL_WITNESS_REASON };
    }
    return decision;
  })();
  return ctx.completionFallback;
}
