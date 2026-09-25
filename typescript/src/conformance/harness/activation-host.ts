/**
 * The members of the `FakeHost` mirror the loop calls between popping an entry and running
 * its node (`stack-scheduler.ts:49-120` at `n8n@2.41.3`): the stop check, the task's start,
 * the input's lineage, the run index, the filters, the retry parameters and the pinned
 * output. Each mirrors its `workflow-execute.ts` namesake; `FakeHost` is the whole host.
 */
import type { IExecuteData, INode, INodeExecutionData, ITaskDataConnections, ITaskStartedData, Workflow } from 'n8n-workflow';
import { pairedItemLineage } from './paired-items.js';
import { StackHost } from './stack-host.js';

export abstract class ActivationHost extends StackHost {
  shouldStopExecuting(): boolean {
    this.record('shouldStopExecuting');
    return this.status === 'canceled';
  }

  resetDynamicCredentialsUsage(executionData: IExecuteData): void {
    this.record('resetDynamicCredentialsUsage', executionData.node.name);
  }

  createTaskStartedData(executionData: IExecuteData): ITaskStartedData {
    this.record('createTaskStartedData', executionData.node.name);
    const ad = this.additionalData as unknown as { currentNodeExecutionIndex: number };
    return {
      startTime: Date.now(),
      executionIndex: ad.currentNodeExecutionIndex++,
      source: !executionData.source ? [] : executionData.source.main!,
      hints: [],
    };
  }

  addPairedItemLineage(executionData: IExecuteData): ITaskDataConnections {
    this.record('addPairedItemLineage', executionData.node.name);
    return pairedItemLineage(executionData.data);
  }

  computeRunIndex(executionData: IExecuteData): number {
    this.record('computeRunIndex', executionData.node.name);
    if (executionData.runIndex !== undefined) return executionData.runIndex;
    const name = executionData.node.name;
    return Object.hasOwn(this.runData, name) ? this.runData[name]!.length : 0;
  }

  isNodeFilteredOut(nodeName: string): boolean {
    this.record('isNodeFilteredOut', nodeName);
    const filter = this.runExecutionData.startData?.runNodeFilter;
    return filter !== undefined && !filter.includes(nodeName);
  }

  ensureInputData(_workflow: Workflow, executionNode: INode, _executionData: IExecuteData): boolean {
    this.record('ensureInputData', executionNode.name);
    return this.options.ensureInputData ?? true;
  }

  getRetryParams(executionData: IExecuteData): [number, number] {
    this.record('getRetryParams', executionData.node.name);
    // `metadata.resumeError` postdates n8n-workflow 2.16's typings (it exists at the pin).
    const isResumedError = (executionData.metadata as { resumeError?: unknown } | undefined)?.resumeError !== undefined;
    if (executionData.node.retryOnFail !== true || isResumedError) return [1, 0];
    return [
      Math.min(5, Math.max(2, executionData.node.maxTries || 3)),
      Math.min(5000, Math.max(0, executionData.node.waitBetweenTries || 1000)),
    ];
  }

  getPinnedOutput(node: INode): INodeExecutionData[][] | undefined {
    this.record('getPinnedOutput', node.name);
    const { pinData } = this.runExecutionData.resultData;
    if (!pinData || node.disabled || pinData[node.name] === undefined) return undefined;
    return [pinData[node.name]!];
  }
}
