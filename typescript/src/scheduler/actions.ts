/**
 * The actions bound to the compiled net — the whole of n8n's execution loop that is not
 * scheduling. Every line of `stack-scheduler.ts` (n8n `441970b`, patch 0001) that touches
 * the host is mirrored here, in the same order, on the transition whose firing corresponds
 * to it; the stack machinery (`isExecutionStackNotEmpty`, `popExecutionStack`,
 * `addNodeToBeExecuted`, the sibling sort, the R6 stuck-join fallback) is what the net
 * replaces and is never called.
 *
 * Per role (README "Per-node gadget"):
 * - `start` / `start-unmet`: instantaneous; build the node's `IExecuteData` from the input
 *   token(s) (`addNodeToBeExecuted`'s shape) and move it to `X/running` with `attempt = 0`
 *   and, for the twin, the unmet reference;
 * - `run`: one attempt of the node (lines 49–212), then the after-loop recording (214–268)
 *   unless a retry is possible; ends on `X/ok`, `X/retry`, the halt branch, `X/waiting`
 *   (`waitTill`) or `X/stopped` (destination node, or a cancellation before the run);
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
 * - `skip`, `arm`, `clear`, `sink`, `reap`: structural, the compiler's placeholders.
 *
 * A halt snapshots the marking (`state.haltMarking`) before `_halt_reap` clears the pending
 * activations, so the scheduler can put them back on `nodeExecutionStack` where n8n's
 * `break` leaves them.
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
 */
import type { Marking, TransitionAction, TransitionContext } from 'libpetri';
import type {
  EngineRequest, EngineResponse, ExecutionBaseError, IExecuteData, INode, INodeExecutionData, IRunExecutionData,
  IRunNodeResponse, ISourceData, ITaskDataConnections, ITaskStartedData, Workflow,
} from 'n8n-workflow';
import { entryForEdge } from '../codec.js';
import type { ActionBinder, InputGadget, NetMapView, NodeGadget, TransitionInfo } from '../compiler/index.js';
import type { SchedulerHooks, SchedulerHost } from '../n8n/host.js';
import { engineRequestUnsupported, UnmetReferenceError } from './errors.js';
import {
  isEdgePayload, isEntryPayload,
  type EdgePayload, type OkPayload, type RetryPayload, type RetryReason, type RunPayload, type StoppedPayload,
  type WaitingPayload,
} from './payloads.js';

/** The execution-context key the scheduler installs (`ctx.executionContext(ENV_KEY)`). */
export const ENV_KEY = 'n8n';

/** The per-execution fields `StackScheduler` keeps on itself, shared between scheduler and actions. */
export interface SchedulerState {
  executionError: ExecutionBaseError | undefined;
  closeFunction: Promise<void> | undefined;
  /** An error the mirrored loop would have thrown out of `run()`; rethrown after quiescence. */
  fatal: unknown | undefined;
  /**
   * The marking as it was when the first halt branch was taken, i.e. before `_halt_reap`'s
   * reset arcs cleared the pending activations (README "Retries, halt, cancellation").
   * n8n's loop `break`s and leaves every entry it has not popped on `nodeExecutionStack`
   * — the entries `ExecutionService.retry()` replays — so the scheduler encodes these back
   * after the failed entry the host pushed.
   */
  haltMarking: Marking | undefined;
  /** The node that put the execution to wait; see {@link claimWait}. */
  waitingNode: string | undefined;
}

export interface ExecutionEnv {
  readonly host: SchedulerHost;
  readonly workflow: Workflow;
  readonly runExecutionData: IRunExecutionData;
  readonly hooks: SchedulerHooks;
  readonly state: SchedulerState;
  readonly diagnostic: (message: string) => void;
  /** The executor's live marking, for the halt snapshot; `undefined` before it exists. */
  readonly snapshotMarking: () => Marking | undefined;
}

function envOf(ctx: TransitionContext): ExecutionEnv {
  const env = ctx.executionContext<ExecutionEnv>(ENV_KEY);
  if (env === undefined) throw new Error(`n8n-libpetri: no '${ENV_KEY}' execution context installed on the executor`);
  return env;
}

// ==================== outcomes ====================

type Outcome =
  | { readonly kind: 'ok'; readonly nodeSuccessData: INodeExecutionData[][]; readonly runIndex: number }
  | { readonly kind: 'retry'; readonly payload: RetryPayload }
  | { readonly kind: 'halt' }
  | { readonly kind: 'waiting'; readonly executionData: IExecuteData }
  | { readonly kind: 'stopped'; readonly executionData: IExecuteData; readonly ran: boolean };

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

