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
import { getHeapStatistics } from 'node:v8';
import type { Place, PetriNet, Transition } from 'libpetri';
import { StateClassGraph } from 'libpetri/verification';
import type { MarkingState, StateClass } from 'libpetri/verification';
import type { CompiledWorkflow, NetMapView, PlaceRole } from '../compiler/index.js';
import { decodeMarking, decodeStep } from './counterexample.js';
import type { Counterexample, CounterexampleStep, MarkedPlace } from './types.js';

/**
 * Class cap for {@link StateSpace.explore}. The graph must never run unbounded: a workflow
 * with a cycle has an unbounded state space, and one with heavy independent parallelism has
 * a combinatorial one (NU-053: the graph has no partial-order reduction), so the cap is what
 * turns "hangs" into "reports truncation".
 *
 * 200 000 comes from the measurement in `docs/verification.md`: every acyclic fixture
 * without independent parallelism closes three orders of magnitude below it (1967 classes
 * for a 41-node chain, 5894 for an 8-wide fan-out), and the two shapes that do truncate cost
 * 4.1 s (a loop) and 36 s (a 20-way switch) to reach it — the same order as the 60 s the SMT
 * route spends per *query*, and paid once for the whole report rather than once per place.
 */
export const DEFAULT_MAX_CLASSES = 200_000;

/**
 * The worst **per class** cost measured, in bytes of peak RSS: `switch20` reaches its
 * 200 003 classes at 2.48 GB. The other two shapes measured are cheaper per class rather
 * than proportional to the net — `loopOverItems` (42 places) costs 4.4 kB a class and the
 * 49-node generated workflow (526 flat places) 12.1 kB — so the class count, not the net size, is
 * what bounds the enumeration's memory. `docs/verification.md` has the table.
 */
const BYTES_PER_CLASS = 12_500;

/** How much of the V8 heap limit the enumeration may plan to spend. */
const HEAP_SHARE = 0.75;

/**
 * The cap the enumeration actually runs with: the caller's, lowered to what the heap can
 * hold.
 *
 * A class cap bounds the class count; only this bounds the **memory**, and the difference
 * matters because a V8 heap exhaustion aborts the process — it is not an exception
 * {@link StateSpace.explore} could catch and turn into a truncation. At this machine's
 * default 4.4 GB heap limit nothing is lowered (0.75 x 4.4 GB / 12.5 kB = 264 000 > the
 * 200 000 default); under a container's 1 GB it becomes ~70 000, and a truncation is
 * reported instead of an abort.
 *
 * `requested <= 0` is passed through untouched: that is "turn the route off", not a cap.
 */
export function effectiveMaxClasses(
  requested: number, heapLimitBytes: number = getHeapStatistics().heap_size_limit,
): number {
  if (requested <= 0) return requested;
  const affordable = Math.floor((heapLimitBytes * HEAP_SHARE) / BYTES_PER_CLASS);
  return Math.max(1, Math.min(requested, affordable));
}

/** How many stuck markings a report keeps. One witness per stranded place is kept anyway. */
export const MAX_WITNESSES = 8;

/**
 * Places where a token at rest is legitimate residue of a finished run, never pending work.
 *
 * `idle` / `free` / `tries` / `budget` are the gadget's own resources handed back;
 * `done` / `skipped` / `ran` are markers nothing consumes; `nil` is drained by a genuine
 * sink (CORE-043 AC4); `halt` / `pause` / `waiting` / `stopped` are the designed terminals —
 * `_halt` is never consumed, it *is* the halted run's terminal marker (`compiler/compile.ts`).
 */
export const REST_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  'idle', 'done', 'skipped', 'free', 'tries', 'budget', 'halt', 'pause', 'waiting', 'stopped', 'ran', 'nil',
  // `rounds` and `calls` are budgets, the agent's `tries`: an execution that finishes without
  // spending every round or every tool call it was allowed leaves the rest there, and that is
  // a completed run, not a stranding. Every other agent-round place is pending work — a round
  // in flight — and widens only inside a designed terminal, where the codec writes it back.
  'rounds', 'calls',
]);

