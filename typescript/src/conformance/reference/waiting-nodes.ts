/**
 * The waiting-node pass of n8n's scheduler (`stack-scheduler.ts:355-518` at the pinned
 * release `n8n@2.41.3`) — R6: once the stack is empty, run the multi-input nodes that are still
 * waiting with whatever data they have, one at a time. `stack-reference.ts` is the loop that
 * calls it; line numbers are of that n8n file.
 */
import type { IExecuteData, INode, IRunExecutionData, Workflow } from 'n8n-workflow';
import type { SchedulerHost } from '../../n8n/host.js';
import type { ReferenceExecutionState } from './state.js';
import { dropWaitingEntry } from './waiting.js';

/** A node type's `requiredInputs` once evaluated: a count, or the input indexes. */
type RequiredInputs = number | number[];

/** 384-391: the node type's `requiredInputs`, evaluated for the node when it is an expression. */
function requiredInputsOf(
  host: SchedulerHost, workflow: Workflow, checkNode: INode, declared: RequiredInputs | string | undefined,
): RequiredInputs | undefined {
  if (typeof declared !== 'string') return declared;
  return workflow.expression.getSimpleParameterValue(
    checkNode, declared, host.mode, { $version: checkNode.typeVersion }, undefined, [],
  ) as number[];
}

/** 392-402: a node all of whose inputs are required is not run with partial data. */
function allInputsRequired(requiredInputs: RequiredInputs | undefined, inputCount: number): boolean {
  return (Array.isArray(requiredInputs) && requiredInputs.length === inputCount) || requiredInputs === inputCount;
}

/** 425-446: the required inputs must be among the ones that did arrive. */
function requiredInputsArrived(requiredInputs: RequiredInputs | undefined, inputsWithData: number[]): boolean {
  if (requiredInputs === undefined) return true;
  if (Array.isArray(requiredInputs)) return !requiredInputs.some((required) => !inputsWithData.includes(required));
  return !(inputsWithData.length < requiredInputs);
}

/**
 * 448-503: a slot that never arrived becomes `[]` — the substitution divergence #2 is about —
 * and an entry with data on any input goes onto the stack. Returns whether it went.
 */
function enqueuePartial(
  exec: ReferenceExecutionState, workflow: Workflow, nodeName: string, runIndex: number, inputCount: number,
): boolean {
  const taskDataMain = exec.waitingExecution[nodeName]![runIndex]!.main.map((data) => (data === null ? [] : data));
  const found = taskDataMain.filter((data) => data.length).length !== 0;
  if (!found) return false;
  while (taskDataMain.length < inputCount) taskDataMain.push([]);
  exec.nodeExecutionStack.push({
    node: workflow.nodes[nodeName],
    data: { main: taskDataMain },
    source: exec.waitingExecutionSource[nodeName]![runIndex],
  } as unknown as IExecuteData);
  return true;
}

/**
 * `stack-scheduler.ts:355-518` — R6: once the stack is empty, run the multi-input nodes
 * that are still waiting with whatever data they have, one at a time.
 */
export async function runWaitingNodes(
  host: SchedulerHost,
  workflow: Workflow,
  runExecutionData: IRunExecutionData,
): Promise<void> {
  const exec = runExecutionData.executionData! as unknown as ReferenceExecutionState;
  let waitingNodes: string[] = Object.keys(exec.waitingExecution);
  if (exec.nodeExecutionStack.length !== 0 || waitingNodes.length === 0) return;

  for (let i = 0; i < waitingNodes.length; i++) {
    const nodeName = waitingNodes[i]!;
    const checkNode = workflow.getNode(nodeName);
    if (!checkNode) continue;
    const nodeType = workflow.nodeTypes.getByNameAndVersion(checkNode.type, checkNode.typeVersion);
    const inputCount = (nodeType.description.inputs as unknown[]).length;

    const requiredInputs = requiredInputsOf(
      host, workflow, checkNode, nodeType.description.requiredInputs as RequiredInputs | string | undefined,
    );
    if (allInputsRequired(requiredInputs, inputCount)) continue;                      // 384-402

    // 404-410: wait while a parent is itself waiting.
    const parentNodes = (workflow as unknown as { getParentNodes: (n: string) => string[] }).getParentNodes(nodeName);
    if (parentNodes.some((value) => waitingNodes.includes(value))) continue;

    const runIndexes = Object.keys(exec.waitingExecution[nodeName]!).sort();
    const firstRunIndex = Number.parseInt(runIndexes[0]!, 10);
    const inputsWithData = exec.waitingExecution[nodeName]![firstRunIndex]!.main
      .map((data, index) => (data === null ? null : index))
      .filter((data) => data !== null);
    if (!requiredInputsArrived(requiredInputs, inputsWithData)) continue;             // 425-446

    const found = enqueuePartial(exec, workflow, nodeName, firstRunIndex, inputCount); // 448-503
    dropWaitingEntry(exec, nodeName, firstRunIndex);
    if (found) break;                                                                 // 505-507
    // 508-514: an empty entry was dropped, so start the scan again.
    waitingNodes = Object.keys(exec.waitingExecution);
    i = -1;
  }
}
