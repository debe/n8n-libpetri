/**
 * The failure side of the gadget: n8n's own `retryOnFail` gadget (`X_retry_wait`, `X_exhausted`)
 * and the unrolled `onFailure` chain of ADR 0009 — the step answering each attempt's failure and
 * the IO-013 deadline funnel before it. The places (`X/retry`, `X/tries`, one `running` /
 * `failed` pair per attempt) are declared by `failure-places.ts` and re-exported here.
 */
import { Transition, delayed, one, outPlace } from 'libpetri';
import type { Place } from 'libpetri';
import { TRANSITION, attemptStepOf, deadlineOf } from '../names.js';
import type { GadgetContext } from './context.js';
import type { LocalAttempt, LocalRetry } from './local-shapes.js';
import type { OutcomeBranches } from './outcome.js';
import { xorOf } from './out-spec.js';
import type { Markers, SharedPorts } from './ports.js';

export { declareFailureChain, declareRetryPlaces, type FailureChainPlaces } from './failure-places.js';

/** `X_retry_wait` and `X_exhausted` of a `retryOnFail` node. */
export function buildRetryGadget(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  branches: OutcomeBranches,
  retry: LocalRetry | null,
): { readonly retryWaitName: string | null; readonly exhaustedName: string | null } {
  if (retry === null) return { retryWaitName: null, exhaustedName: null };
  const { depth, emit, stopWorkflow } = ctx;
  const { halt, pause } = shared;
  const { idle, running } = markers;
  const { success, haltBranch, waitingBranch, stoppedBranch } = branches;

  // ---- retry gadget: the budget stays held across the wait (README, ADR 0004) ----
  const retryWaitName = emit(Transition.builder(TRANSITION.retryWait)
    .inputs(one(retry.retry), one(retry.tries), one(idle))
    .inhibitors(halt, pause)
    .timing(delayed(retry.waitBetweenTries))
    .outputs(outPlace(running))
    .priority(depth).build(), { role: 'retry' });
  const exhaustedName = emit(Transition.builder(TRANSITION.exhausted)
    .inputs(one(retry.retry))
    .inhibitors(retry.tries, halt)
    .outputs(xorOf([success, ...(stopWorkflow ? [haltBranch] : []), waitingBranch, stoppedBranch]))
    .priority(depth + 1).build(), { role: 'exhausted' });
  return { retryWaitName, exhaustedName };
}

/** An attempt's deadline funnel: its expired `timedout_i` into its `failed_i`. */
function buildDeadline(ctx: GadgetContext, halt: Place<unknown>, att: LocalAttempt, timedOut: Place<unknown>): string {
  // A rename, structurally: it inhibits `_halt` like an arm and not `_pause`, so a paused
  // net still funnels and quiesces with one failure place marked rather than two.
  return ctx.emit(Transition.builder(deadlineOf(att.index))
    .inputs(one(timedOut))
    .inhibitors(halt)
    .outputs(outPlace(att.failed))
    .priority(ctx.depth + 1).build(), { role: 'deadline', attempt: att.index });
}

/** The step answering an attempt's failure: the next attempt after its delay, or a terminal outcome. */
function buildAttemptStep(ctx: GadgetContext, shared: SharedPorts, idle: Place<unknown>, branches: OutcomeBranches, att: LocalAttempt): string {
  const { depth } = ctx;
  const { halt, pause } = shared;
  const { success, haltBranch, waitingBranch, stoppedBranch } = branches;
  const b = Transition.builder(attemptStepOf(att.index)).inputs(one(att.failed));
  if (att.action === 'retry') {
    // Holds `_budget` across the wait, as n8n's retry loop does and as `retry_wait` does.
    b.inputs(one(idle))
      .inhibitors(halt, pause)
      .timing(delayed(att.waitMs))
      .outputs(outPlace(att.next))
      .priority(depth);
  } else {
    // A terminal step *is* `X_exhausted` with the outcome the workflow chose rather than the
    // one `onError` fixed, so it offers the same union: the recording it performs can still
    // end in a wait (the node set `waitTill`), a destination stop, or a halt — either because
    // the step said `stop` or because `guarded` caught a fatal outside n8n's own try.
    // `route` and `continue` differ only in which output carries the data, which is a value
    // decision the action makes inside the one `success` branch.
    b.inhibitors(halt)
      .outputs(xorOf([success, haltBranch, waitingBranch, stoppedBranch]))
      .priority(depth + 1);
  }
  return ctx.emit(b.build(), { role: 'attempt', attempt: att.index });
}

/** The step answering each attempt's failure, and the deadline funnel before it. */
export function buildFailureSteps(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  branches: OutcomeBranches,
  attempts: readonly LocalAttempt[],
): { readonly attemptStepNames: readonly string[]; readonly attemptTimeoutNames: readonly string[] } {
  // ---- the onFailure chain: one step per attempt, plus the deadline funnel (ADR 0009) ----
  //
  // This is `retry_wait` + `exhausted` generalised: a `retry` step is `retry_wait` with its own
  // delay, and a terminal step is `exhausted` with the outcome the workflow chose instead of
  // the one `onError` fixed. What it does not have is a counter — the position is the place,
  // so the allowance cannot leak across activations the way `X/tries` does.
  const attemptStepNames: string[] = [];
  const attemptTimeoutNames: string[] = [];
  for (const att of attempts) {
    if (att.timedOut !== null) attemptTimeoutNames.push(buildDeadline(ctx, shared.halt, att, att.timedOut));
    attemptStepNames.push(buildAttemptStep(ctx, shared, markers.idle, branches, att));
  }
  return { attemptStepNames, attemptTimeoutNames };
}
