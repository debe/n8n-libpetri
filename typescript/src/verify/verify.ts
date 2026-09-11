/**
 * `verify(workflow)` — the property table, over the same net the scheduler executes.
 *
 * There is no verification net. {@link verify} calls `compile()` exactly as
 * `PetriScheduler` does and asks its questions of `compiled.net`, so every verdict is about
 * the semantics production runs. Counterexamples come back as node paths
 * (`counterexample.ts`), never as place names.
 *
 * ## Two routes, and which one decides
 *
 * Every question here is **reachability-safety**: does any reachable marking do this? There
 * are two ways to decide such a question over a libpetri net, and M5 inverted which one
 * leads:
 *
 * - the **solver-free route** (`state-class.ts`): libpetri's state-class graph (VER-010),
 *   enumerated once per report and read by every family. When the graph is **complete** it
 *   decides exactly — a bound, a co-marking, a reachable place, a stranded token — with no
 *   solver process and no P-invariant pipeline. When it **truncates** at its class cap it
 *   still decides every violation it found (a class of the explored prefix is reachable
 *   however the BFS ended) and, on a *cyclic* workflow, still certifies the largest whole
 *   number of runs of the workflow's cyclic nodes its prefix closes — the `bounded` verdict;
 * - the **SMT route** (libpetri's `SmtVerifier`, IC3/PDR through z3, VER-001/VER-013): the
 *   **fallback**, run per family only where the graph truncated or failed to build — and not
 *   at all above the measured net size of {@link smtRefusalFor}, where the pipeline libpetri
 *   runs before z3 aborts the process instead of answering, nor for a question the graph has
 *   already shown that query cannot decide ({@link provenUnreachableReason}).
 *
 * NU-053 prescribes exactly this order — *"the verifier routes a bounded quiescence query to
 * Route B first; when Route B truncates (`Unknown`), it defers to \[the SMT encoding] rather
 * than returning `Unknown`"*. M4 had it the other way round and the headline property never
 * closed. `docs/verification.md` has the measured before/after.
 *
 * ## The three things a truncated graph can still say
 *
 * A cap is what turns "hangs" into "reports a limit", and the limit is reported three ways,
 * in decreasing strength. A **violation** found in the explored prefix is a full finding: a
 * quiescent class of that prefix is quiescent and reachable whatever the BFS did. A
 * **`bounded`** verdict is the honest middle for a cyclic workflow, whose state space is
 * unbounded so that `proven` is out of reach at every cap: the prefix closes every run in
 * which the workflow's cyclic nodes run at most `k` times, exactly, and says so
 * ({@link boundedReason}; the closure argument is `state-class.ts` `closedCyclicRuns`).
 * **`unknown`** is what is left — heavy independent parallelism (NU-053: no partial-order
 * reduction), or a cap simply set too low, where there is nothing to count.
 *
 * Nothing folds a `bounded` into `proven`: it has its own {@link CheckVerdict}, its own
 * count, its own section of the report and it fails `--strict`.
 *
 * ## The six property families and what each one can and cannot say
 *
 * 1. **proper completion** — *can this workflow strand a branch?* One whole-net check plus
 *    one per join input and per edge place. A quiescent class of the graph is a run that has
 *    come to rest; it is a **stranding** when it still holds a token on a place whose
 *    `PlaceRole` means pending work (`state-class.ts` `REST_ROLES`), and it is a *designed*
 *    terminal — a paused or halted run whose pending activations the marking codec writes
 *    back (ADR 0005) — when it holds `_pause` / `_halt` / `X/waiting` / `X/stopped`, where
 *    the rest set widens to what the codec accepts in the mode that terminal is encoded with
 *    (`state-class.ts` `PAUSE_REST_ROLES` / `HALT_REST_ROLES`). That filter is what M4 could
 *    not express: `joinedOrDeadLettered` carries no sink clause (NU-040 AC4), so a paused
 *    witness had to be downgraded to `unknown`. The SMT fallback is one **whole-net**
 *    `deadlockFree` query (VER-002 since the `terminatesAtSink` split: *quiescent ∧ some
 *    marked place is not a declared sink* — literally workflow-net proper completion) with
 *    the structural rest set declared as the sinks. Measured, it decides nothing the graph
 *    could not, and on a net whose graph already exhibits a quiescent marking outside that
 *    sink set it cannot even in principle, so it is not asked there (see
 *    {@link SMT_FALLBACK_REASON} and `docs/verification.md`).
 * 2. **dead nodes** — is `X/running` reachable? The graph answers by enumeration; the SMT
 *    fallback asks `unreachable({X/running})`. Only the *unreachable* direction becomes a
 *    verdict, and because that is the finding, the check reports `violated` (`types.ts`). A
 *    node the route *reaches* is `unknown`, never `proven`: both routes explore a
 *    priority-blind, value-blind abstraction in which every `xor` branch of a router is
 *    available whatever the data (VER-004 AC2), and VER-004 AC3 licenses the proof direction
 *    only. So is a node that is dead only because n8n starts **one trigger per execution**
 *    ({@link alternativeEntryReach}).
 * 3. **no double activation** — `X/running` never holds two tokens: the `X/idle` mutex made
 *    structural (`X/idle + X/running = 1` is a found P-invariant, ADR 0004).
 * 4. **budget** — `_budget` never exceeds `k`, plus the two-phase P-semiflow
 *    `w·_budget + w·Σ_X(running + retry + in-flight) = w·k` read off the validated invariants. A net
 *    whose budget were a self-loop would prove the bound trivially: the incidence column is
 *    zero, so the encoder never sees the place move. The two-phase gadget is what makes the
 *    bound mean something, and the semiflow is the half that carries the claim.
 * 5. **retry bound** — `X/tries` never exceeds `maxTries − 1` **plus** a structural check
 *    that no transition of the net produces `X/tries`. The bound alone only restates the
 *    seeding; the conjunction is what bounds the number of *attempts*.
 * 6. **mutual exclusion** — `A/running` and `B/running` never marked together, for
 *    caller-supplied pairs or every pair. At k = 1 every pair holds, which is a sanity check
 *    of the budget model rather than a workflow property; at k ≥ 2 it fails for independent
 *    nodes, which is the point of the budget.
 *
 * ## What no verdict here can say
 *
 * **Order** — both routes are priority-blind (the state-class graph expands every
 * base-enabled transition; the SMT encoding has no priority at all), so nothing about n8n's
 * depth-first walk or the divergence register's ordering rows is provable here. **Values** —
 * both are value-blind, so every `xor` branch of a router is explored and no verdict depends
 * on what a node returns. **Action duration** — both model a firing as atomic, while the
 * executor consumes at fire time and produces when the action settles; the difference is
 * confined to transitions whose *inhibitor* place an action can produce (`_halt`, `_pause`)
 * and is stated as scope in `docs/verification.md`. **Timing** is modelled exactly by the
 * state-class graph (VER-011 zones) and ignored by the SMT encoding, which only strengthens
 * an SMT proof.
 *
 * Without a usable z3 the solver-free route still decides everything a complete graph
 * decides; only the fallbacks and the P-invariant summary come back `unknown`, with a reason
 * naming `PATH` and `LIBPETRI_Z3` (VER-013). Nothing here throws on a solver problem.
 */
import { performance } from 'node:perf_hooks';
import { compile } from '../compiler/index.js';
import type {
  CompiledWorkflow, NetMapView, NodeGadget, PlaceRole, WorkflowDescription,
} from '../compiler/index.js';
import type { Place, Token } from 'libpetri';
import {
  MarkingState, SmtVerifier, deadlockFree, flatten, formatZ3Version, mutualExclusion,
  placeBound, resolveZ3, unreachable,
  type FlatNet, type PInvariant, type SmtProperty, type SmtVerificationResult, type Z3Solver,
} from 'libpetri/verification';
import { decodeCounterexample } from './counterexample.js';
import {
  DEFAULT_MAX_CLASSES, MAX_WITNESSES, REST_ROLES, StateSpace, loopTransitions, restRolesFor,
  rethrowIfBug,
  terminalKindOf,
  witnessCounterexample, PAUSE_REST_ROLES, HALT_REST_ROLES,
} from './state-class.js';
import type { TruncationShape } from './state-class.js';
import type {
  CheckRoute, CheckSubject, CheckVerdict, Counterexample, InvariantSummary, MarkedPlace,
  MutualExclusionRequest, PropertyCheck, PropertyName, SmtFallbackMode, SolverInfo,
  VerificationReport, VerifyOptions,
} from './types.js';
import { PROPERTY_NAMES } from './types.js';

