/**
 * The compiler's output: the per-node gadget as the scheduler drives it, the read side of
 * `NetMap` action binders see, and the `CompiledWorkflow` — one flat net per workflow
 * (MOD-023) with its memoised program and marking. Also {@link CompileOptions}, which carries
 * the {@link ActionBinder} and a precomputed analysis into `compile`.
 */
import type { PetriNet, Place, PrecompiledNet, Token, Transition, TransitionAction } from 'libpetri';
import type { CompileProfile, WorkflowAnalysis } from './analysis.js';
import type { OnError } from './input.js';
import type {
  EdgeRef, PlaceInfo, PlaceRole, SettlementGadget, TransitionInfo, TransitionInfoOf, TransitionRole,
} from './netmap.js';

/** The host-level edge places of one connection, owned by the consumer. */
export interface EdgeSlot {
  readonly edge: EdgeRef;
  readonly data: Place<unknown>;
  /** Present for tree edges only: cycle edges carry no empty token (README emission rule). */
  readonly empty: Place<unknown> | null;
}

/** The fields every modelled input carries, whichever slot shape its form gives it. */
export interface InputGadgetCommon {
  readonly index: number;
  /** Producer edges, canonical order. Empty for a dead (unwired, required) input. */
  readonly edges: readonly EdgeSlot[];
  /** Has at least one producer edge. A dead input never receives a token (README join gadget). */
  readonly wired: boolean;
  /** Must carry data for `X_start` (all-required node, or listed in `requiredInputs`). */
  readonly required: boolean;
  /** An `empty` token can arrive on this input (some producer edge is a tree edge). */
  readonly emptyCapable: boolean;
  /** True when every producer of this input is unreachable from the start node: seeded empty. */
  readonly seedEmpty: boolean;
  /** Tree edges whose producer is unreachable from the start node (the OR form seeds one empty each). */
  readonly unreachableEdges: number;
}

/**
 * The OR form's round places (README "OR-inputs"). No slot: arrivals aggregate a round rather
 * than filling a `free_i` / `ready_i` pair.
 */
export interface OrSlot {
  readonly slot: 'or';
  /** `X/ready_i`: the round counter, one token per delivery of the current round. */
  readonly ready: Place<unknown>;
  /** `X/hasdata_i`: one token per data arrival, carrying the payload. */
  readonly hasdata: Place<unknown>;
  /** `X/ran_i`: one token per run of the current round. */
  readonly ran: Place<unknown>;
  /** The number of empty-capable producer edges, one delivery each per round. */
  readonly round: number;
}

/** A join slot with one ready place for both variants: a generic join input, or a non-required choose-branch input. */
export interface ReadySlot {
  readonly slot: 'ready';
  /** `X/free_i`: the slot is empty. */
  readonly free: Place<unknown>;
  /** `X/ready_i`: the single ready place, for `data` and `empty` alike. */
  readonly ready: Place<unknown>;
}

/** A required choose-branch input's slot, whose two variants are enumerated on distinct places. */
export interface SplitReadySlot {
  readonly slot: 'ready-split';
  /** `X/free_i`: the slot is empty. */
  readonly free: Place<unknown>;
  /** `X/ready_i_data`. */
  readonly readyData: Place<unknown>;
  /** `X/ready_i_empty`; `null` when no producer edge can deliver an empty. */
  readonly readyEmpty: Place<unknown> | null;
}

/** The places of one input, by the shape its form gives it. */
export type InputSlot = OrSlot | ReadySlot | SplitReadySlot;

export interface OrInput extends InputGadgetCommon, OrSlot {}
export interface ReadyInput extends InputGadgetCommon, ReadySlot {}
export interface SplitReadyInput extends InputGadgetCommon, SplitReadySlot {}

/** One modelled input, discriminated on `slot`. */
export type InputGadget = OrInput | ReadyInput | SplitReadyInput;

