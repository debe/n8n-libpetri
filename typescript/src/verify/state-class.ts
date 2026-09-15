/**
 * The **solver-free route**: libpetri's state-class graph (VER-010) as the primary decision
 * procedure for every reachability-safety question `verify()` asks.
 *
 * NU-053 states the strategy in libpetri's own words — *"the verifier routes a bounded
 * quiescence query to Route B first; when Route B truncates (`Unknown`), it defers to [the
 * SMT encoding] rather than returning `Unknown`"*. M4 asked proper completion the other way
 * round (one `joinedOrDeadLettered` SMT query per place) and got `unknown` at 30 s, 60 s and
 * 600 s on a workflow with a stranding **and** on one without. The graph answers the same
 * question by enumeration, in milliseconds, on the same net.
 *
 * `StateClassGraph.build(net, M0, maxClasses)` enumerates reachable `(marking, firing
 * domain)` pairs by BFS (Berthomieu-Diaz). Three facts about it decide how this module may
 * read it:
 *
 * 1. **It is priority-blind and value-blind, and exact in time.** Every base-enabled
 *    transition is expanded and every `xor` output branch is a separate virtual transition
 *    (VER-010 AC3; the plain graph's only priority mode is `'none'`). So the explored
 *    marking set is a **superset** of what the priority-ordered executor can reach: a
 *    `proven` over a complete graph transfers, and a witness is a witness in the same
 *    priority- and value-blind abstraction the SMT route reports in (VER-004).
 * 2. **A quiescent class is quiescent whatever the priority.** Priority orders *enabled*
 *    transitions; it never enables one. "No transition is enabled" is therefore
 *    priority-independent, which is why the stranding question survives the abstraction
 *    intact where an ordering question would not.
 * 3. **Truncation is the honest limit.** The BFS stops at `maxClasses` and reports
 *    `isComplete() === false`. A truncated graph proves nothing — and, less obviously, its
 *    *frontier* classes have no computed successors, so "no successors" stops being evidence
 *    of quiescence there. {@link StateSpace} therefore reads `enabledTransitions` (decisive
 *    whatever the BFS did) and only *adds* the successor-free classes when the graph is
 *    complete, where a class with enabled transitions but no successor is a genuine
 *    time-dead deadlock rather than an unexplored frontier. The cap bounds the class count;
 *    {@link effectiveMaxClasses} is what bounds the **memory**, because a V8 heap exhaustion
 *    aborts the process instead of truncating anything.
 *
 * ## What counts as a stranding
 *
 * A quiescent marking of a compiled workflow is full of tokens on purpose: every `X/idle`,
 * every `X/done` and `X/skipped` marker, the refunded `_budget` units, every unspent
 * `X/tries`. The question "did anything get left behind" is therefore about **which** places
 * hold tokens, which `PlaceRole` answers structurally:
 *
 * - {@link REST_ROLES} — a token here is residue at rest. Nothing is pending.
 * - everything else (`in-data`, `in-empty`, `edge-data`, `edge-empty`, `ready`, `hasdata`,
 *   `ok`, `routed`, `running`, `retry`) is **pending work**: an activation that was
 *   delivered and never consumed, or an outcome that was never routed.
 *
 * ## The pause filter
 *
 * Every node's `X_run` offers the `waiting` and `stopped` outcomes (README "Retries, halt,
 * cancellation"), so **every** workflow has reachable quiescent markings holding `_pause` —
 * a Wait node or a destination stop — or `_halt`. Those are designed terminal markings
 * whose pending activations the marking codec writes back into n8n's own
 * `nodeExecutionStack` / `waitingExecution` (ADR 0005). They are not strandings, and M4's
 * SMT route could not say so: `joinedOrDeadLettered` carries no sink clause (NU-040 AC4), so
 * a paused witness had to be downgraded to `unknown`. Here the class is simply classified.
 *
 * The filter is **not** a blanket skip, because that is the one direction that could hide a
 * defect. In a designed-terminal class the rest set **widens**, and it widens to exactly
 * what `encodeMarking` accepts *in the mode the scheduler encodes that terminal with*
 * (`codec.ts`, `petri-scheduler.ts` `finish`) — which is why there are two widened sets and
 * not one:
 *
 * - a **paused** class (`_pause` / `X/waiting` / `X/stopped`, no halt) is encoded in mode
 *   `pause`, so the rest set is {@link PAUSE_REST_ROLES}: the `in` / `ready` / `hasdata`
 *   arrivals the codec pushes onto the stack and into `waitingExecution`, plus the `retry`
 *   unit `X_retry_wait` is pause-inhibited on (`gadget.ts`) and the codec pushes back;
 * - a **halted** class (`_halt`) is encoded in mode `cancelled`, the one mode
 *   that legitimately sees a marking the net has not drained, so the rest set is
 *   {@link HALT_REST_ROLES}: the pause set plus `in-empty` (the codec drops it with a
 *   diagnostic — "n8n never enqueues an empty" — which is right for a run that is over) and
 *   the `edge` places (the arms are halt-inhibited, so they stop draining; `cancelled` mode
 *   writes them back through `joinQueue`).
 *
 * The split is not decoration. `X_skip` and the `arm` transitions inhibit on `_halt` /
 * `_halt` but **not** on `_pause` (`gadget.ts`), so under a pause those places drain on
 * their own and a token resting on one is pending work — and `encodeMarking` in mode `pause`
 * throws a `CodecError` on exactly `X/in_empty` and an OR input's edge places. Widening them
 * under a pause would classify as residue a marking the codec refuses to encode.
 *
 * A token outside the class's set is still reported: an unrefunded `X/routed`, an `X/ok_o`
 * no `X_route_o` drained. Measured over every fixture at k = 1 **and** k = 2 (the sweep is
 * `docs/verification.md`, "What actually rests in a designed terminal"), the non-rest roles
 * that occur are `in-data`, `ready` and `hasdata` under a pause and, at k = 2 where a second
 * branch is in flight when the halt lands, `in-empty`, `edge-data` and `edge-empty` under
 * `_halt` plus `retry` under both. Every one of them is in the set its own terminal widens
 * to, so the widening changes no verdict on any fixture — it is the *shape* of the argument
 * that matters: each role is admitted by the codec path that terminal actually takes.
 *
 * ## What this route still does not model
 *
 * A firing is **atomic** here: a class successor consumes and produces in one step. The
 * executor consumes at fire time and produces when the action's `Promise` settles, so a
 * marking in which one node's action is in flight while another transition fires is not a
 * class of this graph. It matters only for a transition whose *inhibitor* place an action
 * can produce — `_halt` and `_pause`, and nothing else in this net — so the difference is
 * confined to the halt/pause window. The SMT route encodes firings atomically too, so this
 * is the pre-existing scope of the whole verification surface rather than a property of this
 * route; `docs/verification.md` states it as such.
 */
