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
import type { ExecutionPolicy, FailureAction } from './policy.js';

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
  /**
   * An agent node's `options.maxIterations` (n8n default 10), the number of tool-call rounds
   * the node itself permits before `checkMaxIterations` throws. Seeds `A/rounds`, so the round
   * loop is *structurally* bounded and its reachability graph is finite.
   *
   * The place never enforces: the node's own counter (`iterationCount`, carried on the request
   * metadata and round-tripped by `collectSubNodeResults`) still decides. Seed exactly this many
   * and `A/rounds` cannot bind before n8n's check does. `undefined` on an agent whose parameter
   * is an expression the adapter could not read statically — the compiler then falls back to its
   * configured cap and marks the agent unbounded for verification.
   */
  readonly maxRounds?: number;
  /**
   * An agent's tool-call budget for the whole execution: seeds `A/calls`, consumed one unit per
   * dispatched tool call and refunded by nothing. n8n has no such bound — `maxIterations` caps
   * rounds, and a model may request any number of calls in one — so this one is the
   * scheduler's, read from `options.maxToolCalls` when a workflow declares it and otherwise
   * from `CompileOptions.maxAgentToolCalls`.
   *
   * It is what makes an agent workflow *verifiable* at all: the number of tool calls a round
   * dispatches is a count, an `Out` branch cannot express a count, and the state-class graph
   * would otherwise explore one call in flight where the executor reaches many. Consumed one
   * unit per firing of `A_dispatch`, the count becomes a path length, which the graph sees.
   */
  readonly maxToolCalls?: number;
  /**
   * The node's declared behaviour (ADR 0009): attempt-indexed failure handling, a per-attempt
   * deadline, admission and rate. Already merged from node, group and workflow scope by
   * whichever adapter produced this description — the compiler receives one resolved policy
   * and does not know the scopes it came from.
   *
   * `onFailure` and n8n's `retryOnFail` / `onError` are mutually exclusive: the two express the
   * same thing at different resolutions, and `analyse()` rejects a node carrying both rather
   * than picking a precedence a workflow author cannot see.
   */
  readonly executionPolicy?: ExecutionPolicy;
}

/** One `main` connection `from.outputIndex → to.inputIndex`, by node name. */
export interface MainConnection {
  readonly from: string;
  readonly outputIndex: number;
  readonly to: string;
  readonly inputIndex: number;
}

/**
 * One `ai_tool` connection, by node name. n8n wires these *from* the tool *to* the agent
 * (`connectionsBySourceNode[tool].ai_tool` lists the agent), which is the direction the names
 * here keep.
 *
 * This is the only non-`main` connection type the scheduler ever sees. Every other `ai_*` type
 * (`ai_languageModel`, `ai_memory`, `ai_outputParser`, …) is resolved by `supplyData` *inside*
 * `runNode` and never reaches a scheduler, so the compiler is right not to model it.
 */
export interface ToolConnection {
  /** The agent node the tool is wired into: the `EngineRequest` it answers comes from here. */
  readonly agent: string;
  /** The tool node, dispatched by name in an `ExecutionNodeAction`. */
  readonly tool: string;
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
  /**
   * `ai_tool` connections (README "Agent tool dispatch"). Absent or empty on a workflow with no
   * agent, which is every workflow the compiler saw before M7 — the shape is additive.
   */
  readonly toolConnections?: readonly ToolConnection[];
  /**
   * Names of the nodes the execution starts from, first the primary one (n8n's
   * `nodeExecutionStack[0]`, whose `X/in` receives the trigger data in `initialMarking`).
   * A resumed execution lists every node on `nodeExecutionStack` plus every node with
   * `runData`, so it is compiled from what already ran: depth is the longest path from any
   * start node in the SCC condensation, and reachability (unreachable-input seeding,
   * expression-reference classification) is from the union. Part of the structural hash.
   * At least one of `startNodes` / `startNode` is required.
   */
  readonly startNodes?: readonly string[];
  /** One-element alias of {@link startNodes}. */
  readonly startNode?: string;
  readonly nodeTypes: NodeTypeResolver;
  /**
   * Anything the producer of this description already decided to report — a policy at an
   * unknown schema version, an ignored key. `analyse()` seeds its own diagnostics with these,
   * so a finding made while reading the workflow reaches the same report as one made while
   * analysing it.
   */
  readonly diagnostics?: readonly string[];
  readonly expressionReferences?: ExpressionReferences;
}

