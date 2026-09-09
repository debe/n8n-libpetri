/**
 * The shapes {@link verify} returns: one {@link PropertyCheck} per named question asked of
 * the net, and one {@link VerificationReport} per workflow.
 *
 * A check's `verdict` is always about the **desirable** property, never about the SMT
 * query's polarity. That matters for {@link PropertyName} `'dead-nodes'`, whose underlying
 * query is `unreachable({X/running})`: a `proven` there means the node can never run, which
 * is the *bad* outcome, so the check reports `violated`. Every other property maps straight
 * through. {@link PropertyCheck.query} records which libpetri property was actually asked
 * and what libpetri answered, so the inversion is never hidden.
 */
import type { BudgetRestriction, PlaceRole, TransitionRole, Variant } from '../compiler/index.js';
import type { AgentBudget, TruncationCause } from './state-class.js';

/** The property families {@link verify} can ask about. CLI `--property` takes these names. */
export type PropertyName =
  | 'proper-completion'
  | 'dead-nodes'
  | 'no-double-activation'
  | 'budget'
  | 'retry-bound'
  | 'mutual-exclusion';

export const PROPERTY_NAMES: readonly PropertyName[] = [
  'proper-completion', 'dead-nodes', 'no-double-activation', 'budget', 'retry-bound', 'mutual-exclusion',
];

/**
 * - `proven` — the desirable property holds on every reachable marking.
 * - `violated` — it does not, and the check carries the witness.
 * - `bounded` — it holds on every run in which the workflow's cyclic nodes run at most
 *   {@link StateSpaceSummary.boundedCyclicRuns} times **in total**, and the state space
 *   beyond that was not explored. That is runs of cyclic nodes, not passes of the loop body:
 *   divide by {@link StateSpaceSummary.loopSteps} for the guaranteed number of complete
 *   passes. **Sound, and deliberately not a proof**: the graph truncated, and this is the
 *   largest prefix it closed (`state-class.ts`, `closedCyclicRuns`). It exists because a
 *   cyclic workflow's state space is unbounded, so `proven` is unreachable there and
 *   `unknown` says less than is known. Nothing counts it among the proofs, and `--strict`
 *   fails on it.
 * - `unknown` — undecided, with the reason.
 */
export type CheckVerdict = 'proven' | 'violated' | 'bounded' | 'unknown';

/** What a check is about, in workflow terms rather than place names. */
export type CheckSubject =
  /** A join / OR input of `node`: the `ready_i` place a stranded arrival sits on (ADR 0003). */
  | { readonly kind: 'join-input'; readonly node: string; readonly inputIndex: number; readonly place: string }
  /**
   * A data edge place. `from` / `outputIndex` are absent for the start node's synthetic
   * `X/in`, which no connection feeds.
   */
  | {
    readonly kind: 'edge';
    readonly node: string;
    readonly place: string;
    readonly from?: string;
    readonly outputIndex?: number;
    readonly inputIndex?: number;
  }
  | { readonly kind: 'node'; readonly node: string; readonly place?: string }
  | { readonly kind: 'node-pair'; readonly nodes: readonly [string, string] }
  | { readonly kind: 'place'; readonly place: string }
  /** A structural fact read off the P-invariants, with no solver query of its own. */
  | { readonly kind: 'net' };

/** One step of a decoded counterexample: a flat transition put back in workflow terms. */
export interface CounterexampleStep {
  /** The flat transition name, `_b<k>` branch suffix included (the flattener's own name). */
  readonly transition: string;
  /** The net transition the branch belongs to (`nodeId/run`, `nodeId/route_0`, …). */
  readonly source: string;
  /** Owning node name, `null` for a host-level transition that belongs to no node. */
  readonly node: string | null;
  readonly role: TransitionRole | null;
  readonly port?: number;
  readonly variant?: Variant;
}

/** A place holding tokens in the violating marking, in workflow terms. */
export interface MarkedPlace {
  readonly place: string;
  readonly tokens: number;
  readonly node: string | null;
  readonly role: PlaceRole | null;
  readonly port: number | null;
}

/**
 * A violation witness, decoded through `NetMap`.
 *
 * `ordered` is `true` only when libpetri's abstract replay confirmed a firing order
 * (`SmtVerificationResult.counterexampleConfirmed === true`). Otherwise the steps are the
 * decoded derivation set in traversal order — every step is real, the sequence is not
 * necessarily a firing sequence, and {@link nodePath} must be read as "these nodes are
 * involved", not "in this order".
 */