/** Per-query z3 timeout when the caller names none. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Property families run when the caller names none: everything a workflow always has. */
export const DEFAULT_PROPERTIES: readonly PropertyName[] = [
  'budget', 'no-double-activation', 'dead-nodes', 'retry-bound', 'proper-completion',
];

// ==================== solver ====================

/**
 * The `SmtVerifier` methods this module calls that libpetri gained in 5.1.0.
 *
 * Presence is checked once per report, before any query, because the alternative is worse than
 * a missing method: each call site would throw a `TypeError` from inside a query, and although
 * {@link rethrowIfBug} now makes that loud rather than a verdict, the message a reader gets is
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
 */
const REQUIRED_VERIFIER_METHODS = ['sinkPlacesWhen', 'stateEquation', 'enumerationMaxClasses'] as const;

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
    'This surface (VER-014 conditional sinks, VER-016 the state equation, VER-017 bounded ' +
    "enumeration, and `semiflowInvariants('auto')`) ships in libpetri 5.1.0. Install that or " +
    'later rather than relaxing this check: without those methods every SMT query fails, and ' +
    'the report would close with every proof missing.',
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

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ==================== marking ====================

/** A compiler marking (tokens per place) as the verifier's count vector (VER-004: values are irrelevant). */
export function markingStateOf(marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>): MarkingState {
  const builder = MarkingState.builder();
  for (const [place, tokens] of marking) builder.tokens(place, tokens.length);
  return builder.build();
}

// ==================== invariants ====================

/**
 * libpetri's canonical report lines (VER-013 fixes them byte for byte across the four
 * implementations), which is the only public way to read the **post-validation** counts:
 * the exact BigInt re-check that drops a row runs inside `verify()` and its helper is not
 * package API. Re-deriving them here with `computePInvariants` would report rows libpetri
 * then discarded — an over-count, on exactly the reset-arc chains this net has.
 */
const FOUND_LINE = /^ {2}Found: (\d+) P-invariant\(s\)$/m;
const SEMIFLOW_LINE = /^ {2}Semiflows encoded as invariants: (\d+)$/m;

function countFrom(report: string, pattern: RegExp): number | null {
  const m = pattern.exec(report);
  return m === null ? null : Number(m[1]);
}

/** Place name → weight for one invariant, over the flattened net's place order. */
export function invariantTerms(invariant: PInvariant, flat: FlatNet): Map<string, number> {
  const terms = new Map<string, number>();
  for (const index of invariant.support) {
    const place = flat.places[index];
    if (place === undefined) continue;
    terms.set(place.name, invariant.weights[index] ?? 0);
  }
  return terms;
}

/** `2*_budget + 2*A/running + A/ok_0 + … = 2` — the same shape libpetri prints. */
export function renderInvariant(invariant: PInvariant, flat: FlatNet): string {
  const parts: string[] = [];
  for (const [name, weight] of [...invariantTerms(invariant, flat)].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (weight === 0) continue;
    parts.push(weight === 1 ? name : `${weight}*${name}`);
  }
  return `${parts.join(' + ')} = ${invariant.constant}`;
}

/**
 * The two-phase budget semiflow, if the verifier kept it: a law giving `_budget` and every
 * `X/running` the same positive weight `w`, summing to `w·k`, and touching at least one
 * in-flight place of every node that has one (`X/routed`, the per-output-routing
 * `X/ok_o` / `X/routed_o`, or `X/retry`). A node holds its unit from `X_start` to
 * `X_done`, so those places are exactly where the unit sits while it is not in `_budget`
 * (ADR 0004).
 *
 * "At least one", not "all": a node with more than `SPLIT_ROUTING_ABOVE` connected outputs
 * routes per output, and the Farkas enumeration then returns **one law per output** —
 * `_budget + … + X/ok_o + X/routed_o + X/running + … = w·k` for each `o` — rather than one
 * law folding all `n` in at weight `w/n`. Every one of them is the conservation law; the
 * first is returned. A workflow with no such node yields the single folded law
 * `_budget + Σ_X(X/running + X/retry + X/routed) = k` — one term per node, since every node
 * has an `X/routed`.
 */
export function budgetSemiflowOf(
  invariants: readonly PInvariant[], flat: FlatNet, map: NetMapView, budget: number,
): PInvariant | null {
  for (const invariant of invariants) {
    const terms = invariantTerms(invariant, flat);
    const w = terms.get(map.shared.budget.name) ?? 0;
    if (w <= 0 || invariant.constant !== w * budget) continue;
    if (map.nodes.every((g) => nodeCarriesUnit(g, terms, w))) return invariant;
  }
  return null;
}

function nodeCarriesUnit(g: NodeGadget, terms: ReadonlyMap<string, number>, w: number): boolean {
  if ((terms.get(g.running.name) ?? 0) !== w) return false;
  const inFlight = [
    g.routed,
    g.retry,
    // An agent holds its unit on `A/routed_req` between the request outcome and `A_done_req`,
    // exactly as any node holds it on `X/routed` between `X_run` and `X_done` (ADR 0004).
    g.routedRequest,
    ...g.outputs.flatMap((o) => [o.ok, o.routed]),
  ].filter((p): p is Place<unknown> => p !== null);
  return inFlight.length === 0 || inFlight.some((p) => (terms.get(p.name) ?? 0) > 0);
}


// ==================== the run ====================

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
interface Decision {
  readonly verdict: CheckVerdict;
  readonly reason: string | null;
  readonly route: CheckRoute;
  readonly method: string | null;
  readonly elapsedMs: number;
  readonly counterexample: Counterexample | null;
}

