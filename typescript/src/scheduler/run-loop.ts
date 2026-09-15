/**
 * One attempt of a node: the mirror of n8n's loop body (`stack-scheduler.ts` lines 49–268 at
 * `441970b`, patch 0001), in the same order, on the `X_run` / `X_exhausted` firing that
 * corresponds to it. The retry loop is unrolled into the net: every attempt is its own firing,
 * and whether a try is left is the net's decision (`X/tries`, or the `onFailure` chain).
 */
import type {
  EngineRequest, EngineResponse, ExecutionBaseError, IExecuteData, INode, INodeExecutionData, IRunNodeResponse,
  ITaskDataConnections, ITaskStartedData,
} from 'n8n-workflow';
import type { NodeGadget } from '../compiler/index.js';
import type { ExecutionEnv } from './env.js';
import {
  attemptDeadlineExceeded, engineRequestUnsupported, toolCallBudgetExceeded, UnmetReferenceError,
} from './errors.js';
import type { Outcome } from './outcomes.js';
import type { RetryPayload, RetryReason, RunPayload } from './payloads.js';
import { planRound } from './round.js';
import { probeWait, type WaitProbe } from './wait-claim.js';

/** `stack-scheduler.ts:98-100`: an error item on the first output counts as a failed try. */
function isErrorValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false;
}

function isEngineRequest(data: IRunNodeResponse | EngineRequest): data is EngineRequest {
  return !!data && 'actions' in data;
}

function checkFailure(data: IRunNodeResponse | EngineRequest): boolean {
  return !isEngineRequest(data) && isErrorValue(data.data?.[0]?.[0]?.json?.error);
}

/**
 * Lines 163–186: the request check and the output post-processing of one `runNode` result.
 * An `EngineRequest` is handled by the caller ({@link attempt}); reaching here with one is a
 * bug in this file, not a user-visible condition.
 */
async function postRun(
  env: ExecutionEnv,
  executionNode: INode,
  executionData: IExecuteData,
  taskStartedData: ITaskStartedData,
  runIndex: number,
  runNodeData: IRunNodeResponse | EngineRequest,
  /** The attempt this output belongs to, where one can be abandoned by a deadline. */
  payload?: RunPayload,
): Promise<INodeExecutionData[][] | null | undefined> {
  if (isEngineRequest(runNodeData)) throw engineRequestUnsupported(executionNode);
  const nodeOutput = await env.host.processNodeOutput(runNodeData, env.workflow, executionData, taskStartedData, runIndex);
  // `processNodeOutput` is awaited, so an `executionPolicy.timeoutMs` can expire inside it and
  // the attempt be disowned before this line runs. `env.state.closeFunction` is shared
  // execution state: letting a disowned attempt write it lets attempt 1, abandoned at its
  // deadline, replace the close function that the attempt now actually running registered.
  //
  // The cost of guarding it is that a resource the abandoned attempt opened is not closed at
  // the end of the execution. That is the same residual IO-013 already names — abandoning a
  // firing does not cancel the work behind it — and the same one divergence #17 and the
  // per-node cancellation ask in `tasks/todo.md` record. Losing the live attempt's handle is
  // the worse of the two, so the live one wins.
  if (payload !== undefined && isAbandoned(env, payload)) return nodeOutput.nodeSuccessData;
  // Keep the close function of an earlier node if this one registered none (line 185).
  env.state.closeFunction = nodeOutput.closeFunction ?? env.state.closeFunction;
  return nodeOutput.nodeSuccessData;
}

/**
 * Lines 193–206: paired items, `lastNodeExecuted`, `alwaysOutputData`, and the "succeeded
 * with no data" branch (`continue executionLoop`: no task data, no hook, successors get
 * nothing — here every edge receives `empty` through an all-empty ok token).
 */
async function finishSuccess(
  env: ExecutionEnv,
  executionNode: INode,
  executionData: IExecuteData,
  taskStartedData: ITaskStartedData,
  runIndex: number,
  raw: INodeExecutionData[][] | null | undefined,
  wait: WaitProbe,
): Promise<Outcome> {
  const { host, runExecutionData } = env;
  let nodeSuccessData = host.assignPairedItems(raw, executionData);
  if (nodeSuccessData) runExecutionData.resultData.lastNodeExecuted = executionData.node.name;
  nodeSuccessData = host.ensureAlwaysOutputData(nodeSuccessData, executionData) ?? null;
  if (nodeSuccessData === null && wait() !== 'claimed') {
    // `continue executionLoop`: the iteration ends here, with n8n's field cleared by the
    // successful try and nothing recorded.
    env.state.leftoverError = undefined;
    return { kind: 'ok', nodeSuccessData: [], runIndex };
  }
  return record(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, undefined, wait);
}

