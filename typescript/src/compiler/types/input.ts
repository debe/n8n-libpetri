/**
 * The compiler's input: the structural description of one workflow.
 *
 * The compiler never sees n8n. It takes a {@link WorkflowDescription} — nodes, main
 * connections, the start node, a node-type resolver and an optional expression-reference
 * resolver. Building one from an `n8n-workflow` `Workflow` object is milestone M2's adapter:
 * `INode` JSON supplies {@link NodeDescription}, `NodeHelpers.getNodeInputs` /
 * `getNodeOutputs` (evaluated against the node's parameters) supply {@link NodeTypeShape},
 * `connectionsBySourceNode[*].main` supplies {@link MainConnection}, and
 * `node-reference-parser-utils` supplies {@link ExpressionReferences}. The shapes below are
 * what that adapter must produce; nothing here imports n8n.
 */
import type { ExecutionPolicy } from '../policy.js';

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
