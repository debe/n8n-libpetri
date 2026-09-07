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
  readonly executionData: IExecuteData;
  readonly attempt: number;
  readonly taskStartedData?: ITaskStartedData;
  readonly unmetReference?: string;
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
  | { readonly kind: 'soft'; readonly runNodeData: IRunNodeResponse };

/** The token on `X/retry`. `X_retry_wait` turns it back into a {@link RunPayload}; `X_exhausted` resolves it. */
export interface RetryPayload {
  readonly executionData: IExecuteData;
  readonly attempt: number;
  readonly taskStartedData: ITaskStartedData;
  readonly reason: RetryReason;
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
  readonly nodeSuccessData: INodeExecutionData[][];
  readonly runIndex: number;
}

/** The token on `X/waiting`: n8n's `pushExecutionStack(executionData)` on `waitTill`. */
export interface WaitingPayload {
  readonly executionData: IExecuteData;
}

/**
 * The token on `X/stopped`. `ran: true`: the destination node ran and its outputs are
 * recorded (n8n `continue`s without enqueuing successors). `ran: false`: the execution was
 * already cancelled when `X_run` fired (n8n's `shouldStopExecuting()` check runs before the
 * entry is popped, so the entry stays on the stack; the codec writes it back there).
 */
export interface StoppedPayload {
  readonly executionData: IExecuteData;
  readonly ran: boolean;
}

export function isEdgePayload(v: unknown): v is EdgePayload {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'edge';
}

export function isEntryPayload(v: unknown): v is EntryPayload {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'entry';
}