// ==================== the run ====================

/**
 * Lines 163–186: the request check and the output post-processing of one `runNode` result.
 * An `EngineRequest` is out of scope and fails the node with a clear error.
 */
async function postRun(
  env: ExecutionEnv,
  executionNode: INode,
  executionData: IExecuteData,
  taskStartedData: ITaskStartedData,
  runIndex: number,
  runNodeData: IRunNodeResponse | EngineRequest,
): Promise<INodeExecutionData[][] | null | undefined> {
  if (isEngineRequest(runNodeData)) throw engineRequestUnsupported(executionNode);
  const nodeOutput = await env.host.processNodeOutput(runNodeData, env.workflow, executionData, taskStartedData, runIndex);
  // Keep the close function of an earlier node if this one registered none (line 185).
  env.state.closeFunction = nodeOutput.closeFunction ?? env.state.closeFunction;
  return nodeOutput.nodeSuccessData;
}

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
 */
function claimWait(env: ExecutionEnv, executionNode: INode, before: Date | undefined): boolean {
  const { state, runExecutionData } = env;
  const waitTill = runExecutionData.waitTill;
  if (!waitTill) return false;
  if (state.waitingNode === executionNode.name) return true;
  if (state.waitingNode === undefined && waitTill !== before) {
    state.waitingNode = executionNode.name;
    return true;
  }
  env.diagnostic(
    `node '${executionNode.name}': the execution was put to wait while this node was running` +
    `${state.waitingNode === undefined ? '' : ` (by '${state.waitingNode}')`}; recorded as a normal run (k > 1)`);
  return false;
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
  waitTillBefore: Date | undefined,
): Promise<Outcome> {
  const { host, runExecutionData } = env;
  let nodeSuccessData = host.assignPairedItems(raw, executionData);
  if (nodeSuccessData) runExecutionData.resultData.lastNodeExecuted = executionData.node.name;
  nodeSuccessData = host.ensureAlwaysOutputData(nodeSuccessData, executionData) ?? null;
  if (nodeSuccessData === null && !claimWait(env, executionNode, waitTillBefore)) {
    return { kind: 'ok', nodeSuccessData: [], runIndex };
  }
  return record(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, undefined, waitTillBefore);
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
 * that was already running). The shared `state.executionError` is kept as the contract
 * value: the error of the last node that failed.
 */
