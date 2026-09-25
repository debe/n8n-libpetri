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
  /**
   * What engine v2 reads from a Split In Batches node (`tasks/v2-profile-plan.md` decision 11):
   * `toBatchConfig` (`node-engine-compatibility` `v1-workflow-converter.ts`) builds a batch
   * step's config from it, or refuses the node. The adapters fill it for every node of type
   * `n8n-nodes-base.splitInBatches`, whatever its version; absent, the node's parameters were
   * not read, and n8n's defaults apply (`DEFAULT_BATCH_SIZE`, no options). Only an `engineV2`
   * compile reads it, and it is not part of the structural hash: whether a node is v2's `batch`
   * step is decided by `type` and `typeVersion` (decision 5), and the batch size changes no
   * place or transition — a loop is folded, so the number of passes is data, not structure
   * (decision 6).
   */
  readonly batch?: BatchDescription;
  /**
   * A Merge node's `parameters.mode` as written, when it is a string (an expression starts
   * with `=`); `null` when the parameters were read and the mode is absent or not a string;
   * absent when they were not read, or the node is no Merge. Engine v2 refuses mode
   * `chooseBranch`, and an expression mode from typeVersion 2 on (`assertSupportedMergeMode`,
   * `v1-workflow-converter.ts`). Both adapters set it on every Merge; a description without it
   * on a Merge is read by the node's `requiredInputs` instead (`analysis/engine-v2/nodes.ts`).
   * Only an `engineV2` compile reads it; not hashed, since it decides a refusal, never a place.
   */
  readonly mergeMode?: string | null;
  /**
   * The version `assertSupportedMergeMode` compares with `>= 2`, when the node's `typeVersion`
   * as written is not a number: n8n compares the raw value, which JavaScript converts to a
   * number (`'3'` is 3 there, a missing version `NaN`), where the JSON reader reads a version
   * that is not a number as 1. Absent when the written version is a number, or the node is no
   * Merge. Only an `engineV2` compile reads it; not hashed.
   */
  readonly mergeVersion?: number;
  /**
   * The connection types other than `main` this node is the **source** of, as n8n's
   * connections-by-source map keys them (`ai_tool`, `ai_languageModel`, …), plus the `type` of
   * any connection filed under `main` that is not `main` itself. Engine v2's converter refuses
   * every one of them on a node the fired trigger reaches (`UnsupportedConnectionTypeError`,
   * `toEdgesForSource`): it validates each type key of the source, empty or not. Only an
   * `engineV2` compile reads it; not hashed.
   */
  readonly aiOutputs?: readonly string[];
}

/**
 * A batch node's configuration as engine v2 sees it: the inputs of `toBatchConfig`
 * (`node-engine-compatibility` `v1-workflow-converter.ts`), which builds `BatchStepConfig`
 * (`@n8n/engine` `graph/workflow-graph.ts`) from the node's parameters or refuses it. The
 * version `toBatchConfig` checks first is {@link NodeDescription.typeVersion}.
 */
export interface BatchDescription {
  /**
   * `parameters.batchSize ?? DEFAULT_BATCH_SIZE`: items per pass. A number as written (the
   * converter accepts a whole number ≥ 1, `isBatchStepConfig`); `'expression'` when the
   * parameter is a string, which `toBatchConfig` refuses whatever it says; `NaN` for any other
   * value, which it refuses as not a whole number.
   */
  readonly batchSize: number | 'expression';
  /** `parameters.options` is a string (an expression), which `toBatchConfig` refuses. */
  readonly optionsExpression?: boolean;
  /**
   * `parameters.options.reset` is set to anything but `false` — `true`, or an expression —
   * which `toBatchConfig` refuses: each pass slices a list fixed at the first pass.
   */
  readonly reset?: boolean;
}

/**
 * What n8n's connections-by-source map holds beyond {@link WorkflowDescription.connections}, for
 * the `engineV2` converter port: n8n's `rootAt` walks the map by name (`getChildNodes`), so a
 * node reached only through one of these is in n8n's graph, and `toEdgesForSource` checks the
 * connection types of every source it keeps, node or not.
 */
export interface StrayConnections {
  /**
   * Every `from → to` under a `main` key that `connections` cannot hold, in map order: a source
   * or a target that names no node of the workflow, or a connection whose own `type` is not
   * `main`. The walk follows each one; no edge comes of it.
   */
  readonly main: readonly { readonly from: string; readonly to: string }[];
  /**
   * The map's keys that name no node, each with the connection types other than `main` its entry
   * lists (as {@link NodeDescription.aiOutputs} counts them), in map order.
   */
  readonly sources: readonly { readonly name: string; readonly aiOutputs: readonly string[] }[];
}

/** One `main` connection `from.outputIndex → to.inputIndex`, by node name. */
export interface MainConnection {
  readonly from: string;
  readonly outputIndex: number;
  readonly to: string;
  readonly inputIndex: number;
  /**
   * `engineV2` only, and only when the export's `index` is not a number (`inputIndex` is then
   * `NaN`): the index as n8n's `dedupeEdges` prints it into its key, `String(index)`. n8n copies
   * the index as written, so `'0'` and `0` on one `from → to` output are one key to it, and the
   * later of the two is the edge it keeps. Read by the converter port's dedupe only.
   */
  readonly indexKey?: string;
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
   * `engineV2` only: the connections n8n's converter walks or checks that {@link connections}
   * cannot hold (a name that is no node, a `main` connection of another type). The JSON reader
   * sets it under `engineV2`; absent means there are none. Not hashed: it decides which nodes
   * the converter keeps and what it refuses, and the compiled net is built from those.
   */
  readonly strayConnections?: StrayConnections;
  /**
   * Names of the nodes the execution starts from, first the primary one (n8n's
   * `nodeExecutionStack[0]`, whose `X/in` receives the trigger data in `initialMarking`).
   * A resumed execution lists every node on `nodeExecutionStack` plus every node with
   * `runData`, so it is compiled from what already ran: depth is the longest path from any
   * start node in the SCC condensation, and reachability (unreachable-input seeding,
   * expression-reference classification) is from the union. Part of the structural hash.
   * At least one of `startNodes` / `startNode` is required, except under `engineV2` (see
   * {@link startNode}).
   */
  readonly startNodes?: readonly string[];
  /**
   * One-element alias of {@link startNodes}.
   *
   * Under the `engineV2` profile the start node is the name of the trigger that fired —
   * `firedTriggerName` of n8n's `V1WorkflowConverter.convert` — and may be left out, as
   * `CompileOptions.trigger` may: the compiler then takes the workflow's one trigger, and refuses
   * a workflow with several, as the converter does (`analysis/engine-v2/root.ts`).
   */
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
