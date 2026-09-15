/**
 * Writing one attempt's outcome, and reading the token a firing consumed.
 *
 * An outcome becomes a complete list of deposits (`deposits.ts`) before anything is emitted,
 * and {@link guarded} is the one writer: whatever the body or the list throws takes the halt
 * (or stopped) branch, so a firing never loses the tokens and the budget unit it consumed
 * (EXEC-030). Reading the consumed token is `take.ts`. This module exports both halves' names
 * as it always has.
 */
import type { TransitionContext } from 'libpetri';
import type { IExecuteData, INodeExecutionData } from 'n8n-workflow';
import type { NetMapView, NodeGadget } from '../compiler/index.js';
import { deposits, hasHaltBranch, type Deposit } from './deposits.js';
import type { ExecutionEnv } from './env.js';
import { asExecutionError } from './errors.js';
import type { RequestPayload, RetryPayload, RunPayload } from './payloads.js';

export { dispatchOf, routeOutput } from './deposits.js';
export { take, UnexpectedTokenError } from './take.js';

export type Outcome =
  | { readonly kind: 'ok'; readonly nodeSuccessData: INodeExecutionData[][]; readonly runIndex: number }
  | { readonly kind: 'retry'; readonly payload: RetryPayload }
  | { readonly kind: 'halt' }
  | { readonly kind: 'waiting'; readonly executionData: IExecuteData }
  | { readonly kind: 'stopped'; readonly executionData: IExecuteData; readonly ran: boolean }
  /** The node returned an `EngineRequest`: `A_done_req` opens a tool round from this payload. */
  | { readonly kind: 'request'; readonly payload: RequestPayload };

/**
 * The success outcome of an activation that records nothing routable: an all-empty `ok`, so
 * every edge receives `empty` (README "Per-node gadget").
 */
export function emptyOutcome(runIndex: number): Outcome {
  return { kind: 'ok', nodeSuccessData: [], runIndex };
}

/**
 * The branch `X_run` was compiled with for `outcome`. A `halt` on a gadget without a halt
 * branch — the host stopped the execution on a node whose `onError` continues, which n8n's own
 * handler never does — becomes the stopped branch with `ran: true`: the task data is already
 * recorded, the halt error is already the contract value, and it is the one branch that is
 * always writable. Nothing is re-queued: the marking write-back owns `nodeExecutionStack`, so an
 * entry the host pushed itself does not survive it. Only a host other than n8n's reaches this.
 */
function admissible(env: ExecutionEnv, g: NodeGadget, executionData: IExecuteData, outcome: Outcome): Outcome {
  if (outcome.kind !== 'halt' || hasHaltBranch(g)) return outcome;
  env.diagnostic(
    `node '${g.node}' (onError ${g.onError}): the host stopped the execution, but X_run has no halt branch for ` +
    'a node whose policy continues; the stopped branch stands in and nothing is re-queued');
  return { kind: 'stopped', executionData, ran: true };
}

/**
 * Runs `body` and writes its outcome; anything it throws (the mirrored loop would have
 * rejected `run()`) becomes the contract's halt error and the execution's fatal error, and takes
 * the halt branch — `stopped` (with `ran: true`, so nothing is re-queued) when the gadget
 * has no halt alternative — so the net quiesces and the token is never lost.
 *
 * The same holds for the outcome's *deposits*: they are computed in full before the first
 * `ctx.output`, and a list that cannot be computed is the same fatal, written the same way.
 * Both fallback branches are always writable, so the emission itself cannot fail.
 */
export async function guarded(
  ctx: TransitionContext,
  env: ExecutionEnv,
  g: NodeGadget,
  map: NetMapView,
  executionData: IExecuteData,
  body: () => Promise<Outcome>,
  run?: RunPayload,
): Promise<void> {
  const fallback = (error: unknown): Outcome => {
    env.state.fatal ??= error;
    const fatal = asExecutionError(error);
    // It ends the execution, so it is a halt error: write-once, never cleared by a sibling.
    env.state.haltError ??= fatal;
    env.diagnostic(`node '${g.node}': fatal error outside n8n's node try (run() rejects after quiescence): ${fatal.message}`);
    return hasHaltBranch(g) ? { kind: 'halt' } : { kind: 'stopped', executionData, ran: true };
  };
  let outcome: Outcome;
  try {
    outcome = admissible(env, g, executionData, await body());
  } catch (error) {
    outcome = fallback(error);
  }
  let list: readonly Deposit[];
  try {
    list = deposits(g, map, outcome, run);
  } catch (error) {
    list = deposits(g, map, fallback(error), run);
  }
  // The halt token this writes is the run's terminal marker: nothing consumes it, nothing
  // clears the pending activations, and the quiescent marking still holds every one of them
  // where the codec reads it (`compiler/compile.ts`, ADR 0004). No snapshot is taken here —
  // one taken at this point could not see what a sibling resolving in the same executor
  // cycle deposits, since `X_run` routes its own outcome and those arrivals reach the
  // marking in the same phase-1 batch as `_halt` itself.
  for (const d of list) ctx.output(d.place, d.value);
}