/**
 * Lines 214–268, the after-loop recording: `runData` slot, `createTaskData`,
 * `recordDynamicCredentialsUser`, the error outcome (`handleNodeExecutionError` continues
 * with the node's input as output, or stops: the halt branch), `normalizeNodeErrors`,
 * `rewireOutputLog`, `upsertTaskData`, then `waitTill` → `nodeExecuteAfter` + `waiting`;
 * destination node → `nodeExecuteAfter` + `stopped`; else `nodeExecuteAfter` (line 368,
 * after the enqueue the net does next cycle) + `ok`.
 *
 * `executionError` is this attempt's own (n8n's `this.executionError` is one field because
 * one node runs at a time; above k = 1 a sibling's failure must not be attributed to a node
 * that was already running). This is the end of one n8n loop iteration, so it is also where
 * the contract value is written: `haltError` when the error stops the execution, otherwise
 * the `leftoverError` this iteration leaves behind — exactly the two things n8n's single
 * field holds at the `break` and at the top of the next iteration.
 */
async function record(
  env: ExecutionEnv,
  executionNode: INode,
  executionData: IExecuteData,
  taskStartedData: ITaskStartedData,
  runIndex: number,
  nodeSuccessDataIn: INodeExecutionData[][] | null | undefined,
  executionError: ExecutionBaseError | undefined,
  wait: WaitProbe,
  /**
   * An `onFailure` `route` step's target (ADR 0009): the connected output the failure takes,
   * and the message the item carries. Applied *before* the task data is written, so the run the
   * editor shows is the run that happened — a rewrite afterwards would route one way and record
   * another.
   */
  routeTo?: { readonly index: number; readonly message: string },
): Promise<Outcome> {
  const { host, runExecutionData, hooks } = env;
  let nodeSuccessData = nodeSuccessDataIn;
  if (!Object.hasOwn(runExecutionData.resultData.runData, executionNode.name)) {
    runExecutionData.resultData.runData[executionNode.name] = [];
  }
  const taskData = host.createTaskData(taskStartedData, executionData);
  if (wait() === 'foreign' && taskData.executionStatus === 'waiting') {
    // `createTaskData` reads the execution-global `waitTill` (`workflow-execute.ts:1996`).
    // Another node claimed the pause while this one was running, so this run finished
    // normally and must be recorded as such — the k = 1 status of the same run
    // (divergence #15). Unreachable at k = 1: there the claimant is this node.
    taskData.executionStatus = 'success';
  }
  host.recordDynamicCredentialsUser();

  if (executionError !== undefined) {
    const outcome = await host.handleNodeExecutionError({
      executionNode, executionData, taskData, executionError, nodeSuccessData, runIndex, hooks,
    });
    nodeSuccessData = outcome.nodeSuccessData;
    if (!outcome.continueExecution) {
      env.state.haltError ??= executionError;
      return { kind: 'halt' };
    }
  }
  // The iteration completes; n8n's field still holds this attempt's error (nothing clears it
  // until the *next* iteration starts), and `undefined` when the attempt succeeded.
  env.state.leftoverError = executionError;

  if (routeTo !== undefined) {
    // n8n's own handler continued this failure down output 0 with the input passed through;
    // the step said which output it belongs on, and it carries the error as data.
    const branch: INodeExecutionData[][] = [];
    for (let o = 0; o <= routeTo.index; o++) branch.push([]);
    branch[routeTo.index] = [{ json: { error: routeTo.message }, pairedItem: { item: 0 } }];
    nodeSuccessData = branch;
  }
  // n8n's loop dereferences the value here, after the node `try` (`stack-scheduler.ts`:
  // `host.normalizeNodeErrors(nodeSuccessData!)`). Its own handler can leave it null — it
  // continues a node whose `main[0]` is null without replacing it — and the loop then throws out
  // of `run()`. The same value reaches the same host call, so the same throw happens here and
  // `guarded` makes it the fatal error n8n's rejected `run()` is. A host that tolerates the null
  // does not change what n8n's loop does next, so the reproduction throws in its place.
  host.normalizeNodeErrors(nodeSuccessData!);
  if (nodeSuccessData === null || nodeSuccessData === undefined) {
    throw new TypeError(`node '${executionNode.name}': the error handler continued with no output, which n8n's loop dereferences`);
  }
  taskData.data = { main: nodeSuccessData } as ITaskDataConnections;
  host.rewireOutputLog(executionNode, taskData, nodeSuccessData, runIndex);
  host.upsertTaskData(executionNode.name, runIndex, taskData);

  if (wait() === 'claimed') {
    await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, runExecutionData]);
    // n8n: pushExecutionStack(executionData) — the codec writes the waiting token there.
    return { kind: 'waiting', executionData };
  }

  if (runExecutionData.startData?.destinationNode?.nodeName === executionNode.name) {
    await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, runExecutionData]);
    return { kind: 'stopped', executionData, ran: true };
  }

  // Lines 272–362 (enqueue the successors) are X_route, next cycle. Line 368:
  await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, runExecutionData]);
  return { kind: 'ok', nodeSuccessData, runIndex };
}

