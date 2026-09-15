/**
 * The token vocabulary of the scheduler: what the actions put on each place of the
 * per-node gadget (README "Per-node gadget") and what the marking codec (`src/codec.ts`)
 * reads back. Data travels **by reference**: a token holds the live
 * `INodeExecutionData[]` array n8n produced, never a copy, exactly as n8n hands the same
 * array to every connection of an output.
 *
 * `runIndex` of a node's own run is never stored in a token: `X_run` computes it through
 * `host.computeRunIndex` when it fires. The producer's run index does travel on an edge
 * token, as `source.previousNodeRun`, because that is what n8n records in
 * `IExecuteData.source` / `waitingExecutionSource`.
 */
import type { IExecuteData, INodeExecutionData, IRunNodeResponse, ISourceData, ITaskStartedData } from 'n8n-workflow';

// The guards live beside the vocabulary rather than in it; this module exports them as it always has.
export {
  isDispatchPayload, isEdgePayload, isEntryPayload, isOkPayload, isRequestPayload, isRetryPayload, isRoundPayload,
  isRunPayload, isStoppedPayload, isWaitingPayload,
} from './payload-guards.js';

/**
 * A `data` token on an edge place (`X/in`, `X/in_i_e`, `X/hasdata_i`) or a data-filled
 * `X/ready_i` slot: the producer's non-empty output for that output index, plus the n8n
 * source of the delivery (`previousNode`, `previousNodeOutput`, `previousNodeRun`; `null`
 * only for a slot decoded from a `waitingExecution` entry whose source n8n did not record).
 * An `empty` token carries `null` (a unit token): n8n never records a source for an input
 * that received nothing, and the codec writes it as `[]` with a `null` source.
 */
export interface EdgePayload {
  readonly kind: 'edge';
  readonly items: INodeExecutionData[];
  readonly source: ISourceData | null;
}

/**
 * A decoded `nodeExecutionStack` entry on a direct-form node's `X/in` (the start node's
 * trigger entry on a fresh run, or any pending entry on resume): the start action passes
 * `executionData` through unchanged, `metadata` included.
 */
export interface EntryPayload {
  readonly kind: 'entry';
  readonly executionData: IExecuteData;
}

/** What a direct-form `X/in` place carries. */
export type InputPayload = EdgePayload | EntryPayload;

/**
 * The token on `X/running`: the node's `IExecuteData` (the same object across every
 * attempt, as n8n reuses it), the attempt number (0 for the first run), the
 * `taskStartedData` created on attempt 0 (later attempts reuse it, so `executionIndex` is
 * assigned once per node execution as in n8n) and, for a `start-unmet` activation, the
 * referenced node that was skipped.
 */
export interface RunPayload {
  readonly kind: 'run';
  readonly executionData: IExecuteData;
  readonly attempt: number;
  readonly taskStartedData?: ITaskStartedData;
  readonly unmetReference?: string;
  /** Tool form only: the agent whose `A/response` this run's success branch writes. */
  readonly agent?: string;
  /** Tool and agent forms: the round this activation belongs to, for diagnostics. */
  readonly roundId?: string;
  /**
   * Agent form, set by `A_calls_out`: the tool-call budget ran out with this many actions
   * still queued. `X_run` fails the activation with `toolCallBudgetExceeded` instead of running
   * it, so the failure is recorded and routed under `onError` like any node error.
   */
  readonly toolCallsExceeded?: { readonly undispatched: number; readonly budget: number };
  /**
   * This attempt resumes n8n's *inner* re-run loop (lines 143–160), which calls `runNode`
   * and nothing else — set by `X_retry_wait` when the token it consumed carried a `soft`
   * reason. A thrown failure re-enters the whole try body instead (n8n's outer `for`).
   */
  readonly softRetry?: boolean;
}

/**
 * Why a run is being retried (`X/retry`): a thrown error (n8n's `catch` at
 * `stack-scheduler.ts:209`), or a "soft" failure — an error item on the first output
 * (`checkFailure`, lines 98–100 and 143–160) which n8n re-runs inside the same try and,
 * once the tries are used up, processes as a regular success.
 */
export type RetryReason =
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'soft'; readonly runNodeData: IRunNodeResponse }
  /**
   * The attempt overran `executionPolicy.timeoutMs` and libpetri abandoned its firing
   * (IO-013). Distinct from `error` because n8n never threw — the node may still be working —
   * so the step that answers it reports the deadline rather than a node error (ADR 0009).
   */
  | { readonly kind: 'timeout'; readonly timeoutMs: number };

