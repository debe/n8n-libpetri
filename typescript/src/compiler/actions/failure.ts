/**
 * The failure side: `X_retry_wait` of n8n's `retryOnFail`, and the unrolled `onFailure` chain
 * of ADR 0009 — each attempt's step and its deadline funnel.
 */
import type { TransitionAction } from 'libpetri';
import { assertNever } from '../../internal/assert.js';
import { InternalCompilerError } from '../errors.js';
import type { AttemptGadget, AttemptTransition, DeadlineTransition, NetMapView, NodeGadget } from '../types.js';
import { succeed, type RoutingPolicy } from './routing.js';

export function retryWaitAction(g: NodeGadget): TransitionAction {
  const { retry } = g;
  if (retry === null) throw new InternalCompilerError(`internal: node '${g.node}' has a retry_wait transition but no retry gadget`);
  return async (ctx) => {
    ctx.output(g.running, ctx.input(retry.retry));
  };
}

/** The attempt a chain transition serves; the gadget names one per attempt it built. */
function attemptOf(g: NodeGadget, info: AttemptTransition | DeadlineTransition): AttemptGadget {
  const attempt = g.attempts.find((att) => att.index === info.attempt);
  if (attempt === undefined) throw new InternalCompilerError(`internal: node '${g.node}' has no attempt ${info.attempt} for '${info.name}'`);
  return attempt;
}

/** The `onFailure` step for one attempt: escalate to the next, or take the terminal arm. */
export function attemptAction(
  g: NodeGadget, info: AttemptTransition, policy: RoutingPolicy, map: NetMapView,
): TransitionAction {
  const attempt = attemptOf(g, info);
  switch (attempt.action) {
    case 'retry':
      // The chain is unrolled, so "the next attempt" is a place rather than a decrement.
      return async (ctx) => {
        ctx.output(attempt.next, ctx.input(attempt.failed));
      };
    case 'stop':
      return async (ctx) => {
        ctx.input(attempt.failed);
        ctx.output(map.shared.halt, null);
        ctx.output(map.shared.budget, null);
      };
    case 'route':
    case 'continue':
      // `route` and `continue` share the success spec; which output carries the data is the
      // scheduler's decision, and the placeholder keeps its usual no-data routing.
      return async (ctx) => {
        succeed(ctx, g, policy, ctx.input(attempt.failed), map);
      };
    default: return assertNever(attempt, 'attempt');
  }
}

/** The deadline funnel: an expired attempt becomes the ordinary failure its step answers. */
export function deadlineAction(g: NodeGadget, info: DeadlineTransition): TransitionAction {
  const attempt = attemptOf(g, info);
  const { timedOut } = attempt;
  if (timedOut === null) throw new InternalCompilerError(`internal: node '${g.node}' has a deadline funnel but attempt ${info.attempt} has no timedout place`);
  return async (ctx) => {
    ctx.output(attempt.failed, ctx.input(timedOut));
  };
}