async function record(
  env: ExecutionEnv,
  executionNode: INode,
  executionData: IExecuteData,
  taskStartedData: ITaskStartedData,
  runIndex: number,
  nodeSuccessDataIn: INodeExecutionData[][] | null | undefined,
  executionError: ExecutionBaseError | undefined,
  waitTillBefore: Date | undefined,
): Promise<Outcome> {
  const { host, runExecutionData, hooks } = env;
  let nodeSuccessData = nodeSuccessDataIn;
  if (!Object.hasOwn(runExecutionData.resultData.runData, executionNode.name)) {
    runExecutionData.resultData.runData[executionNode.name] = [];
  }
  const taskData = host.createTaskData(taskStartedData, executionData);
  host.recordDynamicCredentialsUser();

  if (executionError !== undefined) {
    const outcome = await host.handleNodeExecutionError({
      executionNode, executionData, taskData, executionError, nodeSuccessData, runIndex, hooks,
    });
    nodeSuccessData = outcome.nodeSuccessData;
    if (!outcome.continueExecution) return { kind: 'halt' };
  }

  host.normalizeNodeErrors(nodeSuccessData!);
  taskData.data = { main: nodeSuccessData } as ITaskDataConnections;
  host.rewireOutputLog(executionNode, taskData, nodeSuccessData!, runIndex);
  host.upsertTaskData(executionNode.name, runIndex, taskData);

  if (claimWait(env, executionNode, waitTillBefore)) {
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
  return { kind: 'ok', nodeSuccessData: nodeSuccessData!, runIndex };
}

/**
 * The `X/retry` outcome. n8n clears `this.executionError` at the top of the *next* try
 * (line 107) and always reaches it, so a transient failure is never observable outside the
 * retry loop. The net can stop between attempts (`_pause`, or `executor.close()` on a
 * cancellation: `X_retry_wait` never fires), and a leftover `executionError` would make
 * `processRunExecutionData` report the execution as failed instead of canceled
 * (`workflow-execute.ts:2240`). The failing final attempt re-sets it through {@link exhaust}.
 */
function retryOutcome(state: SchedulerState, payload: RetryPayload): Outcome {
  state.executionError = undefined;
  return { kind: 'retry', payload };
}

/**
 * Lines 143–160, n8n's inner `while (nodeFailed && tryIndex !== maxTries - 1)` loop: the
 * `sleep` is the net's `delayed(waitBetweenTries)` `X_retry_wait` and the re-run is a bare
 * `host.runNode` — no stop poll, no `getRetryParams` / `getPinnedOutput` /
 * `collectSubNodeResults`, and **seven** arguments (n8n passes no `EngineResponse` there, so
 * `nodeType.execute` sees `undefined` for it). Whether a try is left is the net's decision
 * (`X/tries`): emitting `X/retry` with none left lands on `X_exhausted`, which is what n8n
 * does when it leaves the inner loop with the failure still in the output. `computeRunIndex`
 * is re-read rather than carried on the token (a token never holds a run index); the node
 * has recorded nothing yet, so it returns the index n8n kept in its local variable.
 */
async function softAttempt(env: ExecutionEnv, g: NodeGadget, payload: RunPayload): Promise<Outcome> {
  const { host, workflow, runExecutionData, state } = env;
  const { executionData } = payload;
  const executionNode = executionData.node;
  const taskStartedData = payload.taskStartedData!;
  const runIndex = host.computeRunIndex(executionData);
  const waitTillBefore = runExecutionData.waitTill;
  const again = (reason: RetryReason): Outcome =>
    retryOutcome(state, { executionData, attempt: payload.attempt + 1, taskStartedData, waitTillBefore, reason });
  try {
    const runNodeData = await host.runNode(
      workflow, executionData, runExecutionData, runIndex, host.additionalData, host.mode, host.abortSignal);
    if (g.retry !== null && checkFailure(runNodeData)) {
      return again({ kind: 'soft', runNodeData: runNodeData as IRunNodeResponse });
    }
    const nodeSuccessData = await postRun(env, executionNode, executionData, taskStartedData, runIndex, runNodeData);
    return await finishSuccess(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, waitTillBefore);
  } catch (error) {
    // A throw leaves the inner loop for n8n's outer `catch` (line 209); the next try runs the
    // whole body again, so it is a plain error retry from here on.
    const executionError = host.reportNodeExecutionError(error, executionNode, workflow);
    state.executionError = executionError;
    if (g.retry !== null) return again({ kind: 'error', error: executionError });
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, executionError, waitTillBefore);
  }
}