/** The token on `X/retry`. `X_retry_wait` turns it back into a {@link RunPayload}; `X_exhausted` resolves it. */
export interface RetryPayload {
  readonly kind: 'retry';
  readonly executionData: IExecuteData;
  readonly attempt: number;
  readonly taskStartedData: ITaskStartedData;
  readonly reason: RetryReason;
  /** Tool form: the agent this activation answers to, carried across every attempt. */
  readonly agent?: string;
  readonly roundId?: string;
  /**
   * `runExecutionData.waitTill` as the failing attempt read it before its own `runNode`, so
   * `X_exhausted` can tell a wait this node started from one a sibling started (k > 1).
   */
  readonly waitTillBefore?: Date;
}

/**
 * The value `X_run` routes with — carried on every `X/ok_o` under per-output routing, and
 * read straight out of the outcome everywhere else: the node's recorded output and the run
 * index it was recorded under, which becomes `previousNodeRun` on every edge.
 * `nodeSuccessData` is `[]` when the node produced nothing routable (n8n's
 * `nodeSuccessData === null` branch, a filtered-out node): every edge then receives `empty`.
 */
export interface OkPayload {
  readonly kind: 'ok';
  readonly nodeSuccessData: INodeExecutionData[][];
  readonly runIndex: number;
}

/** The token on `X/waiting`: n8n's `pushExecutionStack(executionData)` on `waitTill`. */
export interface WaitingPayload {
  readonly kind: 'waiting';
  readonly executionData: IExecuteData;
}

/**
 * The token on `X/stopped`. `ran: true`: the destination node ran and its outputs are
 * recorded (n8n `continue`s without enqueuing successors). `ran: false`: the execution was
 * already cancelled when `X_run` fired (n8n's `shouldStopExecuting()` check runs before the
 * entry is popped, so the entry stays on the stack; the codec writes it back there).
 */
export interface StoppedPayload {
  readonly kind: 'stopped';
  readonly executionData: IExecuteData;
  readonly ran: boolean;
}

/**
 * The token on `A/routed_req` and, once the round opens, on `A/queue` — an agent returned an
 * `EngineRequest` and n8n's own `handleRequest` has planned it.
 *
 * `pending` is the tool activations still to dispatch, **in the order the model requested them**;
 * `A_dispatch` pops the head each firing and puts the tail back, so a tool's `X_start` follows
 * request order at every budget. `resume` is the agent's own re-entry entry, carrying
 * `metadata.nodeWasResumed` and `metadata.subNodeExecutionData` exactly as n8n built it — which
 * is what makes `host.collectSubNodeResults` rebuild the right `EngineResponse` with no help
 * from us. `roundId` is data only: it names the round in diagnostics and in the differ, and
 * never reaches the net's enablement (see ADR 0008 on why this is not a ν-name).
 */
export interface RequestPayload {
  readonly kind: 'request';
  readonly pending: readonly IExecuteData[];
  readonly resume: IExecuteData;
  readonly roundId: string;
  /**
   * Set when the agent is itself a tool (`agentNested`): where its eventual answer goes — the
   * agent that dispatched it and the round it answers into. The round this request opens is the
   * tool's own, so the re-entry reads the address from here: data in the token, where the
   * marking codec sees it, rather than beside the net where a pause would lose it (ADR 0008).
   */
  readonly answers?: ToolDispatch;
}

/**
 * The token on `A/dispatched`: the round is open, and this is the agent's re-entry.
 *
 * Deliberately *not* the {@link RequestPayload}. `A_dispatch` rewrites `A/queue` with a shorter
 * `pending` on every firing, so a copy parked on `A/dispatched` would still name the tools the
 * round started with. The marking codec reads both places when an execution pauses mid-round,
 * and stale entries there would be re-queued tool calls that already ran.
 */
export interface RoundPayload {
  readonly kind: 'round';
  readonly resume: IExecuteData;
  readonly roundId: string;
  /** The {@link RequestPayload.answers} of the request that opened this round, unchanged. */
  readonly answers?: ToolDispatch;
}

/** Where a tool activation's answer goes: the agent that dispatched it, and that agent's round. */
export interface ToolDispatch {
  readonly agent: string;
  readonly roundId: string;
}

/**
 * The token on `T/in_tool`: one planned tool activation plus the agent that asked for it. The
 * agent travels with the token because a tool can serve several agents, and `T_run`'s success
 * branch is an `xor` over their `A/response` places — the token says which one to take.
 */
export interface DispatchPayload {
  readonly kind: 'dispatch';
  readonly executionData: IExecuteData;
  readonly agent: string;
  readonly roundId: string;
}

/** The token on `A/response`: a dispatched tool finished and its `runData` is written. */
export interface ResponsePayload {
  readonly kind: 'response';
  readonly tool: string;
  readonly roundId: string;
}