/**
 * The `X/retry` outcome: no iteration has completed, so nothing is written to the contract
 * value. n8n clears `this.executionError` at the top of the *next* try (line 107) and always
 * reaches it, so a transient failure is never observable outside the retry loop. The net can
 * stop between attempts (`_pause`, or `executor.close()` on a cancellation: `X_retry_wait`
 * never fires), and an error left behind would make `processRunExecutionData` report the
 * execution as failed instead of canceled (`workflow-execute.ts:2240`). The final attempt
 * writes the value it ends on through {@link record}.
 */
function retryOutcome(
  run: RunPayload, taskStartedData: ITaskStartedData, waitTillBefore: Date | undefined, reason: RetryReason,
): Outcome {
  // Same convention throughout: a failure carries the *next* attempt's number, and a tool's
  // dispatch travels with it so the attempt that finally answers still knows which agent asked.
  const payload: RetryPayload = {
    kind: 'retry', executionData: run.executionData, attempt: run.attempt + 1, taskStartedData, waitTillBefore, reason,
    ...carried(run),
  };
  return { kind: 'retry', payload };
}

/**
 * The dispatch fields a tool's payload carries across every attempt (`agent`, `roundId`), as a
 * spread: empty for a node on a main edge, which has neither.
 */
export function carried(p: { readonly agent?: string; readonly roundId?: string }): { readonly agent?: string; readonly roundId?: string } {
  return {
    ...(p.agent === undefined ? {} : { agent: p.agent }),
    ...(p.roundId === undefined ? {} : { roundId: p.roundId }),
  };
}

/**
 * Whether the net disowned this attempt, **without announcing it**.
 *
 * {@link abandoned} is the announcing form and belongs at the points that decide what to return.
 * A guard that only has to suppress a write wants the question without the diagnostic, or the
 * same abandonment is reported twice for one attempt.
 */
function isAbandoned(env: ExecutionEnv, payload: RunPayload): boolean {
  return env.state.abandoned.has(payload);
}

/**
 * Whether a deadline abandoned this activation's firing while it was still running.
 *
 * IO-013 discards what an abandoned firing wrote to the marking, but not what our action went
 * on to do to n8n: `postRun`, `record` and the hooks all write. A `runNode` that resolves after
 * the budget expired must therefore stop here, or the execution ends holding task data for an
 * attempt the net disowned and n8n reports a node the workflow already escalated past.
 *
 * Checked at each point the action can still write — after `runNode` resolves, after `postRun`,
 * and on the error path. The residual window is the inside of those awaits, which is the same
 * shape as divergence #15's `waitTill` race and is recorded with it.
 */
function abandoned(env: ExecutionEnv, payload: RunPayload): boolean {
  if (!isAbandoned(env, payload)) return false;
  env.diagnostic(
    `node '${payload.executionData.node.name}': attempt ${payload.attempt + 1} finished after its ` +
    'deadline abandoned it; the late result is discarded and nothing is recorded for it');
  return true;
}