export interface Counterexample {
  /** Node names in first-occurrence order over {@link steps}; the host transition is skipped. */
  readonly nodePath: readonly string[];
  readonly steps: readonly CounterexampleStep[];
  /** The marking of the violating state: for proper completion, the stuck marking. */
  readonly stuckMarking: readonly MarkedPlace[];
  readonly confirmed: boolean | null;
  readonly ordered: boolean;
}

/**
 * How a check reached its verdict.
 *
 * - `state-class-graph` — the solver-free route (VER-010), the primary one: the reachable
 *   `(marking, zone)` classes were enumerated and the answer read off them. A `proven` here
 *   requires the graph to have **closed**; a `violated` does not (a class of the explored
 *   prefix is reachable whatever the BFS did next), and neither does a `bounded`, which is
 *   the route reporting exactly how far the prefix reaches.
 * - `smt` — libpetri's IC3/PDR encoding through z3, the fallback for a truncated graph. Not
 *   every question reaches it: a net above `verify.ts`'s measured size ceiling gets none, and
 *   neither does a question the graph has already shown the query cannot decide.
 * - `structural` — read off the flattened net or the P-invariants, with no reachability
 *   question at all (the retry producer check, the budget semiflow).
 * - `none` — nothing ran (including the case where the SMT query was deliberately skipped;
 *   the check's `reason` says which).
 */
export type CheckRoute = 'state-class-graph' | 'smt' | 'structural' | 'none';

/** What was asked, how it was answered, and what came back. */
export interface QueryRecord {
  /** libpetri `SmtProperty.type` naming the question, or `'none'` for a structural check. */
  readonly property: string;
  /** The place the property names, when it names one. */
  readonly place: string | null;
  /** The route's own verdict, before any polarity inversion this module applies. */
  readonly verdict: CheckVerdict;
  /**
   * Sink places the whole-net `deadlockFree` question is scoped by (VER-002): the structural
   * rest set, where a token at quiescence is legitimate residue. Recorded on the proper
   * completion family whichever route answered, because it is the *question*'s definition.
   */
  readonly sinks: readonly string[];
  /**
   * The pause filter as the SMT question states it (libpetri VER-014): while `marker` holds a
   * token, a token may also rest on `places`. Two entries on every n8n net — `_pause` widening
   * to the pause rest set, `_halt` to the halt rest set — so the solver-free route's
   * classification (`state-class.ts`) and the solver ask the same question.
   */
  readonly conditionalSinks: readonly { readonly marker: string; readonly places: readonly string[] }[];
  /** `'state-class graph'`, `'IC3/PDR'`, `'P-invariant'`, `'structural'`; `null` when nothing ran. */
  readonly method: string | null;
  readonly route: CheckRoute;
}

export interface PropertyCheck {
  readonly property: PropertyName;
  /** A one-line human name, e.g. `Merge input 1 always completes`. */
  readonly name: string;
  readonly subject: CheckSubject;
  readonly verdict: CheckVerdict;
  /** What the verdict means for the workflow, in one sentence. */
  readonly explanation: string;
  /** Why the verdict is `unknown`, or what bounds a `bounded` one; `null` otherwise. */
  readonly reason: string | null;
  readonly counterexample: Counterexample | null;
  readonly elapsedMs: number;
  readonly query: QueryRecord;
}

/** The solver the run resolved (VER-013). */
export interface SolverInfo {
  readonly available: boolean;
  readonly program: string | null;
  readonly version: string | null;
  /** Why no solver resolved; `null` when one did. Names `PATH` and `LIBPETRI_Z3`. */
  readonly reason: string | null;
}

/** Size of the net every query ran against. */
export interface NetSize {
  readonly places: number;
  readonly transitions: number;
  /**
   * Transitions after XOR expansion — what the SMT encoder actually sees. An `and` of `k`
   * `xor`s expands to `2^k` (IO-016), which is why the compiler splits routing above
   * `SPLIT_ROUTING_ABOVE` connected outputs.
   */
  readonly flatTransitions: number;
}

/**
 * The solver-free route's own numbers (VER-010, `state-class.ts`).
 *
 * `complete` is the load-bearing field: only a complete graph can carry a `proven`. A
 * truncated one is reported as such — `truncation` says which of NU-053's two shapes caused
 * it — and never as a pass.
 */