interface Context {
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
  readonly checks: PropertyCheck[];
  readonly onCheck: ((check: PropertyCheck) => void) | undefined;
  /** The invariant list of the first result that carried one: what the encoder actually saw. */
  invariants: readonly PInvariant[] | null;
  /** That result's report, for the two canonical count lines. */
  invariantReport: string | null;
}

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
async function smtDecision(
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

/**
 * Why the truncated graph cannot answer, and what to do about it — with the cause taken from
 * {@link StateSpace.truncationCause}, which is evidence rather than a default. Two of its
 * four values are the shapes NU-053 names (a cycle, and heavy independent parallelism); the
 * other two are a cap set below what the workflow needs and a route the caller switched off,
 * and telling those apart is the difference between "raise the cap" and "this workflow cannot
 * be enumerated".
 *
 * The sentence is deliberate about what *was* established: "nothing was stranded among the
 * `n` classes explored" is a bounded fact and never a proof. Reporting it as `proven` is the
 * one failure mode this route must not have.
 */
function truncationReason(ctx: Context): string {
  const space = ctx.space;
  if (!space.usable) {
    return `the state-class graph could not be built (${space.error ?? 'unknown reason'}), so the ` +
      'solver-free route decided nothing';
  }
  const cause = space.truncationCause(ctx.shape);
  if (cause === 'off') {
    return `the solver-free route was turned off (maxClasses = ${space.requestedMaxClasses}), so nothing ` +
      'was enumerated and every question went to the SMT route';
  }
  const lowered = space.maxClasses < space.requestedMaxClasses
    ? ` (lowered from the requested ${space.requestedMaxClasses} to what this process's heap can hold)`
    : '';
  const explored = `the state-class graph truncated at its ${space.maxClasses}-class cap${lowered} ` +
    `(${space.classes} classes explored in ${(space.elapsedMs / 1000).toFixed(1)}s), so completeness — ` +
    'and with it any proof — is out of reach.';
  const advice = cause === 'cycle'
    ? ' The workflow has a cycle, so its reachable state space is unbounded and no class cap can ' +
      'close it (NU-053). Nothing was stranded among the classes explored, which is a bounded fact ' +
      'about a prefix of the runs, not a proof about all of them.'
    : cause === 'parallelism'
      ? ' This workflow has branching nodes, and independent parallel branches blow the class count up ' +
        'combinatorially (NU-053: the graph has no partial-order reduction). Raising maxClasses may ' +
        'close it; verifying a smaller slice of the workflow certainly will.'
      : ' No cycle and no branching node explains it, so the cap is simply below what this workflow ' +
        'needs: raise maxClasses.';
  return explored + advice;
}

/**
 * Why the SMT fallback is asked, and what it asks.
 *
 * The fallback is one **whole-net** `deadlockFree` query per workflow — the VER-002 shape
 * that is literally workflow-net proper completion, one query rather than M4's one per
 * place — with the structural rest set declared as sinks ({@link restSinks}) and the pause /
 * halt widenings declared as *conditional* sinks ({@link terminalSinks}, libpetri VER-014):
 * a token may rest on an `in` / `ready` / `hasdata` place while `_pause` holds a token, and
 * on those plus the empty-arrival markers while `_halt` does. That is the solver-free route's
 * classification (`state-class.ts`, "The pause filter") stated as a property, so the two
 * routes now ask the same question and a `proven` from either transfers.
 *
 * Until libpetri 5.0.x (2026-09-08) no property could express the widening, and the plain
 * VER-002 question was false by construction on any workflow with a reachable paused marking
 * holding an arrival — which is most of them — so it was skipped wherever the graph had
 * already reached such a marking, and answered `violated` with a designed-terminal witness
 * everywhere else (nought for ten, `docs/verification.md`). Measured after the change:
 * `fanOut` proven in 0.2 s where it used to return that witness in 2 s. What it still cannot
 * do is *prove* quiescence on a net whose proof needs chained inequality invariants —
 * `agentTwoTools` at `maxToolCalls` 64 is `unknown` at 120 s — the same limit as the
 * reachability cliff (`tasks/todo.md` §4, libpetri's inequality-invariant work).
 *
 * Its `violated` is a finding: a stranding the solver found outside the explored prefix. A
 * witness that is nevertheless a designed terminal would mean the sink declaration and the
 * graph's classification disagree; that is downgraded and named
 * ({@link TERMINAL_WITNESS_REASON}) rather than reported as a defect.
 *
 * All of that is a claim about **this** query only. The other families' fallbacks decide
 * plenty on the same truncated graphs — on `switch20`, z3 proves `placeBound(_budget, 1)`
 * and all 22 `placeBound(X/running, 1)` at ~2.8 s each — which is why the fallback stays per
 * family rather than being dropped wholesale.
 */
const SMT_FALLBACK_REASON =
  'the whole-net deadlockFree fallback (VER-002 with the rest set as sinks and the pause / halt ' +
  'widenings as conditional sinks, VER-014) did not decide it either';

/**
 * Why an SMT proper-completion violation the graph's own rule excuses is downgraded.
 *
 * A witness is classified exactly as the solver-free route classifies a quiescent class:
 * `terminalKindOf` picks the kind (halt over pause), and every marked place is checked
 * against that kind's rest set — the same widening {@link terminalSinks} declares to the
 * solver. **Holding a terminal marker is not itself an excuse.** With the widenings declared
 * the conditional sinks have already excused everything the marker excuses, so a witness that
 * still marks something outside the widened set is a real stranding *even though it is also a
 * paused or halted run* — a workflow that pauses on one branch and strands another — and it
 * is reported. (Before VER-014 the test was "does the witness hold any terminal role", which
 * was right while the query could not tell the two apart and would now discard that finding.)
 *
 * What remains excused is a witness the graph would call a designed terminal outright. That
 * can only mean the two disagree — `terminalKindOf` widens on a marked `waiting` / `stopped`
 * place, `sinkPlacesWhen` on `_pause` / `_halt`, and every gadget branch that produces one of
 * the former produces `_pause` beside it — so it is a bug in one of them, not a defect in the
 * workflow, and it is reported as that ({@link TERMINAL_WITNESS_REASON}).
 *
 * A place the `NetMap` does not resolve (`role === null`) counts as stranded: no rest set
 * contains it, and over-reporting is the safe direction.
 */
const TERMINAL_WITNESS_REASON =
  'the only witness the solver returned is a paused or halted run — a designed terminal marking ' +
  'the conditional sink declaration (VER-014) should have excused. The SMT declaration and the ' +
  "solver-free route's classification disagree on this net; treated as undecided — report it";

/** True when the witness marking holds `_pause` or `_halt`. */
function witnessIsExcusedTerminal(cex: Counterexample | null): boolean {
  if (cex === null) return false;
  const rest = restRolesFor(terminalKindOf(cex.stuckMarking.map((p) => p.role)));
  return !cex.stuckMarking.some((p) => p.role === null || !rest.has(p.role));
}

function record(
  ctx: Context,
  check: Omit<PropertyCheck, 'counterexample'> & { readonly counterexample?: PropertyCheck['counterexample'] },
): void {
  const full: PropertyCheck = { counterexample: null, ...check };
  ctx.checks.push(full);
  ctx.onCheck?.(full);
}

/**
 * The place(s) a property names, for the report. The `default` is deliberate rather than an
 * exhaustive switch: `SmtProperty` is a libpetri union that gains members (VER-002 added
 * `terminates-at-sink`), and a property this module does not use must not break its build.
 */
function placeOf(property: SmtProperty): string | null {
  switch (property.type) {
    case 'place-bound':
    case 'branch-place-bound':
      return property.place.name;
    case 'joined-or-dead-lettered':
      return property.pending.name;
    case 'mutual-exclusion':
      return `${property.p1.name}, ${property.p2.name}`;
    case 'unreachable':
      return [...property.places].map((p) => p.name).join(', ');
    default:
      return null;
  }
}

/** What was asked and how it was answered. `property` names the question, `route` the answer. */
function queryRecord(
  property: SmtProperty | 'none', decision: Decision, sinks: readonly Place<unknown>[] = [],
  conditional: readonly ConditionalSink[] = [],
): PropertyCheck['query'] {
  return {
    property: property === 'none' ? 'none' : property.type,
    place: property === 'none' ? null : placeOf(property),
    verdict: decision.verdict,
    sinks: sinks.map((p) => p.name),
    conditionalSinks: conditional.map((c) => ({ marker: c.marker.name, places: c.places.map((p) => p.name) })),
    method: decision.method,
    route: decision.route,
  };
}

function counterexampleFor(outcome: QueryOutcome, ctx: Context): Counterexample | null {
  if (outcome.result === null || outcome.verdict !== 'violated') return null;
  return decodeCounterexample(outcome.result, ctx.map);
}

// ==================== the solver-free decisions ====================

/** A verdict read straight off the graph. */
function graphDecision(
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
function graphBound(ctx: Context, place: Place<unknown>, bound: number): Decision | null {
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
function graphUnreachable(ctx: Context, place: Place<unknown>): Decision | null {
  if (!ctx.space.usable) return null;
  if (ctx.space.everMarked(place)) return graphDecision('violated');
  return ctx.space.complete ? graphDecision('proven') : null;
}

/**
 * What a `bounded` verdict quantifies over, spelled out where it is reported.
 *
 * It is the honest middle between the two things M5 refuses to do on a cyclic workflow:
 * claim a proof it cannot have, and say nothing at all. The closure argument is in
 * `state-class.ts` (`closedCyclicRuns`); this is its statement in workflow terms.
 */
function boundedReason(ctx: Context, iterations: number): string {
  const space = ctx.space;
  // The unit is a *run of a cyclic node*, not a pass of the loop body: `loopTransitions`
  // counts the `X_run` of every node on a cycle, so a two-node loop spends two per pass.
  // What is guaranteed in the author's own unit is therefore floor(k / loopSteps) passes.
  const passes = space.loopSteps <= 1
    ? ''
    : ` (at least ${Math.floor(iterations / space.loopSteps)} complete pass(es) of the ` +
      `${space.loopSteps} cyclic node(s) on the cycle, and more of a run that visits only some of them)`;
  return `not a proof: the state-class graph truncated at its ${space.maxClasses}-class cap ` +
    `(${space.classes} classes, ${space.expandedClasses} of them expanded, in ` +
    `${(space.elapsedMs / 1000).toFixed(1)}s). What *was* established is bounded and exact — every run ` +
    `in which this workflow's cyclic nodes run at most ${iterations} time(s) in total${passes} was ` +
    'enumerated in full, together with every marking such a run can come to rest in, and none of them ' +
    'breaks this check. A run with more cyclic-node runs than that was not explored. The workflow has ' +
    'a cycle, so its reachable state space is unbounded (NU-053) and no class cap can close it; raising ' +
    '--max-classes raises the bound rather than reaching a proof';
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
function boundedOrUnknown(ctx: Context, decision: Decision, note: string | null = decision.reason): Decision {
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
 * The three-way explanation of a check, with the `bounded` arm derived from the `proven`
 * one: the claim is the same, the quantifier is smaller, and saying so in one place keeps
 * the two from drifting apart.
 */
function explain(verdict: CheckVerdict, text: { proven: string; violated: string; unknown: string }): string {
  switch (verdict) {
    case 'proven': return text.proven;
    case 'violated': return text.violated;
    case 'bounded': return `Only within the explored cyclic-node-run bound — ${text.proven}`;
    case 'unknown': return text.unknown;
  }
}

// ==================== proper completion ====================

/**
 * The **arrival capacity** of a join / OR input: how many arrivals its gadget can hold at
 * once, and which of the two gadgets it is.
 *
 * A join / choose-branch input has one slot: every `arm` consumes `free_i` and only
 * `X_start` / `X_skip` refund it (ADR 0003), so `free_i + ready_i ≤ 1` holds **by
 * construction** and a violation would mean the compiler broke the gadget. The OR form
 * aggregates a round of `n` deliveries with no slot token at all (README "OR-inputs"), and
 * `placeBound(ready_i, n)` there is the query `docs/divergences.md` row #8 names — the form
 * where a violation is a real finding, and the one M4's SMT route could not decide.
 */
function arrivalCapacity(ctx: Context, node: string, inputIndex: number): { capacity: number; round: boolean } {
  const input = ctx.map.node(node).inputs.find((i) => i.index === inputIndex);
  return input?.round === null || input?.round === undefined
    ? { capacity: 1, round: false }
    : { capacity: input.round, round: true };
}

/**
 * Does any reachable quiescent marking leave pending work on `place`?
 *
 * Complete graph: exact — `violated` with the stuck marking and the firing path, or
 * `proven`. Truncated graph: a stranding actually found is still a real one (a quiescent
 * class of the explored prefix is quiescent and reachable), so it is reported; the absence
 * of one is **not** a proof and returns `null` so the caller falls back.
 */
function graphStranding(ctx: Context, place: Place<unknown>): Decision | null {
  if (!ctx.space.usable) return null;
  const stranding = ctx.space.strandedAt(place);
  if (stranding !== null) return graphDecision('violated', witnessCounterexample(stranding));
  if (!ctx.space.complete) return null;
  return graphDecision('proven');
}

/**
 * The whole-net question — *can this workflow strand a branch anywhere?* — and the family's
 * per-input, per-edge and arrival-bound rows.
 *
 * The whole-net row is the headline and is asked first, because it is the one that covers
 * places the per-place rows do not: a token left on `X/hasdata`, on `X/routed`, on an unreaped
 * `_halt`. The per-place rows keep the granularity a finding needs — which input of which
 * node — and are decided from the same graph at no extra cost.
 */
async function runProperCompletion(ctx: Context): Promise<void> {
  await runWholeNetCompletion(ctx);

  for (const group of ctx.compiled.joinReadyPlaces) {
    const { capacity, round } = arrivalCapacity(ctx, group.node, group.inputIndex);
    for (const place of group.places) {
      await recordArrivalBound(ctx, group.node, group.inputIndex, place, capacity, round);
    }
    for (const place of group.places) {
      const where = `${group.node}'s input ${group.inputIndex}`;
      const decision = await decideStranding(ctx, place);
      record(ctx, {
        property: 'proper-completion',
        name: `${group.node} input ${group.inputIndex} always completes`,
        subject: { kind: 'join-input', node: group.node, inputIndex: group.inputIndex, place: place.name },
        verdict: decision.verdict,
        explanation: explain(decision.verdict, {
          proven: `No reachable quiescent marking leaves an arrival waiting on ${where}.`,
          violated: `${group.node} can be left with an arrival stranded on input ${group.inputIndex}: the run ` +
            'quiesces with that token still waiting, which is what n8n discovers at runtime as a stuck Merge.',
          unknown: `Whether an arrival can strand on ${where} was not decided.`,
        }),
        reason: decision.reason,
        elapsedMs: decision.elapsedMs,
        query: queryRecord(deadlockFree(), decision, restSinks(ctx), terminalSinks(ctx)),
        counterexample: decision.counterexample,
      });
    }
  }

  for (const place of ctx.compiled.edgeDataPlaces) {
    const info = ctx.map.place(place.name);
    const consumer = info?.node ?? '(unknown)';
    const edge = info?.edge;
    const subject: CheckSubject = {
      kind: 'edge',
      node: consumer,
      place: place.name,
      ...(edge === undefined ? {} : { from: edge.from, outputIndex: edge.outputIndex, inputIndex: edge.inputIndex }),
    };
    const where = edge === undefined
      ? `${consumer}'s input`
      : `the edge ${edge.from}.${edge.outputIndex} -> ${edge.to}.${edge.inputIndex}`;
    const decision = await decideStranding(ctx, place);
    record(ctx, {
      property: 'proper-completion',
      name: `${where} is always consumed`,
      subject,
      verdict: decision.verdict,
      explanation: explain(decision.verdict, {
        proven: `No reachable quiescent marking leaves a payload on ${where}.`,
        violated: `A payload can be left undelivered on ${where}: ${consumer} never consumes it and the run quiesces.`,
        unknown: `Whether a payload can be left on ${where} was not decided.`,
      }),
      reason: decision.reason,
      elapsedMs: decision.elapsedMs,
      query: queryRecord(deadlockFree(), decision, restSinks(ctx), terminalSinks(ctx)),
      counterexample: decision.counterexample,
    });
  }
}

/**
 * The structural rest set as `Place` objects: the unconditional sink declaration the
 * whole-net `deadlockFree` fallback is asked with (VER-002). It is exactly `REST_ROLES` read
 * off `NetMap`, so the SMT question and the graph's classification start from the same set;
 * the pause filter's widening is {@link terminalSinks}.
 */
function restSinks(ctx: Context): readonly Place<unknown>[] {
  return ctx.map.places.filter((p) => REST_ROLES.has(p.role)).map((p) => p.place);
}

/** A sink set that applies only while `marker` holds a token (libpetri VER-014). */
export interface ConditionalSink {
  readonly marker: Place<unknown>;
  readonly places: readonly Place<unknown>[];
}

/**
 * The pause filter as a sink declaration: while `_pause` is marked a token may rest on the
 * places `PAUSE_REST_ROLES` adds to the rest set, and while `_halt` is marked on those
 * `HALT_REST_ROLES` adds. `terminalKindOf` also treats a marked `waiting` / `stopped` place as
 * a pause, and `_pause` alone reproduces that because every branch that produces one produces
 * `_pause` beside it and nothing ever consumes `_pause` (`compiler/gadget.ts`, the waiting and
 * stopped branches). `HALT_REST_ROLES ⊇ PAUSE_REST_ROLES`, so libpetri's union across markers
 * is the graph's halt-over-pause precedence. A net without the marker declares nothing for it.
 */
function terminalSinks(ctx: Context): readonly ConditionalSink[] {
  const marker = (role: PlaceRole): Place<unknown> | null =>
    ctx.map.places.find((p) => p.role === role)?.place ?? null;
  const widened = (roles: ReadonlySet<PlaceRole>): readonly Place<unknown>[] =>
    ctx.map.places.filter((p) => roles.has(p.role) && !REST_ROLES.has(p.role)).map((p) => p.place);
  const out: ConditionalSink[] = [];
  const pause = marker('pause');
  if (pause !== null) out.push({ marker: pause, places: widened(PAUSE_REST_ROLES) });
  const halt = marker('halt');
  if (halt !== null) out.push({ marker: halt, places: widened(HALT_REST_ROLES) });
  return out;
}

/**
 * Why the SMT fallback did not close it, on its own — the half a bounded reason still wants.
 *
 * When the query was never asked ({@link smtFallbackCompletion} skipping a question the graph
 * has already shown to be false), its own reason *is* the note: saying "the fallback did not
 * decide it either" about a query that never ran would be a second false statement stacked on
 * the first.
 */
function smtFallbackNote(fallback: Decision): string {
  if (fallback.route === 'none') return fallback.reason ?? SMT_FALLBACK_REASON;
  return `${SMT_FALLBACK_REASON}${fallback.reason === null ? '' : ` (${fallback.reason})`}`;
}

/** Both halves of an undecided completion question: why the graph could not, why z3 could not. */
function completionUnknownReason(ctx: Context, fallback: Decision): string {
  return `${truncationReason(ctx)} — and ${smtFallbackNote(fallback)}`;
}

/** Whether the fallback's witness marking holds a token on this very place. */
function witnessMarks(cex: Counterexample | null, place: Place<unknown>): boolean {
  return cex !== null && cex.stuckMarking.some((p) => p.place === place.name);
}

/** The graph first (NU-053); the whole-net `deadlockFree` query only where it truncated. */
async function decideStranding(ctx: Context, place: Place<unknown>): Promise<Decision> {
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
      reason: `${truncationReason(ctx)} — and the whole-net deadlockFree fallback found a stranding ` +
        'elsewhere in this net (see the whole-net row), which decides nothing about this place',
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
 * Memoised per report: the fallback is **one** query per workflow, not one per place — that
 * was M4's shape and it is what made the family cost (places x timeout). Keyed on the
 * `Context`, so concurrent `verifyCompiled` calls never share an entry.
 *
 * It is asked wherever the graph did not close: with the widenings declared (VER-014) the
 * question is the graph's own, so a reachable designed terminal no longer makes it false,
 * and the gate that skipped it on that ground is gone with the reason it gave.
 */
const fallbackCache = new WeakMap<Context, Promise<Decision>>();

async function smtFallbackCompletion(ctx: Context): Promise<Decision> {
  const cached = fallbackCache.get(ctx);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<Decision> => {
    const decision = await smtDecision(ctx, deadlockFree(), restSinks(ctx), terminalSinks(ctx));
    if (decision.verdict === 'violated' && witnessIsExcusedTerminal(decision.counterexample)) {
      return { ...decision, verdict: 'unknown', reason: TERMINAL_WITNESS_REASON };
    }
    return decision;
  })();
  fallbackCache.set(ctx, pending);
  return pending;
}

/** The headline check: no reachable quiescent marking leaves pending work anywhere. */
async function runWholeNetCompletion(ctx: Context): Promise<void> {
  const space = ctx.space;
  const strandings = space.usable ? space.strandings() : [];
  const decision: Decision = strandings.length > 0
    ? {
      ...graphDecision('violated', witnessCounterexample(strandings[0]!)),
      elapsedMs: space.elapsedMs,
    }
    : space.complete
      ? { ...graphDecision('proven'), elapsedMs: space.elapsedMs }
      : await (async (): Promise<Decision> => {
        const fallback = await smtFallbackCompletion(ctx);
        // `proven` and `violated` are both real verdicts about the whole net here: the
        // violated one survived the pause filter, so it is a stranding z3 found outside the
        // explored prefix and it is reported as the finding it is.
        return fallback.verdict === 'proven' || fallback.verdict === 'violated'
          ? fallback
          : boundedOrUnknown(ctx, {
            ...fallback,
            verdict: 'unknown',
            reason: completionUnknownReason(ctx, fallback),
            elapsedMs: space.elapsedMs + fallback.elapsedMs,
          }, smtFallbackNote(fallback));
      })();

  const first = strandings[0];
  const stranded = first === undefined
    ? ''
    : ` It quiesces holding ${first.stranded.map(renderStranded).join(', ')}.`;
  // The graph found none but the fallback did: the row is still `violated`, and its sentence
  // has to say where the witness came from rather than quoting a class count of zero.
  const solverFound = decision.verdict === 'violated' && strandings.length === 0;
  record(ctx, {
    property: 'proper-completion',
    name: 'no branch is ever left stranded',
    subject: { kind: 'net' },
    verdict: decision.verdict,
    explanation: explain(decision.verdict, {
      proven: decision.route === 'smt'
        ? 'The solver proved it: the whole-net deadlockFree question — rest set as sinks, pause / halt ' +
          'widenings as conditional sinks, state equation on — has an inductive invariant over every ' +
          'reachable marking, so no quiescent marking leaves work pending anywhere in the net. The graph ' +
          `had explored ${space.classes} state classes without closing.`
        : `Every one of the ${space.quiescentClasses} reachable quiescent markings of this workflow ` +
          `(${space.classes} state classes) is either a completed run holding only residue or one of the ` +
          `${space.terminalClasses} designed terminals — a paused or halted run the marking codec writes ` +
          'back. Nothing is left pending anywhere in the net.',
      violated: solverFound
        ? 'This workflow can come to rest with work still pending: the whole-net deadlockFree query ' +
          '(VER-002, rest set as sinks, pause / halt widenings as conditional sinks) returned a quiescent ' +
          'marking outside that set, and it is not one of the designed terminals the marking codec writes back.'
        : `This workflow can come to rest with work still pending: ${strandings.length}` +
          `${strandings.length >= MAX_WITNESSES ? '+' : ''} quiescent marking(s) hold a token on a place ` +
          `that is not residue.${stranded}`,
      unknown: `Whether this workflow can strand a branch was not decided: ${space.classes} state classes ` +
        'explored, none of them a stranding, and the graph is not complete.',
    }),
    reason: decision.reason,
    elapsedMs: decision.elapsedMs,
    query: queryRecord(deadlockFree(), decision, restSinks(ctx), terminalSinks(ctx)),
    counterexample: decision.counterexample,
  });
}

/**
 * Roles whose `PlaceInfo.port` is an **input** index; every other ported role (`ok`,
 * `routed`, `nil`) carries an output index (`compiler/types.ts`). Getting this wrong would
 * print "Switch input 3" for a token on the fourth *output*, which is the kind of wrong that
 * sends a reader to the wrong end of the node.
 */
const INPUT_SIDE_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  'in-data', 'in-empty', 'edge-data', 'edge-empty', 'ready', 'hasdata', 'ran', 'free',
]);

/** `Merge input 0 ready (id:Merge/ready_0)` — a stranded place in workflow terms. */
function renderStranded(p: MarkedPlace): string {
  if (p.node === null) return `${p.place}${p.tokens === 1 ? '' : ` x${p.tokens}`}`;
  const port = p.port === null
    ? ''
    : p.role !== null && INPUT_SIDE_ROLES.has(p.role) ? ` input ${p.port}` : ` output ${p.port}`;
  return `${p.node}${port} ${p.role ?? 'place'} (${p.place})${p.tokens === 1 ? '' : ` x${p.tokens}`}`;
}

/** How many arrivals can queue on one join / OR input at once (README "OR-inputs"). */
async function recordArrivalBound(
  ctx: Context, node: string, inputIndex: number, place: Place<unknown>, capacity: number, round: boolean,
): Promise<void> {
  const property = placeBound(place, capacity);
  const decision = graphBound(ctx, place, capacity)
    ?? boundedOrUnknown(ctx, await smtDecision(ctx, property));
  const where = `${node}'s input ${inputIndex}`;
  record(ctx, {
    property: 'proper-completion',
    name: round
      ? `${node} input ${inputIndex} queues at most ${capacity} arrival${capacity === 1 ? '' : 's'} per round`
      : `${node} input ${inputIndex} keeps its join slot discipline`,
    subject: { kind: 'join-input', node, inputIndex, place: place.name },
    verdict: decision.verdict,
    explanation: explain(decision.verdict, {
      proven: round
        ? `${where} never holds more than ${capacity} arrival(s), so a round cannot over-fill and the ` +
          'positional pairing of divergence #8 cannot bite on it. This bounds pile-up; whether anything ' +
          'strands is the check below.'
        : `${where} never holds more than one arrival at a time, so the slot discipline of ADR 0003 ` +
          '(free_i + ready_i <= 1) holds. That bound holds by construction on a join input — every arm ' +
          'consumes the slot and only X_start / X_skip refund it — so this re-checks the gadget against ' +
          'the compiled net rather than detecting anything.',
      violated: round
        ? `More than ${capacity} arrival(s) can pile up on ${where}: arrivals are paired positionally, ` +
          'so the pairing is decided by arrival order (divergence #8).'
        : `${where} can hold two arrivals at once: the join slot discipline of ADR 0003 is broken — an ` +
          'arm armed the input without taking its free token, or something refunded the slot twice.',
      unknown: `Whether ${where} can hold more than ${capacity} arrival(s) was not decided.`,
    }),
    reason: decision.route === 'smt' && decision.verdict === 'unknown'
      ? `${truncationReason(ctx)} — and ${decision.reason ?? 'the SMT fallback did not decide it either'}`
      : decision.reason,
    elapsedMs: decision.elapsedMs,
    query: queryRecord(property, decision),
    counterexample: decision.counterexample,
  });
}

// ==================== dead nodes ====================

/**
 * Why a node the route says is *reachable* is `unknown` and never `proven`.
 *
 * Both routes explore an abstraction that is priority-blind and value-blind: every `xor`
 * branch of a routing transition is available whatever the data (VER-004 AC2), so "the IF
 * sent items down this branch" is reachable on a workflow where no real run does it.
 * VER-004 AC3 licenses the proof direction only, so `unreachable` *proven* — the node is
 * dead — is a verdict and its negation is not. Calling a reached node "live" would be a
 * claim neither encoding supports, and it would be counted among the proofs.
 */
const LIVENESS_REASON =
  'the running place is reachable only in the priority-blind and value-blind over-approximation ' +
  '(VER-004): every xor branch of a router is explored whatever the data, so this witness does not ' +
  'establish that a real run reaches the node. VER-004 AC3 licenses the proof direction only — ' +
  'liveness is not provable by this abstraction';

/**
 * Nodes that can never run in **this** compiled execution only because n8n starts one
 * trigger per execution: an entry point (a node whose type declares no input) that is not
 * the start node the workflow was compiled with, plus everything reachable from it and from
 * no start node. `initialMarking` seeds only `startNodes[0]`'s own input (README "Initial
 * marking and the marking codec"), so `unreachable({X/running})` really is `proven` for
 * them — but a Manual-plus-Webhook workflow is an ordinary n8n pattern, not a defect, and
 * reporting one as a finding would fail the CLI's exit-code gate on a healthy workflow.
 *
 * A node with no incoming connection whose *shape* has an input is **not** an entry point:
 * n8n can never start there, so a dead one is a real finding (the `Orphan` fixture).
 *
 * Returns node name → the entry point it belongs to (an entry point maps to itself).
 */
export function alternativeEntryReach(compiled: CompiledWorkflow): Map<string, string> {
  const analysis = compiled.analysis;
  const starts = new Set(compiled.startNodes);
  const found = new Map<string, string>();
  for (const a of analysis.nodes) {
    const entry = a.node.name;
    if (starts.has(entry) || a.shape.inputCount !== 0 || analysis.reachable.has(entry)) continue;
    const stack = [entry];
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (found.has(name)) continue;
      found.set(name, entry);
      // A node a start node reaches is not dead at all, and must not be excused here.
      for (const e of analysis.outgoing.get(name) ?? []) {
        if (!analysis.reachable.has(e.to) && !found.has(e.to)) stack.push(e.to);
      }
    }
  }
  return found;
}

/**
 * `unreachable({X/running})`: only the *proven* direction is a verdict (see
 * {@link LIVENESS_REASON}). The graph decides every node in one pass when it is complete,
 * which is the family's whole cost; the SMT fallback is one query per node.
 */
async function runDeadNodes(ctx: Context): Promise<void> {
  for (const g of ctx.map.nodes) {
    const property = unreachable(new Set([g.running]));
    const decision = graphUnreachable(ctx, g.running) ?? await smtDecision(ctx, property);
    const entry = ctx.entryReach.get(g.node);
    const dead = decision.verdict === 'proven';
    const verdict: CheckVerdict = dead && entry === undefined ? 'violated' : 'unknown';
    const structural = g.reachable ? '' : ' The compiler already marks it unreachable from every start node.';
    const entryReason = entry === undefined
      ? null
      : `n8n starts one trigger per execution and this net was compiled with '${ctx.compiled.startNode}' ` +
        `as the start node, so ${entry === g.node ? 'this entry point' : `'${entry}'`} never fires here; ` +
        `re-run with the start node set to '${entry}' to verify the execution it starts`;
    record(ctx, {
      property: 'dead-nodes',
      name: `${g.node} can run`,
      subject: { kind: 'node', node: g.node, place: g.running.name },
      verdict,
      explanation: verdict === 'violated'
        ? `${g.node} can never run: no reachable marking ever puts a token on its running place.${structural}`
        : dead
          ? `${g.node} cannot run in an execution started from ${ctx.compiled.startNode}, but it is ` +
            `${entry === g.node ? 'another entry point of this workflow' : `reachable only from '${entry}', another entry point`}` +
            ' — an alternative entry point, not a dead node.'
          : decision.verdict === 'violated'
            ? `${g.node} is reachable in the abstraction. That is not a proof that it is live (VER-004).`
            : `Whether ${g.node} can ever run was not decided.`,
      reason: verdict === 'violated'
        ? decision.reason
        : dead
          ? entryReason
          : decision.verdict === 'violated'
            ? LIVENESS_REASON
            : decision.route === 'smt' ? unknownReason(ctx, decision) : decision.reason,
      elapsedMs: decision.elapsedMs,
      query: queryRecord(property, decision),
      // The witness of a reachable node is a path that runs it in the abstraction, not a
      // defect; the finding here is the dead node, and a dead node has no trace.
      counterexample: null,
    });
  }
}

/** An SMT-fallback `unknown`, prefixed with why the solver-free route did not decide it. */
function unknownReason(ctx: Context, decision: Decision): string | null {
  if (decision.verdict !== 'unknown') return decision.reason;
  const smt = decision.reason ?? 'the SMT fallback did not decide it either';
  return ctx.space.complete ? smt : `${truncationReason(ctx)} — and ${smt}`;
}

// ==================== the remaining families ====================

/** `placeBound(X/running, 1)`: the `X/idle` mutex, structurally (ADR 0004). */
async function runNoDoubleActivation(ctx: Context): Promise<void> {
  for (const g of ctx.map.nodes) {
    const property = placeBound(g.running, 1);
    const decision = graphBound(ctx, g.running, 1)
      ?? boundedOrUnknown(ctx, await smtDecision(ctx, property));
    record(ctx, {
      property: 'no-double-activation',
      name: `${g.node} never runs twice at once`,
      subject: { kind: 'node', node: g.node, place: g.running.name },
      verdict: decision.verdict,
      explanation: explain(decision.verdict, {
        proven: `Two activations of ${g.node} can never overlap: X/idle + X/running = 1 holds on every reachable marking.`,
        violated: `${g.node} can be running twice at once — its X/idle mutex does not hold.`,
        unknown: `Whether two activations of ${g.node} can overlap was not decided.`,
      }),
      reason: unknownReason(ctx, decision),
      elapsedMs: decision.elapsedMs,
      query: queryRecord(property, decision),
      counterexample: decision.counterexample,
    });
  }
}

async function runBudget(ctx: Context): Promise<void> {
  const k = ctx.compiled.effectiveBudget;
  const property = placeBound(ctx.map.shared.budget, k);
  const decision = graphBound(ctx, ctx.map.shared.budget, k)
    ?? boundedOrUnknown(ctx, await smtDecision(ctx, property));
  record(ctx, {
    property: 'budget',
    name: `at most ${k} node${k === 1 ? '' : 's'} in flight`,
    subject: { kind: 'place', place: ctx.map.shared.budget.name },
    verdict: decision.verdict,
    explanation: explain(decision.verdict, {
      proven: `_budget never exceeds ${k}, so at most ${k} activation${k === 1 ? '' : 's'} can hold a unit at once.`,
      violated: `_budget can exceed ${k}: a transition refunds a unit it did not take.`,
      unknown: `Whether _budget stays within ${k} was not decided.`,
    }),
    reason: unknownReason(ctx, decision),
    elapsedMs: decision.elapsedMs,
    query: queryRecord(property, decision),
    counterexample: decision.counterexample,
  });

  // The semiflow is read off the invariants the encoder was given, not asked of z3: it is a
  // structural fact, and its absence is not a violation but a gap in what can be proven.
  // It is the one part of this family the solver-free route cannot supply — a P-invariant is
  // a statement about the incidence matrix, not about the reachable set.
  const invariants = ctx.invariants ?? (await collectInvariants(ctx));
  const semiflow = invariants === null ? null : budgetSemiflowOf(invariants, ctx.flat, ctx.map, k);
  const semiflowDecision: Decision = {
    verdict: semiflow === null ? 'unknown' : 'proven',
    reason: null, route: 'structural', method: semiflow === null ? null : 'P-invariant',
    elapsedMs: 0, counterexample: null,
  };
  record(ctx, {
    property: 'budget',
    name: 'the two-phase budget semiflow holds',
    subject: { kind: 'net' },
    verdict: semiflowDecision.verdict,
    explanation: semiflow === null
      ? 'No validated conservation law covers _budget together with every X/running: the budget unit ' +
        'cannot be tracked structurally, so the bound above rests on the reachable-set enumeration alone.'
      : `_budget + the in-flight places of every node is conserved at ${k}, so a unit is held from ` +
        'X_start to X_done and refunded exactly once (ADR 0004).',
    reason: semiflow === null
      ? ctx.smtRefusal
        ?? 'the P-invariant computation returned no law giving _budget and every X/running the same positive weight'
      : null,
    elapsedMs: 0,
    query: queryRecord('none', semiflowDecision),
    counterexample: null,
  });
}

/** The flat transitions that **produce** tokens on `place`, read off the encoder's own post-vectors. */
export function producersOf(flat: FlatNet, place: Place<unknown>): string[] {
  const index = flat.placeIndex.get(place.name);
  if (index === undefined) return [];
  return flat.transitions.filter((t) => (t.postVector[index] ?? 0) > 0).map((t) => t.name);
}

/**
 * An `onFailure` chain's bound, in the same two halves as the retry bound below (ADR 0009 §3).
 *
 * The **place bound** is `placeBound(X/failed_i, 1)` per attempt: one activation can have at
 * most one failure outstanding at each position. The **structural** half is what turns that
 * into "the node runs at most `steps.length` times per activation": the chain is a line, so
 * every `X/running_i` after the first must be produced by exactly one transition — the step of
 * the attempt before it — and nothing may put a token back on an earlier one. A compiler change
 * that wired a step to an earlier attempt would make the chain a cycle and is exactly what this
 * half catches; the place bound alone would still hold.
 *
 * Read off the flattened net, so it costs no route and cannot come back `unknown`.
 */
async function runAttemptBound(ctx: Context): Promise<void> {
  for (const g of ctx.map.nodes) {
    if (g.attempts.length === 0) continue;
    let weakest: CheckVerdict = 'proven';
    for (const attempt of g.attempts) {
      const property = placeBound(attempt.failed, 1);
      const decision = graphBound(ctx, attempt.failed, 1)
        ?? boundedOrUnknown(ctx, await smtDecision(ctx, property));
      if (decision.verdict !== 'proven') {
        weakest = decision.verdict === 'violated' ? 'violated'
          : weakest === 'violated' ? 'violated' : decision.verdict;
      }
      record(ctx, {
        property: 'retry-bound',
        name: `${g.node} attempt ${attempt.index} has at most one failure outstanding`,
        subject: { kind: 'node', node: g.node, place: attempt.failed.name },
        verdict: decision.verdict,
        explanation: explain(decision.verdict, {
          proven: `${attempt.failed.name} never holds more than one token, so attempt ${attempt.index} of ` +
            `${g.node} can fail at most once before its onFailure step acts on it.`,
          violated: `${attempt.failed.name} can hold more than one token: two activations are at the same ` +
            'attempt position at once, and the step would answer them in an order nothing fixes.',
          unknown: `Whether ${attempt.failed.name} stays within one token was not decided.`,
        }),
        reason: unknownReason(ctx, decision),
        elapsedMs: decision.elapsedMs,
        query: queryRecord(property, decision),
        counterexample: decision.counterexample,
      });
    }

    // The chain must be a line, not a loop: each later attempt has exactly one producer, and it
    // is the step of the attempt before it.
    const wrong: string[] = [];
    g.attempts.forEach((attempt, i) => {
      if (i === 0) return;
      const expected = g.transitions.attemptSteps[i - 1];
      const producers = producersOf(ctx.flat, attempt.running);
      if (producers.length !== 1 || producers[0] !== expected) {
        wrong.push(`${attempt.running.name} <- [${producers.join(', ') || 'nothing'}] (expected ${expected})`);
      }
    });
    const attempts: CheckVerdict = wrong.length > 0 ? 'violated' : weakest;
    const structural: Decision = {
      verdict: wrong.length > 0 ? 'violated' : 'proven',
      reason: null, route: 'structural', method: 'structural', elapsedMs: 0, counterexample: null,
    };
    record(ctx, {
      property: 'retry-bound',
      name: `${g.node} attempts at most ${g.attempts.length} times per activation`,
      subject: { kind: 'node', node: g.node, place: g.attempts[0]!.failed.name },
      verdict: attempts,
      explanation: explain(attempts, {
        proven: `The chain is a line of ${g.attempts.length} attempt(s): each is reached only from the step ` +
          'before it and no failure place holds more than one token, so the node runs at most that many times ' +
          'for one activation — and, unlike X/tries, the next activation starts the chain over.',
        violated: wrong.length > 0
          ? `The chain is not a line: ${wrong.join('; ')}. An attempt reachable from anywhere else is a cycle, ` +
            'and the number of runs is not bounded by the step count.'
          : 'A failure place can hold more than one token, so the attempt count is not bounded by the chain.',
        unknown: 'The chain is a line, but the bound on its failure places was not established.',
      }),
      reason: attempts === 'unknown' || attempts === 'bounded' ? 'the per-attempt place bound did not close' : null,
      elapsedMs: 0,
      query: { ...queryRecord('none', structural), place: g.attempts[0]!.failed.name },
    });
  }
}

/**
 * The retry bound is two checks, because the place bound alone does not entail it.
 *
 * `placeBound(X/tries, maxTries − 1)` is true in the initial marking — `X/tries` is seeded
 * with exactly that many tokens — and a net that *refunded* a try token would still satisfy
 * it while `X_retry_wait` fired without limit (a two-place net whose
 * `retry_wait: one(tries), one(go) → and(go, tries)` keeps `placeBound(tries, 2)` proven
 * forever, and `placeBound(tries, 1)` violated, so the query is live rather than vacuous).
 * What turns the bound into "at most `maxTries` attempts" is the structural fact that
 * **nothing produces `X/tries`**: it is seeded, consumed by `X_retry_wait` and read as an
 * inhibitor by `X_exhausted`. That half needs neither route — it is read off the flattened
 * net — and it is the half a future compiler change would break.
 */
async function runRetryBound(ctx: Context): Promise<void> {
  await runAttemptBound(ctx);
  for (const g of ctx.map.nodes) {
    if (g.tries === null || g.maxTries === null) continue;
    const bound = g.maxTries - 1;
    const property = placeBound(g.tries, bound);
    const decision = graphBound(ctx, g.tries, bound)
      ?? boundedOrUnknown(ctx, await smtDecision(ctx, property));
    record(ctx, {
      property: 'retry-bound',
      name: `${g.node}/tries never holds more than ${bound}`,
      subject: { kind: 'node', node: g.node, place: g.tries.name },
      verdict: decision.verdict,
      explanation: explain(decision.verdict, {
        proven: `${g.node}/tries never exceeds the ${bound} token(s) it is seeded with. On its own that bounds ` +
          'the try tokens, not the attempts — the attempt bound is the check below.',
        violated: `${g.node}/tries can exceed ${bound}: something puts a try token back.`,
        unknown: `Whether ${g.node}/tries stays within ${bound} was not decided.`,
      }),
      reason: unknownReason(ctx, decision),
      elapsedMs: decision.elapsedMs,
      query: queryRecord(property, decision),
      counterexample: decision.counterexample,
    });

    const producers = producersOf(ctx.flat, g.tries);
    // The attempt bound is the conjunction, so it is only ever as strong as the weaker half:
    // a `bounded` place bound makes the attempt bound `bounded` too, never `proven`.
    const attempts: CheckVerdict = producers.length > 0
      ? 'violated'
      : decision.verdict === 'proven' || decision.verdict === 'bounded' ? decision.verdict : 'unknown';
    const structural: Decision = {
      verdict: producers.length > 0 ? 'violated' : 'proven',
      reason: null, route: 'structural', method: 'structural', elapsedMs: 0, counterexample: null,
    };
    record(ctx, {
      property: 'retry-bound',
      name: `${g.node} attempts at most ${g.maxTries} times`,
      subject: { kind: 'node', node: g.node, place: g.tries.name },
      verdict: attempts,
      explanation: explain(attempts, {
        proven: `No transition produces ${g.tries.name} and it never exceeds ${bound}, so X_retry_wait can fire at ` +
          `most ${bound} times and ${g.node} runs at most ${g.maxTries} times before X_exhausted.`,
        violated: `${producers.length} transition(s) produce ${g.tries.name} (${producers.join(', ')}), so the try ` +
          'tokens are refunded and the number of attempts is not bounded by the seeding.',
        unknown: `Nothing produces ${g.tries.name}, but the bound on it was not established, so the attempt count ` +
          'is not bounded either.',
      }),
      reason: attempts === 'unknown' || attempts === 'bounded' ? unknownReason(ctx, decision) : null,
      elapsedMs: 0,
      query: { ...queryRecord('none', structural), place: g.tries.name },
      counterexample: null,
    });
  }
}

/** Node pairs, or every unordered pair in declaration order. */
export function exclusionPairs(map: NetMapView, request: MutualExclusionRequest): Array<readonly [string, string]> {
  if (request !== 'all-pairs') return request.map((p) => [p[0], p[1]] as const);
  const names = map.nodes.map((g) => g.node);
  const pairs: Array<readonly [string, string]> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) pairs.push([names[i]!, names[j]!] as const);
  }
  return pairs;
}

