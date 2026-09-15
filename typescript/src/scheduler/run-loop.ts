/**
 * One attempt of a node: the mirror of n8n's loop body (`stack-scheduler.ts` lines 49–268 at
 * `441970b`, patch 0001), in the same order, on the `X_run` / `X_exhausted` firing that
 * corresponds to it. The retry loop is unrolled into the net: every attempt is its own firing,
 * and whether a try is left is the net's decision (`X/tries`, or the `onFailure` chain).
 *
 * The body is split along n8n's own seams: the per-entry steps before the node `try`
 * (`attempt-entry.ts`), the `try` body with the inner loop's soft re-run and the `catch` (here),
 * reading the `runNode` result (`run-output.ts`) and the recording path (`record.ts`). The
 * last attempt's after-loop handling, `X_exhausted`, is `exhaust.ts`.
 */
import type {
  EngineRequest, EngineResponse, IExecuteData, INodeExecutionData, IRunNodeResponse,
} from 'n8n-workflow';
import type { NodeGadget } from '../compiler/index.js';
import { abandoned } from './abandoned.js';
import { enterAttempt, mayRetry, type AttemptStart } from './attempt-entry.js';
import { retryOutcome } from './attempt-tokens.js';
import type { ExecutionEnv } from './env.js';
import { toolCallBudgetExceeded, UnmetReferenceError } from './errors.js';
import { emptyOutcome, type Outcome } from './outcomes.js';
import type { RunPayload } from './payloads.js';
import { finishSuccess, record } from './record.js';
import { planRound } from './round.js';
import { checkFailure, isEngineRequest, postRun } from './run-output.js';
import { probeWait, type WaitProbe } from './wait-claim.js';

// The token conventions between attempts live in `attempt-tokens.ts`, and `X_exhausted` in
// `exhaust.ts`; this module exports `carried` and `exhaust` as it always has.
export { carried } from './attempt-tokens.js';
export { exhaust } from './exhaust.js';

/** One attempt past its per-entry steps: what its `try` body and its `catch` read. */
interface Trying {
  readonly env: ExecutionEnv;
  readonly g: NodeGadget;
  readonly payload: RunPayload;
  readonly start: AttemptStart;
  /** Line 101 (see {@link mayRetry}). */
  readonly canRetry: boolean;
  /** `runExecutionData.waitTill` as this attempt read it before its own `runNode`. */
  readonly waitTillBefore: Date | undefined;
  readonly wait: WaitProbe;
}

/** What the run leaves the `try` body: an outcome that ends the attempt, or the node's output to finish. */
type Ran =
  | { readonly outcome: Outcome }
  | { readonly output: INodeExecutionData[][] | null | undefined };

/**
 * Lines 125–155: the `runNode` call. A soft re-run is the inner loop's bare call with n8n's
 * seven arguments; otherwise the sub-node results are collected into the attempt's fresh
 * `EngineResponse` (lines 53–56, line 107 on later tries) and passed as the eighth.
 */
function runNode(
  env: ExecutionEnv, executionData: IExecuteData, runIndex: number, soft: boolean,
): Promise<IRunNodeResponse | EngineRequest> {
  const { host, workflow, runExecutionData } = env;
  if (soft) {
    // Lines 147–155: the re-run, with n8n's seven arguments.
    return host.runNode(workflow, executionData, runExecutionData, runIndex, host.additionalData, host.mode, host.abortSignal);
  }
  const subNodeExecutionResults: EngineResponse = { actionResponses: [], metadata: {} };
  host.collectSubNodeResults(executionData, subNodeExecutionResults); // line 125
  return host.runNode(
    workflow, executionData, runExecutionData, runIndex, host.additionalData, host.mode, host.abortSignal,
    subNodeExecutionResults,
  ); // lines 132–141
}

/** Lines 125–186, when no pinned output stands in for the run: the run, and what its result decides. */
async function runOnce(t: Trying): Promise<Ran> {
  const { env, g, payload, start } = t;
  const { executionData } = payload;
  const executionNode = executionData.node;
  // README "Expression references": the twin's token fails with n8n's own error.
  if (payload.unmetReference !== undefined) throw new UnmetReferenceError(payload.unmetReference);
  // `A_calls_out`: the round could not be finished, so this activation fails instead of
  // running — under `onError`, like `checkMaxIterations` throwing inside n8n's own node.
  if (payload.toolCallsExceeded !== undefined) {
    throw toolCallBudgetExceeded(executionNode, payload.toolCallsExceeded.undispatched, payload.toolCallsExceeded.budget);
  }
  const runNodeData = await runNode(env, executionData, start.runIndex, payload.softRetry === true);
  t.wait(); // claim in the same turn as the resolution (divergence #15)
  // The deadline may have fired while `runNode` was outstanding. Everything below this
  // line writes to n8n, so this is where a late completion stops.
  if (abandoned(env, payload)) return { outcome: emptyOutcome(start.runIndex) };
  // Lines 163–174: an agent asking for its tools. n8n `continue`s the loop here — nothing
  // is recorded for this activation, no `nodeExecuteAfter`, no output — and the net does
  // the same: the request outcome opens a round and the agent re-enters through `A_resume`.
  if (isEngineRequest(runNodeData)) {
    return { outcome: planRound(env, g, payload, start.runIndex, runNodeData) ?? emptyOutcome(start.runIndex) };
  }
  // Lines 143–160: the soft-failure re-run; the net decides whether a try is left.
  if (t.canRetry && checkFailure(runNodeData)) {
    return { outcome: retryOutcome(payload, start.taskStartedData, t.waitTillBefore, { kind: 'soft', runNodeData }) };
  }
  return { output: await postRun(env, executionNode, executionData, start.taskStartedData, start.runIndex, runNodeData, payload) };
}