export interface CompileOptions {
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
 * - `run`: the node action, which routes every output in its own `Out` spec unless the node
 *   has more than {@link SPLIT_ROUTING_ABOVE} connected outputs; `route`: per-output
 *   routing under that split shape only (one per connected output, carrying `port`);
 *   `done`: the `X_done` that refunds the budget once the outcome is routed — **every**
 *   node has one, which is what puts the refund one scheduling cycle after the edge tokens;
 * - `skip`: an empty activation; `arm`: an edge arrival of a join / OR input; `clear`:
 *   the OR-input round closer (a genuine sink, CORE-043 AC4);
 * - `retry` (`X_retry_wait`), `exhausted`, `sink` (`nil` drain);
 * - `attempt`: one step of a declared `onFailure` policy (ADR 0009). It is what `retry` and
 *   `exhausted` become when the allowance is a chain rather than a counter: the *i*-th step
 *   consumes `X/failed_i` and either escalates to `X/running_{i+1}` or takes a terminal arm;
 * - `deadline`: the funnel that turns an expired per-attempt deadline (`X/timedout_i`) into the
 *   ordinary failure (`X/failed_i`), so one step answers both.
 */
export type TransitionRole =
  | 'start' | 'start-unmet' | 'run' | 'route' | 'done' | 'skip' | 'arm' | 'clear' | 'retry' | 'exhausted'
  | 'sink' | 'attempt' | 'deadline'
  | 'done-request' | 'dispatch' | 'collect' | 'resume' | 'rounds-out' | 'calls-out';

/**
 * Place roles. Besides the per-node gadget places (README "Per-node gadget"):
 * - `waiting`: the node put the execution to wait (n8n `waitTill`) and must re-run on
 *   resume; the token carries the node's input `executionData` (n8n's `pushExecutionStack`);
 * - `stopped`: the destination node ran and its successors must not be enqueued (or the
 *   execution was cancelled before the node ran); never routed;
 * - `pause`: the shared control terminal `_pause` a `waiting` / `stopped` outcome deposits.
 *   Every start, start-unmet and retry-wait inhibits on it; routes, skips, arms, clears,
 *   done and exhausted do not, so a paused net drains its structural transitions and
 *   quiesces with every token on an in / ready / hasdata / waiting place.
 *
 * The agent round adds its own (README "Agent tool dispatch"). `in-tool`, `queue`, `drained`,
 * `outstanding` and `dispatched` are **a round in flight**: a net that quiesces holding one of
 * them has a tool call or a re-entry the codec must write back, so they join the codec's rest
 * set inside a designed terminal exactly as `in-data` and `ready` do. `rounds` and `calls` are
 * budgets, consumed like `_budget` and never pending.
 *
 * A declared `onFailure` policy adds `failed` (ADR 0009): `X/failed_i` holds the *i*-th
 * attempt's failure until its step acts on it. It is `retry`'s analogue and classifies like it
 * — pending work, so a quiescent marking holding one is a stranding unless the class is a
 * designed terminal, where the codec writes it back.
 */
export type PlaceRole =
  | 'in-data' | 'in-empty' | 'edge-data' | 'edge-empty' | 'nil' | 'ready' | 'hasdata' | 'ran' | 'free'
  | 'idle' | 'running' | 'ok' | 'routed' | 'done' | 'skipped' | 'retry' | 'tries' | 'waiting' | 'stopped'
  | 'budget' | 'halt' | 'pause' | 'failed'
  | 'in-tool' | 'routed-request' | 'queue' | 'drained' | 'outstanding' | 'response'
  | 'dispatched' | 'rounds' | 'calls';

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
  /** Full transition name in the flat net (`nodeId/start`, `nodeId/run`, …). */
  readonly name: string;
  readonly role: TransitionRole;
  /** Owning node name; every transition of the flat net belongs to one. */
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
  /**
   * 1-based attempt an `onFailure` chain's transition serves (ADR 0009): the `run` of attempt
   * *i*, the step that answers its failure, or the funnel that turns its expired deadline into
   * that failure.
   */
  readonly attempt?: number;
}