export interface OutputGadgetCommon {
  readonly index: number;
  readonly name: string | null;
  readonly isErrorOutput: boolean;
  readonly edges: readonly EdgeSlot[];
  /** `X/nil_o` for a producer inside a cycle; `null` for an acyclic producer. */
  readonly nil: Place<unknown> | null;
}

/** An output `X_run` routes in its own `Out` spec (see {@link NodeGadget.routing}). */
export interface CollapsedOutput extends OutputGadgetCommon {
  readonly routing: 'collapsed';
}

/** An output routed by its own `X_route_o` (per-output routing above {@link SPLIT_ROUTING_ABOVE}). */
export interface SplitOutput extends OutputGadgetCommon {
  readonly routing: 'split';
  /** `X/ok_o`: written by `X_run`, drained by `X_route_o`. */
  readonly ok: Place<unknown>;
  /** `X/routed_o`: written by `X_route_o`, consumed by `X_done`. */
  readonly routed: Place<unknown>;
}

/** One connected output, discriminated on `routing`; every output of a node shares its node's shape. */
export type OutputGadget = CollapsedOutput | SplitOutput;

/**
 * How the node delivers its success outcome (ADR 0004):
 * - `collapsed`: `X_run` routes every output in its own `Out` spec and marks the single
 *   `X/routed`, which `X_done` consumes one scheduling cycle later to refund `_budget`;
 * - `split`: the node has more than {@link SPLIT_ROUTING_ABOVE} connected outputs and routes
 *   each through `X/ok_o` → `X_route_o` → `X/routed_o` → `X_done`. `outputs` are the same
 *   objects as {@link NodeGadget.outputs}, typed for their places.
 */
export type RoutingGadget =
  | {
    readonly kind: 'collapsed';
    /** `X/routed`: the marker `X_run` writes in the same firing as the edge tokens. */
    readonly routed: Place<unknown>;
    readonly outputs: readonly CollapsedOutput[];
  }
  | { readonly kind: 'split'; readonly outputs: readonly SplitOutput[] };

export interface NodeGadgetTransitions {
  readonly start: string;
  /** One `X_start_unmet_k` per reference that carries a read arc, in reference order. */
  readonly startUnmet: readonly string[];
  readonly run: string;
  /**
   * One `X_route_o` per connected output (ascending index) under per-output routing; empty
   * when `X_run` routes in its own `Out` spec ({@link SPLIT_ROUTING_ABOVE}).
   */
  readonly routes: readonly string[];
  /** `X_done`: the budget refund, one scheduling cycle after the edge tokens. Every node has one. */
  readonly done: string;
  readonly skip: readonly string[];
  readonly arms: readonly string[];
  /** `X_clear` per OR-form input. */
  readonly clear: readonly string[];
  readonly retryWait: string | null;
  readonly exhausted: string | null;
  /**
   * `X_run` per attempt of an `onFailure` chain, ascending. `attemptRuns[0]` is `X_run` itself,
   * so a policy-free node has this empty and its `run` is unchanged.
   */
  readonly attemptRuns: readonly string[];
  /** The step answering each attempt's failure, ascending. */
  readonly attemptSteps: readonly string[];
  /** The deadline funnel per attempt (`X/timedout_i` into `X/failed_i`); empty without one. */
  readonly attemptTimeouts: readonly string[];
  readonly sinks: readonly string[];
  /** `A_done_req`: refunds `_budget` and opens the round (agent nodes only). */
  readonly doneRequest: string | null;
  /** `A_dispatch`: pops one action off `A/queue` onto some tool's `T/in_tool` (agent nodes only). */
  readonly dispatch: string | null;
  /**
   * `A_collect`: pairs one `A/response` with one `A/outstanding` and produces nothing — a
   * genuine sink (CORE-043 AC4), the same category as the OR form's `X_clear`.
   */
  readonly collect: string | null;
  /** `A_resume`: re-enters `X_run` with the round's `EngineResponse` (agent nodes only). */
  readonly resume: string | null;
  /**
   * `A_rounds_out`: the round budget is spent with a round still open, so the agent pauses
   * instead of stranding and its re-entry is written back to `nodeExecutionStack`.
   */
  readonly roundsOut: string | null;
  /**
   * `A_calls_out`: the tool-call budget is spent with calls still queued. The agent re-enters
   * `X_run` carrying the fact, and the run fails with the budget error under its own `onError`
   * policy — the same shape as `maxIterations` throwing inside n8n's node.
   */
  readonly callsOut: string | null;
}

