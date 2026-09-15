/**
 * The try loop of n8n's scheduler (`stack-scheduler.ts:102-212` at the pinned commit
 * `441970b`): run one activation's node, up to its retry count. `stack-reference.ts` is the
 * loop around it; line numbers are of that n8n file.
 */
import type {
  EngineRequest, EngineResponse, ExecutionBaseError, IExecuteData, INodeExecutionData, IRunExecutionData,
  IRunNodeResponse, ITaskStartedData, Workflow,
} from 'n8n-workflow';
import type { SchedulerHost } from '../../n8n/host.js';
import { sleep } from '../harness/scripts.js';
import { isEngineRequest } from './requests-response.js';

/** The two `WorkflowScheduler` values the try loop writes: the node's error and its close function. */
export interface LoopResults {
  executionError: ExecutionBaseError | undefined;
  closeFunction: Promise<void> | undefined;
}

/** One activation, as the loop has prepared it by the time the try loop starts (49-100). */
export interface Activation {
  readonly host: SchedulerHost;
  readonly workflow: Workflow;
  readonly runExecutionData: IRunExecutionData;
  readonly executionData: IExecuteData;
  readonly runIndex: number;
  readonly taskStartedData: ITaskStartedData;
  readonly subNodeExecutionResults: EngineResponse;
}

/** The try loop's end: `continue executionLoop` (`next`), or the node's output for the loop to record. */
export type TriesOutcome =
  | { readonly next: true }
  | { readonly next: false; readonly nodeSuccessData: INodeExecutionData[][] | null | undefined };

const NEXT_ACTIVATION: TriesOutcome = { next: true };

const isErrorValue = (v: unknown): boolean => v !== undefined && v !== null && v !== false;

/** 144-160: a *soft* failure is an error in the first item's json. */
function checkFailure(data: IRunNodeResponse | EngineRequest): boolean {
  return !isEngineRequest(data) && isErrorValue(data.data?.[0]?.[0]?.json?.error);
}

/** `stack-scheduler.ts:102-212`: run the node until it succeeds or its tries run out. */
export async function runTries(results: LoopResults, activation: Activation): Promise<TriesOutcome> {
  const { host, workflow, runExecutionData, executionData, runIndex, taskStartedData, subNodeExecutionResults } = activation;
  const executionNode = executionData.node;
  let nodeSuccessData: INodeExecutionData[][] | null | undefined = null;
  const [maxTries, waitBetweenTries] = host.getRetryParams(executionData);

  for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {                         // 102
    try {
      if (tryIndex !== 0) {                                                        // 104-118
        results.executionError = undefined;
        if (waitBetweenTries !== 0) await sleep(waitBetweenTries);
      }
      const pinnedOutput = host.getPinnedOutput(executionNode);
      if (pinnedOutput) {
        nodeSuccessData = pinnedOutput;
      } else {
        host.collectSubNodeResults(executionData, subNodeExecutionResults);
        let runNodeData = await host.runNode(
          workflow, executionData, runExecutionData, runIndex,
          host.additionalData, host.mode, host.abortSignal, subNodeExecutionResults,
        );
        // 144-160: a *soft* failure re-runs the node without the engine response, inside
        // the same try index.
        let nodeFailed = checkFailure(runNodeData);
        while (nodeFailed && tryIndex !== maxTries - 1) {
          await sleep(waitBetweenTries);
          runNodeData = await host.runNode(
            workflow, executionData, runExecutionData, runIndex,
            host.additionalData, host.mode, host.abortSignal,
          );
          nodeFailed = checkFailure(runNodeData);
          tryIndex++;
        }
        if (isEngineRequest(runNodeData)) {                                        // 163-174
          host.handleEngineRequest({
            workflow, currentNode: executionNode, request: runNodeData, runIndex, executionData,
            runData: runExecutionData.resultData.runData,
          });
          return NEXT_ACTIVATION;
        }
        const nodeOutput = await host.processNodeOutput(
          runNodeData, workflow, executionData, taskStartedData, runIndex,
        );
        nodeSuccessData = nodeOutput.nodeSuccessData;
        results.closeFunction = nodeOutput.closeFunction ?? results.closeFunction;
      }
      nodeSuccessData = host.assignPairedItems(nodeSuccessData, executionData);     // 193
      if (nodeSuccessData) runExecutionData.resultData.lastNodeExecuted = executionData.node.name;
      nodeSuccessData = host.ensureAlwaysOutputData(nodeSuccessData, executionData);
      if (nodeSuccessData === null && !runExecutionData.waitTill) return NEXT_ACTIVATION; // 201-206
      break;
    } catch (error) {
      results.executionError = host.reportNodeExecutionError(error, executionNode, workflow);
    }
  }
  return { next: false, nodeSuccessData };
}
