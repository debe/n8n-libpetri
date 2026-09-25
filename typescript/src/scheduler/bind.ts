/**
 * The scheduler's binder, and the per-role actions that are neither the start, the run loop, the
 * agent round nor the `onFailure` chain (`on-failure.ts`): `X_run` around {@link attempt},
 * `X_exhausted`, `X_retry_wait` and the per-output `X_route_o`.
 */
import type { Place, TransitionAction } from 'libpetri';
import { assertProfile, type ActionBinder, type NetMapView, type NodeGadget, type RouteTransition, type RunTransition } from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import { carried, nextAttempt } from './attempt-tokens.js';
import { envOf } from './env.js';
import { InternalSchedulerError } from './errors.js';
import { attemptOf, attemptStepAction, deadlineAction } from './on-failure.js';
import { guarded, routeOutput, take } from './outcomes.js';
import { isOkPayload, isRetryPayload, isRunPayload } from './payloads.js';
import { callsOutAction, dispatchAction, doneRequestAction, resumeAction, roundsOutAction } from './round.js';
import { exhaust } from './exhaust.js';
import { attempt } from './run-loop.js';
import { startAction } from './start.js';

function runAction(g: NodeGadget, map: NetMapView, info: RunTransition): TransitionAction {
  // With a chain each attempt has its own run transition and its own `X/running_i`; attempt 1
  // reuses `X/running`, so a policy-free node is untouched.
  const from = g.attempts.length === 0 ? g.running : attemptOf(g, info).running;
  return runFrom(g, map, from);
}

/**
 * `A_run_failed`: the budget-exceeded re-entry, read off `A/running_failed`. It is the same run
 * as {@link runAction} — `attempt` fails the activation with `toolCallBudgetExceeded` on the
 * `toolCallsExceeded` payload before `runNode` — only the place it reads differs.
 */
function runFailedAction(g: NodeGadget, map: NetMapView): TransitionAction {
  if (g.agent === null) throw new InternalSchedulerError(`internal: node '${g.node}' has a run-failed transition but no agent side`);
  return runFrom(g, map, g.agent.runningFailed);
}

function runFrom(g: NodeGadget, map: NetMapView, from: Place<unknown>): TransitionAction {
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

function exhaustedAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const retry = retryOf(g);
  return async (ctx) => {
    const env = envOf(ctx);
    const payload = take(ctx, retry, isRetryPayload);
    await guarded(ctx, env, g, map, payload.executionData, () => exhaust(env, payload),
      { kind: 'run', executionData: payload.executionData, attempt: payload.attempt, ...carried(payload) });
  };
}

function retryWaitAction(g: NodeGadget): TransitionAction {
  const retry = retryOf(g);
  return async (ctx) => {
    ctx.output(g.running, nextAttempt(take(ctx, retry, isRetryPayload)));
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
 * compiler's placeholders (`null`). It drives v1 gadgets only, and refuses an `engineV2` map
 * (`ProfileMismatchError`, `tasks/v2-profile-plan.md` decision 14).
 *
 * Only `X_run`, `X_exhausted` and a terminal `onFailure` step await anything (the node run and
 * the hooks). Every other action here is `async` solely because libpetri's `TransitionAction`
 * is a promise-returning signature; they resolve in the same turn they start.
 */
export function schedulerActions(): ActionBinder {
  return (info, map) => {
    assertProfile('schedulerActions', 'v1', map.profile);
    const g = map.node(info.node);
    switch (info.role) {
      case 'start': return startAction(g, map);
      case 'start-unmet': return startAction(g, map, info.reference);
      case 'run': return runAction(g, map, info);
      case 'run-failed': return runFailedAction(g, map);
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
