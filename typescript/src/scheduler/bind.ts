/**
 * The scheduler's binder, and the per-role actions that are neither the start, the run loop nor
 * the agent round: `X_run` around {@link attempt}, `X_exhausted`, the `onFailure` chain's steps
 * and deadline funnel (ADR 0009), `X_retry_wait` and the per-output `X_route_o`.
 */
import type { Place, TransitionAction } from 'libpetri';
import type { IExecuteData } from 'n8n-workflow';
import type {
  ActionBinder, AttemptGadget, AttemptTransition, DeadlineTransition, NetMapView, NodeGadget, RouteTransition,
  RunTransition,
} from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import { envOf } from './env.js';
import { InternalSchedulerError } from './errors.js';
import { guarded, routeOutput, take } from './outcomes.js';
import { isOkPayload, isRetryPayload, isRunPayload, type RetryPayload, type RunPayload } from './payloads.js';
import { callsOutAction, dispatchAction, doneRequestAction, resumeAction, roundsOutAction } from './round.js';
import { attempt, carried, exhaust } from './run-loop.js';
import { startAction } from './start.js';

function runAction(g: NodeGadget, map: NetMapView, info: RunTransition): TransitionAction {
  // With a chain each attempt has its own run transition and its own `X/running_i`; attempt 1
  // reuses `X/running`, so a policy-free node is untouched.
  const from = g.attempts.length === 0 ? g.running : attemptOf(g, info).running;
  return async (ctx) => {
    const env = envOf(ctx);
    const { state } = env;
    const payload = take(ctx, from, isRunPayload);
    state.inFlight++;
    if (state.inFlight > state.maxInFlight) state.maxInFlight = state.inFlight;
    try {
      await guarded(ctx, env, g, map, payload.executionData, () => attempt(env, g, payload), payload);
    } finally {
      state.inFlight--;
    }
    ctx.output(g.idle, null);
  };
}

/** The retry gadget of a node whose `X_retry_wait` / `X_exhausted` is being bound: the gadget built them only with one. */
function retryOf(g: NodeGadget): Place<unknown> {
  if (g.retry === null) throw new InternalSchedulerError(`internal: node '${g.node}' has a retry transition but no retry gadget`);
  return g.retry.retry;
}

/** The attempt a chain transition serves; the gadget names one per attempt it built. */
function attemptOf(g: NodeGadget, info: RunTransition | AttemptTransition | DeadlineTransition): AttemptGadget {
  const attempt = g.attempts.find((a) => a.index === info.attempt);
  if (attempt === undefined) throw new InternalSchedulerError(`internal: node '${g.node}' has no attempt ${info.attempt} for '${info.name}'`);
  return attempt;
}

function exhaustedAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const retry = retryOf(g);
  return async (ctx) => {
    const env = envOf(ctx);
    const payload = take(ctx, retry, isRetryPayload);
    await guarded(ctx, env, g, map, payload.executionData, () => exhaust(env, payload),
      { kind: 'run', executionData: payload.executionData, attempt: payload.attempt, ...carried(payload) });
  };
}

/**
 * `X/timedout_i` into `X/failed_i`: the deadline funnel (ADR 0009 §4).
 *
 * The token it moves is the very `RunPayload` the abandoned firing consumed — `forwardInput`
 * (IO-014) reproduces it, where IO-013's plain timeout child would have deposited a sentinel
 * and left the step with no `executionData`. Registering it as abandoned is what stops the
 * still-running `runNode` writing to n8n when it eventually resolves.
 */