/**
 * Re-throws a **programming** error rather than letting it become a weaker verdict.
 *
 * The catches in this surface convert a failure into "undecided" — the route could not answer,
 * the solver died, the graph could not be built. That is right for a real condition and wrong
 * for a bug in this codebase or a mismatch with libpetri, and once both arrive as "undecided"
 * they are indistinguishable: the report stays well-formed, the proofs quietly disappear, and
 * nothing fails. A `TypeError` is how a library method this code calls but the installed
 * version does not have presents itself, so that instance would turn a version skew into a
 * silently weaker suite (`tasks/todo.md`).
 *
 * `TypeError` and `ReferenceError` are never verdicts. `RangeError` is deliberately excluded:
 * a stack overflow on a deep net is a capacity limit, which is what "undecided" is for.
 */
export function rethrowIfBug(e: unknown): void {
  if (e instanceof TypeError || e instanceof ReferenceError) throw e;
}

/** A marking holding one of these is a *designed* terminal: a paused or halted run. */
export const TERMINAL_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  'pause', 'halt', 'waiting', 'stopped',
]);

/** Which designed terminal a quiescent class holds — and so which codec mode encodes it. */
export type TerminalKind = 'none' | 'pause' | 'halt';

/**
 * The rest set inside a **paused** class (`_pause`, `X/waiting`, `X/stopped`): the pending
 * work `encodeMarking` in mode `pause` writes back into n8n's `nodeExecutionStack` and
 * `waitingExecution` (`codec.ts`; ADR 0005). `retry` is in it because `X_retry_wait`
 * inhibits on `_pause` (`gadget.ts`), so its unit rests there by design and the codec pushes
 * the entry back.
 *
 * `in-empty` and the `edge` roles are deliberately **absent**, and that is the half of this
 * set that had to be measured rather than assumed: `X_skip` and the `arm` transitions are
 * *not* pause-inhibited, so those places drain on their own under a pause and a token at
 * rest on one is real pending work — and `encodeMarking` in mode `pause` throws a
 * `CodecError` on `X/in_empty` and on an OR input's edge places rather than writing them
 * `halt` is absent too, and for a different reason: `_halt` at rest is the *halted*
 * terminal, so a marking holding it is classified against {@link HALT_REST_ROLES} instead.
 */
export const PAUSE_REST_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  // `failed` is `retry`'s analogue for an `onFailure` chain (ADR 0009): an attempt that failed
  // and whose step has not acted. Pending work, so it is *not* in `REST_ROLES` — a quiescent
  // marking holding one outside a designed terminal is a stranding and is reported as one —
  // but inside a pause or a halt the codec writes it back, exactly as it does `retry`.
  ...REST_ROLES, 'in-data', 'ready', 'hasdata', 'retry', 'failed',
  // An agent round the pause caught mid-flight: the tool calls not yet dispatched (`queue`) or
  // the mark that there are none (`drained`), the one dispatched but not yet started
  // (`in-tool`), the ones still out (`outstanding`) and the agent's own re-entry
  // (`dispatched`). `encodeMarking` writes every one of them back onto `nodeExecutionStack` in
  // n8n's own shape, so they rest by design — exactly the argument `retry` is in this set for.
  'in-tool', 'queue', 'drained', 'outstanding', 'dispatched',
]);

/**
 * The rest set inside a **halted** class (`_halt`): {@link PAUSE_REST_ROLES} plus the places
 * a halt stops draining and the codec handles in mode `cancelled` — the one mode that
 * legitimately sees an undrained marking (`codec.ts`; the scheduler encodes a halted run
 * with it, `petri-scheduler.ts`). `X_skip` and the arms inhibit on `_halt`, so `X/in_empty`
 * and the `edge` places come to rest; `cancelled` mode drops the empty with a diagnostic
 * ("n8n never enqueues an empty", which is right for a run that is over) and writes the edge
 * arrivals back through `joinQueue`. Every one of these is where a pending activation was
 * *delivered*: since there is no reap, that is exactly where the halted run leaves it.
 */
export const HALT_REST_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>([
  ...PAUSE_REST_ROLES, 'in-empty', 'edge-data', 'edge-empty',
]);

/** The rest set a class of this kind is classified against. */
export function restRolesFor(kind: TerminalKind): ReadonlySet<PlaceRole> {
  switch (kind) {
    case 'halt': return HALT_REST_ROLES;
    case 'pause': return PAUSE_REST_ROLES;
    case 'none': return REST_ROLES;
  }
}

/**
 * Which terminal a marking is: `'halt'` wins over `'pause'`, because a marking holding both
 * is encoded on the halt path (`petri-scheduler.ts` checks `_halt` first).
 */