/**
 * One attempt of an `onFailure` chain: where it runs, where its failure lands, and what the
 * step answering that failure does (ADR 0009).
 *
 * The chain is *unrolled* rather than counted. n8n evaluates `getRetryParams(executionData)`
 * per activation, but `X/tries` is seeded once per execution and refunded by nothing, so a node
 * that activates twice gets its leftover allowance. Every token here is created and consumed
 * inside one activation, so the allowance is per activation by construction.
 */
export interface AttemptGadgetCommon {
  /** 1-based. `index === 1` is the ordinary run. */
  readonly index: number;
  /** `X/running` for attempt 1, `X/running_i` after it. */
  readonly running: Place<unknown>;
  /** `X/failed_i`: this attempt failed and its step has not yet acted. */
  readonly failed: Place<unknown>;
  /**
   * `X/timedout_i`: the deadline expired. A distinct place from `failed`, because IO-013's
   * timeout child is an `Xor` sibling of the normal outcome and two branches claiming the same
   * set would make every failing firing ambiguous under IO-015. A funnel transition moves it to
   * `failed`, which is what makes "a timeout is another way an attempt fails" true in the net.
   */
  readonly timedOut: Place<unknown> | null;
}

/** A `retry` step: wait, then run the next attempt. */
export interface RetryAttempt extends AttemptGadgetCommon {
  readonly action: 'retry';
  /** The delay before the next attempt. */
  readonly waitMs: number;
  /** The next attempt's `running` place — the chain is unrolled, so "next" is a place, not a decrement. */
  readonly next: Place<unknown>;
}

/** A `route` step: the failure takes a connected output. */
export interface RouteAttempt extends AttemptGadgetCommon {
  readonly action: 'route';
  /** The connected output the failure takes. */
  readonly outputIndex: number;
}

/** A `stop` or `continue` step: the terminal arm `onError` would have fixed. */
export interface TerminalAttempt extends AttemptGadgetCommon {
  readonly action: 'stop' | 'continue';
}

/** One attempt of an `onFailure` chain, discriminated on what its step does (see {@link AttemptGadgetCommon}). */
export type AttemptGadget = RetryAttempt | RouteAttempt | TerminalAttempt;

/** n8n's own `retryOnFail` gadget: `X/retry`, `X/tries` and the clamped parameters that seed and time them. */
export interface RetryGadget {
  /** `X/retry`: the attempt failed and a try may be left. */
  readonly retry: Place<unknown>;
  /** `X/tries`: seeded with `maxTries − 1`, consumed one per `X_retry_wait`, refunded by nothing. */
  readonly tries: Place<unknown>;
  /** n8n's clamped `maxTries` (`[2, 5]`). */
  readonly maxTries: number;
  /** n8n's clamped `waitBetweenTries` (`[0, 5000]` ms). */
  readonly waitBetweenTries: number;
}

/**
 * The agent side of a node with at least one `ai_tool` producer. This is
 * `references/patterns.md` §5 ("fan-out and join with pending markers"): `routedRequest` phases
 * the budget refund as `routed` does, `queue` carries the undispatched actions, `pending`
 * counts them structurally so no action decides "am I the last one", `outstanding` is the
 * pattern's `JOB_PENDING`, `dispatched` its `ROUTING_DONE`, and `rounds` bounds the loop.
 *
 * There is no accumulator for collected responses on purpose: `A_collect` consumes
 * `outstanding` when it fires and would deposit on completion, so `A_resume` could drain
 * n − 1 markers inside that window and leak one into the next round
 * (`tests/spikes/agent-round.test.ts` measured it). `A_collect` produces nothing instead.
 */