function deadlineAction(g: NodeGadget, info: DeadlineTransition): TransitionAction {
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

/**
 * One step of an `onFailure` chain (ADR 0009 §3).
 *
 * The mapping is exact rather than new machinery: a `retry` step **is** `X_retry_wait` with the
 * step's own delay, and a terminal step **is** `X_exhausted` with the outcome the workflow chose
 * instead of the one `onError` fixed.
 */
function attemptStepAction(g: NodeGadget, info: AttemptTransition, map: NetMapView): TransitionAction {
  const attempt = attemptOf(g, info);
  if (attempt.action === 'retry') {
    return async (ctx) => {
      const r = take(ctx, attempt.failed, isRetryPayload);
      const payload: RunPayload = {
        kind: 'run',
        // `retryOutcome` already advanced the counter when it built this failure, so the next
        // run carries `r.attempt` as it stands — the same convention `X_retry_wait` uses.
        executionData: r.executionData, attempt: r.attempt, taskStartedData: r.taskStartedData,
        // A soft failure resumes inside n8n's inner loop; a thrown or timed-out one re-enters
        // the whole try body, since neither left a `runNodeData` to resume from.
        softRetry: r.reason.kind === 'soft',
        ...carried(r),
      };
      ctx.output(attempt.next, payload);
    };
  }
  return async (ctx) => {
    const env = envOf(ctx);
    const payload = take(ctx, attempt.failed, isRetryPayload);
    // The terminal step *is* this node's error policy, so n8n's own `handleNodeExecutionError`
    // is reused rather than reimplemented — with `executionData.node.onError` set to the value
    // the step named. n8n reads `onError` off `executionData.node` (`continuesOnError`), not off
    // the `executionNode` argument, which is why the clone is on the execution data.
    // `route` borrows n8n's `continueErrorOutput`, `continue` its `continueRegularOutput`.
    // Both make `continuesOnError` true, so n8n's own handler continues the execution; which
    // output the payload lands on is decided below, because n8n itself never routes a *thrown*
    // failure to the error output — `handleNodeErrorOutput` only sorts per-item errors out of
    // an otherwise successful run (divergence #27).
    const onError = attempt.action === 'stop' ? 'stopWorkflow'
      : attempt.action === 'route' ? 'continueErrorOutput' : 'continueRegularOutput';
    const executionData: IExecuteData = {
      ...payload.executionData,
      node: { ...payload.executionData.node, onError },
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

function retryWaitAction(g: NodeGadget): TransitionAction {
  const retry = retryOf(g);
  return async (ctx) => {
    const r = take(ctx, retry, isRetryPayload);
    const next: RunPayload = {
      kind: 'run', executionData: r.executionData, attempt: r.attempt, taskStartedData: r.taskStartedData,
      // A soft failure resumes inside n8n's inner loop; a thrown one re-enters the try body.
      softRetry: r.reason.kind === 'soft',
      // A tool's next attempt still answers the agent that dispatched it.
      ...carried(r),
    };
    ctx.output(g.running, next);
  };
}

/** Per-output routing only (`routing.kind === 'split'`): `X_route_o` drains one `X/ok_o`. */
function routeAction(g: NodeGadget, info: RouteTransition): TransitionAction {
  if (g.routing.kind !== 'split') throw new InternalSchedulerError(`internal: node '${g.node}' has a route transition but routes in X_run`);
  const out = g.routing.outputs.find((o) => o.index === info.port);
  if (out === undefined) throw new InternalSchedulerError(`internal: node '${g.node}' has no output ${info.port} for '${info.name}'`);
  return async (ctx) => {
    for (const d of routeOutput(g, out, take(ctx, out.ok, isOkPayload))) ctx.output(d.place, d.value);
    ctx.output(out.routed, null);
  };
}

/**
 * The scheduler's binder. Structural roles (`skip`, `arm`, `clear`, `sink`, `done`) keep the
 * compiler's placeholders (`null`).
 *
 * Only `X_run`, `X_exhausted` and a terminal `onFailure` step await anything (the node run and
 * the hooks). Every other action here is `async` solely because libpetri's `TransitionAction`
 * is a promise-returning signature; they resolve in the same turn they start.
 */
export function schedulerActions(): ActionBinder {
  return (info, map) => {
    const g = map.node(info.node);
    switch (info.role) {
      case 'start': return startAction(g, map);
      case 'start-unmet': return startAction(g, map, info.reference);
      case 'run': return runAction(g, map, info);
      case 'attempt': return attemptStepAction(g, info, map);
      case 'deadline': return deadlineAction(g, info);
      case 'route': return routeAction(g, info);
      case 'retry': return retryWaitAction(g);
      case 'exhausted': return exhaustedAction(g, map);
      case 'done-request': return doneRequestAction(g, map);
      case 'dispatch': return dispatchAction(g, map);
      case 'resume': return resumeAction(g);
      case 'rounds-out': return roundsOutAction(g, map);
      case 'calls-out': return callsOutAction(g);
      // The structural roles keep the compiler's placeholders. `collect` produces nothing (a
      // genuine sink, CORE-043 AC4): pairing one response with one outstanding marker is the
      // whole of its effect, and the marking is where it lands.
      case 'done':
      case 'skip':
      case 'arm':
      case 'clear':
      case 'sink':
      case 'collect': return null;
      default: return assertNever(info, 'transition role');
    }
  };
}
