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
 *   at all above the measured net size of `route.ts` `smtRefusalFor`, where the pipeline
 *   libpetri runs before z3 aborts the process instead of answering.
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
 * (`reasons.ts` `boundedReason`; the closure argument is `state-class.ts` `closedCyclicRuns`).
 * **`unknown`** is what is left — heavy independent parallelism (NU-053: no partial-order
 * reduction), or a cap simply set too low, where there is nothing to count.
 *
 * Nothing folds a `bounded` into `proven`: it has its own {@link CheckVerdict}, its own
 * count, its own section of the report and it fails `--strict`.
 *
 * ## The six property families and what each one can and cannot say
 *
 * One module per family under `families/`, named as `docs/verification.md` names them.
 *
 * 1. **proper completion** (`families/proper-completion.ts`) — *can this workflow strand a
 *    branch?* One whole-net check plus one per join input and per edge place. A quiescent
 *    class of the graph is a run that has come to rest; it is a **stranding** when it still
 *    holds a token on a place whose `PlaceRole` means pending work (`state-class.ts`
 *    `REST_ROLES`), and it is a *designed* terminal — a paused or halted run whose pending
 *    activations the marking codec writes back (ADR 0005) — when it holds `_pause` / `_halt` /
 *    `X/waiting` / `X/stopped`, where the rest set widens to what the codec accepts in the
 *    mode that terminal is encoded with (`state-class.ts` `PAUSE_REST_ROLES` /
 *    `HALT_REST_ROLES`). That filter is what M4 could not express: `joinedOrDeadLettered`
 *    carries no sink clause (NU-040 AC4), so a paused witness had to be downgraded to
 *    `unknown`. The SMT fallback is one **whole-net** `deadlockFree` query (VER-002 since the
 *    `terminatesAtSink` split: *quiescent ∧ some marked place is not a declared sink* —
 *    literally workflow-net proper completion) with the structural rest set declared as the
 *    sinks and the pause / halt widenings as conditional sinks (VER-014; `reasons.ts`
 *    `SMT_FALLBACK_REASON` and `docs/verification.md`).
 * 2. **dead nodes** (`families/dead-nodes.ts`) — is `X/running` reachable? The graph answers
 *    by enumeration; the SMT fallback asks `unreachable({X/running})`. Only the *unreachable*
 *    direction becomes a verdict, and because that is the finding, the check reports
 *    `violated` (`types.ts`). A node the route *reaches* is `unknown`, never `proven`: both
 *    routes explore a priority-blind, value-blind abstraction in which every `xor` branch of a
 *    router is available whatever the data (VER-004 AC2), and VER-004 AC3 licenses the proof
 *    direction only. So is a node that is dead only because n8n starts **one trigger per
 *    execution** (`shape.ts` `alternativeEntryReach`).
 * 3. **no double activation** (`families/no-double-activation.ts`) — `X/running` never holds
 *    two tokens: the `X/idle` mutex made structural (`X/idle + X/running = 1` is a found
 *    P-invariant, ADR 0004).
 * 4. **budget** (`families/budget.ts`) — `_budget` never exceeds `k`, plus the two-phase
 *    P-semiflow `w·_budget + w·Σ_X(running + retry + in-flight) = w·k` read off the validated
 *    invariants (`invariants.ts`). A net whose budget were a self-loop would prove the bound
 *    trivially: the incidence column is zero, so the encoder never sees the place move. The
 *    two-phase gadget is what makes the bound mean something, and the semiflow is the half
 *    that carries the claim.
 * 5. **retry bound** (`families/retry-bound.ts`) — `X/tries` never exceeds `maxTries − 1`
 *    **plus** a structural check that no transition of the net produces `X/tries`. The bound
 *    alone only restates the seeding; the conjunction is what bounds the number of *attempts*.
 * 6. **mutual exclusion** (`families/mutual-exclusion.ts`) — `A/running` and `B/running`
 *    never marked together, for caller-supplied pairs or every pair. At k = 1 every pair
 *    holds, which is a sanity check of the budget model rather than a workflow property; at
 *    k ≥ 2 it fails for independent nodes, which is the point of the budget.
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
 *
 * ## Where the rest lives
 *
 * This module keeps the entry points, the libpetri surface gate, solver resolution and the
 * report assembly. The two routes and the per-report `Context` are `route.ts`; every reason
 * and explanation sentence is `reasons.ts`; a `PropertyCheck` is recorded by `record.ts`;
 * workflow-shape facts are `shape.ts`; reading the P-invariants is `invariants.ts`.
 */
import { performance } from 'node:perf_hooks';
import type { Place, Token } from 'libpetri';
import {
  MarkingState, SmtVerifier, flatten, formatZ3Version, resolveZ3, type Z3Solver,
} from 'libpetri/verification';
import { compile } from '../compiler/index.js';
import type { CompiledWorkflow, WorkflowDescription } from '../compiler/index.js';
import { messageOf } from '../internal/errors.js';
import { runBudget } from './families/budget.js';
import { runDeadNodes } from './families/dead-nodes.js';
import { runMutualExclusion } from './families/mutual-exclusion.js';
import { runNoDoubleActivation } from './families/no-double-activation.js';
import { runProperCompletion } from './families/proper-completion.js';
import { runRetryBound } from './families/retry-bound.js';
import { FOUND_LINE, SEMIFLOW_LINE, budgetSemiflowOf, countFrom, renderInvariant } from './invariants.js';
import { completionSinksOf, smtRefusalFor, type Context } from './route.js';
import { alternativeEntryReach, truncationShapeOf } from './shape.js';
import { DEFAULT_MAX_CLASSES, StateSpace, loopTransitions, rethrowIfBug } from './state-class.js';
import type {
  CheckVerdict, InvariantSummary, PropertyName, SolverInfo, VerificationReport, VerifyOptions,
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

// ==================== marking ====================

/** A compiler marking (tokens per place) as the verifier's count vector (VER-004: values are irrelevant). */
export function markingStateOf(marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>): MarkingState {
  const builder = MarkingState.builder();
  for (const [place, tokens] of marking) builder.tokens(place, tokens.length);
  return builder.build();
}

// ==================== entry points ====================

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
    // The completion question's sink declaration is a property of the net: built here, once,
    // and shared by every completion row rather than rescanned per row.
    completion: completionSinksOf(compiled.netMap),
    checks: [],
    onCheck: options.onCheck,
    invariants: null,
    invariantReport: null,
    invariantsUnionedSemiflows: false,
    completionFallback: null,
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

  const counts: Record<CheckVerdict, number> = { proven: 0, violated: 0, bounded: 0, unknown: 0 };
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