export interface AgentGadget {
  /** `A/routed_req`: the request outcome's marker, refunded by `A_done_req` one cycle later. */
  readonly routedRequest: Place<unknown>;
  /** `A/queue`: one token carrying the actions not yet dispatched, plus the agent's resume entry. */
  readonly queue: Place<unknown>;
  /**
   * `A/calls`: the tool-call budget, seeded with `maxToolCalls` and consumed one unit per
   * `A_dispatch`. Refunded by nothing, so it is monotonically decreasing — which is what keeps
   * the reachability graph finite, and what lets it explore every round size up to the budget:
   * the count is the number of dispatch firings, not a token deposit.
   */
  readonly calls: Place<unknown>;
  /**
   * `A/drained`: the round has nothing left to dispatch. Written by `A_done_req` for an empty
   * request and by `A_dispatch` when it takes the last action off the queue; consumed by
   * `A_resume`. The queue token and this marker are exclusive.
   */
  readonly drained: Place<unknown>;
  /** `A/outstanding`: one unit token per dispatched, uncollected action. */
  readonly outstanding: Place<unknown>;
  /** `A/response`: one token per tool that finished, deposited by the tool's own `T_done`. */
  readonly response: Place<unknown>;
  /** `A/dispatched`: the round is open and fully dispatched; carries the agent's resume entry. */
  readonly dispatched: Place<unknown>;
  /** `A/rounds`: the round budget, seeded with `maxRounds` units and consumed one per `A_resume`. */
  readonly rounds: Place<unknown>;
  /**
   * `A/running_failed`: the running place `A_calls_out`'s re-entry lands on, consumed only by
   * `A_run_failed`. The primary run is therefore structurally unreachable from `A_calls_out` —
   * no inhibitor, so a linear ranking can bound the round — and the value-blind
   * `calls_out → run → done_req → calls_out` lasso, which the executor never runs, has no edge.
   * Carries the re-entry unit for one step and never rests.
   */
  readonly runningFailed: Place<unknown>;
  /** Tool nodes this agent may dispatch, in `A_dispatch`'s `xor` branch order. At least one: that is what makes it an agent. */
  readonly tools: readonly [string, ...string[]];
  /** `maxRounds` as compiled: the seed of `A/rounds`. */
  readonly maxRounds: number;
  /** True when `maxRounds` came from a configured fallback rather than the workflow JSON. */
  readonly roundsAssumed: boolean;
  /** `maxToolCalls` as compiled: the seed of `A/calls`. */
  readonly maxToolCalls: number;
  /** True when `maxToolCalls` is the scheduler's default rather than a value the workflow declared. */
  readonly toolCallsAssumed: boolean;
}

