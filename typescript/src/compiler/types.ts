/**
 * Structural input and compiled output of the n8n → libpetri compiler.
 *
 * The compiler never sees n8n. It takes a {@link WorkflowDescription} — nodes, main
 * connections, the start node, a node-type resolver and an optional expression-reference
 * resolver — and produces one flat libpetri `PetriNet` per workflow (MOD-023) together with
 * the maps the scheduler, the marking codec and the verifier need.
 *
 * Building a `WorkflowDescription` from an `n8n-workflow` `Workflow` object is milestone
 * M2's adapter: `INode` JSON supplies {@link NodeDescription}, `NodeHelpers.getNodeInputs`
 * / `getNodeOutputs` (evaluated against the node's parameters) supply {@link NodeTypeShape},
 * `connectionsBySourceNode[*].main` supplies {@link MainConnection}, and
 * `node-reference-parser-utils` supplies {@link ExpressionReferences}. The shapes below are
 * what that adapter must produce; nothing here imports n8n.
 */
import type { PetriNet, Place, PrecompiledNet, Token, Transition, TransitionAction } from 'libpetri';
import type { WorkflowAnalysis } from './graph.js';

/** n8n `INode.onError`. `undefined` on a node means `'stopWorkflow'`. */
export type OnError = 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';

/** One n8n node, structurally. Mirrors the `INode` fields the compiler reads. */
export interface NodeDescription {
  /**
   * n8n `INode.id`. Used as the subnet instance prefix (MOD-010), so every place and
   * transition of this node's gadget is named `id/…`. Must be unique and must not contain
   * `/` (the prefix separator reserved by MOD-010).
   */
  readonly id: string;
  /**
   * n8n `INode.name`: the key of `connections`, `runData` and `$('name')`. Unique per
   * workflow. This is the name `NetMap` speaks.
   */
  readonly name: string;
  readonly type: string;
  readonly typeVersion: number;
  /** Canvas position `[x, y]` (`INode.position`). Declaration order is `(y, x)` ascending. */
  readonly position: readonly [number, number];
  /** n8n `INode.disabled`. Structurally identical; M2 binds n8n's pass-through action. */
  readonly disabled?: boolean;
  readonly onError?: OnError;
  /** n8n `retryOnFail`. Adds the retry gadget (`X/retry`, `X/tries`, `X_retry_wait`, `X_exhausted`). */
  readonly retryOnFail?: boolean;
  /**
   * n8n `maxTries`, read exactly as `WorkflowExecute.getRetryParams` reads it:
   * `min(5, max(2, maxTries || 3))`. Values outside `[2, 5]` are clamped, `0` / `undefined`
   * mean 3; nothing is rejected. A node resuming with `metadata.resumeError` gets no retry
   * in n8n (`[1, 0]`); that is decided by M2's action, not by the gadget.
   */
  readonly maxTries?: number;
  /** n8n `waitBetweenTries` in milliseconds, read as `min(5000, max(0, waitBetweenTries || 1000))`. */
  readonly waitBetweenTries?: number;
}

/** One `main` connection `from.outputIndex → to.inputIndex`, by node name. */
export interface MainConnection {
  readonly from: string;
  readonly outputIndex: number;
  readonly to: string;
  readonly inputIndex: number;
}

/**
 * What the compiler needs from a node type. Resolved per node because n8n evaluates
 * dynamic `inputs` / `outputs` expressions against the node's parameters.
 */
export interface NodeTypeShape {
  /** Number of `main` inputs. */
  readonly inputCount: number;
  /**
   * Number of declared `main` outputs of the node type, **excluding** the error output
   * n8n appends under `onError: 'continueErrorOutput'` (`node-helpers.ts`,
   * `getNodeOutputs`). The compiler appends that output itself at index `outputCount`, so
   * the error output is always the last index, as in n8n.
   */
  readonly outputCount: number;
  /**
   * n8n `requiredInputs`, already evaluated (`'={{ … }}'` expressions depend on
   * `$parameter` only). Read as R6 reads it (`workflow-execute.ts`):
   * - an array of length `inputCount`, or the number `inputCount`: every input must carry
   *   data (Merge chooseBranch); the data/empty combinations are enumerated explicitly;
   * - a shorter non-empty array (Merge v3 chooseBranch with extra inputs): data on exactly
   *   the listed inputs, data-or-empty on the rest;
   * - a smaller number, `[]` or `undefined`: the generic join ("every input arrived, at
   *   least one non-empty").
   */
  readonly requiredInputs?: number | readonly number[];
  /**
   * Informational: marks Loop Over Items. The emission rule is decided by the SCC
   * decomposition of the connection graph, not by this flag; it is carried into `NetMap`.
   */
  readonly loopNode?: boolean;
  /** Display names of the outputs, for `NetMap` labels only. */
  readonly outputNames?: readonly string[];
}

