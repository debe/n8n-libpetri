/**
 * The token conventions between one node's attempts. A failure carries the *next* attempt's
 * number, the run that follows it carries that number as it stands, and a tool's dispatch
 * (`agent`, `roundId`) travels with every one of them, so the attempt that finally answers
 * still knows which agent asked.
 */
import type { ITaskStartedData } from 'n8n-workflow';
import type { Outcome } from './outcomes.js';
import type { RetryPayload, RetryReason, RunPayload } from './payloads.js';

/**
 * The dispatch fields a tool's payload carries across every attempt (`agent`, `roundId`), as a
 * spread: empty for a node on a main edge, which has neither.
 */
export function carried(p: { readonly agent?: string; readonly roundId?: string }): { readonly agent?: string; readonly roundId?: string } {
  return {
    ...(p.agent === undefined ? {} : { agent: p.agent }),
    ...(p.roundId === undefined ? {} : { roundId: p.roundId }),
  };
}

/**
 * The `X/retry` outcome: no iteration has completed, so nothing is written to the contract
 * value. n8n clears `this.executionError` at the top of the *next* try (line 107) and always
 * reaches it, so a transient failure is never observable outside the retry loop. The net can
 * stop between attempts (`_pause`, or `executor.close()` on a cancellation: `X_retry_wait`
 * never fires), and an error left behind would make `processRunExecutionData` report the
 * execution as failed instead of canceled (`workflow-execute.ts:2240`). The final attempt
 * writes the value it ends on through `record`.
 */
export function retryOutcome(
  run: RunPayload, taskStartedData: ITaskStartedData, waitTillBefore: Date | undefined, reason: RetryReason,
): Outcome {
  // Same convention throughout: a failure carries the *next* attempt's number, and a tool's
  // dispatch travels with it so the attempt that finally answers still knows which agent asked.
  const payload: RetryPayload = {
    kind: 'retry', executionData: run.executionData, attempt: run.attempt + 1, taskStartedData, waitTillBefore, reason,
    ...carried(run),
  };
  return { kind: 'retry', payload };
}

/**
 * The run that follows a failure, for `X_retry_wait` and an `onFailure` chain's `retry` step
 * alike. The failure already advanced the counter when it was built, so the next run carries
 * `r.attempt` as it stands. A soft failure resumes inside n8n's inner loop; a thrown or
 * timed-out one re-enters the whole try body, since neither left a `runNodeData` to resume
 * from. A tool's next attempt still answers the agent that dispatched it.
 */
export function nextAttempt(r: RetryPayload): RunPayload {
  return {
    kind: 'run', executionData: r.executionData, attempt: r.attempt, taskStartedData: r.taskStartedData,
    softRetry: r.reason.kind === 'soft',
    ...carried(r),
  };
}