/** The fields every node's gadget carries, whichever form its input side takes. */
export interface NodeGadgetCommon {
  readonly node: string;
  readonly id: string;
  readonly type: string;
  readonly typeVersion: number;
  readonly disabled: boolean;
  readonly loopNode: boolean;
  /** Longest path from the start node in the SCC condensation; `X_start` priority. */
  readonly depth: number;
  readonly cyclic: boolean;
  /** Reachable from the union of start nodes. */
  readonly reachable: boolean;
  /** The primary start node (`startNodes[0]`): `initialMarking` seeds its own input. */
  readonly isStart: boolean;
  /** One of the start nodes (primary or not). */
  readonly isStartNode: boolean;
  readonly onError: OnError;
  /**
   * n8n's `retryOnFail` gadget; `null` when the node declares none. Mutually exclusive with
   * {@link NodeGadgetCommon.attempts}: `analyse()` rejects a node carrying both.
   */
  readonly retry: RetryGadget | null;
  readonly running: Place<unknown>;
  readonly idle: Place<unknown>;
  /** How the success outcome is delivered and where its in-flight marker sits (ADR 0004). */
  readonly routing: RoutingGadget;
  readonly done: Place<unknown>;
  /** Present iff the node has a skip transition or is referenced (the reference twin reads it). */
  readonly skipped: Place<unknown> | null;
  /**
   * `X_skip` deposits the empty of every outgoing tree edge. False when no successor reads a
   * skip or feeds a node that does — a join or OR slot, a `$('X')` reference, a cycle or a
   * loop — so the skip ends at this node (ADR 0002, `analysis/skip-observers.ts`).
   */
  readonly skipForwards: boolean;
  /**
   * The `onFailure` chain, one entry per attempt, ascending (ADR 0009). Empty when the node
   * declares no policy, in which case {@link NodeGadgetCommon.retry} carries n8n's own
   * `retryOnFail` — the two are mutually exclusive and `analyse()` rejects a node carrying both.
   *
   * `attempts[0].running` **is** {@link NodeGadgetCommon.running}: the first attempt is the
   * ordinary run, so `X_start` is unchanged and a policy-free node compiles byte-identically.
   */
  readonly attempts: readonly AttemptGadget[];
  /** `executionPolicy.timeoutMs`: the per-attempt deadline (IO-013). `null` when undeclared. */
  readonly attemptTimeoutMs: number | null;
  /** `X/waiting`: the node put the execution to wait (PlaceRole `waiting`). */
  readonly waiting: Place<unknown>;
  /** `X/stopped`: the destination-node stop, or a cancellation before the run (PlaceRole `stopped`). */
  readonly stopped: Place<unknown>;
  /** The agent side; `null` unless the node has at least one `ai_tool` producer. */
  readonly agent: AgentGadget | null;
  /** Connected outputs, ascending index. Unconnected outputs get no places. */
  readonly outputs: readonly OutputGadget[];
  /** Referenced nodes that carry a read arc on their `done` (and a `start-unmet` twin on their `skipped`). */
  readonly references: readonly string[];
  /** Referenced nodes reachable only through this node: no arc, the expression fails inside the action. */
  readonly unguardedReferences: readonly string[];
  readonly transitions: NodeGadgetTransitions;
}

/** The `direct` form: at most one producer edge (README "Per-node gadget"). */
export interface DirectGadget extends NodeGadgetCommon {
  readonly form: 'direct';
  /** The single in-data place (an edge place, or a synthetic `in`). */
  readonly in: Place<unknown>;
  /** Tree edge: the in-empty place; `null` for a cycle edge or a synthetic `in`. */
  readonly inEmpty: Place<unknown> | null;
  /** The direct form has no join inputs. */
  readonly inputs: readonly [];
}

/** The `or` form: one input index with several empty-capable producer edges (README "OR-inputs"). */
export interface OrGadget extends NodeGadgetCommon {
  readonly form: 'or';
  /** The one aggregated input. */
  readonly inputs: readonly [OrInput];
}

/** The `join` form: several inputs, or an input with several producers of which at most one can carry an empty (README "Join gadget"). */
export interface JoinGadget extends NodeGadgetCommon {
  readonly form: 'join';
  /** `X/hasdata`: the slot-wide "at least one non-empty" counter. */
  readonly hasdata: Place<unknown>;
  /** Inputs the gadget models, ascending index: connected ones plus dead required ones. */
  readonly inputs: readonly ReadyInput[];
}

/** The `choose-branch` form: a join whose `requiredInputs` lists inputs that must carry data. */
export interface ChooseBranchGadget extends NodeGadgetCommon {
  readonly form: 'choose-branch';
  /** Inputs the gadget models, ascending index; a required input's slot is enumerated (`ready-split`). */
  readonly inputs: readonly (ReadyInput | SplitReadyInput)[];
}

/**
 * The `tool` form: the node is dispatched by an agent over `ai_tool`, never by a `main`
 * producer. Its input side is a single `T/in_tool` an agent's `A_dispatch` writes, and its
 * success branch deposits the agent's `A/response` instead of edge tokens. Everything between
 * those two ends — start, run, retry, halt, wait, stop, done — is the ordinary gadget.
 */
