/**
 * The enqueue half of n8n's loop: `addNodeToBeExecuted` (`workflow-execute.ts:445-851` at
 * the pinned release `n8n@2.41.3`), v1 path only. The module doc of `stack-reference.ts` says
 * why the ancestor-forcing block (`workflow-execute.ts:610-778`) is not ported.
 */
import type { IConnection, IExecuteData, INode, INodeExecutionData, Workflow } from 'n8n-workflow';
import type { Arrival, ReferenceExecutionState } from './state.js';
import { prepareWaitingToExecution, sourceOf, waitForAllInputs } from './waiting.js';

/** 780-800: the data array this arrival goes into. */
function connectionDataArrayFor(
  exec: ReferenceExecutionState, arrival: Arrival, waitingNodeIndex: number | undefined,
): Array<INodeExecutionData[] | null> {
  const { connectionData, nodeSuccessData } = arrival;
  let connectionDataArray: Array<INodeExecutionData[] | null> | null =
    waitingNodeIndex === undefined
      ? null
      : (exec.waitingExecution[connectionData.node]?.[waitingNodeIndex]?.main ?? null);
  if (connectionDataArray === null) {
    connectionDataArray = [];
    for (let i = connectionData.index; i >= 0; i--) connectionDataArray[i] = null;
  }
  connectionDataArray[connectionData.index] = nodeSuccessData === null ? null : nodeSuccessData[arrival.outputIndex]!;
  return connectionDataArray;
}

/** 802-826: back to waiting, keeping the sources the slot already had. */
function backToWaiting(
  exec: ReferenceExecutionState, nodeName: string, index: number, numberOfInputs: number,
  connectionDataArray: Array<INodeExecutionData[] | null>,
): void {
  const waitingExecutionSource = exec.waitingExecutionSource[nodeName]![index]!.main;
  prepareWaitingToExecution(exec, nodeName, numberOfInputs, index);
  exec.waitingExecution[nodeName]![index] = { main: connectionDataArray };
  exec.waitingExecutionSource[nodeName]![index]!.main = waitingExecutionSource;
}

/** `addNodeToBeExecuted` (`workflow-execute.ts:445-851`), v1 path only. */
export function enqueueArrival(exec: ReferenceExecutionState, workflow: Workflow, arrival: Arrival): void {
  const { connectionData } = arrival;
  const nodes = workflow.nodes as unknown as Record<string, INode>;
  const byDestination = workflow.connectionsByDestinationNode as unknown as
    Record<string, { main: Array<IConnection[] | null> }>;

  let stillDataMissing = false;
  let waitingNodeIndex: number | undefined;

  // 484-486: a node with several inputs waits for all of them.
  const numberOfInputs = byDestination[connectionData.node]?.main?.length ?? 0;
  if (numberOfInputs > 1) {
    waitingNodeIndex = waitForAllInputs(exec, nodes, arrival, numberOfInputs);             // 487-608
    if (waitingNodeIndex === undefined) return;
    stillDataMissing = true;
    // 610-778: the ancestor-forcing block; a no-op under v1 (see `stack-reference.ts`).
  }

  const connectionDataArray = connectionDataArrayFor(exec, arrival, waitingNodeIndex);   // 780-800
  if (stillDataMissing) {
    backToWaiting(exec, connectionData.node, waitingNodeIndex!, numberOfInputs, connectionDataArray); // 802-826
  } else if (nodes[connectionData.node]) {
    // 827-849: everything is there, so straight onto the stack (v1: `unshift`).
    exec.nodeExecutionStack.unshift({
      node: nodes[connectionData.node],
      data: { main: connectionDataArray },
      source: { main: [sourceOf(arrival)] },
      runIndex: arrival.newRunIndex,
      metadata: arrival.metadata,
    } as unknown as IExecuteData);
  }
}