export type NodeTypeResolver = (node: NodeDescription) => NodeTypeShape;

/**
 * Names of the nodes a node's parameters reference through `$('X')` / `$node['X']`. How a
 * reference compiles depends on where the referenced node sits (README "Expression
 * references"): a read arc on `Y/done` plus an `X_start_unmet` twin reading `Y/skipped`
 * when `Y` is reachable from the start node avoiding `X`, the same arcs with `Y/skipped`
 * seeded when `Y` is unreachable, and no arc (a diagnostic) when `Y` is reachable only
 * through `X`.
 */
export type ExpressionReferences = (node: NodeDescription) => readonly string[];

/** The structural description of one workflow. */
export interface WorkflowDescription {
  readonly id?: string;
  readonly name?: string;
  readonly nodes: readonly NodeDescription[];
  readonly connections: readonly MainConnection[];
  /** Name of the node the execution starts at (n8n's `startNode`, `nodeExecutionStack[0]`). */
  readonly startNode: string;
  readonly nodeTypes: NodeTypeResolver;
  readonly expressionReferences?: ExpressionReferences;
}

export interface CompileOptions {
  /** Concurrency budget `k` (`_budget` tokens). Default 1. Forced to 1 when the k-safety check fails. */
  readonly budget?: number;
  /**
   * Actions to bind per transition. A binder that returns `null` leaves the structural
   * placeholder in place, so M2 can bind real actions for the roles it owns and keep the
   * placeholders for purely structural transitions.
   */
  readonly actions?: ActionBinder;
}

// ==================== NetMap vocabulary ====================

/**
 * Transition roles of the per-node gadget (README "Per-node gadget", ADR 0004):
 * - `start` / `start-unmet`: `X_start` and its per-reference twin that fires when the
 *   referenced node was skipped (the running token then carries the unmet reference);
 * - `run`: the node action; `route`: per-edge routing (one per node, or one per connected
 *   output above {@link SPLIT_ROUTING_ABOVE} outputs, carrying `port`); `done`: the
 *   split-routing `X_done` that refunds the budget once every output is routed;
 * - `skip`: an empty activation; `arm`: an edge arrival of a join / OR input; `clear`:
 *   the OR-input round closer (a genuine sink, CORE-043 AC4);
 * - `retry` (`X_retry_wait`), `exhausted`, `sink` (`nil` drain), `reap` (`_halt_reap`).
 */
export type TransitionRole =
  | 'start' | 'start-unmet' | 'run' | 'route' | 'done' | 'skip' | 'arm' | 'clear' | 'retry' | 'exhausted'
  | 'sink' | 'reap';

export type PlaceRole =
  | 'in-data' | 'in-empty' | 'edge-data' | 'edge-empty' | 'nil' | 'ready' | 'hasdata' | 'ran' | 'free'
  | 'idle' | 'running' | 'ok' | 'routed' | 'done' | 'skipped' | 'retry' | 'tries' | 'budget' | 'halt' | 'halted';

/** `tree`: the two ends are in different SCCs; `cycle`: both ends share one SCC. */
export type EdgeKind = 'tree' | 'cycle';

/** `data` / `empty` variant of an arm, a ready place or an enumerated join combination. */
export type Variant = 'data' | 'empty';

/** One (deduplicated) main connection with its SCC classification. */
export interface EdgeRef {
  /** Stable index of the edge in canonical order (producer canvas index, output, consumer canvas index, input). */
  readonly id: number;
  readonly from: string;
  readonly outputIndex: number;
  readonly to: string;
  readonly inputIndex: number;
  readonly kind: EdgeKind;
}

export interface TransitionInfo {
  /** Full transition name in the flat net (`nodeId/start`, …, `_halt_reap`). */
  readonly name: string;
  readonly role: TransitionRole;
  /** Owning node name; `null` for the host-level `_halt_reap`. */
  readonly node: string | null;
  /** Output index of a per-output `route`; input index of a `clear`. */
  readonly port?: number;
  /** The edge an `arm` transition serves. */
  readonly edge?: EdgeRef;
  /** `data` / `empty` for an `arm`. */
  readonly variant?: Variant;
  /** Per-input variants of an enumerated (chooseBranch) `skip` transition, listed inputs only. */
  readonly combination?: readonly Variant[];
  /** The referenced node a `start-unmet` twin reports as unmet. */
  readonly reference?: string;
}