export function terminalKindOf(roles: Iterable<PlaceRole | null>): TerminalKind {
  let kind: TerminalKind = 'none';
  for (const role of roles) {
    if (role === null) continue;
    if (role === 'halt') return 'halt';
    if (TERMINAL_ROLES.has(role)) kind = 'pause';
  }
  return kind;
}

/**
 * Why the enumeration stopped short, reported as **measured** rather than inferred:
 *
 * - `'cycle'` — the workflow has one, so its reachable state space is unbounded and no class
 *   cap can close it (NU-053). This is the shape the `bounded` verdict exists for;
 * - `'parallelism'` — no cycle, and the workflow has a node with two or more distinct
 *   successors, so independent branches interleave combinatorially (NU-053: the graph has no
 *   partial-order reduction). Raising the cap may still close a borderline case;
 * - `'cap'` — no cycle and no branching either, so nothing about the *shape* explains it:
 *   the cap was simply set below what this workflow needs. Raise it;
 * - `'off'` — the caller passed `maxClasses <= 0`, which turns the solver-free route off
 *   (the M4 surface). Not a limit of anything.
 */
export type TruncationCause = 'cycle' | 'tool-calls' | 'parallelism' | 'cap' | 'off';

/** What the *workflow* looks like, for {@link StateSpace.truncationCause}. */
export interface TruncationShape {
  /** `analysis.hasCycle`. */
  readonly hasCycle: boolean;
  /** Some node has two or more distinct successors: branches that interleave. */
  readonly independentBranches: boolean;
  /**
   * Every agent, with its tool-call budget. The graph explores every round size up to the
   * budget — a product of per-tool and per-round counters, polynomial in K and in the tool
   * count — so this is the one truncation cause with
   * a knob the user can turn: a declared `options.maxToolCalls` is both the runtime cap and the
   * width of the claim, and an assumed one is the scheduler's runtime default, sized for
   * production and far too wide for a graph.
   */
  readonly agents: readonly AgentBudget[];
}

export interface AgentBudget {
  readonly node: string;
  readonly tools: number;
  readonly maxToolCalls: number;
  readonly assumed: boolean;
}

/**
 * The transitions a **cyclic-node run** is counted in: the `run` transition of every node
 * that lies on a cycle of the workflow's main-connection graph (`analysis.cyclic`, a
 * non-trivial SCC or a self-loop).
 *
 * That is the unit {@link StateSpace.boundedCyclicRuns} quantifies over, and it is
 * deliberately *not* "one iteration of the loop": on a two-node cycle (`Loop -> Body ->
 * Loop`) one pass of the body fires two of these transitions, so a bound of `k` guarantees
 * `floor(k / size)` complete passes and nothing may report it as `k` iterations. A node's
 * `X_run` is the transition whose action is the node's own execution, so what is counted is
 * exactly the node runs a user would count on the canvas.
 */
export function loopTransitions(compiled: CompiledWorkflow): Set<string> {
  const cyclic = compiled.analysis.cyclic;
  const names = new Set<string>();
  for (const t of compiled.netMap.transitions) {
    if (t.node !== null && t.role === 'run' && cyclic.has(t.node)) names.add(t.name);
  }
  return names;
}

/** One state class, decoded into workflow terms: how it is reached and what it holds. */
export interface Witness {
  /** The marking of the class. */
  readonly marking: readonly MarkedPlace[];
  /** A firing sequence from the initial class to this one. Empty only if the BFS lost it. */
  readonly path: readonly CounterexampleStep[];
}

/** A quiescent class that leaves pending work behind. */
export interface Stranding extends Witness {
  /** The pending-work places only: what was left behind. */
  readonly stranded: readonly MarkedPlace[];
  /** Which designed terminal the class is, and so which rest set classified it. */
  readonly terminal: TerminalKind;
  /** `terminal !== 'none'`: the class is a paused or halted run that *also* holds work. */
  readonly paused: boolean;
}

/** A {@link Witness} in the shape the report already renders. */
export function witnessCounterexample(witness: Witness): Counterexample {
  const nodePath: string[] = [];
  for (const step of witness.path) {
    if (step.node !== null && !nodePath.includes(step.node)) nodePath.push(step.node);
  }
  return {
    nodePath,
    steps: witness.path,
    stuckMarking: witness.marking,
    // A path in the state-class graph *is* a firing sequence of the timed net
    // (Berthomieu-Diaz), so unlike an SMT derivation set it needs no replay to be ordered.
    confirmed: true,
    ordered: true,
  };
}

