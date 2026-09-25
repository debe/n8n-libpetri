/**
 * The waiting slots of n8n's loop: `IRunExecutionData.executionData.waitingExecution` and
 * its sources, as `addNodeToBeExecuted` (`workflow-execute.ts:426-608`) and the waiting-node
 * pass (`stack-scheduler.ts:511-516`) read and write them. Line numbers are
 * of those n8n files at the pinned release `n8n@2.41.3`; `stack-reference.ts` is the port.
 */
import type { IExecuteData, INode } from 'n8n-workflow';
import type { Arrival, ReferenceExecutionState } from './state.js';

/** A slot's source as `addNodeToBeExecuted` records it, waiting (535-539) or not (834-838). */
export function sourceOf(arrival: Arrival): { previousNode: string; previousNodeOutput?: number; previousNodeRun?: number } {
  return {
    previousNode: arrival.parentNodeName,
    previousNodeOutput: arrival.outputIndex ?? undefined,
    previousNodeRun: arrival.runIndex ?? undefined,
  };
}

/** `prepareWaitingToExecution` (`workflow-execute.ts:426-442`). */
export function prepareWaitingToExecution(
  executionData: ReferenceExecutionState, nodeName: string, numberOfConnections: number, runIndex: number,
): void {
  executionData.waitingExecution ??= {};
  executionData.waitingExecutionSource ??= {};
  const nodeWaiting = (executionData.waitingExecution[nodeName] ??= []);
  const nodeWaitingSource = (executionData.waitingExecutionSource[nodeName] ??= []);
  nodeWaiting[runIndex] = { main: [] };
  nodeWaitingSource[runIndex] = { main: [] };
  for (let i = 0; i < numberOfConnections; i++) {
    nodeWaiting[runIndex]!.main.push(null);
    nodeWaitingSource[runIndex]!.main.push(null);
  }
}

/**
 * Drop one waiting entry, and the node's maps once it has none left: the tail of both the
 * enqueue (`workflow-execute.ts:598-603`) and the waiting-node pass (`stack-scheduler.ts:511-516`).
 */
export function dropWaitingEntry(exec: ReferenceExecutionState, nodeName: string, index: number): void {
  delete exec.waitingExecution[nodeName]![index];
  delete exec.waitingExecutionSource[nodeName]![index];
  if (Object.keys(exec.waitingExecution[nodeName]!).length === 0) {
    delete exec.waitingExecution[nodeName];
    delete exec.waitingExecutionSource[nodeName];
  }
}

/** 503-524: reuse the first waiting entry whose slot for this input is still free. */
function waitingIndexFor(exec: ReferenceExecutionState, nodeName: string, inputIndex: number, numberOfInputs: number): number {
  let createNewWaitingEntry = true;
  let waitingNodeIndex: number | undefined;
  const waiting = exec.waitingExecution[nodeName]!;
  if (Object.keys(waiting).length > 0) {
    for (const index of Object.keys(waiting)) {
      if (!waiting[Number.parseInt(index, 10)]!.main[inputIndex]) {
        createNewWaitingEntry = false;
        waitingNodeIndex = Number.parseInt(index, 10);
        break;
      }
    }
  }
  if (waitingNodeIndex === undefined) waitingNodeIndex = Object.values(waiting).length;
  if (createNewWaitingEntry) prepareWaitingToExecution(exec, nodeName, numberOfInputs, waitingNodeIndex);
  return waitingNodeIndex;
}

/** 526-543: write the arrival into the slot. */
function writeArrival(exec: ReferenceExecutionState, arrival: Arrival, index: number): void {
  const { node, index: input } = arrival.connectionData;
  const slots = exec.waitingExecution[node]![index]!.main;
  const sources = exec.waitingExecutionSource[node]![index]!.main;
  if (arrival.nodeSuccessData === null) {
    slots[input] = null;
    sources[input] = null;
  } else {
    slots[input] = arrival.nodeSuccessData[arrival.outputIndex]!;
    sources[input] = sourceOf(arrival);
  }
}

/** 545-608: every slot filled → onto the stack, and drop the waiting entry. */
function enqueueIfComplete(exec: ReferenceExecutionState, nodes: Record<string, INode>, nodeName: string, index: number): boolean {
  const waiting = exec.waitingExecution[nodeName]!;
  const allDataFound = waiting[index]!.main.every((slot) => slot !== null);
  if (!allDataFound) return false;
  const executionStackItem = {
    node: nodes[nodeName],
    data: waiting[index],
    source: exec.waitingExecutionSource[nodeName]![index],
  } as unknown as IExecuteData;
  exec.nodeExecutionStack.unshift(executionStackItem);
  dropWaitingEntry(exec, nodeName, index);
  return true;
}

/**
 * 487-608: a node with several inputs waits for all of them. Returns the waiting entry the
 * arrival went into, or `undefined` once that entry was complete and went onto the stack.
 */
export function waitForAllInputs(
  exec: ReferenceExecutionState, nodes: Record<string, INode>, arrival: Arrival, numberOfInputs: number,
): number | undefined {
  const nodeName = arrival.connectionData.node;
  exec.waitingExecutionSource ??= {};
  // 487-501: the original also records `nodeWasWaiting` here; only the ancestor-forcing
  // block (610, v0 only) reads it, so the port does not keep it.
  if (exec.waitingExecution[nodeName] === undefined) {
    exec.waitingExecution[nodeName] = {};
    exec.waitingExecutionSource[nodeName] = {};
  }
  const index = waitingIndexFor(exec, nodeName, arrival.connectionData.index, numberOfInputs);
  writeArrival(exec, arrival, index);
  return enqueueIfComplete(exec, nodes, nodeName, index) ? undefined : index;
}
