/**
 * The recording path of one attempt (`stack-scheduler.ts` lines 193–268 at `n8n@2.41.3`, patch
 * 0001): the success post-processing, then the after-loop recording that writes the task data,
 * decides the branch and runs `nodeExecuteAfter`. It is the end of one n8n loop iteration.
 */
import type {
  ExecutionBaseError, IExecuteData, INode, INodeExecutionData, ITaskData, ITaskDataConnections, ITaskStartedData,
} from 'n8n-workflow';
import type { ExecutionEnv } from './env.js';
import { emptyOutcome, type Outcome } from './outcomes.js';
import type { WaitProbe } from './wait-claim.js';

/**
 * An `onFailure` `route` step's target (ADR 0009): the connected output the failure takes,
 * and the message the item carries.
 */
export interface RouteTo {
  readonly index: number;
  readonly message: string;
}

/**
 * Lines 193–206: paired items, `lastNodeExecuted`, `alwaysOutputData`, and the "succeeded
 * with no data" branch (`continue executionLoop`: no task data, no hook, successors get
 * nothing — here every edge receives `empty` through an all-empty ok token).
 */
export async function finishSuccess(
  env: ExecutionEnv,
  executionNode: INode,
  executionData: IExecuteData,
  taskStartedData: ITaskStartedData,
  runIndex: number,
  raw: INodeExecutionData[][] | null | undefined,
  wait: WaitProbe,
): Promise<Outcome> {
  const { host, runExecutionData } = env;
  let nodeSuccessData = host.assignPairedItems(raw, executionData);
  if (nodeSuccessData) runExecutionData.resultData.lastNodeExecuted = executionData.node.name;
  nodeSuccessData = host.ensureAlwaysOutputData(nodeSuccessData, executionData) ?? null;
  if (nodeSuccessData === null && wait() !== 'claimed') {
    // `continue executionLoop`: the iteration ends here, with n8n's field cleared by the
    // successful try and nothing recorded.
    env.state.leftoverError = undefined;
    return emptyOutcome(runIndex);
  }
  return record(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, undefined, wait);
}

/** The node's `runData` slot, and its task data as `createTaskData` builds it — corrected for a pause another node claimed. */
function taskDataFor(
  env: ExecutionEnv, executionNode: INode, executionData: IExecuteData, taskStartedData: ITaskStartedData, wait: WaitProbe,
): ITaskData {
  const { host, runExecutionData } = env;
  if (!Object.hasOwn(runExecutionData.resultData.runData, executionNode.name)) {
    runExecutionData.resultData.runData[executionNode.name] = [];
  }
  const taskData = host.createTaskData(taskStartedData, executionData);
  if (wait() === 'foreign' && taskData.executionStatus === 'waiting') {
    // `createTaskData` reads the execution-global `waitTill` (`workflow-execute.ts:1996`).
    // Another node claimed the pause while this one was running, so this run finished
    // normally and must be recorded as such — the k = 1 status of the same run
    // (divergence #15). Unreachable at k = 1: there the claimant is this node.
    taskData.executionStatus = 'success';
  }
  return taskData;
}

/**
 * The output a `route` step puts the failure on. n8n's own handler continued this failure down
 * output 0 with the input passed through; the step said which output it belongs on, and it
 * carries the error as data.
 */
function routedBranch(routeTo: RouteTo): INodeExecutionData[][] {
  const branch: INodeExecutionData[][] = [];
  for (let o = 0; o <= routeTo.index; o++) branch.push([]);
  branch[routeTo.index] = [{ json: { error: routeTo.message }, pairedItem: { item: 0 } }];
  return branch;
}

/**
 * The branch a recorded run takes, decided before `nodeExecuteAfter` as n8n's own tests are:
 * `waitTill` → `waiting`; the destination node → `stopped`; else `ok`.
 */