export interface PlaceInfo {
  readonly name: string;
  readonly role: PlaceRole;
  /** Owning node name; `null` for `_budget`, `_halt`, `_halted`. Edge places belong to their consumer. */
  readonly node: string | null;
  /** Input index for input-side places, output index for `nil` / `ok_o` / `routed_o`; `null` otherwise. */
  readonly port: number | null;
  /** The canonical `Place` object of the flat net. */
  readonly place: Place<unknown>;
  /** The edge an edge/in place carries (absent for a synthetic `in`). */
  readonly edge?: EdgeRef;
  /** `data` / `empty` for an enumerated join's `ready` places. */
  readonly variant?: Variant;
}

/**
 * How a node's input side is compiled:
 * - `direct`: at most one producer edge (README "Per-node gadget");
 * - `or`: one input index with several empty-capable producer edges (README "OR-inputs");
 * - `join`: several inputs, or an input with several producers of which at most one can
 *   carry an empty (README "Join gadget");
 * - `choose-branch`: a join whose `requiredInputs` lists inputs that must carry data.
 */
export type JoinForm = 'direct' | 'or' | 'join' | 'choose-branch';

/** The host-level edge places of one connection, owned by the consumer. */
export interface EdgeSlot {
  readonly edge: EdgeRef;
  readonly data: Place<unknown>;
  /** Present for tree edges only: cycle edges carry no empty token (README emission rule). */
  readonly empty: Place<unknown> | null;
}

export interface InputGadget {
  readonly index: number;
  /** Producer edges, canonical order. Empty for a dead (unwired, required) input. */
  readonly edges: readonly EdgeSlot[];
  /** Has at least one producer edge. A dead input never receives a token (README join gadget). */
  readonly wired: boolean;
  /** Must carry data for `X_start` (all-required node, or listed in `requiredInputs`). */
  readonly required: boolean;
  /** `X/free_i` (join and choose-branch forms); `null` for the OR form, which has no slots. */
  readonly free: Place<unknown> | null;
  /**
   * `X/ready_i`: the single ready place of a generic join input, a choose-branch input that
   * is not required, or the OR form's round counter; `null` for a required choose-branch input.
   */
  readonly ready: Place<unknown> | null;
  /** `X/ready_i_data` (required choose-branch input); `null` otherwise. */
  readonly readyData: Place<unknown> | null;
  /** `X/ready_i_empty` (required choose-branch input that can receive an empty); `null` otherwise. */
  readonly readyEmpty: Place<unknown> | null;
  /** `X/hasdata_i` (OR form): one token per data arrival, carrying the payload. */
  readonly hasdata: Place<unknown> | null;
  /** `X/ran_i` (OR form): one token per run of the current round. */
  readonly ran: Place<unknown> | null;
  /** OR form: the number of empty-capable producer edges, one delivery each per round. */
  readonly round: number | null;
  /** An `empty` token can arrive on this input (some producer edge is a tree edge). */
  readonly emptyCapable: boolean;
  /** True when every producer of this input is unreachable from the start node: seeded empty. */
  readonly seedEmpty: boolean;
  /** Tree edges whose producer is unreachable from the start node (the OR form seeds one empty each). */
  readonly unreachableEdges: number;
}

export interface OutputGadget {
  readonly index: number;
  readonly name: string | null;
  readonly isErrorOutput: boolean;
  readonly edges: readonly EdgeSlot[];
  /** `X/nil_o` for a producer inside a cycle; `null` for an acyclic producer. */
  readonly nil: Place<unknown> | null;
  /** `X/ok_o` under split routing (more than {@link SPLIT_ROUTING_ABOVE} connected outputs); `null` otherwise. */
  readonly ok: Place<unknown> | null;
  /** `X/routed_o` under split routing; `null` otherwise. */
  readonly routed: Place<unknown> | null;
}

export interface NodeGadgetTransitions {
  readonly start: string;
  /** One `X_start_unmet_k` per reference that carries a read arc, in reference order. */
  readonly startUnmet: readonly string[];
  readonly run: string;
  /** The single `X_route`, or one `X_route_o` per connected output under split routing (ascending index). */
  readonly routes: readonly string[];
  /** `X_done` under split routing; `null` otherwise. */
  readonly done: string | null;
  readonly skip: readonly string[];
  readonly arms: readonly string[];
  /** `X_clear` per OR-form input. */
  readonly clear: readonly string[];
  readonly retryWait: string | null;
  readonly exhausted: string | null;
  readonly sinks: readonly string[];
}