async function runMutualExclusion(ctx: Context, request: MutualExclusionRequest): Promise<void> {
  const pairs = exclusionPairs(ctx.map, request);
  // One pass over the classes covers every pair, so `--all-pairs` costs what one pair costs.
  // It runs on a truncated graph too: a class marking both places is a real witness whatever
  // the BFS did, so only the *absence* of one needs the graph to have closed.
  const co = ctx.space.usable ? ctx.space.coMarkings(ctx.map.nodes.map((g) => g.running)) : null;
  for (const [a, b] of pairs) {
    const subject: CheckSubject = { kind: 'node-pair', nodes: [a, b] };
    let ga: NodeGadget;
    let gb: NodeGadget;
    try {
      ga = ctx.map.node(a);
      gb = ctx.map.node(b);
    } catch (e) {
      record(ctx, {
        property: 'mutual-exclusion',
        name: `${a} and ${b} never run at once`,
        subject,
        verdict: 'unknown',
        explanation: 'The pair could not be resolved to two nodes of this workflow.',
        reason: messageOf(e),
        elapsedMs: 0,
        query: { property: 'mutual-exclusion', place: null, verdict: 'unknown', sinks: [], conditionalSinks: [], method: null, route: 'none' },
      });
      continue;
    }
    const property = mutualExclusion(ga.running, gb.running);
    const witness = co === null ? null : co.witness(ga.running, gb.running);
    const decision: Decision = witness !== null
      ? graphDecision('violated', witnessCounterexample(witness))
      : co !== null && ctx.space.complete
        ? graphDecision('proven')
        : boundedOrUnknown(ctx, await smtDecision(ctx, property));
    record(ctx, {
      property: 'mutual-exclusion',
      name: `${a} and ${b} never run at once`,
      subject,
      verdict: decision.verdict,
      explanation: explain(decision.verdict, {
        proven: `${a} and ${b} can never be running at the same time.`,
        violated: `${a} and ${b} can be running at the same time.`,
        unknown: `Whether ${a} and ${b} can overlap was not decided.`,
      }),
      reason: unknownReason(ctx, decision),
      elapsedMs: decision.elapsedMs,
      query: queryRecord(property, decision),
      counterexample: decision.counterexample,
    });
  }
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
async function collectInvariants(ctx: Context): Promise<readonly PInvariant[] | null> {
  if (ctx.invariants !== null) return ctx.invariants;
  // Same guard as {@link query}: this *is* the pipeline, so on a net above the ceiling it is
  // the call that would abort the process.
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
    if (result.invariants.length === 0 && result.route !== 'smt') return null;
    ctx.invariants = result.invariants;
    ctx.invariantReport = result.report;
    return result.invariants;
  } catch (e) {
    // Same rule as {@link query}: an invariant pipeline that failed is `null`, a bug is not.
    // This catch was bare, so a `TypeError` here emptied the report's structural section and
    // took the budget family's semiflow with it, silently.
    rethrowIfBug(e);
    return null;
  }
}