function recordedOutcome(
  env: ExecutionEnv, executionNode: INode, executionData: IExecuteData, nodeSuccessData: INodeExecutionData[][],
  runIndex: number, wait: WaitProbe,
): Outcome {
  // n8n: pushExecutionStack(executionData) — the codec writes the waiting token there.
  if (wait() === 'claimed') return { kind: 'waiting', executionData };
  if (env.runExecutionData.startData?.destinationNode?.nodeName === executionNode.name) {
    return { kind: 'stopped', executionData, ran: true };
  }
  // Lines 272–362 (enqueue the successors) are X_route, next cycle.
  return { kind: 'ok', nodeSuccessData, runIndex };
}

/**
 * Lines 214–268, the after-loop recording: `runData` slot, `createTaskData`,
 * `recordDynamicCredentialsUser`, the error outcome (`handleNodeExecutionError` continues
 * with the node's input as output, or stops: the halt branch), `normalizeNodeErrors`,
 * `rewireOutputLog`, `upsertTaskData`, then `waitTill` → `nodeExecuteAfter` + `waiting`;
 * destination node → `nodeExecuteAfter` + `stopped`; else `nodeExecuteAfter` (line 368,
 * after the enqueue the net does next cycle) + `ok`.
 *
 * `executionError` is this attempt's own (n8n's `this.executionError` is one field because
 * one node runs at a time; above k = 1 a sibling's failure must not be attributed to a node
 * that was already running). This is the end of one n8n loop iteration, so it is also where
 * the contract value is written: `haltError` when the error stops the execution, otherwise
 * the `leftoverError` this iteration leaves behind — exactly the two things n8n's single
 * field holds at the `break` and at the top of the next iteration.
 */
export async function record(
  env: ExecutionEnv,
  executionNode: INode,
  executionData: IExecuteData,
  taskStartedData: ITaskStartedData,
  runIndex: number,
  nodeSuccessDataIn: INodeExecutionData[][] | null | undefined,
  executionError: ExecutionBaseError | undefined,
  wait: WaitProbe,
  /**
   * An `onFailure` `route` step's target (ADR 0009). Applied *before* the task data is written,
   * so the run the editor shows is the run that happened — a rewrite afterwards would route one
   * way and record another.
   */
  routeTo?: RouteTo,
): Promise<Outcome> {
  const { host, runExecutionData, hooks } = env;
  let nodeSuccessData = nodeSuccessDataIn;
  const taskData = taskDataFor(env, executionNode, executionData, taskStartedData, wait);
  host.recordDynamicCredentialsUser();

  if (executionError !== undefined) {
    const outcome = await host.handleNodeExecutionError({
      executionNode, executionData, taskData, executionError, nodeSuccessData, runIndex, hooks,
    });
    nodeSuccessData = outcome.nodeSuccessData;
    if (!outcome.continueExecution) {
      env.state.haltError ??= executionError;
      return { kind: 'halt' };
    }
  }
  // The iteration completes; n8n's field still holds this attempt's error (nothing clears it
  // until the *next* iteration starts), and `undefined` when the attempt succeeded.
  env.state.leftoverError = executionError;

  if (routeTo !== undefined) nodeSuccessData = routedBranch(routeTo);
  // n8n's loop dereferences the value here, after the node `try` (`stack-scheduler.ts`:
  // `host.normalizeNodeErrors(nodeSuccessData!)`). Its own handler can leave it null — it
  // continues a node whose `main[0]` is null without replacing it — and the loop then throws out
  // of `run()`. The same value reaches the same host call, so the same throw happens here and
  // `guarded` makes it the fatal error n8n's rejected `run()` is. A host that tolerates the null
  // does not change what n8n's loop does next, so the reproduction throws in its place.
  host.normalizeNodeErrors(nodeSuccessData!);
  if (nodeSuccessData === null || nodeSuccessData === undefined) {
    throw new TypeError(`node '${executionNode.name}': the error handler continued with no output, which n8n's loop dereferences`);
  }
  taskData.data = { main: nodeSuccessData } as ITaskDataConnections;
  host.rewireOutputLog(executionNode, taskData, nodeSuccessData, runIndex);
  host.upsertTaskData(executionNode.name, runIndex, taskData);

  const outcome = recordedOutcome(env, executionNode, executionData, nodeSuccessData, runIndex, wait);
  // Every branch runs the hook; on the `ok` one it is line 368.
  await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, runExecutionData]);
  return outcome;
}
