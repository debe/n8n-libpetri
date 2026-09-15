/**
 * The failure side's places: n8n's own `retryOnFail` (`X/retry`, `X/tries`) and the unrolled
 * `onFailure` chain of ADR 0009 — one `running` / `failed` pair per attempt, plus a `timedout`
 * where an IO-013 deadline is declared.
 */
import type { Place } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { InternalCompilerError } from '../errors.js';
import { PLACE, failedOf, runningOf, timedOutOf } from '../names.js';
import type { ResolvedStep } from '../types.js';
import type { GadgetContext } from './context.js';
import type { LocalAttempt, LocalAttemptCommon, LocalRetry } from './local-shapes.js';

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

/** One attempt over its places; a `retry` step escalates to `next`, the following attempt's `running`. */
function attemptOf(name: string, step: ResolvedStep, common: LocalAttemptCommon, next: Place<unknown> | null): LocalAttempt {
  switch (step.action) {
    case 'retry':
      if (next === null) throw new InternalCompilerError(`internal: node '${name}' onFailure retry step ${step.attempt} has no next attempt`);
      return { ...common, action: 'retry', waitMs: step.waitMs, next };
    case 'route':
      return { ...common, action: 'route', outputIndex: step.outputIndex };
    case 'stop':
    case 'continue':
      return { ...common, action: step.action };
    default: return assertNever(step, 'failure step');
  }
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
    attempts.unshift(attemptOf(name, c.step, common, next));
    next = c.running;
  }
  return { attempts, chainTimeoutMs };
}
