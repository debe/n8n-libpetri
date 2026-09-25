/**
 * `X_exhausted`: the after-loop handling of a node's last attempt (`stack-scheduler.ts` at
 * `n8n@2.41.3`, patch 0001), for n8n's own retry counter and for a terminal `onFailure` step alike.
 * The failure the attempt left on its retry token is recorded through the same path n8n's loop
 * takes when it leaves the try loop with that failure (`record.ts`).
 */
import type { ExecutionBaseError } from 'n8n-workflow';
import type { ExecutionEnv } from './env.js';
import { attemptDeadlineExceeded } from './errors.js';
import type { Outcome } from './outcomes.js';
import type { RetryPayload } from './payloads.js';
import { finishSuccess, record, type RouteTo } from './record.js';
import { postRun } from './run-output.js';
import { probeWait } from './wait-claim.js';

/** `X_exhausted`: the after-loop handling of the last attempt. */
export async function exhaust(env: ExecutionEnv, payload: RetryPayload, routeTo?: RouteTo): Promise<Outcome> {
  const { host } = env;
  const { executionData, taskStartedData, reason } = payload;
  const executionNode = executionData.node;
  const runIndex = host.computeRunIndex(executionData);
  // The attempt that produced this token read `waitTill` before its own `runNode`; probing
  // here is the earliest point after that run, since the run itself is already over.
  const wait = probeWait(env, executionNode, payload.waitTillBefore);
  wait();
  if (reason.kind === 'error') {
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, reason.error as ExecutionBaseError, wait, routeTo);
  }
  if (reason.kind === 'timeout') {
    // The node never threw; the engine abandoned its firing. Recorded like any other node
    // failure so `runData`, the hooks and `onError` all see one, which is what lets the
    // terminal step reuse n8n's own error handling unchanged.
    const error = host.reportNodeExecutionError(
      attemptDeadlineExceeded(executionNode, reason.timeoutMs, payload.attempt), executionNode, env.workflow);
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, error, wait, routeTo);
  }
  // A soft failure with no try left is processed like any other output (line 176 on).
  try {
    const nodeSuccessData = await postRun(env, executionNode, executionData, taskStartedData, runIndex, reason.runNodeData);
    return await finishSuccess(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, wait);
  } catch (error) {
    const executionError = host.reportNodeExecutionError(error, executionNode, env.workflow);
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, executionError, wait, routeTo);
  }
}
