/**
 * The actions bound to the compiled net — the whole of n8n's execution loop that is not
 * scheduling. Every line of `stack-scheduler.ts` (n8n `441970b`, patch 0001) that touches
 * the host is mirrored here, in the same order, on the transition whose firing corresponds
 * to it; the stack machinery (`isExecutionStackNotEmpty`, `popExecutionStack`,
 * `addNodeToBeExecuted`, the sibling sort, the R6 stuck-join fallback) is what the net
 * stands in for, and is never called.
 *
 * Per role (README "Per-node gadget"):
 * - `start` / `start-unmet`: instantaneous; build the node's `IExecuteData` from the input
 *   token(s) (`addNodeToBeExecuted`'s shape) and move it to `X/running` with `attempt = 0`
 *   and, for the twin, the unmet reference;
 * - `run`: one attempt of the node (lines 49–212), then the after-loop recording (214–268)
 *   unless a retry is possible; ends on the routed success branch (the edge tokens plus
 *   `X/routed`, or one `X/ok_o` per output under per-output routing), `X/retry`, the halt
 *   branch, `X/waiting` (`waitTill`) or `X/stopped` (destination node, or a cancellation
 *   before the run);
 * - `retry` (`X_retry_wait`): the net's `delayed(waitBetweenTries)` replaces the `sleep`
 *   (lines 108–117 and 146); the token becomes the next attempt's running token, marked
 *   `softRetry` when it came from an error *item* — that attempt is n8n's inner `while`
 *   loop, a bare `runNode` with none of the per-entry preamble around it;
 * - `exhausted`: the after-loop handling of the last attempt — the recorded error for a
 *   thrown one, the regular success path for a "soft" failure (an error item on the first
 *   output, which n8n stops re-running once the tries are used up);
 * - `route` / `done`: lines 272–362, one token per connected edge: `data` when
 *   `nodeSuccessData[o]` is non-empty (the same array reference for every connection of
 *   that output), `empty` / `nil` otherwise, with the n8n `source`; the budget refund and
 *   `X/done`;
 * - `skip`, `arm`, `clear`, `sink`: structural, the compiler's placeholders.
 *
 * A halt writes `_halt` and stops there: nothing consumes it and nothing clears the pending
 * activations, so the quiescent marking still holds each of them where it was delivered and
 * the scheduler puts them back on `nodeExecutionStack`, where n8n's `break` leaves them.
 *
 * `nodeExecuteAfter` for the ok branch runs at the end of the action: n8n runs it after
 * enqueuing the successors and before any of them runs (line 368); `X_route` fires the next
 * cycle, so the observable order is preserved. The action never throws (EXEC-030 would lose
 * the consumed tokens and the budget with them): anything the mirrored code does not catch
 * — which in n8n would reject `run()` (a hook rejecting, a host helper throwing outside
 * n8n's own `try`) — sets `executionError` (n8n's `{ ...e, message, stack }` shape), is
 * stored as the execution's fatal error and takes the halt branch so nothing new starts and
 * the net quiesces (the `stopped` outcome on a node whose `onError` policy gives `X_run` no
 * halt alternative); the scheduler rethrows it after quiescence, as n8n's `run()` rejects.
 *
 * Per-execution state reaches the actions through the executor's execution context under
 * {@link ENV_KEY} (`executionContextProvider`); the compiled workflow and its actions are
 * shared by every execution of the workflow version.
 *
 * The module is split along those concerns; this file re-exports what it always exported.
 * - `env.ts`: the per-execution state ({@link ExecutionEnv}, {@link SchedulerState});
 * - `start.ts`: `X_start` / `X_start_unmet`;
 * - `run-loop.ts`: one attempt, the mirror of n8n's loop (`attempt`, `record`, `exhaust`);
 * - `wait-claim.ts`: which node put the execution to wait (divergence #15);
 * - `round.ts`: the agent's tool round (ADR 0008);
 * - `outcomes.ts`: an outcome as the tokens its firing deposits, and the token it consumed;
 * - `bind.ts`: the binder, and the remaining per-role actions.
 */
export { ENV_KEY, type ExecutionEnv, type SchedulerState } from './env.js';
export { UnexpectedTokenError } from './outcomes.js';
export { schedulerActions } from './bind.js';
