/**
 * The per-entry steps of one attempt, before n8n's node `try` (`stack-scheduler.ts` lines
 * 49–101 at `441970b`, patch 0001): the stop poll, the attempt-0 setup, the run index, the
 * filtered-out and input checks, and the retry read. `nodeExecuteBefore` (lines 95–97) sits
 * between the checks and the retry read and stays in the loop body (`run-loop.ts`), which
 * awaits it where n8n does.
 */
import type { ITaskStartedData } from 'n8n-workflow';
import type { NodeGadget } from '../compiler/index.js';
import type { ExecutionEnv } from './env.js';
import { emptyOutcome, type Outcome } from './outcomes.js';
import type { RunPayload } from './payloads.js';

/** The per-entry steps let the attempt proceed: what they computed for it. */
export interface AttemptStart {
  readonly kind: 'start';
  readonly taskStartedData: ITaskStartedData;
  readonly runIndex: number;
}

/** Lines 60–65 on attempt 0; a later attempt reuses the `taskStartedData` attempt 0 created. */
function taskStartedDataOf(env: ExecutionEnv, payload: RunPayload): ITaskStartedData {
  if (payload.attempt !== 0) return payload.taskStartedData!;
  const { host } = env;
  const { executionData } = payload;
  host.resetDynamicCredentialsUsage(executionData); // line 60
  const taskStartedData = host.createTaskStartedData(executionData); // line 62
  executionData.data = host.addPairedItemLineage(executionData); // line 65
  return taskStartedData;
}

/**
 * Lines 74–82, on attempt 0 only: whether the entry is dropped before it runs. Either way the
 * activation records nothing and its iteration leaves n8n's field cleared.
 */
function dropped(env: ExecutionEnv, payload: RunPayload): boolean {
  const { host, workflow, state } = env;
  const { executionData } = payload;
  const executionNode = executionData.node;
  // Lines 74–76: a filtered-out node is skipped entirely — no run, no task data, no hook.
  if (host.isNodeFilteredOut(executionNode.name)) {
    state.leftoverError = undefined;
    return true;
  }
  // Lines 78–82: n8n defers the entry to the end of the stack and, once it comes round
  // again unchanged, throws its endless-loop error. Under v1 this is only reachable for an
  // entry without `data.main`, which no start action produces; a decoded one is dropped.
  if (!host.ensureInputData(workflow, executionNode, executionData)) {
    env.diagnostic(
      `node '${executionNode.name}': ensureInputData is false; n8n would defer the entry to the end of the ` +
      'stack (and then stop with its endless-loop error); the activation is dropped and nothing is recorded');
    state.leftoverError = undefined;
    return true;
  }
  return false;
}

/**
 * Lines 49–82: the steps before `nodeExecuteBefore`. Returns the outcome that ends the attempt
 * here, or what the attempt proceeds with.
 */
export function enterAttempt(env: ExecutionEnv, payload: RunPayload): Outcome | AttemptStart {
  const { host, state } = env;
  const { executionData } = payload;

  // Lines 49–51: polled once per popped entry, before the try loop — nothing inside the loop
  // re-checks it, so a stop arriving between attempts still lets n8n finish the tries and
  // record the node instead of discarding a node that has already run.
  if (payload.attempt === 0 && host.shouldStopExecuting()) return { kind: 'stopped', executionData, ran: false };

  // Lines 53–56 (line 107 on later tries): fresh per-attempt state — the run's own
  // `EngineResponse` is created where the run is. n8n's line 56
  // (`this.executionError = undefined`) is not mirrored: it clears a field this activation
  // does not own. What the previous iteration left is `state.leftoverError`, and this
  // activation overwrites it when it completes (see `record`).
  const taskStartedData = taskStartedDataOf(env, payload);
  // Reachable by the deadline funnel, which sees this payload and nothing else.
  state.startedData.set(payload, taskStartedData);
  // Line 67. Recomputed per attempt: runData of this node does not change between attempts.
  const runIndex = host.computeRunIndex(executionData);
  // Lines 69–72, the endless-loop guard: abandoned (divergence #6).
  if (payload.attempt === 0 && dropped(env, payload)) return emptyOutcome(runIndex);
  return { kind: 'start', taskStartedData, runIndex };
}

/**
 * Line 101: whether a failure of this attempt may go to the net as a retry, read once per
 * popped entry as n8n reads it (outside the try loop): `[1, 0]` for a node without
 * `retryOnFail` or resuming with `metadata.resumeError`. A later attempt only exists because
 * that read allowed one, so the net (`X/tries`) decides from there on.
 *
 * An `onFailure` chain answers this for every attempt, including the last: it stands in for
 * n8n's counter (ADR 0009), so every failure lands on that attempt's `X/failed_i` and the
 * *step* decides — the run itself never records and never consults `onError` (ADR 0009 §3).
 * n8n's `getRetryParams` is still read on attempt 0, where n8n reads it.
 */
export function mayRetry(env: ExecutionEnv, g: NodeGadget, payload: RunPayload): boolean {
  if (payload.attempt !== 0) return g.attempts.length > 0 || g.retry !== null;
  const [maxTries] = env.host.getRetryParams(payload.executionData);
  return g.attempts.length > 0 || (maxTries > 1 && g.retry !== null);
}
