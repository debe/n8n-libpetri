/**
 * The second part of the data gate: the **resumable state**, `IRunExecutionData.executionData`
 * plus `waitTill` ({@link compareResumableState}).
 */
import type { IRunExecutionData } from 'n8n-workflow';
import { firstDifference } from '../diff-value.js';
import type { EngineRun } from '../engines.js';
import { ownValue } from '../values/missing.js';
import { differenceAt, type NodeDifference } from './node-difference.js';

type ExecutionData = NonNullable<IRunExecutionData['executionData']>;

/** The `IExecuteData` fields a stack entry is compared by: the node, its input, its source. */
function entryShape(entry: { node: { name: string }; data?: unknown; source?: unknown }): unknown {
  return { node: entry.node.name, data: (entry as { data?: { main?: unknown } }).data?.main, source: entry.source };
}

/** The node at the stack index a difference's path ends in, `''` when it ends in none. */
function nodeAtStackIndex(path: string, left: ExecutionData, right: ExecutionData): string {
  const at = /\[(\d+)\]$/.exec(path);
  if (at === null) return '';
  const index = Number(at[1]);
  return (left.nodeExecutionStack[index] ?? right.nodeExecutionStack[index])?.node.name ?? '';
}

/** The stack's node names first; when those agree, each entry's input and source. */
function stackDifferences(left: ExecutionData, right: ExecutionData): NodeDifference[] {
  const names = (e: ExecutionData): string[] => e.nodeExecutionStack.map((x) => x.node.name);
  const stackNames = firstDifference(names(left), names(right), 'executionData.nodeExecutionStack');
  if (stackNames !== null) return [{ d: stackNames, node: nodeAtStackIndex(stackNames.path, left, right) }];
  return left.nodeExecutionStack.flatMap((entry, i) => differenceAt(
    firstDifference(entryShape(entry), entryShape(right.nodeExecutionStack[i]!), `executionData.nodeExecutionStack[${i}]`),
    entry.node.name,
  ));
}

/** `waitingExecution` and `waitingExecutionSource`, node by node in sorted order. */
function waitingDifferences(left: ExecutionData, right: ExecutionData): NodeDifference[] {
  return (['waitingExecution', 'waitingExecutionSource'] as const).flatMap((field) => {
    const a = (left[field] ?? {}) as Record<string, unknown>;
    const b = (right[field] ?? {}) as Record<string, unknown>;
    const nodes = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return nodes.flatMap((node) => differenceAt(
      firstDifference(ownValue(a, node), ownValue(b, node), `executionData.${field}.${node}`),
      node,
    ));
  });
}

/**
 * The **resumable state**: `IRunExecutionData.executionData` plus `waitTill`. This is what
 * n8n persists with a paused, waiting or failed execution and what "Retry execution" and a
 * Wait-node resume replay, and producing it is the marking codec's whole job (README
 * "Initial marking and the marking codec"). It is data, not order, so it belongs in the gate:
 * two engines that agree on every `ITaskData` and leave different `nodeExecutionStack` /
 * `waitingExecution` behind have not produced the same execution.
 *
 * Skipped when either side has no `executionData` (a hand-built {@link EngineRun}).
 */
export function compareResumableState(reference: EngineRun, candidate: EngineRun): NodeDifference[] {
  const left = reference.runExecutionData.executionData;
  const right = candidate.runExecutionData.executionData;
  if (left === undefined || right === undefined) return [];
  return [
    ...stackDifferences(left, right),
    ...waitingDifferences(left, right),
    ...differenceAt(firstDifference(left.contextData, right.contextData, 'executionData.contextData'), ''),
    ...differenceAt(firstDifference(reference.runExecutionData.waitTill, candidate.runExecutionData.waitTill, 'waitTill'), ''),
  ];
}
