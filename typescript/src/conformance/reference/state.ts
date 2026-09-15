/**
 * The two shapes the port of n8n's loop indexes: the execution state it reads and writes,
 * and one `addNodeToBeExecuted` call. `stack-reference.ts` is the port; `waiting.ts`,
 * `enqueue.ts` and `waiting-nodes.ts` are the parts of it that write the state.
 */
import type { IConnection, IExecuteData, INodeExecutionData, ITaskMetadata } from 'n8n-workflow';

/**
 * `IRunExecutionData.executionData` as n8n's loop writes it: the stack it pops, and the
 * per-node, per-run-index waiting slots (one `main` array per multi-input node, a slot per
 * input, `null` until that input arrives) with the sources of each slot alongside. The
 * `n8n-workflow` typings say `IWaitingForExecution` / `IWaitingForExecutionSource`; this is
 * the same shape written out, because the port indexes it the way the original does.
 */
export interface ReferenceExecutionState {
  nodeExecutionStack: IExecuteData[];
  waitingExecution: Record<string, Record<number, { main: Array<INodeExecutionData[] | null> }>>;
  waitingExecutionSource: Record<string, Record<number, { main: Array<unknown | null> }>>;
}

/** One `addNodeToBeExecuted` call: the data arriving on `connectionData`, and where it came from. */
export interface Arrival {
  readonly connectionData: IConnection;
  readonly outputIndex: number;
  readonly parentNodeName: string;
  readonly nodeSuccessData: INodeExecutionData[][];
  readonly runIndex: number;
  readonly newRunIndex: number | undefined;
  readonly metadata: ITaskMetadata | undefined;
}