import { performance } from 'node:perf_hooks';
import type { PetriNet } from 'libpetri';
import type { MarkingState, StateClassGraph } from 'libpetri/verification';
import type { NetMapView } from '../compiler/index.js';
import { messageOf } from '../internal/errors.js';
import { rethrowIfBug } from './rethrow-if-bug.js';
import { buildStateClassGraph } from './state-space/build.js';
import { DEFAULT_MAX_CLASSES, effectiveMaxClasses } from './state-space/cap.js';
import { closedCyclicRuns } from './state-space/cyclic-runs.js';
import { ExploredClasses } from './state-space/explored-classes.js';
import { truncationCauseOf, type TruncationShape } from './state-space/truncation.js';
import type { TruncationCause } from './types.js';

export { rethrowIfBug } from './rethrow-if-bug.js';
export { DEFAULT_MAX_CLASSES, effectiveMaxClasses } from './state-space/cap.js';
export { MAX_WITNESSES } from './state-space/classify.js';
export { CoMarkings } from './state-space/co-markings.js';
export { loopTransitions } from './state-space/cyclic-runs.js';
export { witnessCounterexample } from './state-space/decode.js';
export {
  HALT_REST_ROLES, PAUSE_REST_ROLES, REST_ROLES, TERMINAL_ROLES, restRolesFor, terminalKindOf,
} from './state-space/roles.js';
export type { TruncationShape } from './state-space/truncation.js';

/**
 * One exploration of the compiled net's state-class graph, and every question this route can
 * answer from it. Built once per report and shared by every property family, which is the
 * whole reason it is cheaper than the SMT route: the pipeline the SMT route re-pays per
 * query (flatten, structural pre-check, P-invariants) has no analogue here.
 *
 * Construction never throws: a rejected net (CORE-043) or any other build failure leaves
 * {@link error} set and {@link usable} false, so every caller falls back to the SMT route.
 *
 * What the classes say — peaks, co-markings, strandings — is {@link ExploredClasses}
 * (`state-space/explored-classes.ts`); this class adds how the exploration ran.
 *
 * ## The expanded prefix, and why it is tracked
 *
 * libpetri's BFS pops in FIFO order and appends every newly discovered class to
 * `stateClasses()`, so the classes it actually **expanded** are a *prefix* of that array;
 * when the cap stops it, the rest are a frontier whose successors were never computed.
 * Two of this module's answers depend on knowing where the prefix ends
 * ({@link expandedClasses}):
 *
 * - a class in the prefix with enabled transitions and no successors is **time-dead** —
 *   nothing can fire, so it is quiescent and may be a stranding. The same shape outside the
 *   prefix is an unexplored frontier class and evidence of nothing;
 * - the prefix is what {@link boundedCyclicRuns} certifies a bounded claim over.
 *
 * A class with no enabled transitions needs no expansion at all — it has no successors by
 * definition — so it counts as expanded wherever it sits.
 *
 * ## Drop-in seam for a reduced graph
 *
 * Everything below reads a `StateClassGraph` through its public surface only
 * (`stateClasses`, `successors`, `outgoingBranchEdges`, `isComplete`, `initialClass`).
 * {@link StateSpace.explore} is the single place the graph is constructed, so a future
 * partial-order-reduced or structurally reduced builder (NU-053 names the missing reduction
 * outright) is a change to that one call, not to any of the classification, decoding or
 * bounded-iteration code — provided the reduced graph keeps the same two guarantees this
 * module leans on: every reachable *quiescent* class is represented, and a class's
 * `enabledTransitions` is the real enabled set of its marking.
 */