export interface ToolGadget extends NodeGadgetCommon {
  readonly form: 'tool';
  /**
   * `T/in_tool`: the dispatch place an agent's `A_dispatch` writes, carrying the `IExecuteData`
   * n8n's own `addNodeToBeExecuted` built for this action.
   */
  readonly inTool: Place<unknown>;
  /** Agents that may dispatch this tool. At least one: that is what makes it a tool. */
  readonly agents: readonly [string, ...string[]];
  /** A tool has no main input side. */
  readonly inputs: readonly [];
}

/** Everything the scheduler needs to drive one node's gadget, discriminated on `form`. */
export type NodeGadget = DirectGadget | OrGadget | JoinGadget | ChooseBranchGadget | ToolGadget;

/** A gadget whose input side is made of join slots: the two forms {@link readySlot} serves. */
export type SlottedGadget = JoinGadget | ChooseBranchGadget;

export interface SharedPlaces {
  readonly budget: Place<unknown>;
  /**
   * `_halt`: the halted run's terminal marker. A fatal node error writes it and **nothing
   * consumes it** — every transition that could move a pending activation on inhibits on it,
   * so the run quiesces with its arrivals intact (README "Retries, halt, cancellation").
   */
  readonly halt: Place<unknown>;
  /** `_pause`: the control terminal for Wait and destination-node stops (README "Retries, halt, cancellation"). */
  readonly pause: Place<unknown>;
}

/**
 * The value an `X_start_unmet` twin puts on `X/running`: the node's input plus the name of
 * the referenced node that was skipped, so M2's action can fail with n8n's own "node is
 * unexecuted" error under the node's `onError` policy.
 */
export interface UnmetReferencePayload {
  readonly unmetReference: string;
  readonly input: unknown;
}

/**
 * Binds an action to a transition given its role. Return `null` to keep the action the
 * transition currently carries. Actions must satisfy the transition's `Out` spec on every
 * firing (IO-015) and must never reject (EXEC-030 loses the consumed tokens, and with them
 * the budget).
 */
export type ActionBinder = (info: TransitionInfo, map: NetMapView) => TransitionAction | null;

/**
 * Read side of `NetMap`, as seen by action binders. The gadget accessors are profile-bound
 * (`tasks/v2-profile-plan.md` decision 14): the v1 ones throw `InternalCompilerError` on an
 * `engineV2` net and the `engineV2` ones on a v1 net, so neither profile reads the other's
 * gadgets as an empty workflow. The transition and place lookups serve both.
 */
export interface NetMapView {
  /** The target the net was compiled for (`CompileOptions.profile`). */
  readonly profile: CompileProfile;
  /** `_budget`, `_halt`, `_pause`; throws on an `engineV2` net, which has only `_halt`. */
  readonly shared: SharedPlaces;
  /** `_halt`, the shared place both profiles have. */
  readonly halt: Place<unknown>;
  /** Node gadgets in declaration (canvas) order; throws on an `engineV2` net. */
  readonly nodes: readonly NodeGadget[];
  /** An `engineV2` net's settlement gadgets in declaration (canvas) order; throws on a v1 net. */
  readonly settlements: readonly SettlementGadget[];
  /** The settlement gadget of `name` in an `engineV2` net; throws for a node it does not compile, and on a v1 net. */
  settlement(name: string): SettlementGadget;
  /** Every transition of the flat net, in declaration order. */
  readonly transitions: readonly TransitionInfo[];
  /** Every place of the flat net. */
  readonly places: readonly PlaceInfo[];
  /** The gadget of `name`; throws for a node the workflow does not have, and on an `engineV2` net. */
  node(name: string): NodeGadget;
  /** Whether `name` is a node of the workflow; throws on an `engineV2` net. */
  hasNode(name: string): boolean;
  /** The gadget of `name`, `undefined` for a node the workflow does not have; throws on an `engineV2` net. */
  tryNode(name: string): NodeGadget | undefined;
  transition(name: string): TransitionInfo | undefined;
  transitionsOf(node: string): readonly TransitionInfo[];
  /** The first transition of `role` on `node` in declaration order; with `port`, the one carrying it (`route`, `clear`). */
  transitionFor<R extends TransitionRole>(node: string, role: R, port?: number): TransitionInfoOf<R> | undefined;
  transitionObject(name: string): Transition;
  place(name: string): PlaceInfo | undefined;
  placesOf(node: string): readonly PlaceInfo[];
  /** The first place of `role` on `node` in declaration order; with `port`, the first carrying it. */
  placeFor(node: string, role: PlaceRole, port?: number): PlaceInfo | undefined;
}