/**
 * One attempt: lines 49–212 with the retry loop unrolled, then {@link record} unless the net may retry.
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
  const { host, workflow, runExecutionData, hooks, state } = env;
  const { executionData } = payload;
  const executionNode = executionData.node;
  const soft = payload.softRetry === true;

  // Lines 49–51: polled once per popped entry, before the try loop — nothing inside the loop
  // re-checks it, so a stop arriving between attempts still lets n8n finish the tries and
  // record the node instead of discarding a node that has already run.
  if (payload.attempt === 0 && host.shouldStopExecuting()) return { kind: 'stopped', executionData, ran: false };

  // Lines 53–56 (line 107 on later tries): fresh per-attempt state.
  const subNodeExecutionResults: EngineResponse = { actionResponses: [], metadata: {} };
  let nodeSuccessData: INodeExecutionData[][] | null | undefined = null;
  // n8n's line 56 (`this.executionError = undefined`) is not mirrored: it clears a field
  // this activation does not own. What the previous iteration left is `state.leftoverError`,
  // and this activation overwrites it when it completes (see {@link record}).

  let taskStartedData: ITaskStartedData;
  if (payload.attempt === 0) {
    host.resetDynamicCredentialsUsage(executionData); // line 60
    taskStartedData = host.createTaskStartedData(executionData); // line 62
    executionData.data = host.addPairedItemLineage(executionData); // line 65
  } else {
    taskStartedData = payload.taskStartedData!;
  }
  // Reachable by the deadline funnel, which sees this payload and nothing else.
  state.startedData.set(payload, taskStartedData);
  // Line 67. Recomputed per attempt: runData of this node does not change between attempts.
  const runIndex = host.computeRunIndex(executionData);
  // Lines 69–72, the endless-loop guard: abandoned (divergence #6).
  // Line 101, read once per popped entry as n8n reads it (outside the try loop): `[1, 0]` for
  // a node without retryOnFail or resuming with `metadata.resumeError`. A later attempt only
  // exists because that read allowed one, so the net (`X/tries`) decides from there on.
  // An `onFailure` chain answers this for every attempt, including the last: the failure always
  // lands on that attempt's `X/failed_i` and the *step* decides, so the run itself never
  // records and never consults `onError` (ADR 0009 §3).
  let canRetry = g.attempts.length > 0 ? true : g.retry !== null;
  if (payload.attempt === 0) {
    // Lines 74–76: a filtered-out node is skipped entirely — no run, no task data, no hook.
    if (host.isNodeFilteredOut(executionNode.name)) {
      state.leftoverError = undefined;
      return { kind: 'ok', nodeSuccessData: [], runIndex };
    }
    // Lines 78–82: n8n defers the entry to the end of the stack and, once it comes round
    // again unchanged, throws its endless-loop error. Under v1 this is only reachable for an
    // entry without `data.main`, which no start action produces; a decoded one is dropped.
    if (!host.ensureInputData(workflow, executionNode, executionData)) {
      env.diagnostic(
        `node '${executionNode.name}': ensureInputData is false; n8n would defer the entry to the end of the ` +
        'stack (and then stop with its endless-loop error); the activation is dropped and nothing is recorded');
      state.leftoverError = undefined;
      return { kind: 'ok', nodeSuccessData: [], runIndex };
    }
    // Lines 95–97.
    if (!executionData.metadata?.nodeWasResumed) {
      await hooks.runHook('nodeExecuteBefore', [executionNode.name, taskStartedData]);
    }
    // An `onFailure` chain stands in for n8n's counter (ADR 0009): every failure lands on this
    // attempt's `X/failed_i` and the *step* decides what happens, so the run never consults
    // `getRetryParams` and never records — the terminal step does that, as `X_exhausted` does.
    const [maxTries] = host.getRetryParams(executionData);
    canRetry = g.attempts.length > 0 ? true : (maxTries > 1 && g.retry !== null);
  }

  const waitTillBefore = runExecutionData.waitTill;
  const wait = probeWait(env, executionNode, waitTillBefore);
  try {
    // The inner loop re-runs the node alone: line 120 is outside it.
    const pinnedOutput = soft ? undefined : host.getPinnedOutput(executionNode); // line 120
    if (pinnedOutput) {
      nodeSuccessData = pinnedOutput;
      wait(); // no `runNode` to resolve; this is the same turn `waitTillBefore` was read in
    } else {
      // README "Expression references": the twin's token fails with n8n's own error.
      if (payload.unmetReference !== undefined) throw new UnmetReferenceError(payload.unmetReference);
      // `A_calls_out`: the round could not be finished, so this activation fails instead of
      // running — under `onError`, like `checkMaxIterations` throwing inside n8n's own node.
      if (payload.toolCallsExceeded !== undefined) {
        throw toolCallBudgetExceeded(executionNode, payload.toolCallsExceeded.undispatched, payload.toolCallsExceeded.budget);
      }
      let runNodeData: IRunNodeResponse | EngineRequest;
      if (soft) {
        // Lines 147–155: the re-run, with n8n's seven arguments.
        runNodeData = await host.runNode(
          workflow, executionData, runExecutionData, runIndex, host.additionalData, host.mode, host.abortSignal);
      } else {
        host.collectSubNodeResults(executionData, subNodeExecutionResults); // line 125
        runNodeData = await host.runNode(
          workflow, executionData, runExecutionData, runIndex, host.additionalData, host.mode, host.abortSignal,
          subNodeExecutionResults,
        ); // lines 132–141
      }
      wait(); // claim in the same turn as the resolution (divergence #15)
      // The deadline may have fired while `runNode` was outstanding. Everything below this
      // line writes to n8n, so this is where a late completion stops.
      if (abandoned(env, payload)) return { kind: 'ok', nodeSuccessData: [], runIndex };
      // Lines 163–174: an agent asking for its tools. n8n `continue`s the loop here — nothing
      // is recorded for this activation, no `nodeExecuteAfter`, no output — and the net does
      // the same: the request outcome opens a round and the agent re-enters through `A_resume`.
      if (isEngineRequest(runNodeData)) {
        const round = planRound(env, g, payload, runIndex, runNodeData);
        if (round !== null) return round;
        return { kind: 'ok', nodeSuccessData: [], runIndex };
      }
      // Lines 143–160: the soft-failure re-run; the net decides whether a try is left.
      if (canRetry && checkFailure(runNodeData)) {
        return retryOutcome(payload, taskStartedData, waitTillBefore, { kind: 'soft', runNodeData });
      }
      nodeSuccessData = await postRun(env, executionNode, executionData, taskStartedData, runIndex, runNodeData, payload);
    }
    if (abandoned(env, payload)) return { kind: 'ok', nodeSuccessData: [], runIndex };
    return await finishSuccess(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, wait);
  } catch (error) {
    const executionError = host.reportNodeExecutionError(error, executionNode, workflow); // line 210
    if (abandoned(env, payload)) return { kind: 'ok', nodeSuccessData: [], runIndex };
    if (canRetry) return retryOutcome(payload, taskStartedData, waitTillBefore, { kind: 'error', error: executionError });
    // A re-run hands `record` no output beside its error: the value the inner loop's own catch
    // has always passed.
    return record(
      env, executionNode, executionData, taskStartedData, runIndex, soft ? null : nodeSuccessData, executionError, wait);
  }
}

/** `X_exhausted`: the after-loop handling of the last attempt. */
export async function exhaust(
  env: ExecutionEnv, payload: RetryPayload,
  routeTo?: { readonly index: number; readonly message: string },
): Promise<Outcome> {
  const { host } = env;
  const { executionData, taskStartedData, reason } = payload;
  const executionNode = executionData.node;
  const runIndex = host.computeRunIndex(executionData);
  // The attempt that produced this token read `waitTill` before its own `runNode`; probing
  // here is the earliest point after that run, since the run itself is already over.
  const wait = probeWait(env, executionNode, payload.waitTillBefore);
  wait();
  if (reason.kind === 'error') {
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, reason.error as ExecutionBaseError, wait, routeTo);
  }
  if (reason.kind === 'timeout') {
    // The node never threw; the engine abandoned its firing. Recorded like any other node
    // failure so `runData`, the hooks and `onError` all see one, which is what lets the
    // terminal step reuse n8n's own error handling unchanged.
    const error = host.reportNodeExecutionError(
      attemptDeadlineExceeded(executionNode, reason.timeoutMs, payload.attempt), executionNode, env.workflow);
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, error, wait, routeTo);
  }
  // A soft failure with no try left is processed like any other output (line 176 on).
  try {
    const nodeSuccessData = await postRun(env, executionNode, executionData, taskStartedData, runIndex, reason.runNodeData);
    return await finishSuccess(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, wait);
  } catch (error) {
    const executionError = host.reportNodeExecutionError(error, executionNode, env.workflow);
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, executionError, wait, routeTo);
  }
}