/**
 * Line 209 on, the node `catch`: a deadline-abandoned attempt writes nothing, a failure the net
 * may retry goes to it as `X/retry`, and anything else is recorded with its error.
 */
function failed(
  t: Trying, error: unknown, nodeSuccessData: INodeExecutionData[][] | null | undefined,
): Outcome | Promise<Outcome> {
  const { env, payload, start } = t;
  const { executionData } = payload;
  const executionError = env.host.reportNodeExecutionError(error, executionData.node, env.workflow); // line 210
  if (abandoned(env, payload)) return emptyOutcome(start.runIndex);
  if (t.canRetry) return retryOutcome(payload, start.taskStartedData, t.waitTillBefore, { kind: 'error', error: executionError });
  return record(env, executionData.node, executionData, start.taskStartedData, start.runIndex, nodeSuccessData, executionError, t.wait);
}

/**
 * One attempt: lines 49–212 with the retry loop unrolled, then `record` unless the net may retry.
 *
 * A `softRetry` payload is n8n's inner `while (nodeFailed && tryIndex !== maxTries - 1)` loop
 * instead (lines 143–160): the `sleep` is the net's delay (`X_retry_wait`, or an `onFailure`
 * retry step) and the re-run is a bare `host.runNode` — no stop poll, no `getRetryParams` /
 * `getPinnedOutput` / `collectSubNodeResults`, and **seven** arguments (n8n passes no
 * `EngineResponse` there, so `nodeType.execute` sees `undefined` for it). A re-run is never
 * attempt 0, so every per-entry step below already passes it by. Whether a try is left is the
 * net's decision (`X/tries`, or under a chain the chain's next step): emitting `X/retry` with
 * none left lands on `X_exhausted`, which is
 * what n8n does when it leaves the inner loop with the failure still in the output.
 * `computeRunIndex` is re-read rather than carried on the token (a token never holds a run
 * index); the node has recorded nothing yet, so it returns the index n8n kept in its local
 * variable.
 *
 * Both kinds run through this one body, so both carry the deadline guards: a re-run has its
 * attempt's `executionPolicy.timeoutMs` like any other (ADR 0009 §4), and one the deadline
 * abandoned writes nothing to n8n when it resolves.
 */
export async function attempt(env: ExecutionEnv, g: NodeGadget, payload: RunPayload): Promise<Outcome> {
  const entered = enterAttempt(env, payload);
  if (entered.kind !== 'start') return entered;
  const { executionData } = payload;
  const executionNode = executionData.node;
  // Lines 95–97.
  if (payload.attempt === 0 && !executionData.metadata?.nodeWasResumed) {
    await env.hooks.runHook('nodeExecuteBefore', [executionNode.name, entered.taskStartedData]);
  }
  const canRetry = mayRetry(env, g, payload);
  const waitTillBefore = env.runExecutionData.waitTill;
  const t: Trying = {
    env, g, payload, start: entered, canRetry, waitTillBefore, wait: probeWait(env, executionNode, waitTillBefore),
  };
  const soft = payload.softRetry === true;
  let nodeSuccessData: INodeExecutionData[][] | null | undefined = null;
  try {
    // The inner loop re-runs the node alone: line 120 is outside it.
    const pinnedOutput = soft ? undefined : env.host.getPinnedOutput(executionNode); // line 120
    if (pinnedOutput) {
      nodeSuccessData = pinnedOutput;
      t.wait(); // no `runNode` to resolve; this is the same turn `waitTillBefore` was read in
    } else {
      const ran = await runOnce(t);
      if ('outcome' in ran) return ran.outcome;
      nodeSuccessData = ran.output;
    }
    if (abandoned(env, payload)) return emptyOutcome(entered.runIndex);
    return await finishSuccess(
      env, executionNode, executionData, entered.taskStartedData, entered.runIndex, nodeSuccessData, t.wait);
  } catch (error) {
    // A re-run hands `record` no output beside its error: the value the inner loop's own catch
    // has always passed.
    return failed(t, error, soft ? null : nodeSuccessData);
  }
}