// ==================== entry points ====================

/**
 * The workflow shape behind a truncation cause, from the compiler's own analysis: whether it
 * has a cycle, and whether any node has two or more distinct successors.
 *
 * The second is *evidence* for the "independent parallel branches" reading of a blow-up
 * (NU-053), and its absence is evidence against it: a chain that truncates truncated because
 * the cap was too small, and saying "independent parallel branches" there sends the reader
 * looking for a fan-out that is not in the workflow.
 */
export function truncationShapeOf(compiled: CompiledWorkflow): TruncationShape {
  let branching = false;
  for (const [, edges] of compiled.analysis.outgoing) {
    if (new Set(edges.map((e) => e.to)).size > 1) {
      branching = true;
      break;
    }
  }
  const agents = compiled.netMap.nodes
    .filter((g) => g.calls !== null && g.maxToolCalls !== null)
    .map((g) => ({ node: g.node, tools: g.tools.length, maxToolCalls: g.maxToolCalls!, assumed: g.toolCallsAssumed }));
  return { hasCycle: compiled.analysis.hasCycle, independentBranches: branching, agents };
}

/** Which property families to run: the caller's list, or the default plus any requested pairs. */
export function selectProperties(options: VerifyOptions): readonly PropertyName[] {
  if (options.properties !== undefined) {
    return PROPERTY_NAMES.filter((p) => options.properties!.includes(p));
  }
  return options.mutualExclusion === undefined
    ? DEFAULT_PROPERTIES
    : [...DEFAULT_PROPERTIES, 'mutual-exclusion'];
}