/** Why the k-safety check forced the budget to 1. */
export interface BudgetRestriction {
  readonly reason: 'cyclic' | 'multi-producer-input';
  readonly detail: string;
}

/**
 * The `ready` places of one join / OR input: where a stranded arrival sits (the arm drains
 * the edge place into `ready_i` as soon as the slot is free, ADR 0003), so this is what
 * `joinedOrDeadLettered` must be run on per input.
 */
export interface JoinReadyPlaces {
  readonly node: string;
  readonly inputIndex: number;
  readonly places: readonly Place<unknown>[];
}

export interface CompiledWorkflow {
  /** The one net that executes and is verified. Actions bound. */
  readonly net: PetriNet;
  /**
   * `PrecompiledNet.compile(net)`, memoised per `CompiledWorkflow` (CONC-020) and run on
   * first access; it performs the CORE-043 check. A `PrecompiledNet` captures the bound
   * `Transition` objects (the executor fires `program.compiled.transition(tid)`), so a
   * re-bound workflow (`withActions`) compiles its own program; the structural analysis,
   * the net and the `NetMap` are shared.
   */
  readonly program: PrecompiledNet;
  /**
   * SHA-256 (hex) of the canonical structural description: nodes in canvas order with
   * their shapes, deduplicated connections, classified references, start node, compile
   * profile. Equal hashes compile to structurally identical nets and programs. The budget is
   * not part of it: it only affects `initialMarking`.
   */
  readonly structuralHash: string;
  readonly netMap: NetMapView;
  /** The graph analysis the net was derived from (SCCs, depths, reachability, edge kinds). */
  readonly analysis: WorkflowAnalysis;
  /** The primary start node (`startNodes[0]`). */
  readonly startNode: string;
  /** Every start node, primary first, then the rest in canvas order. */
  readonly startNodes: readonly string[];
  readonly requestedBudget: number;
  /** `requestedBudget`, or 1 when the k-safety check failed (see `budgetRestriction`). */
  readonly effectiveBudget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  /**
   * Every `ready` place, flat: the join inputs the verifier checks for stranded tokens. This and
   * the next three are v1 collections; each throws `InternalCompilerError` on an `engineV2` net.
   */
  readonly joinInputPlaces: readonly Place<unknown>[];
  /** The same places grouped per join / OR input. */
  readonly joinReadyPlaces: readonly JoinReadyPlaces[];
  /** Every `in-data` / `edge-data` place. */
  readonly edgeDataPlaces: readonly Place<unknown>[];
  /** Every `X/running` place. */
  readonly runningPlaces: readonly Place<unknown>[];
  /** Non-fatal findings: ignored references, deduplicated connections, dead joins, unguarded references. */
  readonly diagnostics: readonly string[];
  /**
   * The initial marking for one execution (CORE-072): `_budget` × k, `X/idle` × 1 per node,
   * `X/free_i` × 1 per join input whose slot is not pre-filled, `X/tries` × (maxTries − 1)
   * per retry node, one `empty` token on the `ready` place of every join input fed only by
   * nodes unreachable from the start node (one per unreachable edge on an OR input),
   * `Y/skipped` for every referenced node unreachable from the start node, and
   * `triggerItems` on the start node's `in` place (n8n runs the start node itself from
   * `nodeExecutionStack[0]`; a webhook node passes its input through). A pre-filled
   * `ready_i` slot keeps its `free_i` token withheld, so `free_i + ready_i ≤ 1` holds from
   * the first marking on.
   *
   * An `engineV2` net's initial marking is one unit on the trigger's `T/in` and nothing else
   * (`tasks/v2-profile-plan.md` decision 7). `triggerItems` is not carried: engine v2 keeps the
   * trigger's outputs in the trigger's own row, and the net carries no data (decision 3).
   */
  initialMarking(triggerItems: unknown): Map<Place<unknown>, Token<unknown>[]>;
  /**
   * The execution-independent part of {@link initialMarking}: `_budget` × k, every
   * `X/idle`, every `X/free_i` (including the ones a pre-filled slot would withhold), every
   * `X/tries`, the seeded `empty` tokens of inputs fed only by unreachable producers and
   * the seeded `Y/skipped` markers. No start node is activated: the marking codec layers
   * the decoded `nodeExecutionStack` / `waitingExecution` over it and withholds the
   * `free_i` of every slot it pre-fills.
   *
   * Empty for an `engineV2` net, which seeds nothing before its trigger.
   */
  sharedMarking(): Map<Place<unknown>, Token<unknown>[]>;
  /** The same structure with `binder`'s actions layered over the current ones (CORE-042). */
  withActions(binder: ActionBinder): CompiledWorkflow;
}

