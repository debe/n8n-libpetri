/**
 * What `analyse()` derives from a {@link WorkflowDescription} before any place exists: canvas
 * order, SCCs and edge kinds (the emission rule, ADR 0002), reachability, depth (the `X_start`
 * priority, EXEC-002), classified `$('Y')` references, the input-side form and the resolved
 * failure chain. The gadget and the structural hash read this, never the description.
 */
import type { NodeDescription, NodeTypeShape, OnError, ToolConnection } from './input.js';
import type { EdgeRef } from './netmap.js';

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

/**
 * How one `$('Y')` reference from `X` compiles (README "Expression references"):
 * - `read`: `Y` is reachable from the start node on a path avoiding `X` — `X_start` reads
 *   `Y/done`, the `X_start_unmet` twin reads `Y/skipped`;
 * - `seeded`: `Y` is unreachable from the start node — the same arcs, and `Y/skipped` is
 *   seeded in the initial marking so the reference fails exactly as in n8n;
 * - `unguarded`: `Y` is reachable only through `X` (self, downstream or loop-back) — no
 *   arc; the expression fails inside the action as in n8n.
 */
export type ReferenceKind = 'read' | 'seeded' | 'unguarded';

export interface ResolvedReference {
  readonly node: string;
  readonly kind: ReferenceKind;
}

/** n8n's retry parameters, clamped as `WorkflowExecute.getRetryParams` reads them (see `retryParamsOf`). */
export interface RetryParams {
  readonly maxTries: number;
  readonly waitBetweenTries: number;
}

/** The fields every resolved step carries. */
export interface ResolvedStepCommon {
  /** 1-based: the attempt whose failure this step answers. */
  readonly attempt: number;
}

/** A resolved `retry` step. */
export interface ResolvedRetryStep extends ResolvedStepCommon {
  readonly action: 'retry';
  /** The declared delay, `0` when the step named none. */
  readonly waitMs: number;
  /** The attempt this step escalates to: `attempt + 1`, which the chain guarantees exists. */
  readonly nextAttempt: number;
}

/** A resolved `route` step, its output name resolved to an index. */
export interface ResolvedRouteStep extends ResolvedStepCommon {
  readonly action: 'route';
  /** Always a connected output of the node. */
  readonly outputIndex: number;
}

/** A resolved `stop` / `continue` step. */
export interface ResolvedTerminalStep extends ResolvedStepCommon {
  readonly action: 'stop' | 'continue';
}

/** One attempt's step, discriminated on `action`, with its `route` output resolved to an index. */
export type ResolvedStep = ResolvedRetryStep | ResolvedRouteStep | ResolvedTerminalStep;

/**
 * A node's resolved failure policy: one step per attempt, the last of them terminal.
 *
 * `steps.length` is the number of attempts, so `steps[0]` answers the first run's failure.
 * `timeoutMs` arms libpetri's output timeout (IO-013) on every attempt, and an expired budget
 * lands on the same failure place a thrown error does.
 */
export interface FailureChain {
  readonly steps: readonly ResolvedStep[];
  readonly timeoutMs: number | null;
}

