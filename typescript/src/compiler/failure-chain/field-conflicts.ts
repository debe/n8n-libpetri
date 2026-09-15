/**
 * The node fields an `onFailure` chain cannot sit beside: n8n's own `retryOnFail` and `onError`
 * say the same thing at a different resolution, and a `timeoutMs` needs a chain to receive the
 * expiry.
 */
import { PolicyError } from '../policy.js';
import type { NodeDescription } from '../types.js';

/** A `timeoutMs` declared without an `onFailure` chain: nothing would say what an expired attempt does. */
export function refuseDeadlineWithoutChain(timeoutMs: number | undefined, where: string): void {
  if (timeoutMs === undefined) return;
  throw new PolicyError(where, [
    `${where}: executionPolicy.timeoutMs needs an onFailure chain to say what an expired ` +
    'attempt does']);
}

/** The problems of a chain declared beside `retryOnFail` or an `onError` that claims its terminal. */
export function fieldConflictsOf(node: NodeDescription, where: string): string[] {
  const problems: string[] = [];
  if (node.retryOnFail === true) {
    problems.push(
      `${where}: executionPolicy.onFailure and retryOnFail both set; onFailure is the same ` +
      'policy at a finer resolution, so declare one of them');
  }
  // `continueErrorOutput` is allowed beside a chain, and is the only way to get a second arc
  // out of a node that has one main output: `NodeHelpers.getNodeOutputs` appends the error
  // output purely on this field, which is what makes the editor draw the port and lets a user
  // wire it. So the two divide cleanly — `onError` declares the *shape*, `onFailure` decides
  // the *policy* — and a `route` step can then name `'error'`.
  //
  // `continueRegularOutput` is refused because it declares no port and claims the terminal the
  // chain already owns.
  if (node.onError !== undefined
    && node.onError !== 'stopWorkflow'
    && node.onError !== 'continueErrorOutput') {
    problems.push(
      `${where}: executionPolicy.onFailure and onError '${node.onError}' both set; the chain's ` +
      "last step is this node's error policy, so declare one of them (onError " +
      "'continueErrorOutput' is the exception: it declares the error output the chain routes to)");
  }
  return problems;
}
