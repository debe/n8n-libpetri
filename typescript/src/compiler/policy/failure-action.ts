/**
 * The closed set of {@link FailureAction}s and the two facts about it the parser and the
 * failure-chain resolver ask: whether a raw value names one, and whether it ends the chain.
 */
import type { FailureAction } from '../policy.js';

/** Every {@link FailureAction}, in the order a message lists them. */
export const FAILURE_ACTIONS: readonly FailureAction[] = ['retry', 'route', 'stop', 'continue'];

/** `retry` continues the chain; everything else ends the activation. */
export function isTerminalAction(action: FailureAction): boolean {
  return action !== 'retry';
}

/** Whether `v` names a {@link FailureAction}; the one place a raw string becomes one. */
export function isFailureAction(v: unknown): v is FailureAction {
  return FAILURE_ACTIONS.some((action) => action === v);
}