/**
 * Which of a set of places some class marks **together**, with the class that does it.
 * Produced by {@link StateSpace.coMarkings} in one pass, so `'all-pairs'` mutual exclusion
 * costs the same as a single pair.
 */
export class CoMarkings {
  private readonly pairs: ReadonlyMap<string, StateClass>;
  private readonly decode: (sc: StateClass) => Witness;

  /** @internal Built by {@link StateSpace.coMarkings}. */
  constructor(pairs: ReadonlyMap<string, StateClass>, decode: (sc: StateClass) => Witness) {
    this.pairs = pairs;
    this.decode = decode;
  }

  has(a: Place<unknown>, b: Place<unknown>): boolean {
    return this.pairs.has(`${a.name} ${b.name}`) || this.pairs.has(`${b.name} ${a.name}`);
  }

  witness(a: Place<unknown>, b: Place<unknown>): Witness | null {
    const sc = this.pairs.get(`${a.name} ${b.name}`) ?? this.pairs.get(`${b.name} ${a.name}`);
    return sc === undefined ? null : this.decode(sc);
  }
}

/**
 * One exploration of the compiled net's state-class graph, and every question this route can
 * answer from it. Built once per report and shared by every property family, which is the
 * whole reason it is cheaper than the SMT route: the pipeline the SMT route re-pays per
 * query (flatten, structural pre-check, P-invariants) has no analogue here.
 *
 * Construction never throws: a rejected net (CORE-043) or any other build failure leaves
 * {@link error} set and {@link usable} false, so every caller falls back to the SMT route.
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
export class StateSpace {
  private readonly graph: StateClassGraph | null;
  private readonly map: NetMapView;
  private readonly peakTokens = new Map<string, number>();
  private readonly peakClass = new Map<string, StateClass>();
  private readonly strandedBy = new Map<string, StateClass>();
  private readonly strandingClasses: StateClass[] = [];
  private parents: Map<StateClass, { readonly from: StateClass; readonly transition: Transition }> | null = null;

  /** The cap the enumeration ran with: {@link effectiveMaxClasses} of the requested one. */
  readonly maxClasses: number;
  /** What the caller asked for. Above {@link maxClasses} when the heap could not hold it. */
  readonly requestedMaxClasses: number;
  readonly classes: number;
  readonly complete: boolean;
  readonly elapsedMs: number;
  readonly error: string | null;
  /** Classes with nothing enabled, plus the time-dead ones inside the expanded prefix. */
  readonly quiescentClasses: number;
  /** Quiescent classes whose every token is at rest for that class's rest set. */
  readonly restingClasses: number;
  /** Quiescent classes that are designed terminals (paused / halted). */
  readonly terminalClasses: number;
  /**
   * Quiescent classes marking at least one place **outside {@link REST_ROLES}**, whatever
   * they hold — strandings and designed terminals alike.
   *
   * It is not a defect count. It was the exact error condition of the SMT fallback while
   * that query could declare only the plain rest set (VER-002: *quiescent ∧ some marked place
   * is not a declared sink*), and `verify.ts` skipped the query wherever it was non-zero.
   * Since the pause / halt widenings are declared as conditional sinks (libpetri VER-014) the
   * query excuses the same terminals the graph does, and this is a statistic: how many
   * quiescent classes the unwidened question would have called strandings.
   */
  readonly outsideSinkClasses: number;
  /** How many classes the BFS expanded: the prefix a bounded claim may be made over. */
  readonly expandedClasses: number;
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
   * verdict — sound, and clearly not a proof. See {@link StateSpace.boundedCyclicRuns} for
   * the closure argument.
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
    this.graph = graph;
    this.map = map;
    this.maxClasses = maxClasses;
    this.requestedMaxClasses = requestedMaxClasses;
    this.elapsedMs = elapsedMs;
    this.error = error;
    this.classes = graph === null ? 0 : graph.size();
    this.complete = graph !== null && graph.isComplete();
    this.loopSteps = loops.size;

    let quiescent = 0;
    let resting = 0;
    let terminal = 0;
    let outsideSinks = 0;
    if (graph === null) {
      this.expandedClasses = 0;
      this.quiescentClasses = 0;
      this.restingClasses = 0;
      this.terminalClasses = 0;
      this.outsideSinkClasses = 0;
      this.boundedCyclicRuns = null;
      return;
    }

    const classes = graph.stateClasses();
    // One past the last class that recorded an outgoing edge. Everything before it was
    // popped and expanded (FIFO order); everything after it either has nothing enabled — so
    // it needs no expansion — or is frontier.
    let lastExpanded = 0;
    for (let i = 0; i < classes.length; i++) {
      if (graph.outgoingBranchEdges(classes[i]!).size > 0) lastExpanded = i + 1;
    }
    this.expandedClasses = this.complete ? classes.length : lastExpanded;

    for (let i = 0; i < classes.length; i++) {
      const sc = classes[i]!;
      const marked = sc.marking.placesWithTokens();
      for (const place of marked) {
        const count = sc.marking.tokens(place);
        if (count > (this.peakTokens.get(place.name) ?? 0)) {
          this.peakTokens.set(place.name, count);
          this.peakClass.set(place.name, sc);
        }
      }
      if (!this.isQuiescent(graph, sc, this.wasExpanded(i, sc))) continue;
      quiescent++;
      const kind = terminalKindOf(marked.map((p) => this.roleOf(p)));
      if (kind !== 'none') terminal++;
      // Outside REST_ROLES *whatever* the class holds — the unwidened VER-002 question's
      // error condition, kept as a statistic ({@link outsideSinkClasses}).
      if (marked.some((p) => !REST_ROLES.has(this.roleOf(p)))) outsideSinks++;
      const rest = restRolesFor(kind);
      const pending = marked.filter((p) => !rest.has(this.roleOf(p)));
      if (pending.length === 0) {
        resting++;
        continue;
      }
      if (this.strandingClasses.length < MAX_WITNESSES) this.strandingClasses.push(sc);
      for (const p of pending) if (!this.strandedBy.has(p.name)) this.strandedBy.set(p.name, sc);
    }
    this.quiescentClasses = quiescent;
    this.restingClasses = resting;
    this.terminalClasses = terminal;
    this.outsideSinkClasses = outsideSinks;
    this.boundedCyclicRuns = this.closedCyclicRuns(graph, loops);
  }

  /**
   * Builds the graph, bounded by `maxClasses`. Timed, and never throws. **The single seam
   * where the graph is constructed** — see the class note on swapping in a reduced builder.
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
    try {
      // `StateClassGraph` never reads a transition's `matchSpec`: its enablement is the
      // structural token counts, so it explores a ν-join as an uncorrelated one. That is
      // libpetri's **over-approximation fallback**, and the fallback is sound for reachability
      // safety but *not* for quiescence — "a `Proven` on a quiescence property never comes from
      // the fallback" (`nu-nets.md` §8). `SmtVerifier` routes around this; building the graph
      // directly, as this module does, does not. Nothing here compiles a `matchSpec` today
      // (ADR 0008 records why the agent round does not use one), so this is a tripwire for
      // whoever adds the first: it must not silently start answering with a coarser abstraction.
      for (const t of net.transitions) {
        if ((t as { matchSpec?: unknown }).matchSpec != null) {
          throw new Error(
            `transition '${t.name}' carries a ν-net matchSpec; the state-class graph is match-blind, ` +
            'so its quiescence verdicts would come from an over-approximation that is not sound for ' +
            'them (nu-nets.md §8). Route this net through SmtVerifier with budgetPlaces declared.');
        }
      }
      const graph = StateClassGraph.build(net, initialMarking, cap);
      return new StateSpace(graph, map, cap, maxClasses, performance.now() - started, null, loops);
    } catch (e) {
      // A graph that could not be built is a route that cannot answer, and every family falls
      // back — which is right for "the net is outside the fragment" or "the build ran out of
      // room", and wrong for a defect in this module, where it would delete the solver-free
      // route from every report while leaving the report well-formed and merely weaker.
      rethrowIfBug(e);
      const message = e instanceof Error ? e.message : String(e);
      return new StateSpace(null, map, cap, maxClasses, performance.now() - started, message, loops);
    }
  }

  /** Whether the route produced a graph at all. `false` means every caller must fall back. */
  get usable(): boolean {
    return this.graph !== null;
  }

  /**
   * Why the enumeration stopped, from evidence rather than from a default: see
   * {@link TruncationCause}. `null` when the graph is complete or unusable.
   *
   * The `'parallelism'` arm used to be the catch-all, which reported "independent parallel
   * branches (NU-053)" for a four-node chain whose only problem was a cap set below 50.
   */
  truncationCause(shape: TruncationShape): TruncationCause | null {
    if (this.complete || this.graph === null) return null;
    if (this.maxClasses <= 0) return 'off';
    if (shape.hasCycle) return 'cycle';
    // An agent's budget is named before parallelism because it is the cause with a knob: the
    // branching an agent workflow shows is its own round, and lowering `maxToolCalls` is what
    // closes the graph, where nothing closes an independent fan-out but a reduction libpetri
    // does not have (NU-053).
    if (shape.agents.length > 0) return 'tool-calls';
    return shape.independentBranches ? 'parallelism' : 'cap';
  }

  /** The largest token count any explored class puts on `place`. */
  peak(place: Place<unknown>): number {
    return this.peakTokens.get(place.name) ?? 0;
  }

  /** Whether any explored class marks `place`. */
  everMarked(place: Place<unknown>): boolean {
    return this.peak(place) > 0;
  }

  /** The class achieving {@link peak} on `place`, decoded; `null` when the place never marks. */
  peakWitness(place: Place<unknown>): Witness | null {
    const sc = this.peakClass.get(place.name);
    return sc === undefined ? null : this.decode(sc);
  }

  /** Which of `places` some explored class marks together. One pass over the classes. */
  coMarkings(places: readonly Place<unknown>[]): CoMarkings {
    const wanted = new Set(places.map((p) => p.name));
    const pairs = new Map<string, StateClass>();
    if (this.graph !== null) {
      for (const sc of this.graph.stateClasses()) {
        const marked = sc.marking.placesWithTokens().map((p) => p.name).filter((n) => wanted.has(n));
        for (let i = 0; i < marked.length; i++) {
          for (let j = 0; j < marked.length; j++) {
            const key = `${marked[i]} ${marked[j]}`;
            if (i !== j && !pairs.has(key)) pairs.set(key, sc);
          }
        }
      }
    }
    return new CoMarkings(pairs, (sc) => this.decode(sc));
  }

  /** The first stranding that leaves work on `place`, decoded; `null` when none does. */
  strandedAt(place: Place<unknown>): Stranding | null {
    const sc = this.strandedBy.get(place.name);
    return sc === undefined ? null : this.decode(sc);
  }

  /** Whether any explored quiescent class leaves work on `place`. */
  isStranded(place: Place<unknown>): boolean {
    return this.strandedBy.has(place.name);
  }

  /** Every place some stranding leaves work on, in first-seen order. */
  strandedPlaces(): readonly string[] {
    return [...this.strandedBy.keys()];
  }

  /** The strandings found, capped at {@link MAX_WITNESSES}, decoded on demand. */
  strandings(): readonly Stranding[] {
    return this.strandingClasses.map((sc) => this.decode(sc));
  }

  // ==================== internals ====================

  private roleOf(place: Place<unknown>): PlaceRole {
    // A place NetMap does not know cannot be classified as rest, so it counts as pending
    // work: the unsound direction would be calling work "residue", never the other way.
    return this.map.place(place.name)?.role ?? 'running';
  }

  /**
   * Whether the BFS computed this class's successors. Inside the prefix it did; outside it,
   * only a class with nothing enabled is settled — it has no successors to compute.
   */
  private wasExpanded(index: number, sc: StateClass): boolean {
    return index < this.expandedClasses || sc.enabledTransitions.length === 0;
  }

  /**
   * A class nothing can fire from. `enabledTransitions.length === 0` is decisive whatever
   * the BFS did. A class with enabled transitions and no successors is a **time-dead**
   * deadlock — every successor's firing domain was empty — but only where the BFS actually
   * tried; on the frontier the same shape is an unexplored class and evidence of nothing.
   */
  private isQuiescent(graph: StateClassGraph, sc: StateClass, expanded: boolean): boolean {
    if (sc.enabledTransitions.length === 0) return true;
    return expanded && graph.successors(sc).size === 0;
  }

  /**
   * The largest `k >= 1` such that every class reachable by a run firing at most `k` loop
   * transitions lies in the expanded prefix.
   *
   * The argument, which is the whole soundness of the bounded verdict. Let `A` be the
   * expanded prefix and `B` the rest, and let `iter(C)` be the fewest loop firings on any
   * path to `C` **through recorded edges**. Every class in `A` had all its successors
   * recorded, so a run that stays inside `A` is fully represented. Take
   * `k = min{ iter(C) : C in B } - 1` and induct on run length: a run firing at most `k`
   * loop transitions reaches only classes whose `iter` is at most `k`, each is therefore not
   * in `B`, so it is in `A` and its successors are recorded. Hence every run within the
   * bound — and every marking it comes to rest in — was enumerated and classified, and
   * "nothing bad happens within `k` iterations" is a fact rather than an extrapolation.
   *
   * `iter` is a shortest path with weights 1 (a loop transition) and 0 (everything else), so
   * it is computed by Dial's algorithm: one bucket per distance, and 0-weight successors
   * appended to the bucket being drained.
   */
  private closedCyclicRuns(graph: StateClassGraph, loops: ReadonlySet<string>): number | null {
    if (graph.isComplete() || loops.size === 0) return null;
    const classes = graph.stateClasses();
    const index = new Map<StateClass, number>();
    for (let i = 0; i < classes.length; i++) index.set(classes[i]!, i);
    const start = index.get(graph.initialClass);
    if (start === undefined) return null;

    const UNREACHED = -1;
    const iter = new Int32Array(classes.length).fill(UNREACHED);
    iter[start] = 0;
    const buckets: number[][] = [[start]];
    for (let d = 0; d < buckets.length; d++) {
      const bucket = buckets[d];
      if (bucket === undefined) continue;
      // `bucket` grows while it is drained: a 0-weight successor belongs to this very
      // distance, and appending it here is what makes Dial's algorithm exact for 0/1 weights.
      for (let b = 0; b < bucket.length; b++) {
        const i = bucket[b]!;
        if (iter[i] !== d) continue;
        for (const [transition, edges] of graph.outgoingBranchEdges(classes[i]!)) {
          const step = loops.has(transition.name) ? 1 : 0;
          for (const edge of edges) {
            const j = index.get(edge.target);
            if (j === undefined) continue;
            const next = d + step;
            if (iter[j] === UNREACHED || next < iter[j]!) {
              iter[j] = next;
              (buckets[next] ??= []).push(j);
            }
          }
        }
      }
    }

    let frontier = Number.POSITIVE_INFINITY;
    for (let i = 0; i < classes.length; i++) {
      if (this.wasExpanded(i, classes[i]!)) continue;
      const d = iter[i]!;
      // An unexpanded class the recorded edges do not reach cannot bound anything: no run
      // through recorded edges gets there, so it constrains no `k`.
      if (d !== UNREACHED && d < frontier) frontier = d;
    }
    if (!Number.isFinite(frontier)) return null;
    const k = frontier - 1;
    // `k = 0` would only say "nothing goes wrong in runs where the loop never runs", which
    // is not a statement about the loop at all. One cyclic-node run is the floor.
    return k >= 1 ? k : null;
  }

  /** BFS parents from the initial class, built once, for the firing paths. */
  private buildParents(graph: StateClassGraph): Map<StateClass, { from: StateClass; transition: Transition }> {
    const parents = new Map<StateClass, { from: StateClass; transition: Transition }>();
    const seen = new Set<StateClass>([graph.initialClass]);
    // An index cursor rather than `shift()`: the graph can hold `maxClasses` entries, and a
    // shifting queue over 200 000 of them is a needless O(n^2) risk.
    const queue: StateClass[] = [graph.initialClass];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (const [transition, edges] of graph.outgoingBranchEdges(current)) {
        for (const edge of edges) {
          if (seen.has(edge.target)) continue;
          seen.add(edge.target);
          parents.set(edge.target, { from: current, transition });
          queue.push(edge.target);
        }
      }
    }
    return parents;
  }

  private decode(sc: StateClass): Stranding {
    const graph = this.graph!;
    this.parents ??= this.buildParents(graph);
    const steps: CounterexampleStep[] = [];
    let cursor: StateClass | undefined = sc;
    while (cursor !== undefined && cursor !== graph.initialClass) {
      const parent: { from: StateClass; transition: Transition } | undefined = this.parents.get(cursor);
      if (parent === undefined) break;
      steps.push(decodeStep(parent.transition.name, this.map));
      cursor = parent.from;
    }
    steps.reverse();
    const marking = decodeMarking(sc.marking, this.map);
    const kind = terminalKindOf(marking.map((p) => p.role));
    const rest = restRolesFor(kind);
    return {
      stranded: marking.filter((p) => p.role === null || !rest.has(p.role)),
      marking,
      path: steps,
      terminal: kind,
      paused: kind !== 'none',
    };
  }
}
