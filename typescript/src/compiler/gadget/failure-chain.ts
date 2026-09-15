/**
 * The failure side of the gadget: n8n's own `retryOnFail` gadget (`X/retry`, `X/tries`,
 * `X_retry_wait`, `X_exhausted`) and the unrolled `onFailure` chain of ADR 0009 — one
 * `running` / `failed` pair per attempt, the step answering each failure, and the IO-013
 * deadline funnel.
 */
import { Transition, delayed, one, outPlace } from 'libpetri';
import type { Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { InternalCompilerError } from '../errors.js';
import { PLACE, TRANSITION, attemptStepOf, deadlineOf, failedOf, runningOf, timedOutOf } from '../names.js';
import { xorOf, type GadgetContext, type LocalAttempt, type LocalAttemptCommon, type LocalRetry } from './context.js';
import type { OutcomeBranches } from './output-side.js';
import type { Markers, SharedPorts } from './ports.js';

/** The attempts of an `onFailure` chain over local places, ascending; empty without one. */
export interface FailureChainPlaces {
  readonly attempts: readonly LocalAttempt[];
  /** The declared per-attempt deadline (IO-013); `null` when undeclared. */
  readonly chainTimeoutMs: number | null;
}

/** `X/retry` and `X/tries` of a `retryOnFail` node; `null` when it declares none. */
export function declareRetryPlaces(ctx: GadgetContext): LocalRetry | null {
  const { a, internal } = ctx;

  // ---- retry places ----
  const retry: LocalRetry | null = a.retry === null ? null : {
    retry: internal(PLACE.retry, 'retry', null),
    tries: internal(PLACE.tries, 'tries', null),
    maxTries: a.retry.maxTries,
    waitBetweenTries: a.retry.waitBetweenTries,
  };
  return retry;
}

/** One `running` / `failed` (and `timedout`) pair per attempt, linked from the end. */
export function declareFailureChain(ctx: GadgetContext, running: Place<unknown>): FailureChainPlaces {
  const { a, name, internal } = ctx;

  // ---- onFailure chain places (ADR 0009) ----
  // One `running` / `failed` pair per attempt, plus a `timedout` when a deadline is declared.
  // Attempt 1 reuses `X/running`, so `X_start` never learns the node has a policy and a
  // policy-free node compiles exactly as before.
  const chain = a.failure;
  const chainSteps = chain?.steps ?? [];
  const chainTimeoutMs = chain?.timeoutMs ?? null;
  const created = chainSteps.map((step, i) => ({
    step,
    running: i === 0 ? running : internal(runningOf(step.attempt), 'running', null),
    failed: internal(failedOf(step.attempt), 'failed', null),
    timedOut: chainTimeoutMs === null ? null : internal(timedOutOf(step.attempt), 'failed', null),
  }));
  // Linked from the end, so a `retry` step's "next attempt" is the place already created for
  // it: the chain is unrolled, and `resolveFailureChain` guarantees the last step is terminal.
  const attempts: LocalAttempt[] = [];
  let next: Place<unknown> | null = null;
  for (const c of [...created].reverse()) {
    const common: LocalAttemptCommon = { index: c.step.attempt, running: c.running, failed: c.failed, timedOut: c.timedOut };
    let attempt: LocalAttempt;
    switch (c.step.action) {
      case 'retry':
        if (next === null) throw new InternalCompilerError(`internal: node '${name}' onFailure retry step ${c.step.attempt} has no next attempt`);
        attempt = { ...common, action: 'retry', waitMs: c.step.waitMs, next };
        break;
      case 'route':
        attempt = { ...common, action: 'route', outputIndex: c.step.outputIndex };
        break;
      case 'stop':
      case 'continue':
        attempt = { ...common, action: c.step.action };
        break;
      default: return assertNever(c.step, 'failure step');
    }
    attempts.unshift(attempt);
    next = c.running;
  }
  return { attempts, chainTimeoutMs };
}

/** `X_retry_wait` and `X_exhausted` of a `retryOnFail` node. */
export function buildRetryGadget(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  branches: OutcomeBranches,
  retry: LocalRetry | null,
): { readonly retryWaitName: string | null; readonly exhaustedName: string | null } {
  const { depth, body, tinfo, stopWorkflow } = ctx;
  const { halt, pause } = shared;
  const { idle, running } = markers;
  const { success, haltBranch, waitingBranch, stoppedBranch } = branches;

  // ---- retry gadget: the budget stays held across the wait (README, ADR 0004) ----
  let retryWaitName: string | null = null;
  let exhaustedName: string | null = null;
  if (retry !== null) {
    body.push(Transition.builder(TRANSITION.retryWait)
      .inputs(one(retry.retry), one(retry.tries), one(idle))
      .inhibitors(halt, pause)
      .timing(delayed(retry.waitBetweenTries))
      .outputs(outPlace(running))
      .priority(depth).build());
    retryWaitName = tinfo(TRANSITION.retryWait, { role: 'retry' });
    body.push(Transition.builder(TRANSITION.exhausted)
      .inputs(one(retry.retry))
      .inhibitors(retry.tries, halt)
      .outputs(xorOf([success, ...(stopWorkflow ? [haltBranch] : []), waitingBranch, stoppedBranch]))
      .priority(depth + 1).build());
    exhaustedName = tinfo(TRANSITION.exhausted, { role: 'exhausted' });
  }
  return { retryWaitName, exhaustedName };
}

/** The step answering each attempt's failure, and the deadline funnel before it. */
export function buildFailureSteps(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  branches: OutcomeBranches,
  attempts: readonly LocalAttempt[],
): { readonly attemptStepNames: readonly string[]; readonly attemptTimeoutNames: readonly string[] } {
  const { depth, body, tinfo } = ctx;
  const { halt, pause } = shared;
  const { idle } = markers;
  const { success, haltBranch, waitingBranch, stoppedBranch } = branches;

  // ---- the onFailure chain: one step per attempt, plus the deadline funnel (ADR 0009) ----
  //
  // This is `retry_wait` + `exhausted` generalised: a `retry` step is `retry_wait` with its own
  // delay, and a terminal step is `exhausted` with the outcome the workflow chose instead of
  // the one `onError` fixed. What it does not have is a counter — the position is the place,
  // so the allowance cannot leak across activations the way `X/tries` does.
  const attemptStepNames: string[] = [];
  const attemptTimeoutNames: string[] = [];
  for (const att of attempts) {
    if (att.timedOut !== null) {
      // A rename, structurally: it inhibits `_halt` like an arm and not `_pause`, so a paused
      // net still funnels and quiesces with one failure place marked rather than two.
      const local = deadlineOf(att.index);
      body.push(Transition.builder(local)
        .inputs(one(att.timedOut))
        .inhibitors(halt)
        .outputs(outPlace(att.failed))
        .priority(depth + 1).build());
      attemptTimeoutNames.push(tinfo(local, { role: 'deadline', attempt: att.index }));
    }
    const local = attemptStepOf(att.index);
    const b = Transition.builder(local).inputs(one(att.failed));
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
    body.push(b.build());
    attemptStepNames.push(tinfo(local, { role: 'attempt', attempt: att.index }));
  }
  return { attemptStepNames, attemptTimeoutNames };
}
