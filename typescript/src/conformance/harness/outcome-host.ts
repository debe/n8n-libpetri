/**
 * The members of the `FakeHost` mirror the loop calls once a node has run
 * (`stack-scheduler.ts:190-267` at n8n `441970b`): pairing its output items, reporting and
 * handling its failure, and recording its task. Each mirrors its `workflow-execute.ts`
 * namesake; `FakeHost` is the whole host.
 */
import type { ExecutionBaseError, IExecuteData, INode, INodeExecutionData, ITaskData, ITaskStartedData, Workflow } from 'n8n-workflow';
import type { SchedulerHooks } from '../../n8n/host.js';
import { ActivationHost } from './activation-host.js';
import { continuedOutput, executionErrorOf, normalizeItemErrors } from './node-errors.js';
import { pairOutputItems, withAlwaysOutputData } from './paired-items.js';

/** A node's output as the loop carries it: `null` / `undefined` until there is one. */
type NodeOutput = INodeExecutionData[][] | null | undefined;

export abstract class OutcomeHost extends ActivationHost {
  reportNodeExecutionError(error: unknown, executionNode: INode, _workflow: Workflow): ExecutionBaseError {
    this.record('reportNodeExecutionError', executionNode.name);
    this.runExecutionData.resultData.lastNodeExecuted = executionNode.name;
    return executionErrorOf(error);
  }

  assignPairedItems(nodeSuccessData: NodeOutput, executionData: IExecuteData): INodeExecutionData[][] | null {
    this.record('assignPairedItems', executionData.node.name);
    return pairOutputItems(nodeSuccessData, executionData);
  }

  ensureAlwaysOutputData(nodeSuccessData: NodeOutput, executionData: IExecuteData): NodeOutput {
    this.record('ensureAlwaysOutputData', executionData.node.name);
    return withAlwaysOutputData(nodeSuccessData, executionData);
  }

  createTaskData(taskStartedData: ITaskStartedData, executionData: IExecuteData): ITaskData {
    this.record('createTaskData', executionData.node.name);
    return {
      ...taskStartedData,
      executionTime: Date.now() - taskStartedData.startTime,
      metadata: executionData.metadata,
      executionStatus: this.runExecutionData.waitTill ? 'waiting' : 'success',
    };
  }

  recordDynamicCredentialsUser(): void {
    this.record('recordDynamicCredentialsUser');
  }

  async handleNodeExecutionError(args: {
    executionNode: INode; executionData: IExecuteData; taskData: ITaskData; executionError: ExecutionBaseError;
    nodeSuccessData: NodeOutput; runIndex: number; hooks: SchedulerHooks;
  }): Promise<{ continueExecution: boolean; nodeSuccessData: NodeOutput }> {
    const { executionNode, executionData, taskData, executionError, runIndex, hooks } = args;
    this.record('handleNodeExecutionError', executionNode.name);
    taskData.error = executionError as never;
    taskData.executionStatus = 'error';
    const continued = continuedOutput(executionNode, executionData, executionError, args.nodeSuccessData);
    if (continued !== undefined) return { continueExecution: true, nodeSuccessData: continued.nodeSuccessData };
    this.upsertTaskData(executionNode.name, runIndex, taskData);
    this.pushExecutionStack(executionData);
    if (!this.abortSignal.aborted) await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, this.runExecutionData]);
    return { continueExecution: false, nodeSuccessData: args.nodeSuccessData };
  }

  /**
   * `upsertTaskData` (`workflow-execute.ts:2154-2161`). n8n indexes `runData[nodeName]`
   * without a check because its loop created the array just before (`stack-scheduler.ts:216-218`),
   * as the scheduler's run loop does (`src/scheduler/run-loop.ts`); creating it here on a miss
   * is that same behaviour, minus the `TypeError` a caller that skipped the step would
   * otherwise get from the mirror.
   */
  upsertTaskData(nodeName: string, runIndex: number, taskData: ITaskData): void {
    this.record('upsertTaskData', nodeName);
    const nodeRunData = (this.runData[nodeName] ??= []);
    if (nodeRunData[runIndex]) Object.assign(nodeRunData[runIndex], taskData);
    else nodeRunData.push(taskData);
  }

  normalizeNodeErrors(nodeSuccessData: INodeExecutionData[][]): void {
    this.record('normalizeNodeErrors');
    normalizeItemErrors(nodeSuccessData);
  }

  rewireOutputLog(executionNode: INode, _taskData: ITaskData, _nodeSuccessData: INodeExecutionData[][], _runIndex: number): void {
    this.record('rewireOutputLog', executionNode.name);
  }
}
