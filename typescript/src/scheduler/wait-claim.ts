/**
 * Which node put the execution to wait (divergence #15): the claim one attempt makes on the
 * execution-global `runExecutionData.waitTill`, probed in the turn its own `runNode` resolves.
 */
import type { INode } from 'n8n-workflow';
import type { ExecutionEnv } from './env.js';

/**
 * What one node's attempt makes of `runExecutionData.waitTill` (divergence #15).
 *
 * - `claimed` — this node put the execution to wait: it takes the `waiting` branch and is
 *   pushed back on `nodeExecutionStack` to re-run on resume, as n8n does.
 * - `foreign` — the field is set, but another node claimed it. The field changed while this
 *   node was running, so `host.createTaskData` stamped `executionStatus: 'waiting'` on a run
 *   that in fact completed; the stamp is corrected to what the run actually was. Reachable
 *   only above k = 1.
 * - `none` — no pause, or a pause that was already there when this node started and that
 *   nobody has claimed (n8n's own reading of the field, kept byte-identical).
 */
export type WaitClaim = 'claimed' | 'foreign' | 'none';

/** A memoised {@link observeWait} for one attempt: probed once, read by every branch. */
export type WaitProbe = () => WaitClaim;

/**
 * Did **this** node put the execution to wait (n8n's `if (runExecutionData.waitTill)`)?
 * The field is execution-global, which is unambiguous for n8n — one node runs at a time and
 * `handleWaitingState` clears it before the scheduler runs (`workflow-execute.ts:1502-1503`,
 * called at `:2228`) — but not for the net: above k = 1 a sibling still in flight when a
 * Wait node sets it, or a node whose `X_exhausted` fires after the pause (`_pause` does not
 * inhibit it), would take the waiting branch too, be pushed back on the stack and run a
 * second time on resume. Two signals narrow it to the node that waited: the value must have
 * changed during this node's own attempt (`before` is read just ahead of its `runNode`), and
 * the first node to claim it keeps it. At k = 1 `before` is always `undefined` and no other
 * node can be between the two, so this is byte-identical to n8n's test.
 *
 * {@link probeWait} makes the claim in the same synchronous turn in which the node's own
 * `runNode` resolves, so the claim order is the order the runs finished, not the order the
 * recording paths happen to reach this test. What is left undecidable from outside the node
 * — a node that sets the field and then keeps working while a sibling finishes — is a
 * refused claim with a diagnostic (divergence #15).
 */
export function observeWait(env: ExecutionEnv, executionNode: INode, before: Date | undefined): WaitClaim {
  const { state, runExecutionData } = env;
  const waitTill = runExecutionData.waitTill;
  if (!waitTill) return 'none';
  if (state.waitingNode === executionNode.name) return 'claimed';
  // The value `run()` started with: no node of this execution set it, so this is n8n's own
  // reading of the field (unreachable under v1 — `handleWaitingState` clears it at
  // `workflow-execute.ts:1502-1503` before the scheduler runs).
  if (waitTill === state.waitTillAtStart) return 'none';
  if (state.waitingNode === undefined && waitTill !== before) {
    state.waitingNode = executionNode.name;
    return 'claimed';
  }
  // Some node of this execution set it and this is not that node: either it has already
  // claimed, or it is still running and will (this node started after the field changed).
  env.diagnostic(
    `node '${executionNode.name}': the execution was put to wait while this node was running` +
    `${state.waitingNode === undefined ? '' : ` (by '${state.waitingNode}')`}; recorded as a normal run (k > 1)`);
  return 'foreign';
}

/**
 * The claim probe of one attempt. Call it in the same turn as the node's own `runNode`
 * resolution; every later branch reads the memoised answer.
 */
export function probeWait(env: ExecutionEnv, executionNode: INode, before: Date | undefined): WaitProbe {
  let claim: WaitClaim | undefined;
  return () => (claim ??= observeWait(env, executionNode, before));
}
