/**
 * n8n's stack-entry shapes as the codec reads and writes them: the source of an entry's first
 * input, the source a pending token carries, and the entry n8n hands a node for one edge
 * arrival ({@link entryForEdge}, which the scheduler's run action uses too).
 */
import type { IExecuteData, INodeExecutionData, ISourceData, ITaskDataConnections, ITaskDataConnectionsSource } from 'n8n-workflow';
import { isEdgePayload, isEntryPayload, type EdgePayload } from '../scheduler/payloads.js';

/** The n8n source of an entry's first input (`source.main[0]`), where n8n records a single-input delivery. */
export function sourceOfEntry(entry: IExecuteData): ISourceData | null {
  return entry.source?.main?.[0] ?? null;
}

/** The n8n source a pending `X/in` / `X/hasdata_i` token carries; `null` for a value that carries none. */
export function sourceOfValue(value: unknown): ISourceData | null {
  if (isEdgePayload(value)) return value.source;
  if (isEntryPayload(value)) return sourceOfEntry(value.executionData);
  return null;
}

/**
 * The `IExecuteData` for one edge arrival, in the shape n8n hands the node: the items at
 * `main[inputIndex]`, `[]` on the inputs below it, the source alongside.
 *
 * `addNodeToBeExecuted`'s single-input path (`workflow-execute.ts:786-800`) writes `null`
 * below the index, but it is unreachable above input 0: `numberOfInputs` there is
 * `connectionsByDestinationNode[node].main.length`, which is `inputIndex + 1` for a node
 * wired on `inputIndex`, so every arrival above input 0 goes to the waiting path and reaches
 * the node through R6's stuck-join fallback instead — and that substitutes `[]` for every
 * input which never arrived, keeping the sources positional
 * (`stack-scheduler.ts:467-491`, `prepareWaitingToExecution`). A node wired only on a higher
 * input is compiled in direct form and run on arrival with the same data (divergence #9), so
 * it is the fallback's shape that must be reproduced: a `null` below the index would make
 * `getInputItems` throw "Input index was not set" (`base-execute-context.ts:321`) in a node
 * that reads input 0, which is what n8n's Merge does.
 */
export function entryForEdge(node: IExecuteData['node'], inputIndex: number, edge: EdgePayload): IExecuteData {
  const main: Array<INodeExecutionData[] | null> = Array.from({ length: inputIndex + 1 }, () => []);
  main[inputIndex] = edge.items;
  const data: ITaskDataConnections = { main };
  let source: ITaskDataConnectionsSource | null = null;
  if (edge.source !== null) {
    const sources: Array<ISourceData | null> = Array.from({ length: inputIndex + 1 }, () => null);
    sources[inputIndex] = edge.source;
    source = { main: sources };
  }
  return { node, data, source };
}
