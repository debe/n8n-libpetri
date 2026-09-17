/**
 * `X_run`: the outcome (README "Per-node gadget", ADR 0004) — or, for a node with an `onFailure`
 * chain (ADR 0009), one `X_run_i` per attempt, with the IO-013 deadline where one is declared.
 */
import { Transition, and, forwardInput, one, outPlace, timeout, xor } from 'libpetri';
import type { Out, Place } from 'libpetri';
import { TRANSITION, attemptRunOf, qualified } from '../names.js';
import type { GadgetContext } from './context.js';
import type { LocalAgent, LocalAttempt, LocalRetry } from './local-shapes.js';
import type { OutcomeBranches } from './outcome.js';
import { xorOf } from './out-spec.js';
import type { Markers } from './ports.js';

/** The outcome of one attempt, given the place its failure writes (`null` without a policy). */
type OutcomeOf = (failure: Place<unknown> | null) => Out;

/**
 * The outcome of one attempt. Without a policy this is the historical shape and `failure` is
 * `null`; with one, the retry alternative is that attempt's own `X/failed_i` — a chain
 * position rather than a counter decrement.
 */
function outcomeFor(ctx: GadgetContext, branches: OutcomeBranches, retry: LocalRetry | null, agent: LocalAgent | null): OutcomeOf {
  const { success, haltBranch, waitingBranch, stoppedBranch } = branches;
  // An agent has one more: the node returned an `EngineRequest` instead of data. It is phased
  // like the success outcome — `A/routed_req` here, the budget refunded by `A_done_req` one
  // cycle later — so `_budget + Σ(running + retry + routed) = k` still holds with `routed_req`
  // counted among the in-flight markers.
  const requestBranch = agent === null ? [] : [outPlace(agent.routedRequest)];
  const retryBranch = (failure: Place<unknown> | null): Out[] => {
    if (failure !== null) return [outPlace(failure)];
    return retry !== null ? [outPlace(retry.retry)] : [];
  };
  return (failure) => xorOf([
    success,
    ...retryBranch(failure),
    ...(ctx.stopWorkflow ? [haltBranch] : []),
    waitingBranch,
    stoppedBranch,
    ...requestBranch,
  ]);
}

/**
 * One attempt's `X_run_i`. Attempt 1 keeps the name `run`, so every consumer that addresses a
 * node's run transition by name — the scheduler's binder, `NetMap`, the differ — is unchanged.
 */
function buildAttemptRun(
  ctx: GadgetContext,
  idle: Place<unknown>,
  outcomeOf: OutcomeOf,
  att: LocalAttempt,
  chainTimeoutMs: number | null,
): string {
  const normal = and(outcomeOf(att.failed), outPlace(idle));
  // IO-013's timeout child is an `Xor` sibling of the normal spec, and IO-015 needs
  // exactly one assignment to explain a write. It therefore has to claim a place the
  // normal branches do not, or every failing firing would be ambiguous — hence the
  // separate `timedout_i`, funnelled into `failed_i` by the attempt's deadline.
  const outputs = att.timedOut === null || chainTimeoutMs === null
    ? normal
    // `forwardInput`, not `outPlace`: IO-013 AC3 gives the timeout child *sentinel*
    // tokens, so a plain output would land a `null` on `timedout_i` and the step would
    // have no `executionData` to act on. IO-014 forwards the very token the firing
    // consumed from `X/running_i` — the run payload — which is what "this enables retry
    // patterns without losing tokens" means.
    : xor(normal, timeout(chainTimeoutMs, and(forwardInput(att.running, att.timedOut), outPlace(idle))));
  return ctx.emit(Transition.builder(attemptRunOf(att.index))
    .inputs(one(att.running))
    .outputs(outputs)
    .priority(ctx.depth + 1).build(), { role: 'run', attempt: att.index });
}

/** `X_run`, or one `X_run_i` per attempt of an `onFailure` chain. */
export function buildRun(
  ctx: GadgetContext,
  markers: Markers,
  branches: OutcomeBranches,
  retry: LocalRetry | null,
  chain: { readonly attempts: readonly LocalAttempt[]; readonly chainTimeoutMs: number | null },
  agent: LocalAgent | null,
): { readonly runName: string; readonly attemptRunNames: readonly string[] } {
  const { id, depth, emit } = ctx;
  const { idle, running } = markers;
  const { attempts, chainTimeoutMs } = chain;
  const outcomeOf = outcomeFor(ctx, branches, retry, agent);
  const runName = qualified(id, TRANSITION.run);
  const attemptRunNames = attempts.length > 0
    ? attempts.map((att) => buildAttemptRun(ctx, idle, outcomeOf, att, chainTimeoutMs))
    : [];
  if (attempts.length === 0) {
    emit(Transition.builder(TRANSITION.run)
      .inputs(one(running))
      .outputs(and(outcomeOf(null), outPlace(idle)))
      .priority(depth + 1).build(), { role: 'run', attempt: 1 });
  }
  // `A_run_failed`: the run an agent re-enters after `A_calls_out`, off `A/running_failed` —
  // a running place only `A_calls_out` writes, so the primary run is unreachable from it (no
  // inhibitor, which is what lets a linear ranking bound the round). It runs the same node and
  // fails the same way (`toolCallBudgetExceeded` before `runNode`, so the executor is
  // unchanged), but its out spec is the non-agent outcome — no request branch — because a
  // failed activation never opens a tool round. That cuts the value-blind
  // `calls_out → run → done_req → calls_out` lasso the executor never runs (ADR 0008). With an
  // `onFailure` chain the failure is the chain's first `X/failed_1`, so a routed budget
  // overflow takes the chain's error branch exactly as an attempt-1 failure does; without one
  // it is the plain non-agent outcome.
  if (agent !== null) {
    const failedOutcome = outcomeFor(ctx, branches, retry, null);
    const firstAttempt = attempts.length > 0 ? attempts[0]! : null;
    emit(Transition.builder(TRANSITION.runFailed)
      .inputs(one(agent.runningFailed))
      .outputs(and(failedOutcome(firstAttempt === null ? null : firstAttempt.failed), outPlace(idle)))
      .priority(depth + 1).build(), { role: 'run-failed' });
  }
  return { runName, attemptRunNames };
}