export interface StateSpaceSummary {
  /** State classes explored. */
  readonly classes: number;
  /** The BFS closed: every reachable class was enumerated. */
  readonly complete: boolean;
  /**
   * The cap the exploration actually ran with. Equal to `VerifyOptions.maxClasses` unless
   * the V8 heap could not hold that many classes, in which case it is lower and
   * {@link requestedMaxClasses} says what was asked for (`state-class.ts`
   * `effectiveMaxClasses`).
   */
  readonly maxClasses: number;
  /** What the caller asked for, before the heap-limit check. */
  readonly requestedMaxClasses: number;
  readonly elapsedMs: number;
  /** Classes nothing can fire from: the markings a run can come to rest in. */
  readonly quiescent: number;
  /** Of those, the designed terminals: a paused (`_pause`) or halted (`_halt`) run. */
  readonly terminal: number;
  /** Places some quiescent class leaves pending work on. Non-zero means a stranding. */
  readonly strandedPlaces: number;
  /** Why the graph did not close; `null` when it did. */
  readonly truncation: TruncationCause | null;
  /**
   * Every agent and its tool-call budget, declared or assumed. The graph explores every round
   * size up to the budget, so on an agent workflow this is the width of the claim a `proven`
   * makes — and, when the graph truncated, the knob that closes it.
   */
  readonly agents: readonly AgentBudget[];
  /**
   * Classes the BFS expanded — the prefix a `bounded` verdict is certified over. Equal to
   * {@link classes} on a complete graph.
   */
  readonly expanded: number;
  /**
   * The largest `k >= 1` for which every run firing at most `k` **cyclic-node runs** was
   * enumerated, so a safety property that holds across the explored prefix holds for all of
   * them. `null` when the graph closed (nothing to bound), when the workflow is acyclic
   * (there is nothing to count), or when not even one whole cyclic-node run is closed.
   *
   * This is what a `bounded` {@link CheckVerdict} quantifies over. It is a count of node
   * runs, not of loop iterations: divide by {@link loopSteps} for complete passes.
   */
  readonly boundedCyclicRuns: number | null;
  /**
   * How many transitions {@link boundedCyclicRuns} counts: the `run` of every node on a
   * cycle. A bound of `k` over `loopSteps` cyclic nodes guarantees `floor(k / loopSteps)`
   * complete passes of the loop body, so `k` itself must never be reported as an iteration
   * count.
   */
  readonly loopSteps: number;
  /** Why the graph could not be built at all; `null` when it was. */
  readonly error: string | null;
}

/**
 * The conservation laws handed to the encoder (VER-007).
 *
 * `basis` and `semiflowsEncoded` are read off libpetri's own report — the canonical
 * `  Found: N P-invariant(s)` and `  Semiflows encoded as invariants: N` lines, which
 * VER-013 fixes byte for byte across the four implementations — so they are the
 * post-validation figures, not a re-derivation. `encoded` is the length of the invariant
 * list the result carries, which is the list the CHC rule bodies were conjoined with.
 */
export interface InvariantSummary {
  /** Null-space basis rows that survived the exact re-check. */
  readonly basis: number;
  /** Semiflows `strengthenWithSemiflows` added on top of the basis — what VER-007 bought here. */
  readonly semiflowsEncoded: number;
  /** Basis ∪ added semiflows: the set every query's rule bodies carry. */
  readonly encoded: number;
  /**
   * Rendered `w·_budget + w·Σ_X(running + retry + in-flight) = w·k` when it survives validation;
   * `null` when no law covering `_budget` and every `X/running` was found (the H1 guard
   * drops any row whose support touches a reset or consume-all place).
   */
  readonly budgetSemiflow: string | null;
}

export interface VerificationReport {
  readonly workflow: string;
  readonly structuralHash: string;
  readonly requestedBudget: number;
  /** The budget the net was compiled with: `requestedBudget`, or 1 under a k-safety restriction. */
  readonly budget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  readonly solver: SolverInfo;
  readonly net: NetSize;
  /** What the solver-free route explored, and whether it closed. */
  readonly stateSpace: StateSpaceSummary;
  readonly invariants: InvariantSummary;
  /** Per-query timeout in milliseconds. */
  readonly timeoutMs: number;
  readonly properties: readonly PropertyName[];
  readonly checks: readonly PropertyCheck[];
  readonly counts: Readonly<Record<CheckVerdict, number>>;
  /**
   * No check came back `violated`. `unknown` and `bounded` checks do not make a workflow
   * unsound; they make it unproven, which is what `--strict` fails on rather than this flag.
   */
  readonly ok: boolean;
  /** The compiler's own non-fatal findings, carried through. */
  readonly diagnostics: readonly string[];
  /**
   * Node shapes the caller had to guess, one line each (`workflow-json.ts`). A guessed
   * input / output count changes the compiled net — it decides the join versus the direct
   * form and how routing is split — so a report carrying any of these may be about a net
   * that is not quite the workflow. The CLI prints them to stderr as well; they are in the
   * report so the stored JSON is self-describing.
   */
  readonly shapeWarnings: readonly string[];
  readonly elapsedMs: number;
}