/** One attempt: lines 49–212 with the retry loop unrolled, then {@link record} unless the net may retry. */
async function attempt(env: ExecutionEnv, g: NodeGadget, payload: RunPayload): Promise<Outcome> {
  const { host, workflow, runExecutionData, hooks, state } = env;
  const { executionData } = payload;
  const executionNode = executionData.node;

  if (payload.softRetry === true) return await softAttempt(env, g, payload);

  // Lines 49–51: polled once per popped entry, before the try loop — nothing inside the loop
  // re-checks it, so a stop arriving between attempts still lets n8n finish the tries and
  // record the node instead of discarding a node that has already run.
  if (payload.attempt === 0 && host.shouldStopExecuting()) return { kind: 'stopped', executionData, ran: false };

  // Lines 53–56 (line 107 on later tries): fresh per-attempt state.
  const subNodeExecutionResults: EngineResponse = { actionResponses: [], metadata: {} };
  let nodeSuccessData: INodeExecutionData[][] | null | undefined = null;
  state.executionError = undefined;

  let taskStartedData: ITaskStartedData;
  if (payload.attempt === 0) {
    host.resetDynamicCredentialsUsage(executionData); // line 60
    taskStartedData = host.createTaskStartedData(executionData); // line 62
    executionData.data = host.addPairedItemLineage(executionData); // line 65
  } else {
    taskStartedData = payload.taskStartedData!;
  }
  // Line 67. Recomputed per attempt: runData of this node does not change between attempts.
  const runIndex = host.computeRunIndex(executionData);
  // Lines 69–72, the endless-loop guard: abandoned (divergence #6).
  // Line 101, read once per popped entry as n8n reads it (outside the try loop): `[1, 0]` for
  // a node without retryOnFail or resuming with `metadata.resumeError`. A later attempt only
  // exists because that read allowed one, so the net (`X/tries`) decides from there on.
  let canRetry = g.retry !== null;
  if (payload.attempt === 0) {
    // Lines 74–76: a filtered-out node is skipped entirely — no run, no task data, no hook.
    if (host.isNodeFilteredOut(executionNode.name)) return { kind: 'ok', nodeSuccessData: [], runIndex };
    // Lines 78–82: n8n defers the entry to the end of the stack and, once it comes round
    // again unchanged, throws its endless-loop error. Under v1 this is only reachable for an
    // entry without `data.main`, which no start action produces; a decoded one is dropped.
    if (!host.ensureInputData(workflow, executionNode, executionData)) {
      env.diagnostic(
        `node '${executionNode.name}': ensureInputData is false; n8n would defer the entry to the end of the ` +
        'stack (and then stop with its endless-loop error); the activation is dropped and nothing is recorded');
      return { kind: 'ok', nodeSuccessData: [], runIndex };
    }
    // Lines 95–97.
    if (!executionData.metadata?.nodeWasResumed) {
      await hooks.runHook('nodeExecuteBefore', [executionNode.name, taskStartedData]);
    }
    const [maxTries] = host.getRetryParams(executionData);
    canRetry = maxTries > 1 && g.retry !== null;
  }

  const waitTillBefore = runExecutionData.waitTill;
  try {
    const pinnedOutput = host.getPinnedOutput(executionNode); // line 120
    if (pinnedOutput) {
      nodeSuccessData = pinnedOutput;
    } else {
      // README "Expression references": the twin's token fails with n8n's own error.
      if (payload.unmetReference !== undefined) throw new UnmetReferenceError(payload.unmetReference);
      host.collectSubNodeResults(executionData, subNodeExecutionResults); // line 125
      const runNodeData = await host.runNode(
        workflow, executionData, runExecutionData, runIndex, host.additionalData, host.mode, host.abortSignal,
        subNodeExecutionResults,
      ); // lines 132–141
      // Lines 143–160: the soft-failure re-run; the net decides whether a try is left.
      if (canRetry && checkFailure(runNodeData)) {
        return retryOutcome(state, { executionData, attempt: payload.attempt + 1, taskStartedData, waitTillBefore, reason: { kind: 'soft', runNodeData: runNodeData as IRunNodeResponse } });
      }
      nodeSuccessData = await postRun(env, executionNode, executionData, taskStartedData, runIndex, runNodeData);
    }
    return await finishSuccess(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, waitTillBefore);
  } catch (error) {
    const executionError = host.reportNodeExecutionError(error, executionNode, workflow); // line 210
    state.executionError = executionError;
    if (canRetry) {
      return retryOutcome(state, { executionData, attempt: payload.attempt + 1, taskStartedData, waitTillBefore, reason: { kind: 'error', error: executionError } });
    }
    return record(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, executionError, waitTillBefore);
  }
}

/** `X_exhausted`: the after-loop handling of the last attempt. */
async function exhaust(env: ExecutionEnv, payload: RetryPayload): Promise<Outcome> {
  const { host, state } = env;
  const { executionData, taskStartedData, reason } = payload;
  const executionNode = executionData.node;
  const runIndex = host.computeRunIndex(executionData);
  // The attempt that produced this token read `waitTill` before its own `runNode`.
  const waitTillBefore = payload.waitTillBefore;
  if (reason.kind === 'error') {
    const executionError = reason.error as ExecutionBaseError;
    state.executionError = executionError;
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, executionError, waitTillBefore);
  }
  // A soft failure with no try left is processed like any other output (line 176 on).
  state.executionError = undefined;
  try {
    const nodeSuccessData = await postRun(env, executionNode, executionData, taskStartedData, runIndex, reason.runNodeData);
    return await finishSuccess(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, waitTillBefore);
  } catch (error) {
    const executionError = host.reportNodeExecutionError(error, executionNode, env.workflow);
    state.executionError = executionError;
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, executionError, waitTillBefore);
  }
}

// ==================== writing outcomes ====================

function succeed(ctx: TransitionContext, g: NodeGadget, value: OkPayload): void {
  if (g.splitRouting) for (const out of g.outputs) ctx.output(out.ok!, value);
  else ctx.output(g.ok!, value);
}

