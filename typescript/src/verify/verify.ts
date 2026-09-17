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
 * (`reasons.ts` `boundedReason`; the closure argument is `state-space/cyclic-runs.ts`
 * `closedCyclicRuns`). **`unknown`** is what is left — heavy independent parallelism (NU-053:
 * no partial-order reduction), or a cap simply set too low, where there is nothing to count.
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
 * This module keeps the entry points and the per-report context. The order the families run
 * in is `families/run-families.ts`; the libpetri surface gate and solver resolution are
 * `solver.ts`; the report assembly is `report/assemble.ts`. The two routes and the per-report `Context` are `route.ts`; every
 * reason and explanation sentence is `reasons.ts`; a `PropertyCheck` is recorded by
 * `record.ts`; workflow-shape facts are `shape.ts`; reading the P-invariants is
 * `invariants.ts`.
 */
import { performance } from 'node:perf_hooks';
import type { Place, Token } from 'libpetri';
import { MarkingState, flatten } from 'libpetri/verification';
import { compile } from '../compiler/index.js';
import type { CompiledWorkflow, WorkflowDescription } from '../compiler/index.js';
import { runFamilies } from './families/run-families.js';
import { assembleReport } from './report/assemble.js';
import { completionSinksOf, smtRefusalFor, type Context } from './route.js';
import { alternativeEntryReach, truncationShapeOf } from './shape.js';
import { assertLibpetriSurface, resolveSolver } from './solver.js';
import { DEFAULT_MAX_CLASSES, FIRST_PASS_MAX_CLASSES, StateSpace, loopTransitions } from './state-class.js';
import type { PropertyName, VerificationReport, VerifyOptions } from './types.js';
import { PROPERTY_NAMES } from './types.js';

export { assertLibpetriSurface, resolveSolver } from './solver.js';

/** Per-query z3 timeout when the caller names none. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Property families run when the caller names none: everything a workflow always has. */
export const DEFAULT_PROPERTIES: readonly PropertyName[] = [
  'budget', 'no-double-activation', 'dead-nodes', 'retry-bound', 'proper-completion',
];

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

/**
 * Verifies an already compiled workflow (the scheduler's own `CompiledWorkflow`).
 *
 * ## The staged route, and why the cap is not a constant
 *
 * The graph leads (NU-053) because on the nets where it closes it is exact, solver-free, and an
 * order of magnitude cheaper — it is explored **once** and read by every family, where the SMT
 * route pays per query. Measured: `fanOut8` at k = 1 decides its whole report from a closed
 * graph in 135 ms, against 1.4 s through the solver.
 *
 * What was wrong was the *cap*. A flat 200 000 meant a net whose graph cannot close discovered
 * that by burning all of it — 18.5 s on `fanOut8` at k = 4 — before falling through to a route
 * that answers the same question in under a second and does not move with k. So the first pass
 * stops at {@link FIRST_PASS_MAX_CLASSES}, and the full cap is spent only when it can still
 * change an answer:
 *
 * 1. **first pass** at the staged cap. Closed ⇒ exact, and nothing more is asked.
 * 2. truncated but every check `proven` (the SMT route decided them) ⇒ done. This is the case
 *    the staging exists for.
 * 3. anything else ⇒ **escalate** to the caller's cap and re-run. A `violated` needs the graph
 *    for its witness (the solver route is weak there), and a `bounded` is certified over the
 *    explored prefix, so a bigger prefix is a wider claim.
 *
 * Staging is skipped entirely when the caller set `maxClasses` (their number, not ours) and on
 * a **cyclic** workflow, whose space is unbounded: it always truncates, so a first pass could
 * only ever narrow its `bounded` verdict and never save a second one.
 */
export async function verifyCompiled(
  compiled: CompiledWorkflow, options: VerifyOptions = {},
): Promise<VerificationReport> {
  assertLibpetriSurface();
  const started = performance.now();
  const properties = selectProperties(options);
  const full = options.maxClasses ?? DEFAULT_MAX_CLASSES;
  const staged = stagedCap(compiled, options, full);

  const first = await runReport(compiled, options, properties, staged, started);
  if (staged === full || !worthEscalating(first)) return first;
  return runReport(compiled, options, properties, full, started);
}

/**
 * The first pass's cap.
 *
 * `maxClasses` is a **ceiling, not a strategy**: a caller who sets it is saying how much the
 * enumeration may spend, not that it must spend it before asking anything else. So staging
 * applies under it too, and is a no-op whenever their ceiling is already at or below the staged
 * cap — which is why a test asking for 2 000 classes still gets exactly one truncated pass.
 *
 * The one exemption is a **cyclic** workflow: its space is unbounded so it truncates at every
 * cap, and the `bounded` verdict is certified over the prefix explored, so a first pass could
 * only narrow the claim and could never save a second pass.
 */
function stagedCap(compiled: CompiledWorkflow, _options: VerifyOptions, full: number): number {
  if (compiled.analysis.hasCycle) return full;
  return Math.min(full, FIRST_PASS_MAX_CLASSES);
}

/**
 * Would the caller's full cap still change an answer?
 *
 * Only when the first pass truncated *and* left something the bigger graph could decide. A
 * report that closed is exact, and one whose every check is `proven` has nothing left to gain —
 * the enumeration would only re-derive what the solver already established.
 */
function worthEscalating(first: VerificationReport): boolean {
  return first.stateSpace.truncation !== null && first.checks.some((c) => c.verdict !== 'proven');
}

/** One whole report at a given class cap. */
async function runReport(
  compiled: CompiledWorkflow, options: VerifyOptions, properties: readonly PropertyName[],
  maxClasses: number, started: number,
): Promise<VerificationReport> {
  const ctx = contextFor(compiled, { ...options, maxClasses });
  await runFamilies(ctx, properties, options);
  return assembleReport(ctx, { properties, shapeWarnings: options.shapeWarnings ?? [], started });
}

/** The per-report context: the net, both routes, and no checks recorded yet. */
function contextFor(compiled: CompiledWorkflow, options: VerifyOptions): Context {
  const state = markingStateOf(compiled.initialMarking(options.triggerItems ?? null));
  const flat = flatten(compiled.net);
  const smtFallback = options.smtFallback ?? 'auto';
  return {
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
    space: StateSpace.explore(
      compiled.net, state, compiled.netMap, options.maxClasses ?? DEFAULT_MAX_CLASSES, loopTransitions(compiled)),
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
}