/** Everything the scheduler needs to drive one node's gadget. */
export interface NodeGadget {
  readonly node: string;
  readonly id: string;
  readonly type: string;
  readonly typeVersion: number;
  readonly disabled: boolean;
  readonly loopNode: boolean;
  readonly form: JoinForm;
  /** Longest path from the start node in the SCC condensation; `X_start` priority. */
  readonly depth: number;
  readonly cyclic: boolean;
  readonly reachable: boolean;
  readonly isStart: boolean;
  readonly onError: OnError;
  readonly retryOnFail: boolean;
  /** n8n's clamped `maxTries` (`[2, 5]`) when `retryOnFail`; `null` otherwise. */
  readonly maxTries: number | null;
  /** n8n's clamped `waitBetweenTries` (`[0, 5000]` ms) when `retryOnFail`; `null` otherwise. */
  readonly waitBetweenTries: number | null;
  /** Direct form: the single in-data place (an edge place, or a synthetic `in`). */
  readonly in: Place<unknown> | null;
  /** Direct form, tree edge: the in-empty place. */
  readonly inEmpty: Place<unknown> | null;
  readonly running: Place<unknown>;
  readonly idle: Place<unknown>;
  /** The routed outcome between `X_run` and `X_route` (ADR 0004); `null` under split routing (see `outputs[*].ok`). */
  readonly ok: Place<unknown> | null;
  /** True when the node has more than {@link SPLIT_ROUTING_ABOVE} connected outputs and routes per output. */
  readonly splitRouting: boolean;
  readonly done: Place<unknown>;
  /** Present iff the node has a skip transition or is referenced (the reference twin reads it). */
  readonly skipped: Place<unknown> | null;
  /** Generic join only: the slot-wide "at least one non-empty" counter. */
  readonly hasdata: Place<unknown> | null;
  readonly retry: Place<unknown> | null;
  readonly tries: Place<unknown> | null;
  /** Inputs the gadget models, ascending index: connected ones plus dead required ones. Empty for the direct form. */
  readonly inputs: readonly InputGadget[];
  /** Connected outputs, ascending index. Unconnected outputs get no places. */
  readonly outputs: readonly OutputGadget[];
  /** Referenced nodes that carry a read arc on their `done` (and a `start-unmet` twin on their `skipped`). */
  readonly references: readonly string[];
  /** Referenced nodes reachable only through this node: no arc, the expression fails inside the action. */
  readonly unguardedReferences: readonly string[];
  readonly transitions: NodeGadgetTransitions;
}

export interface SharedPlaces {
  readonly budget: Place<unknown>;
  readonly halt: Place<unknown>;
  readonly halted: Place<unknown>;
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

/** Read side of `NetMap`, as seen by action binders. */
export interface NetMapView {
  readonly shared: SharedPlaces;
  /** Node gadgets in declaration (canvas) order. */
  readonly nodes: readonly NodeGadget[];
  /** Every transition of the flat net, in declaration order. */
  readonly transitions: readonly TransitionInfo[];
  /** Every place of the flat net. */
  readonly places: readonly PlaceInfo[];
  node(name: string): NodeGadget;
  transition(name: string): TransitionInfo | undefined;
  transitionsOf(node: string): readonly TransitionInfo[];
  transitionFor(node: string, role: TransitionRole, port?: number): TransitionInfo | undefined;
  transitionObject(name: string): Transition;
  place(name: string): PlaceInfo | undefined;
  placesOf(node: string): readonly PlaceInfo[];
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
   * their shapes, deduplicated connections, classified references, start node. Equal
   * hashes compile to structurally identical nets and programs. The budget is not part of
   * it: it only affects `initialMarking`.
   */
  readonly structuralHash: string;
  readonly netMap: NetMapView;
  /** The graph analysis the net was derived from (SCCs, depths, reachability, edge kinds). */
  readonly analysis: WorkflowAnalysis;
  readonly startNode: string;
  readonly requestedBudget: number;
  /** `requestedBudget`, or 1 when the k-safety check failed (see `budgetRestriction`). */
  readonly effectiveBudget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  /** Every `ready` place, flat: the join inputs the verifier checks for stranded tokens. */
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
   */
  initialMarking(triggerItems: unknown): Map<Place<unknown>, Token<unknown>[]>;
  /** The same structure with `binder`'s actions layered over the current ones (CORE-042). */
  withActions(binder: ActionBinder): CompiledWorkflow;
}