export interface PlaceInfo {
  readonly name: string;
  readonly role: PlaceRole;
  /** Owning node name; `null` for `_budget`, `_halt`, `_pause`. Edge places belong to their consumer. */
  readonly node: string | null;
  /** Input index for input-side places, output index for `nil` / `ok_o` / `routed_o`; `null` otherwise (`X/routed` included). */
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
 * - `choose-branch`: a join whose `requiredInputs` lists inputs that must carry data;
 * - `tool`: the node is dispatched by an agent over `ai_tool`, never by a `main` producer. Its
 *   input side is a single `T/in_tool` an agent's `A_dispatch` writes, and its success branch
 *   deposits the agent's `A/response` instead of edge tokens. Everything between those two ends
 *   — start, run, retry, halt, wait, stop, done — is the ordinary gadget.
 */
export type JoinForm = 'direct' | 'or' | 'join' | 'choose-branch' | 'tool';

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
  /** `X/ok_o` under per-output routing; `null` when `X_run` routes this output in its own spec. */
  readonly ok: Place<unknown> | null;
  /** `X/routed_o` under per-output routing; `null` when `X_run` routes (see `NodeGadget.routed`). */
  readonly routed: Place<unknown> | null;
}

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
export interface AttemptGadget {
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
  /** What the step answering this attempt's failure does. */
  readonly action: FailureAction;
  /** `retry` only: the delay before the next attempt. */
  readonly waitMs: number | null;
  /** `route` only: the connected output the failure takes. */
  readonly outputIndex: number | null;
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
  /** Reachable from the union of start nodes. */
  readonly reachable: boolean;
  /** The primary start node (`startNodes[0]`): `initialMarking` seeds its own input. */
  readonly isStart: boolean;
  /** One of the start nodes (primary or not). */
  readonly isStartNode: boolean;
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
  /**
   * `X/routed`: the marker `X_run` writes in the same firing as the edge tokens and
   * `X_done` consumes one scheduling cycle later to refund `_budget` (ADR 0004). `null`
   * when the node routes per output — use `outputs[*].routed`.
   */
  readonly routed: Place<unknown> | null;
  /**
   * True when the node routes per connected output through `X/ok_o` → `X_route_o` →
   * `X/routed_o` → `X_done`, i.e. when it has more than {@link SPLIT_ROUTING_ABOVE}
   * connected outputs. False when `X_run` routes every output in its own `Out` spec and
   * marks the single `X/routed`.
   */
  readonly splitRouting: boolean;
  readonly done: Place<unknown>;
  /** Present iff the node has a skip transition or is referenced (the reference twin reads it). */
  readonly skipped: Place<unknown> | null;
  /** Generic join only: the slot-wide "at least one non-empty" counter. */
  readonly hasdata: Place<unknown> | null;
  readonly retry: Place<unknown> | null;
  readonly tries: Place<unknown> | null;
  /**
   * The `onFailure` chain, one entry per attempt, ascending (ADR 0009). Empty when the node
   * declares no policy, in which case `retry` / `tries` carry n8n's own `retryOnFail` — the two
   * are mutually exclusive and `analyse()` rejects a node carrying both.
   *
   * `attempts[0].running` **is** {@link NodeGadget.running}: the first attempt is the ordinary
   * run, so `X_start` is unchanged and a policy-free node compiles byte-identically.
   */
  readonly attempts: readonly AttemptGadget[];
  /** `executionPolicy.timeoutMs`: the per-attempt deadline (IO-013). `null` when undeclared. */
  readonly attemptTimeoutMs: number | null;
  /** `X/waiting`: the node put the execution to wait (PlaceRole `waiting`). */
  readonly waiting: Place<unknown>;
  /** `X/stopped`: the destination-node stop, or a cancellation before the run (PlaceRole `stopped`). */
  readonly stopped: Place<unknown>;
  /**
   * `T/in_tool` (`tool` form): the dispatch place an agent's `A_dispatch` writes, carrying the
   * `IExecuteData` n8n's own `addNodeToBeExecuted` built for this action. `null` on every other
   * form.
   */
  readonly inTool: Place<unknown> | null;
  /**
   * The agent side, all `null` unless the node has at least one `ai_tool` producer. This is
   * `references/patterns.md` §5 ("fan-out and join with pending markers"): `routedReq` phases
   * the budget refund as `routed` does, `queue` carries the undispatched actions, `pending`
   * counts them structurally so no action decides "am I the last one", `outstanding` is the
   * pattern's `JOB_PENDING`, `dispatched` its `ROUTING_DONE`, and `rounds` bounds the loop.
   *
   * There is no accumulator for collected responses on purpose: `A_collect` consumes
   * `outstanding` when it fires and would deposit on completion, so `A_resume` could drain
   * n − 1 markers inside that window and leak one into the next round
   * (`tests/spikes/agent-round.test.ts` measured it). `A_collect` produces nothing instead.
   */
  readonly routedRequest: Place<unknown> | null;
  /** `A/queue`: one token carrying the actions not yet dispatched, plus the agent's resume entry. */
  readonly queue: Place<unknown> | null;
  /**
   * `A/calls`: the tool-call budget, seeded with `maxToolCalls` and consumed one unit per
   * `A_dispatch`. Refunded by nothing, so it is monotonically decreasing — which is what keeps
   * the reachability graph finite, and what lets it explore every round size up to the budget:
   * the count is the number of dispatch firings, not a token deposit.
   */
  readonly calls: Place<unknown> | null;
  /**
   * `A/drained`: the round has nothing left to dispatch. Written by `A_done_req` for an empty
   * request and by `A_dispatch` when it takes the last action off the queue; consumed by
   * `A_resume`. The queue token and this marker are exclusive.
   */
  readonly drained: Place<unknown> | null;
  /** `A/outstanding`: one unit token per dispatched, uncollected action. */
  readonly outstanding: Place<unknown> | null;
  /** `A/response`: one token per tool that finished, deposited by the tool's own `T_done`. */
  readonly response: Place<unknown> | null;
  /** `A/dispatched`: the round is open and fully dispatched; carries the agent's resume entry. */
  readonly dispatched: Place<unknown> | null;
  /** `A/rounds`: the round budget, seeded with `maxRounds` units and consumed one per `A_resume`. */
  readonly rounds: Place<unknown> | null;
  /** Tool nodes this agent may dispatch, in `A_dispatch`'s `xor` branch order. */
  readonly tools: readonly string[];
  /** Agents that may dispatch this tool (`tool` form); empty otherwise. */
  readonly agents: readonly string[];
  /** `maxRounds` as compiled: the seed of `A/rounds`. `null` when the node is not an agent. */
  readonly maxRounds: number | null;
  /** True when `maxRounds` came from a configured fallback rather than the workflow JSON. */
  readonly roundsAssumed: boolean;
  /** `maxToolCalls` as compiled: the seed of `A/calls`. `null` when the node is not an agent. */
  readonly maxToolCalls: number | null;
  /** True when `maxToolCalls` is the scheduler's default rather than a value the workflow declared. */
  readonly toolCallsAssumed: boolean;
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
  /** The primary start node (`startNodes[0]`). */
  readonly startNode: string;
  /** Every start node, primary first, then the rest in canvas order. */
  readonly startNodes: readonly string[];
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
  /**
   * The execution-independent part of {@link initialMarking}: `_budget` × k, every
   * `X/idle`, every `X/free_i` (including the ones a pre-filled slot would withhold), every
   * `X/tries`, the seeded `empty` tokens of inputs fed only by unreachable producers and
   * the seeded `Y/skipped` markers. No start node is activated: the marking codec layers
   * the decoded `nodeExecutionStack` / `waitingExecution` over it and withholds the
   * `free_i` of every slot it pre-fills.
   */
  sharedMarking(): Map<Place<unknown>, Token<unknown>[]>;
  /** The same structure with `binder`'s actions layered over the current ones (CORE-042). */
  withActions(binder: ActionBinder): CompiledWorkflow;
}
