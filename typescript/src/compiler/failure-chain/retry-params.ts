/** n8n's `retryOnFail` parameters, clamped the way n8n reads them. */
import type { NodeDescription, RetryParams } from '../types.js';

/**
 * n8n's retry parameters as `WorkflowExecute.getRetryParams` reads them
 * (`workflow-execute.ts` @ `n8n@2.41.3`, lines 1805–1815):
 * `maxTries = min(5, max(2, node.maxTries || 3))`,
 * `waitBetweenTries = min(5000, max(0, node.waitBetweenTries || 1000))`.
 * `0`, `undefined` and `NaN` are falsy and take the default; out-of-range values are
 * clamped; nothing is rejected.
 */
export const DEFAULT_MAX_TRIES = 3;
export const MIN_MAX_TRIES = 2;
export const MAX_MAX_TRIES = 5;
export const DEFAULT_WAIT_BETWEEN_TRIES_MS = 1000;
export const MAX_WAIT_BETWEEN_TRIES_MS = 5000;

/** The clamped retry parameters of a `retryOnFail` node (see the constants above). */
export function retryParamsOf(node: Pick<NodeDescription, 'maxTries' | 'waitBetweenTries'>): RetryParams {
  return {
    maxTries: Math.min(MAX_MAX_TRIES, Math.max(MIN_MAX_TRIES, node.maxTries || DEFAULT_MAX_TRIES)),
    waitBetweenTries: Math.min(MAX_WAIT_BETWEEN_TRIES_MS, Math.max(0, node.waitBetweenTries || DEFAULT_WAIT_BETWEEN_TRIES_MS)),
  };
}