/** How far the SMT route may go: see {@link VerifyOptions.smtFallback}. */
export type SmtFallbackMode = 'auto' | 'off' | 'force';

/** A pair of node names for {@link PropertyName} `'mutual-exclusion'`, or every pair. */
export type MutualExclusionRequest = readonly (readonly [string, string])[] | 'all-pairs';

export interface VerifyOptions {
  /** Concurrency budget `k`. Default 1. The compiler may lower it (`budgetRestriction`). */
  readonly budget?: number;
  /** Which property families to run. Default: everything except `'mutual-exclusion'`. */
  readonly properties?: readonly PropertyName[];
  /** Per-query timeout handed to the SMT **fallback** (VER-013). Default 60 000 ms. */
  readonly timeoutMs?: number;
  /**
   * Class cap for the solver-free route (VER-010). Default
   * {@link DEFAULT_MAX_CLASSES} (200 000). The graph must never run unbounded: a cyclic
   * workflow's state space is infinite and a heavily parallel one's is combinatorial
   * (NU-053), so this is what turns a hang into a reported truncation — which is an
   * `unknown`, never a pass.
   *
   * `0` turns the route off entirely: the graph truncates at the initial class and every
   * family falls back to the SMT route, which is M4's surface.
   */
  readonly maxClasses?: number;
  /** VER-007. Default `true`: without it the reset-arc chains lose their conservation laws. */
  readonly semiflowInvariants?: boolean;
  /**
   * An agent's round budget when its `options.maxIterations` is an expression. Default 10, n8n's
   * own default for that parameter — the scheduler's `maxAgentRounds`, so a report matches the
   * net that runs.
   */
  readonly maxAgentRounds?: number;
  /**
   * An agent's tool-call budget unless the workflow declares `options.maxToolCalls`. Default 64,
   * the scheduler's runtime default, which is far wider than a graph can explore: pass a small
   * value here to see what a declared budget would verify as, then declare it on the agent.
   */
  readonly maxAgentToolCalls?: number;
  /**
   * Whether the SMT route may run at all, and on how big a net (VER-001/VER-013).
   *
   * - `'auto'` (default) — run it, but only below the measured size ceiling
   *   (`verify.ts` `SMT_MAX_FLAT_PLACES` / `SMT_MAX_JOIN_INPUTS`). Above it the pipeline
   *   libpetri runs before z3 (flatten, structural pre-check, P-invariants, semiflows)
   *   exhausts the V8 heap, and a heap exhaustion **aborts the process** — there is no
   *   exception to catch, so the only safe handling is not to start it. Refusing yields
   *   `unknown` with a reason naming the ceiling, which is a verdict; an abort is not.
   * - `'off'` — never run it. Every family answers off the state-class graph or comes back
   *   `unknown`; nothing spawns z3 and the P-invariant pipeline never runs.
   * - `'force'` — run it whatever the size. The escape hatch for a big net you want the
   *   budget semiflow or a fallback proof on, at the risk of the abort above.
   */
  readonly smtFallback?: SmtFallbackMode;
  /**
   * Node pairs for `'mutual-exclusion'`, or `'all-pairs'`. Supplying any of these turns the
   * property on even when `properties` was not given.
   */
  readonly mutualExclusion?: MutualExclusionRequest;
  /** The value on the start node's `in` place. Irrelevant to every verdict (VER-004). */
  readonly triggerItems?: unknown;
  /**
   * Warnings about the description itself, carried into
   * {@link VerificationReport.shapeWarnings}. The CLI passes `parseWorkflowJson`'s guessed
   * node shapes here.
   */
  readonly shapeWarnings?: readonly string[];
  /** Called as each check completes, so a CLI can stream a long run. */
  readonly onCheck?: (check: PropertyCheck) => void;
}