export interface CompileOptions {
  /**
   * The engine the net is compiled for (ADR 0012 §1); default `v1`. Under `engineV2` the net has
   * no `_budget` and no agent round, so {@link budget}, {@link maxAgentRounds} and
   * {@link maxAgentToolCalls} are refused beside it, and a precomputed {@link analysis} must
   * carry the same profile.
   */
  readonly profile?: CompileProfile;
  /**
   * `engineV2` only: the trigger that fired (`AnalysisOptions.trigger`). n8n's converter needs
   * it named when a workflow has several triggers. Refused under `v1`, and beside a precomputed
   * {@link analysis} unless it names that analysis's trigger.
   */
  readonly trigger?: string;
  /** Concurrency budget `k` (`_budget` tokens). Default 1. Forced to 1 when the k-safety check fails. */
  readonly budget?: number;
  /**
   * Seed for an agent's `A/rounds` when the adapter could not read `options.maxIterations`
   * statically (an expression). Default `DEFAULT_MAX_AGENT_ROUNDS` — n8n's own default for that
   * parameter. Distinct from {@link budget}: this bounds a round *loop*, the budget bounds
   * *concurrency*.
   */
  readonly maxAgentRounds?: number;
  /**
   * Seed for an agent's `A/calls` when the workflow declares no `options.maxToolCalls`. Default
   * `DEFAULT_MAX_AGENT_TOOL_CALLS`. Unlike {@link maxAgentRounds} this is not a fallback for an
   * n8n bound: n8n has none, so it is the bound.
   */
  readonly maxAgentToolCalls?: number;
  /**
   * `analyse(workflow, …)` already computed by the caller, so a caller that analysed the
   * workflow for its own reasons — a cache key, as `PetriScheduler.compileDescription` does —
   * does not pay for the analysis twice. It must be the analysis of the `workflow` handed to
   * `compile` beside it; nothing re-checks that. The compiled workflow's `analysis` is this very
   * object. The agent budgets are analysis options, so {@link maxAgentRounds} and
   * {@link maxAgentToolCalls} are refused beside it: pass them to `analyse` instead.
   */
  readonly analysis?: WorkflowAnalysis;
  /**
   * `structuralHash(analysis)`, already computed by the caller; taken as given. Only meaningful
   * with {@link analysis}, and refused without it: a hash of some other analysis would key the
   * compiled net under the wrong entry.
   */
  readonly structuralHash?: string;
  /**
   * Actions to bind per transition. A binder that returns `null` leaves the structural
   * placeholder in place, so M2 can bind real actions for the roles it owns and keep the
   * placeholders for purely structural transitions.
   */
  readonly actions?: ActionBinder;
}