export class StateSpace extends ExploredClasses {
  /** The cap the enumeration ran with: {@link effectiveMaxClasses} of the requested one. */
  readonly maxClasses: number;
  /** What the caller asked for. Above {@link maxClasses} when the heap could not hold it. */
  readonly requestedMaxClasses: number;
  readonly classes: number;
  readonly complete: boolean;
  readonly elapsedMs: number;
  readonly error: string | null;
  /**
   * How many transitions a cyclic-node run is counted over ({@link loopTransitions}) — the
   * divisor between {@link boundedCyclicRuns} and complete passes of the loop body.
   */
  readonly loopSteps: number;
  /**
   * The largest `k >= 1` for which **every** class reachable by a firing sequence that fires
   * at most `k` loop transitions was expanded — so every such run, and every marking it can
   * come to rest in, is inside the explored prefix. `null` when the graph is complete (the
   * question is moot), when it is unusable, when the workflow has no cycle (there is nothing
   * to bound), or when not even one whole cyclic-node run is closed.
   *
   * This is what turns a truncated cyclic graph from "nothing can be said" into a **bounded**
   * verdict — sound, and clearly not a proof. See `state-space/cyclic-runs.ts`
   * `closedCyclicRuns` for the closure argument.
   */
  readonly boundedCyclicRuns: number | null;

  private constructor(
    graph: StateClassGraph | null,
    map: NetMapView,
    maxClasses: number,
    requestedMaxClasses: number,
    elapsedMs: number,
    error: string | null,
    loops: ReadonlySet<string>,
  ) {
    super(graph, map);
    this.maxClasses = maxClasses;
    this.requestedMaxClasses = requestedMaxClasses;
    this.elapsedMs = elapsedMs;
    this.error = error;
    this.classes = graph === null ? 0 : graph.size();
    this.complete = graph !== null && graph.isComplete();
    this.loopSteps = loops.size;
    this.boundedCyclicRuns = graph === null ? null : closedCyclicRuns(graph, loops, this.expandedClasses);
  }

  /**
   * Builds the graph, bounded by `maxClasses`. Timed, and never throws. **The single seam
   * where the graph is constructed** (`state-space/build.ts`) — see the class note on swapping
   * in a reduced builder.
   *
   * The environment-place arguments are deliberately omitted, and that is a soundness
   * argument rather than a convenience: `ignore()` models an environment place as one that
   * never receives a token, which would be an *under*-approximation — the direction that can
   * produce a false `proven` — if the net had one. It cannot. `CompiledWorkflow` carries no
   * environment-place field, so there is nowhere for one to arrive from, and the compiler
   * constructs none (`EnvironmentPlace` appears nowhere in `src/compiler`). The alternative
   * modes go the other way and treat such a place as a token source (VER-006), which would
   * make every quiescence answer vacuous.
   *
   * `loops` names the transitions a cyclic-node run is counted in ({@link loopTransitions});
   * omit it on an acyclic net, where there is nothing to bound.
   */
  static explore(
    net: PetriNet,
    initialMarking: MarkingState,
    map: NetMapView,
    maxClasses: number = DEFAULT_MAX_CLASSES,
    loops: ReadonlySet<string> = new Set(),
  ): StateSpace {
    const started = performance.now();
    // The cap the caller asked for, lowered to what the heap can hold: a class cap bounds
    // the class count, and only this bounds the memory (see {@link effectiveMaxClasses}).
    const cap = effectiveMaxClasses(maxClasses);
    const space = (graph: StateClassGraph | null, error: string | null): StateSpace =>
      new StateSpace(graph, map, cap, maxClasses, performance.now() - started, error, loops);
    try {
      return space(buildStateClassGraph(net, initialMarking, cap), null);
    } catch (e) {
      // A graph that could not be built is a route that cannot answer, and every family falls
      // back — which is right for "the net is outside the fragment" or "the build ran out of
      // room", and wrong for a defect in this module, where it would delete the solver-free
      // route from every report while leaving the report well-formed and merely weaker.
      rethrowIfBug(e);
      return space(null, messageOf(e));
    }
  }

  /**
   * Why the enumeration stopped, from evidence rather than from a default: see
   * {@link TruncationCause} and `state-space/truncation.ts`. `null` when the graph is
   * complete or unusable.
   */
  truncationCause(shape: TruncationShape): TruncationCause | null {
    if (this.complete || this.graph === null) return null;
    return truncationCauseOf(this.maxClasses, shape);
  }
}