/** Writes the outcome's branch; `fallback` handles an outcome the gadget has no branch for. */
function write(ctx: TransitionContext, g: NodeGadget, map: NetMapView, outcome: Outcome): void {
  const shared = map.shared;
  switch (outcome.kind) {
    case 'ok':
      succeed(ctx, g, { nodeSuccessData: outcome.nodeSuccessData, runIndex: outcome.runIndex });
      return;
    case 'retry':
      ctx.output(g.retry!, outcome.payload);
      return;
    case 'halt':
      if (g.onError !== 'stopWorkflow') throw new Error(`node '${g.node}' (onError ${g.onError}) has no halt branch but the host stopped the execution`);
      ctx.output(shared.halt, null);
      ctx.output(shared.budget, null);
      return;
    case 'waiting': {
      const v: WaitingPayload = { executionData: outcome.executionData };
      ctx.output(g.waiting, v);
      ctx.output(shared.pause, null);
      ctx.output(shared.budget, null);
      return;
    }
    case 'stopped': {
      const v: StoppedPayload = { executionData: outcome.executionData, ran: outcome.ran };
      ctx.output(g.stopped, v);
      ctx.output(shared.pause, null);
      ctx.output(shared.budget, null);
      return;
    }
  }
}

/** n8n's serialisable error shape (`initializeExecution`, `reportNodeExecutionError`): `{ ...e, message, stack }`. */
function asExecutionError(error: unknown): ExecutionBaseError {
  const e = (typeof error === 'object' && error !== null ? error : { message: String(error) }) as Error;
  return { ...e, message: e.message, stack: e.stack } as unknown as ExecutionBaseError;
}

/**
 * Runs `body` and writes its outcome; anything it throws (the mirrored loop would have
 * rejected `run()`) sets `executionError`, becomes the execution's fatal error and takes
 * the halt branch — `stopped` (with `ran: true`, so nothing is re-queued) when the gadget
 * has no halt alternative — so the net quiesces and the token is never lost.
 */
async function guarded(
  ctx: TransitionContext,
  g: NodeGadget,
  map: NetMapView,
  executionData: IExecuteData,
  body: () => Promise<Outcome>,
): Promise<void> {
  const env = envOf(ctx);
  let outcome: Outcome;
  try {
    outcome = await body();
  } catch (error) {
    env.state.fatal ??= error;
    env.state.executionError = asExecutionError(error);
    env.diagnostic(`node '${g.node}': fatal error outside n8n's node try (run() rejects after quiescence): ${env.state.executionError.message}`);
    outcome = g.onError === 'stopWorkflow' ? { kind: 'halt' } : { kind: 'stopped', executionData, ran: true };
  }
  // The halt token this writes makes `_halt_reap` clear every pending activation on the next
  // cycle; n8n keeps them on its stack, so the marking is captured here, while they exist.
  if (outcome.kind === 'halt') env.state.haltMarking ??= env.snapshotMarking();
  write(ctx, g, map, outcome);
}

// ==================== start: IExecuteData from the input tokens ====================

function liveNode(env: ExecutionEnv, g: NodeGadget): INode {
  const node = env.workflow.nodes[g.node];
  if (node === undefined) throw new Error(`n8n-libpetri: workflow has no node '${g.node}'`);
  return node;
}

function readyOf(g: NodeGadget, i: InputGadget) {
  return g.form === 'choose-branch' && i.required ? i.readyData! : i.ready!;
}

