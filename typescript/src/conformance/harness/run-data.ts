/**
 * Run data for the harness: items, and the `IRunExecutionData` an execution starts from —
 * one entry on `nodeExecutionStack` for the start node, as n8n builds it.
 */
import type { INode, INodeExecutionData, IPinData, IRunExecutionData, ITaskMetadata } from 'n8n-workflow';

export function items(...values: unknown[]): INodeExecutionData[] {
  return values.map((v) => ({ json: (typeof v === 'object' && v !== null ? v : { v }) as INodeExecutionData['json'] }));
}

export interface RunDataOptions {
  readonly startItems?: INodeExecutionData[];
  readonly destinationNode?: string;
  readonly runNodeFilter?: string[];
  readonly pinData?: IPinData;
  /** `metadata` of the start entry (e.g. `{ resumeError }`). */
  readonly stackMetadata?: ITaskMetadata;
  /** Start with an empty `nodeExecutionStack` (n8n's loop never enters). */
  readonly emptyStack?: boolean;
}

export function newRunExecutionData(startNode: INode, options: RunDataOptions = {}): IRunExecutionData {
  const data = {
    version: 1,
    startData: {
      ...(options.destinationNode === undefined ? {} : { destinationNode: { nodeName: options.destinationNode, mode: 'inclusive' } }),
      ...(options.runNodeFilter === undefined ? {} : { runNodeFilter: options.runNodeFilter }),
    },
    resultData: { runData: {}, ...(options.pinData === undefined ? {} : { pinData: options.pinData }) },
    executionData: {
      contextData: {},
      metadata: {},
      nodeExecutionStack: options.emptyStack === true ? [] : [{
        node: startNode, data: { main: [options.startItems ?? [{ json: {} }]] }, source: null,
        ...(options.stackMetadata === undefined ? {} : { metadata: options.stackMetadata }),
      }],
      waitingExecution: {},
      waitingExecutionSource: {},
    },
  };
  return data as unknown as IRunExecutionData;
}
