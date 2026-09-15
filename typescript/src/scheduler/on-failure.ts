/**
 * The actions of an `onFailure` chain (ADR 0009): each step, and the deadline funnel that turns
 * an attempt's expiry into one more way it fails.
 */
import type { TransitionAction } from 'libpetri';
import type { IExecuteData } from 'n8n-workflow';
import type {
  AttemptGadget, AttemptTransition, DeadlineTransition, NetMapView, NodeGadget, RunTransition,
} from '../compiler/index.js';
import { carried, nextAttempt } from './attempt-tokens.js';
import { envOf } from './env.js';
import { InternalSchedulerError } from './errors.js';
import { guarded, take } from './outcomes.js';
import { isRetryPayload, isRunPayload, type RetryPayload } from './payloads.js';
import { exhaust } from './exhaust.js';

type RetryStep = Extract<AttemptGadget, { readonly action: 'retry' }>;
type TerminalStep = Exclude<AttemptGadget, RetryStep>;

/** The attempt a chain transition serves; the gadget names one per attempt it built. */
export function attemptOf(g: NodeGadget, info: RunTransition | AttemptTransition | DeadlineTransition): AttemptGadget {
  const attempt = g.attempts.find((a) => a.index === info.attempt);
  if (attempt === undefined) throw new InternalSchedulerError(`internal: node '${g.node}' has no attempt ${info.attempt} for '${info.name}'`);
  return attempt;
}

/**
 * `X/timedout_i` into `X/failed_i`: the deadline funnel (ADR 0009 §4).
 *
 * The token it moves is the very `RunPayload` the abandoned firing consumed — `forwardInput`
 * (IO-014) reproduces it, where IO-013's plain timeout child would have deposited a sentinel
 * and left the step with no `executionData`. Registering it as abandoned is what stops the
 * still-running `runNode` writing to n8n when it eventually resolves.
 */
export function deadlineAction(g: NodeGadget, info: DeadlineTransition): TransitionAction {
  const attempt = attemptOf(g, info);
  const { timedOut, failed } = attempt;
  const timeoutMs = g.attemptTimeoutMs;
  if (timedOut === null || timeoutMs === null) {
    throw new InternalSchedulerError(`internal: node '${g.node}' has a deadline funnel but attempt ${info.attempt} has no deadline`);
  }
  return async (ctx) => {
    const { state } = envOf(ctx);
    const run = take(ctx, timedOut, isRunPayload);
    state.abandoned.add(run);
    const started = state.startedData.get(run) ?? run.taskStartedData;
    if (started === undefined) {
      throw new InternalSchedulerError(
        `internal: node '${g.node}' timed out before its task-started data was recorded`);
    }
    const failure: RetryPayload = {
      kind: 'retry',
      executionData: run.executionData,
      // Same convention as `retryOutcome`: a failure carries the *next* attempt's number.
      attempt: run.attempt + 1,
      taskStartedData: started,
      reason: { kind: 'timeout', timeoutMs },
      ...carried(run),
    };
    ctx.output(failed, failure);
  };
}

/** Why this attempt failed, in one line, for the item a `route` step emits. */
function failureMessage(payload: RetryPayload): string {
  const reason = payload.reason;
  if (reason.kind === 'timeout') return `did not finish within ${reason.timeoutMs} ms`;
  if (reason.kind === 'error') {
    // `.message` rather than `instanceof Error`: `reportNodeExecutionError` is the host's, and it
    // is only contracted to return something error-*shaped* — `FakeHost` returns a plain object.
    const message = (reason.error as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string' && message !== '' ? message : String(reason.error);
  }
  const item = reason.runNodeData.data?.[0]?.[0]?.json?.['error'];
  return typeof item === 'string' ? item : 'the attempt returned an error item';
}

/** A `retry` step **is** `X_retry_wait` with the step's own delay: the next attempt's run, on its own place. */
function retryStepAction(attempt: RetryStep): TransitionAction {
  return async (ctx) => {
    const r = take(ctx, attempt.failed, isRetryPayload);
    ctx.output(attempt.next, nextAttempt(r));
  };
}

/**
 * The `onError` value each terminal step stands for. `route` borrows n8n's `continueErrorOutput`,
 * `continue` its `continueRegularOutput`. Both make `continuesOnError` true, so n8n's own
 * handler continues the execution; which output the payload lands on is decided by the step,
 * because n8n itself never routes a *thrown* failure to the error output —
 * `handleNodeErrorOutput` only sorts per-item errors out of an otherwise successful run
 * (divergence #27).
 */
const STEP_ON_ERROR = {
  stop: 'stopWorkflow', route: 'continueErrorOutput', continue: 'continueRegularOutput',
} as const satisfies Record<TerminalStep['action'], string>;

/**
 * A terminal step **is** `X_exhausted` with the outcome the workflow chose instead of the one
 * `onError` fixed. The step *is* this node's error policy, so n8n's own
 * `handleNodeExecutionError` is reused rather than reimplemented — with
 * `executionData.node.onError` set to the value the step named. n8n reads `onError` off
 * `executionData.node` (`continuesOnError`), not off the `executionNode` argument, which is why
 * the clone is on the execution data.
 */
function terminalStepAction(g: NodeGadget, attempt: TerminalStep, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const env = envOf(ctx);
    const payload = take(ctx, attempt.failed, isRetryPayload);
    const executionData: IExecuteData = {
      ...payload.executionData,
      node: { ...payload.executionData.node, onError: STEP_ON_ERROR[attempt.action] },
    };
    const routed: RetryPayload = { ...payload, executionData };
    // `route` names the output; `continue` leaves n8n's input passthrough on output 0.
    const routeTo = attempt.action === 'route'
      ? { index: attempt.outputIndex, message: failureMessage(payload) }
      : undefined;
    await guarded(ctx, env, g, map, executionData,
      async () => await exhaust(env, routed, routeTo),
      { kind: 'run', executionData, attempt: payload.attempt, taskStartedData: payload.taskStartedData, ...carried(payload) });
  };
}

/**
 * One step of an `onFailure` chain (ADR 0009 §3).
 *
 * The mapping is exact rather than new machinery: a `retry` step **is** `X_retry_wait` with the
 * step's own delay, and a terminal step **is** `X_exhausted` with the outcome the workflow chose
 * instead of the one `onError` fixed.
 */
export function attemptStepAction(g: NodeGadget, info: AttemptTransition, map: NetMapView): TransitionAction {
  const attempt = attemptOf(g, info);
  if (attempt.action === 'retry') return retryStepAction(attempt);
  return terminalStepAction(g, attempt, map);
}