/** Consumes the start inputs and builds the node's `IExecuteData`, refunding the join slots. */
function startInput(ctx: TransitionContext, env: ExecutionEnv, g: NodeGadget, map: NetMapView): IExecuteData {
  if (g.form === 'direct') {
    const v = ctx.input(g.in!);
    if (isEntryPayload(v)) return v.executionData;
    if (!isEdgePayload(v)) throw new Error(`node '${g.node}': unexpected token on '${g.in!.name}'`);
    const inputIndex = map.place(g.in!.name)?.edge?.inputIndex ?? 0;
    return entryForEdge(liveNode(env, g), inputIndex, v);
  }
  if (g.form === 'or') {
    const i = g.inputs[0]!;
    ctx.output(i.ran!, null);
    const v = ctx.input(i.hasdata!);
    if (isEntryPayload(v)) return v.executionData;
    if (!isEdgePayload(v)) throw new Error(`node '${g.node}': unexpected token on '${i.hasdata!.name}'`);
    return entryForEdge(liveNode(env, g), i.index, v);
  }
  const values = g.inputs.map((i) => ctx.input(readyOf(g, i)));
  for (const i of g.inputs) ctx.output(i.free!, null);
  const first = values[0];
  if (isEntryPayload(first)) return first.executionData;
  // n8n's waitingExecution shape: items per arrived input, `[]` for an empty (R6's null → []
  // substitution done once), sources alongside.
  const inputCount = Math.max(...g.inputs.map((i) => i.index + 1));
  const main: Array<INodeExecutionData[] | null> = Array.from({ length: inputCount }, () => null);
  const sources: Array<ISourceData | null> = Array.from({ length: inputCount }, () => null);
  g.inputs.forEach((i, k) => {
    const v = values[k];
    if (isEdgePayload(v)) {
      main[i.index] = v.items;
      sources[i.index] = v.source;
    } else {
      main[i.index] = [];
    }
  });
  return { node: liveNode(env, g), data: { main }, source: { main: sources } };
}

function startAction(g: NodeGadget, map: NetMapView, unmetReference?: string): TransitionAction {
  return async (ctx) => {
    const env = envOf(ctx);
    const executionData = startInput(ctx, env, g, map);
    const payload: RunPayload = unmetReference === undefined
      ? { executionData, attempt: 0 }
      : { executionData, attempt: 0, unmetReference };
    ctx.output(g.running, payload);
  };
}

// ==================== the other roles ====================

function runAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const payload = ctx.input(g.running) as RunPayload;
    await guarded(ctx, g, map, payload.executionData, () => attempt(envOf(ctx), g, payload));
    ctx.output(g.idle, null);
  };
}

function exhaustedAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const payload = ctx.input(g.retry!) as RetryPayload;
    await guarded(ctx, g, map, payload.executionData, () => exhaust(envOf(ctx), payload));
  };
}

function retryWaitAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    const r = ctx.input(g.retry!) as RetryPayload;
    const next: RunPayload = {
      executionData: r.executionData, attempt: r.attempt, taskStartedData: r.taskStartedData,
      // A soft failure resumes inside n8n's inner loop; a thrown one re-enters the try body.
      softRetry: r.reason.kind === 'soft',
    };
    ctx.output(g.running, next);
  };
}

/** Lines 272–331 per connected output: the v1 gate `nodeSuccessData[o].length !== 0`. */
function routeOutput(ctx: TransitionContext, g: NodeGadget, out: NodeGadget['outputs'][number], value: OkPayload): void {
  const items = value.nodeSuccessData[out.index];
  if (items !== undefined && items !== null && items.length !== 0) {
    const source: ISourceData = { previousNode: g.node, previousNodeOutput: out.index, previousNodeRun: value.runIndex };
    const payload: EdgePayload = { kind: 'edge', items, source };
    for (const e of out.edges) ctx.output(e.data, payload);
  } else if (out.nil !== null) {
    ctx.output(out.nil, null);
  } else {
    for (const e of out.edges) ctx.output(e.empty!, null);
  }
}

function routeAction(g: NodeGadget, map: NetMapView, info: TransitionInfo): TransitionAction {
  if (g.splitRouting) {
    const out = g.outputs.find((o) => o.index === info.port)!;
    return async (ctx) => {
      routeOutput(ctx, g, out, ctx.input(out.ok!) as OkPayload);
      ctx.output(out.routed!, null);
    };
  }
  return async (ctx) => {
    const value = ctx.input(g.ok!) as OkPayload;
    for (const out of g.outputs) routeOutput(ctx, g, out, value);
    ctx.output(map.shared.budget, null);
    ctx.output(g.done, null);
  };
}

/**
 * The scheduler's binder. Structural roles (`skip`, `arm`, `clear`, `sink`, `reap`, the
 * split-routing `done`) keep the compiler's placeholders (`null`).
 */
export function schedulerActions(): ActionBinder {
  return (info, map) => {
    if (info.node === null) return null;
    const g = map.node(info.node);
    switch (info.role) {
      case 'start': return startAction(g, map);
      case 'start-unmet': return startAction(g, map, info.reference!);
      case 'run': return runAction(g, map);
      case 'route': return routeAction(g, map, info);
      case 'retry': return retryWaitAction(g);
      case 'exhausted': return exhaustedAction(g, map);
      default: return null;
    }
  };
}