export interface AnalysedNode {
  readonly node: NodeDescription;
  readonly shape: NodeTypeShape;
  /** Position in canvas order ((y, x) ascending): the declaration order of the gadget. */
  readonly index: number;
  /** `shape.outputCount`, plus one for the error output under `continueErrorOutput`. */
  readonly outputCount: number;
  readonly errorOutputIndex: number | null;
  readonly onError: OnError;
  /** The clamped parameters (`retryParamsOf`) of a `retryOnFail` node; `null` when it declares none. */
  readonly retry: RetryParams | null;
  /** Classified expression references (existing nodes), resolver order, no duplicates. */
  readonly references: readonly ResolvedReference[];
  /** `requiredInputs` names every input: every connected input must carry data. */
  readonly allRequired: boolean;
  /**
   * Inputs that must carry data for the node to run: every index below `inputCount` when
   * `allRequired`, the listed indexes for a shorter non-empty array, `null` for the
   * generic join (`undefined`, `[]`, or a number below `inputCount`).
   */
  readonly requiredInputs: readonly number[] | null;
  /**
   * Required inputs with no producer below the highest wired index. n8n pads the lower
   * inputs (`mapConnectionsByDestination`) and never runs such a node; the join gadget
   * models them as inputs that never receive a token.
   */
  readonly deadInputs: readonly number[];
  /**
   * The node is dispatched by an agent over `ai_tool` and has no `main` producer, so it
   * compiles in the `tool` form. A node wired both ways keeps its `main` form and its tool
   * connections are diagnosed and dropped — the agent then has no branch for it and a dispatch
   * naming it fails loudly rather than half-working.
   */
  readonly isTool: boolean;
  /**
   * The input-side gadget (`joinFormOf`), chosen once here. The consumer-owned edge places are
   * named after it (`X/in` for `direct`, per-edge ports otherwise, `names.ts`), so `compile` and
   * the gadget must read this one value: two calls that disagreed would compose a port nothing
   * binds.
   */
  readonly form: JoinForm;
  /** Tool nodes this node may dispatch, canvas order. Non-empty exactly when it is an agent. */
  readonly tools: readonly string[];
  /** Seed of `A/rounds` for an agent; `null` when the node is not an agent. */
  readonly maxRounds: number | null;
  /** `maxRounds` came from the compiler's fallback, not from the workflow: unbounded for verification. */
  readonly roundsAssumed: boolean;
  /** Seed of `A/calls` for an agent; `null` when the node is not an agent. */
  readonly maxToolCalls: number | null;
  /** `maxToolCalls` is the scheduler's default rather than a value the workflow declared. */
  readonly toolCallsAssumed: boolean;
  /**
   * The node's resolved `onFailure` chain (ADR 0009), or `null` when it declares none and the
   * node keeps n8n's `retryOnFail` gadget. Output names are already resolved to indexes here,
   * so the gadget never re-reads the policy.
   */
  readonly failure: FailureChain | null;
}

export interface MultiProducerInput {
  readonly node: string;
  readonly inputIndex: number;
  readonly producers: number;
}

export interface WorkflowAnalysis {
  /** The primary start node (`startNodes[0]`): n8n's `nodeExecutionStack[0]`. */
  readonly startNode: string;
  /** Every start node: the primary first, then the others in canvas order, no duplicates. */
  readonly startNodes: readonly string[];
  /** {@link startNodes} as a set, for the per-node membership test every gadget makes. Not hashed: it is `startNodes`. */
  readonly startNodeSet: ReadonlySet<string>;
  /** Nodes in canvas order. */
  readonly nodes: readonly AnalysedNode[];
  readonly byName: ReadonlyMap<string, AnalysedNode>;
  /** Deduplicated connections in canonical order, ids ascending. */
  readonly edges: readonly EdgeRef[];
  readonly incoming: ReadonlyMap<string, readonly EdgeRef[]>;
  readonly outgoing: ReadonlyMap<string, readonly EdgeRef[]>;
  /** Node name to SCC index (Tarjan emission order: reverse topological). */
  readonly sccOf: ReadonlyMap<string, number>;
  readonly sccs: readonly (readonly string[])[];
  /** Nodes in a non-trivial SCC or carrying a self-loop: producers "in a cycle". */
  readonly cyclic: ReadonlySet<string>;
  /** Nodes reachable from the union of the start nodes. */
  readonly reachable: ReadonlySet<string>;
  /** Longest path (tree edges) from any start node's SCC; unreachable nodes get 0. */
  readonly depth: ReadonlyMap<string, number>;
  readonly maxDepth: number;
  readonly hasCycle: boolean;
  readonly multiProducerInputs: readonly MultiProducerInput[];
  /** Nodes referenced with a read arc (`read` or `seeded`): their `skipped` place must exist. */
  readonly referenced: ReadonlySet<string>;
  /** Referenced nodes unreachable from every start node: `Y/skipped` is seeded. */
  readonly seededSkipped: ReadonlySet<string>;
  /**
   * Nodes that must hear of an upstream skip: those that read one — a join or OR slot, a
   * `$('X')` reference, a cycle or a loop — and every node that feeds one
   * (`analysis/skip-observers.ts`). A skipped node forwards `empty` on its outgoing tree edges
   * only when one of its successors is in this set (ADR 0002).
   */
  readonly skipObservable: ReadonlySet<string>;
  /** Deduplicated `ai_tool` connections in canonical order (agent canvas index, then tool). */
  readonly toolConnections: readonly ToolConnection[];
  /** Agents that may dispatch each tool node. Only tool-form nodes appear. */
  readonly agentsOf: ReadonlyMap<string, readonly string[]>;
  /** Any node compiles in the `tool` form: the workflow has agent tool dispatch. */
  readonly hasAgents: boolean;
  readonly diagnostics: readonly string[];
}