/** Compiles `workflow` exactly as the scheduler does, then verifies the net it produced. */
export async function verify(
  workflow: WorkflowDescription, options: VerifyOptions = {},
): Promise<VerificationReport> {
  const compiled = compile(workflow, {
    budget: options.budget ?? 1,
    ...(options.maxAgentRounds === undefined ? {} : { maxAgentRounds: options.maxAgentRounds }),
    ...(options.maxAgentToolCalls === undefined ? {} : { maxAgentToolCalls: options.maxAgentToolCalls }),
  });
  return verifyCompiled(compiled, options);
}

/** Verifies an already compiled workflow (the scheduler's own `CompiledWorkflow`). */
export async function verifyCompiled(
  compiled: CompiledWorkflow, options: VerifyOptions = {},
): Promise<VerificationReport> {
  assertLibpetriSurface();
  const started = performance.now();
  const properties = selectProperties(options);
  const state = markingStateOf(compiled.initialMarking(options.triggerItems ?? null));
  const maxClasses = options.maxClasses ?? DEFAULT_MAX_CLASSES;
  const flat = flatten(compiled.net);
  const smtFallback = options.smtFallback ?? 'auto';
  const ctx: Context = {
    compiled,
    map: compiled.netMap,
    state,
    flat,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    semiflowInvariants: options.semiflowInvariants ?? true,
    solver: resolveSolver(),
    smtFallback,
    smtRefusal: smtRefusalFor(flat, compiled.joinReadyPlaces.length, smtFallback),
    shape: truncationShapeOf(compiled),
    // NU-053: the solver-free route runs first, once, for every family. `maxClasses: 0`
    // turns it off — the graph truncates at the initial class — and every family falls back
    // to the SMT route, which is the M4 surface.
    space: StateSpace.explore(compiled.net, state, compiled.netMap, maxClasses, loopTransitions(compiled)),
    entryReach: alternativeEntryReach(compiled),
    checks: [],
    onCheck: options.onCheck,
    invariants: null,
    invariantReport: null,
  };

  // Cheapest first, so a streamed run says something useful before the expensive family.
  if (properties.includes('budget')) await runBudget(ctx);
  if (properties.includes('no-double-activation')) await runNoDoubleActivation(ctx);
  if (properties.includes('retry-bound')) await runRetryBound(ctx);
  if (properties.includes('mutual-exclusion')) {
    await runMutualExclusion(ctx, options.mutualExclusion ?? 'all-pairs');
  }
  if (properties.includes('dead-nodes')) await runDeadNodes(ctx);
  if (properties.includes('proper-completion')) await runProperCompletion(ctx);

  // The P-invariant pipeline is the expensive half of the SMT route and nothing but the
  // budget semiflow needs it, so a report that did not select that family never runs it.
  const invariants = ctx.invariants;
  const report = ctx.invariantReport;
  const summary: InvariantSummary = {
    basis: report === null ? 0 : countFrom(report, FOUND_LINE) ?? 0,
    semiflowsEncoded: report === null ? 0 : countFrom(report, SEMIFLOW_LINE) ?? 0,
    encoded: invariants?.length ?? 0,
    budgetSemiflow: invariants === null
      ? null
      : (() => {
        const sf = budgetSemiflowOf(invariants, ctx.flat, ctx.map, compiled.effectiveBudget);
        return sf === null ? null : renderInvariant(sf, ctx.flat);
      })(),
  };

  const counts = { proven: 0, violated: 0, bounded: 0, unknown: 0 };
  for (const c of ctx.checks) counts[c.verdict]++;

  return {
    workflow: compiled.net.name,
    structuralHash: compiled.structuralHash,
    requestedBudget: compiled.requestedBudget,
    budget: compiled.effectiveBudget,
    budgetRestriction: compiled.budgetRestriction,
    solver: ctx.solver,
    net: {
      places: compiled.net.places.size,
      transitions: compiled.net.transitions.size,
      flatTransitions: ctx.flat.transitions.length,
    },
    stateSpace: {
      classes: ctx.space.classes,
      complete: ctx.space.complete,
      maxClasses: ctx.space.maxClasses,
      requestedMaxClasses: ctx.space.requestedMaxClasses,
      elapsedMs: ctx.space.elapsedMs,
      quiescent: ctx.space.quiescentClasses,
      terminal: ctx.space.terminalClasses,
      strandedPlaces: ctx.space.strandedPlaces().length,
      truncation: ctx.space.truncationCause(ctx.shape),
      agents: ctx.shape.agents,
      expanded: ctx.space.expandedClasses,
      boundedCyclicRuns: ctx.space.boundedCyclicRuns,
      loopSteps: ctx.space.loopSteps,
      error: ctx.space.error,
    },
    invariants: summary,
    timeoutMs: ctx.timeoutMs,
    properties,
    checks: ctx.checks,
    counts,
    ok: counts.violated === 0,
    diagnostics: compiled.diagnostics,
    shapeWarnings: options.shapeWarnings ?? [],
    elapsedMs: performance.now() - started,
  };
}
