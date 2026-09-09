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
 */
import type { TransitionAction, TransitionContext } from 'libpetri';
import type {
  EngineRequest, EngineResponse, ExecutionBaseError, IExecuteData, INode, INodeExecutionData, IRunExecutionData,
  IRunNodeResponse, ISourceData, ITaskDataConnections, ITaskStartedData, Workflow,
} from 'n8n-workflow';
import { entryForEdge } from '../codec.js';
import type { ActionBinder, InputGadget, NetMapView, NodeGadget, TransitionInfo } from '../compiler/index.js';
import type { PlannedNode, SchedulerHooks, SchedulerHost } from '../n8n/host.js';
import { engineRequestUnsupported, toolCallBudgetExceeded, UnmetReferenceError } from './errors.js';
import {
  isDispatchPayload, isEdgePayload, isEntryPayload,
  type DispatchPayload, type EdgePayload, type OkPayload, type RequestPayload, type ResponsePayload,
  type RetryPayload, type RetryReason, type RoundPayload, type RunPayload, type StoppedPayload,
  type WaitingPayload,
} from './payloads.js';

/** The execution-context key the scheduler installs (`ctx.executionContext(ENV_KEY)`). */
export const ENV_KEY = 'n8n';

/** The per-execution fields `StackScheduler` keeps on itself, shared between scheduler and actions. */
export interface SchedulerState {
  /**
   * The error that ended the execution: n8n's `this.executionError` at the loop's `break`.
   * Written **once**, by the activation whose failure took the halt branch, and never
   * overwritten — above k = 1 a sibling is still running and its own catch, retry or start
   * would otherwise clear it, and `processSuccessExecution` would persist a halted
   * execution as a finished success (`workflow-execute.ts:2250-2255`).
   */
  haltError: ExecutionBaseError | undefined;
  /**
   * What n8n's per-iteration `this.executionError` still held when the last activation to
   * *complete* finished: `undefined` unless that activation ended on an error its `onError`
   * policy continued past. n8n clears the field at the top of every iteration (line 56) and
   * every retry (line 107), so only the last iteration's value survives its `run()`; at
   * k = 1 completion order *is* iteration order, so this is byte-identical, and above it the
   * value follows completion order (divergence #19).
   */
  leftoverError: ExecutionBaseError | undefined;
  closeFunction: Promise<void> | undefined;
  /** An error the mirrored loop would have thrown out of `run()`; rethrown after quiescence. */
  fatal: unknown | undefined;
  /** The node that put the execution to wait; see {@link observeWait}. */
  waitingNode: string | undefined;
  /**
   * `runExecutionData.waitTill` as `run()` found it. A field still holding that value was
   * not set by any node of this execution, so no node may claim it and no recorded status
   * is corrected: that is n8n's own reading of the field.
   */
  waitTillAtStart: Date | undefined;
  /** How often each node's `X_start` / `X_start_unmet` has fired in this execution. */
  readonly starts: Map<string, number>;
  /**
   * Node runs currently in flight: activations inside an `X_run` action, which is the only
   * transition that calls `host.runNode`. A retry *wait* (`X_retry_wait`) and the exhausted
   * recording (`X_exhausted`) hold a budget unit without running the node, and are not
   * counted — README "Concurrency" defines the observable as concurrent **runs**.
   */
  inFlight: number;
  /** The high-water mark of {@link SchedulerState.inFlight}: never above the budget k. */
  maxInFlight: number;
}

export interface ExecutionEnv {
  readonly host: SchedulerHost;
  readonly workflow: Workflow;
  readonly runExecutionData: IRunExecutionData;
  readonly hooks: SchedulerHooks;
  readonly state: SchedulerState;
  readonly diagnostic: (message: string) => void;
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
  | { readonly kind: 'stopped'; readonly executionData: IExecuteData; readonly ran: boolean }
  /** The node returned an `EngineRequest`: `A_done_req` opens a tool round from this payload. */
  | { readonly kind: 'request'; readonly payload: RequestPayload };

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
 * The `IExecuteData` of one planned activation, exactly as `addNodeToBeExecuted` builds it for a
 * node with at most one `main` input (`workflow-execute.ts:800-855`).
 *
 * Every entry of a round is such a node: a tool has no `main` producer at all, and an agent has
 * one. The multi-input half of that function — `waitingExecution`, the sibling walk — is
 * therefore unreachable here, and {@link planRound} refuses rather than guesses if a workflow
 * ever presents an agent wired otherwise.
 */
function plannedEntry(env: ExecutionEnv, e: PlannedNode): IExecuteData {
  const node = env.workflow.nodes[e.inputConnectionData.node];
  if (node === undefined) {
    throw new Error(`n8n-libpetri: planned activation for unknown node '${e.inputConnectionData.node}'`);
  }
  const main: Array<INodeExecutionData[] | null> = [];
  for (let i = e.inputConnectionData.index; i >= 0; i--) main[i] = null;
  main[e.inputConnectionData.index] = e.parentOutputData[e.parentOutputIndex] ?? null;
  return {
    node,
    data: { main } as ITaskDataConnections,
    source: {
      main: [{
        previousNode: e.parentNode,
        previousNodeOutput: e.parentOutputIndex,
        previousNodeRun: e.runIndex,
      }],
    },
    runIndex: e.nodeRunIndex,
    ...(e.metadata === undefined ? {} : { metadata: e.metadata }),
  } as IExecuteData;
}

/**
 * Lines 163–174: the agent's `EngineRequest`, planned but not dispatched.
 *
 * n8n's `handleEngineRequest` plans the round *and* pushes it onto `nodeExecutionStack`.
 * `planEngineRequest` is the same call without the push, so we get n8n's own plan — the
 * reserved `runData` slots, the `rewireOutputLogTo` tag, the `preservedSourceOverwrite`
 * metadata — and the net decides when any of it runs. Nothing is ever enqueued on the host:
 * `FakeHost.addNodeToBeExecuted` throws precisely to keep that true.
 *
 * `handleRequest` reverses the actions under v1 and `unshift`s the agent's own re-entry first,
 * so the plan reads `[agent, tool_m … tool_1]`. Reversing it back gives the request order the
 * queue dispatches in, with the agent's re-entry separated out.
 */
function planRound(
  env: ExecutionEnv,
  g: NodeGadget,
  executionNode: INode,
  executionData: IExecuteData,
  runIndex: number,
  request: EngineRequest,
): Outcome | null {
  const { host, workflow, runExecutionData } = env;
  // Whether the node has a round to open is decided *after* the plan, not before it: n8n
  // reserves the requested nodes' run-data slots inside `handleRequest` even on the path where
  // it then schedules nothing, and a request that plans nothing dispatches nothing, so it needs
  // no round and no `ai_tool` connection. The per-entry check below is what refuses a dispatch
  // the net cannot route.
  const planned = host.planEngineRequest({
    workflow, currentNode: executionNode, request, runIndex, executionData,
    runData: runExecutionData.resultData.runData,
  });
  // n8n returns nothing when the parent node cannot be found and reports it; the round never
  // opens and the activation produced no output, which is what its own loop does next.
  if (planned.length === 0) {
    env.diagnostic(
      `node '${executionNode.name}': engine request could not be planned (no parent node); ` +
      'no tool round is opened and the activation produces no output, as n8n does');
    return null;
  }
  const [resumePlan, ...toolPlans] = planned;
  if (resumePlan === undefined || resumePlan.inputConnectionData.node !== executionNode.name) {
    throw new Error(
      `internal: node '${executionNode.name}' planned a round whose first entry is ` +
      `'${resumePlan?.inputConnectionData.node}'; expected the agent's own re-entry`);
  }
  for (const e of planned) {
    // The single-input assumption `plannedEntry` rests on. n8n would route a multi-input node
    // through `waitingExecution` instead, and no agent or tool node is one.
    const inputs = workflow.connectionsByDestinationNode[e.inputConnectionData.node]?.main?.length ?? 0;
    if (inputs > 1) {
      throw new Error(
        `n8n-libpetri: tool round for '${executionNode.name}' includes '${e.inputConnectionData.node}', ` +
        `which has ${inputs} main inputs; agent and tool activations must have at most one`);
    }
  }
  // `handleRequest` reversed the actions so a LIFO stack would run them in request order; we
  // dispatch from the head of a queue, so reverse them back.
  const pending = toolPlans.reverse().map((e) => plannedEntry(env, e));
  for (const entry of pending) {
    if (!g.tools.includes(entry.node.name)) {
      // n8n dispatches by node *name* and never consults the connections; the net dispatches by
      // the `ai_tool` connection the workflow draws, so an action naming an unwired node cannot
      // be routed (divergence #22). Fail by name rather than dispatching a prefix of the round.
      throw engineRequestUnsupported(executionNode, entry.node.name);
    }
  }
  if (g.routedRequest === null) throw engineRequestUnsupported(executionNode);
  const payload: RequestPayload = {
    kind: 'request',
    pending,
    resume: plannedEntry(env, resumePlan),
    roundId: `${executionNode.name}#${runIndex}`,
  };
  return { kind: 'request', payload };
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
): Promise<INodeExecutionData[][] | null | undefined> {
  if (isEngineRequest(runNodeData)) throw engineRequestUnsupported(executionNode);
  const nodeOutput = await env.host.processNodeOutput(runNodeData, env.workflow, executionData, taskStartedData, runIndex);
  // Keep the close function of an earlier node if this one registered none (line 185).
  env.state.closeFunction = nodeOutput.closeFunction ?? env.state.closeFunction;
  return nodeOutput.nodeSuccessData;
}

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
type WaitClaim = 'claimed' | 'foreign' | 'none';

/** A memoised {@link observeWait} for one attempt: probed once, read by every branch. */
type WaitProbe = () => WaitClaim;

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
function observeWait(env: ExecutionEnv, executionNode: INode, before: Date | undefined): WaitClaim {
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
function probeWait(env: ExecutionEnv, executionNode: INode, before: Date | undefined): WaitProbe {
  let claim: WaitClaim | undefined;
  return () => (claim ??= observeWait(env, executionNode, before));
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

  host.normalizeNodeErrors(nodeSuccessData!);
  taskData.data = { main: nodeSuccessData } as ITaskDataConnections;
  host.rewireOutputLog(executionNode, taskData, nodeSuccessData!, runIndex);
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
  return { kind: 'ok', nodeSuccessData: nodeSuccessData!, runIndex };
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
function retryOutcome(payload: RetryPayload): Outcome {
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
  const { host, workflow, runExecutionData } = env;
  const { executionData } = payload;
  const executionNode = executionData.node;
  const taskStartedData = payload.taskStartedData!;
  const runIndex = host.computeRunIndex(executionData);
  const waitTillBefore = runExecutionData.waitTill;
  const wait = probeWait(env, executionNode, waitTillBefore);
  const again = (reason: RetryReason): Outcome =>
    retryOutcome({ executionData, attempt: payload.attempt + 1, taskStartedData, waitTillBefore, reason });
  try {
    const runNodeData = await host.runNode(
      workflow, executionData, runExecutionData, runIndex, host.additionalData, host.mode, host.abortSignal);
    wait(); // claim in the same turn as the resolution (divergence #15)
    if (isEngineRequest(runNodeData)) {
      const round = planRound(env, g, executionNode, executionData, runIndex, runNodeData);
      if (round !== null) return round;
      return { kind: 'ok', nodeSuccessData: [], runIndex };
    }
    if (g.retry !== null && checkFailure(runNodeData)) {
      return again({ kind: 'soft', runNodeData: runNodeData as IRunNodeResponse });
    }
    const nodeSuccessData = await postRun(env, executionNode, executionData, taskStartedData, runIndex, runNodeData);
    return await finishSuccess(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, wait);
  } catch (error) {
    // A throw leaves the inner loop for n8n's outer `catch` (line 209); the next try runs the
    // whole body again, so it is a plain error retry from here on.
    const executionError = host.reportNodeExecutionError(error, executionNode, workflow);
    if (g.retry !== null) return again({ kind: 'error', error: executionError });
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, executionError, wait);
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
  // Line 67. Recomputed per attempt: runData of this node does not change between attempts.
  const runIndex = host.computeRunIndex(executionData);
  // Lines 69–72, the endless-loop guard: abandoned (divergence #6).
  // Line 101, read once per popped entry as n8n reads it (outside the try loop): `[1, 0]` for
  // a node without retryOnFail or resuming with `metadata.resumeError`. A later attempt only
  // exists because that read allowed one, so the net (`X/tries`) decides from there on.
  let canRetry = g.retry !== null;
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
    const [maxTries] = host.getRetryParams(executionData);
    canRetry = maxTries > 1 && g.retry !== null;
  }

  const waitTillBefore = runExecutionData.waitTill;
  const wait = probeWait(env, executionNode, waitTillBefore);
  try {
    const pinnedOutput = host.getPinnedOutput(executionNode); // line 120
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
      host.collectSubNodeResults(executionData, subNodeExecutionResults); // line 125
      const runNodeData = await host.runNode(
        workflow, executionData, runExecutionData, runIndex, host.additionalData, host.mode, host.abortSignal,
        subNodeExecutionResults,
      ); // lines 132–141
      wait(); // claim in the same turn as the resolution (divergence #15)
      // Lines 163–174: an agent asking for its tools. n8n `continue`s the loop here — nothing
      // is recorded for this activation, no `nodeExecuteAfter`, no output — and the net does
      // the same: the request outcome opens a round and the agent re-enters through `A_resume`.
      if (isEngineRequest(runNodeData)) {
        const round = planRound(env, g, executionNode, executionData, runIndex, runNodeData);
        if (round !== null) return round;
        return { kind: 'ok', nodeSuccessData: [], runIndex };
      }
      // Lines 143–160: the soft-failure re-run; the net decides whether a try is left.
      if (canRetry && checkFailure(runNodeData)) {
        return retryOutcome({ executionData, attempt: payload.attempt + 1, taskStartedData, waitTillBefore, reason: { kind: 'soft', runNodeData: runNodeData as IRunNodeResponse } });
      }
      nodeSuccessData = await postRun(env, executionNode, executionData, taskStartedData, runIndex, runNodeData);
    }
    return await finishSuccess(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, wait);
  } catch (error) {
    const executionError = host.reportNodeExecutionError(error, executionNode, workflow); // line 210
    if (canRetry) {
      return retryOutcome({ executionData, attempt: payload.attempt + 1, taskStartedData, waitTillBefore, reason: { kind: 'error', error: executionError } });
    }
    return record(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, executionError, wait);
  }
}

/** `X_exhausted`: the after-loop handling of the last attempt. */
async function exhaust(env: ExecutionEnv, payload: RetryPayload): Promise<Outcome> {
  const { host } = env;
  const { executionData, taskStartedData, reason } = payload;
  const executionNode = executionData.node;
  const runIndex = host.computeRunIndex(executionData);
  // The attempt that produced this token read `waitTill` before its own `runNode`; probing
  // here is the earliest point after that run, since the run itself is already over.
  const wait = probeWait(env, executionNode, payload.waitTillBefore);
  wait();
  if (reason.kind === 'error') {
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, reason.error as ExecutionBaseError, wait);
  }
  // A soft failure with no try left is processed like any other output (line 176 on).
  try {
    const nodeSuccessData = await postRun(env, executionNode, executionData, taskStartedData, runIndex, reason.runNodeData);
    return await finishSuccess(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, wait);
  } catch (error) {
    const executionError = host.reportNodeExecutionError(error, executionNode, env.workflow);
    return record(env, executionNode, executionData, taskStartedData, runIndex, null, executionError, wait);
  }
}

// ==================== writing outcomes ====================

/**
 * The success outcome. Unless the node routes per output ({@link SPLIT_ROUTING_ABOVE}),
 * `X_run` carries the routing in its own `Out` spec, so the edge tokens are deposited here
 * and `X/routed` marks the outcome for `X_done` to refund the budget one cycle later
 * (ADR 0004). A split node writes one `X/ok_o` per output for its `X_route_o` instead.
 */
function succeed(
  ctx: TransitionContext, g: NodeGadget, value: OkPayload, map: NetMapView, run?: RunPayload,
): void {
  if (g.form === 'tool') {
    // A tool's output goes to the agent that dispatched it, not to a main edge. The `xor` over
    // the agents is resolved by the dispatch token, which named one when `T_start` fired. The
    // place is the agent's own `A/response`: composition funnelled this tool's `resp_k` port
    // onto it, so addressing it through the map is addressing the same place (CORE-002).
    const owner = run?.agent ?? g.agents[0]!;
    if (!g.agents.includes(owner)) {
      throw new Error(`internal: tool '${g.node}' has no ai_tool connection to '${owner}'`);
    }
    const payload: ResponsePayload = { kind: 'response', tool: g.node, roundId: run?.roundId ?? '' };
    ctx.output(map.node(owner).response!, payload);
    ctx.output(g.routed!, null);
    return;
  }
  if (g.splitRouting) {
    for (const out of g.outputs) ctx.output(out.ok!, value);
    return;
  }
  for (const out of g.outputs) routeOutput(ctx, g, out, value);
  ctx.output(g.routed!, null);
}

/** Writes the outcome's branch; `fallback` handles an outcome the gadget has no branch for. */
function write(ctx: TransitionContext, g: NodeGadget, map: NetMapView, outcome: Outcome, run?: RunPayload): void {
  const shared = map.shared;
  switch (outcome.kind) {
    case 'ok':
      succeed(ctx, g, { nodeSuccessData: outcome.nodeSuccessData, runIndex: outcome.runIndex }, map, run);
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
    case 'request':
      // Phased like the success outcome: the marker here, the budget refunded by `A_done_req`
      // one cycle later (ADR 0004), so the agent releases its slot for the tools it asked for.
      ctx.output(g.routedRequest!, outcome.payload);
      return;
  }
}

/** n8n's serialisable error shape (`initializeExecution`, `reportNodeExecutionError`): `{ ...e, message, stack }`. */
function asExecutionError(error: unknown): ExecutionBaseError {
  const e = (typeof error === 'object' && error !== null ? error : { message: String(error) }) as Error;
  return { ...e, message: e.message, stack: e.stack } as unknown as ExecutionBaseError;
}

/**
 * Runs `body` and writes its outcome; anything it throws (the mirrored loop would have
 * rejected `run()`) becomes the contract's halt error and the execution's fatal error, and takes
 * the halt branch — `stopped` (with `ran: true`, so nothing is re-queued) when the gadget
 * has no halt alternative — so the net quiesces and the token is never lost.
 */
async function guarded(
  ctx: TransitionContext,
  g: NodeGadget,
  map: NetMapView,
  executionData: IExecuteData,
  body: () => Promise<Outcome>,
  run?: RunPayload,
): Promise<void> {
  const env = envOf(ctx);
  let outcome: Outcome;
  try {
    outcome = await body();
  } catch (error) {
    env.state.fatal ??= error;
    const fatal = asExecutionError(error);
    // It ends the execution, so it is a halt error: write-once, never cleared by a sibling.
    env.state.haltError ??= fatal;
    env.diagnostic(`node '${g.node}': fatal error outside n8n's node try (run() rejects after quiescence): ${fatal.message}`);
    outcome = g.onError === 'stopWorkflow' ? { kind: 'halt' } : { kind: 'stopped', executionData, ran: true };
  }
  // The halt token this writes is the run's terminal marker: nothing consumes it, nothing
  // clears the pending activations, and the quiescent marking still holds every one of them
  // where the codec reads it (`compiler/compile.ts`, ADR 0004). No snapshot is taken here —
  // one taken at this point could not see what a sibling resolving in the same executor
  // cycle deposits, since `X_run` routes its own outcome and those arrivals reach the
  // marking in the same phase-1 batch as `_halt` itself.
  write(ctx, g, map, outcome, run);
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
/**
 * The tool form's input side: one dispatch token, which carries the activation n8n's own
 * `addNodeToBeExecuted` built *and* the agent that asked for it. The agent travels on the token
 * because a tool can serve several agents and `T_run`'s success is an `xor` over their
 * `A/response` places.
 */
function startInputTool(ctx: TransitionContext, g: NodeGadget): DispatchPayload {
  const v = ctx.input(g.inTool!);
  if (!isDispatchPayload(v)) throw new Error(`node '${g.node}': unexpected token on '${g.inTool!.name}'`);
  return v;
}

function startInput(ctx: TransitionContext, env: ExecutionEnv, g: NodeGadget, map: NetMapView): IExecuteData {
  if (g.form === 'tool') return startInputTool(ctx, g).executionData;
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
    env.state.starts.set(g.node, (env.state.starts.get(g.node) ?? 0) + 1);
    // The tool form consumes a dispatch token that names the agent it answers to, so the run
    // can route its success back to the right `A/response`.
    let executionData: IExecuteData;
    let round: { agent?: string; roundId?: string } = {};
    if (g.form === 'tool') {
      const dispatch = startInputTool(ctx, g);
      executionData = dispatch.executionData;
      round = { agent: dispatch.agent, roundId: dispatch.roundId };
    } else {
      executionData = startInput(ctx, env, g, map);
    }
    const payload: RunPayload = unmetReference === undefined
      ? { executionData, attempt: 0, ...round }
      : { executionData, attempt: 0, unmetReference, ...round };
    ctx.output(g.running, payload);
  };
}

// ==================== the other roles ====================

function runAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const { state } = envOf(ctx);
    const payload = ctx.input(g.running) as RunPayload;
    state.inFlight++;
    if (state.inFlight > state.maxInFlight) state.maxInFlight = state.inFlight;
    try {
      await guarded(ctx, g, map, payload.executionData, () => attempt(envOf(ctx), g, payload), payload);
    } finally {
      state.inFlight--;
    }
    ctx.output(g.idle, null);
  };
}

function exhaustedAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const payload = ctx.input(g.retry!) as RetryPayload;
    await guarded(ctx, g, map, payload.executionData, () => exhaust(envOf(ctx), payload),
      { executionData: payload.executionData, attempt: payload.attempt, agent: payload.agent, roundId: payload.roundId });
  };
}

// ==================== the agent round ====================

/**
 * `A_done_req`: the round opens — with the queue when there is something to dispatch, or
 * already drained for an empty request, in which case `A_resume` fires next and the agent
 * re-runs with an empty `EngineResponse`. No count is deposited: the number of tool calls is
 * discovered by `A_dispatch` firing, one budget unit at a time.
 */
function doneRequestAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const payload = ctx.input(g.routedRequest!) as RequestPayload;
    ctx.output(map.shared.budget, null);
    const round: RoundPayload = { kind: 'round', resume: payload.resume, roundId: payload.roundId };
    ctx.output(g.dispatched!, round);
    if (payload.pending.length === 0) ctx.output(g.drained!, null);
    else ctx.output(g.queue!, payload);
  };
}

/**
 * `A_dispatch`: the head of the queue onto its tool's `T/in_tool`, the tail back onto
 * `A/queue`, one unit onto `A/outstanding`.
 *
 * One firing per action, in request order, because `A/queue` holds a single token. n8n's own
 * `executes requested tools in the order the actions were requested` is what that preserves;
 * the tools then run at whatever width `_budget` allows, which is where this differs from a
 * stack that runs them one at a time.
 */
function dispatchAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const payload = ctx.input(g.queue!) as RequestPayload;
    const [head, ...tail] = payload.pending;
    if (head === undefined) {
      throw new Error(`internal: agent '${g.node}' dispatched with an empty queue; the queue token should have been drained`);
    }
    const target = map.node(head.node.name);
    if (target.inTool === null) {
      throw new Error(`internal: agent '${g.node}' dispatched to '${head.node.name}', which is not a tool`);
    }
    const dispatch: DispatchPayload = {
      kind: 'dispatch', executionData: head, agent: g.node, roundId: payload.roundId,
    };
    ctx.output(target.inTool, dispatch);
    ctx.output(g.outstanding!, null);
    // The one decision this action makes that the graph cannot: whether the queue has more.
    // The graph explores both; see the gadget for why neither spurious branch can strand.
    if (tail.length === 0) ctx.output(g.drained!, null);
    else ctx.output(g.queue!, { ...payload, pending: tail });
  };
}

/**
 * `A_calls_out`: the tool-call budget is spent and the queue still holds actions. The agent
 * re-enters `X_run` carrying the fact; `attempt()` then fails the activation with
 * `toolCallBudgetExceeded` before `runNode`, so the error is recorded and routed under the
 * node's `onError` policy exactly as `maxIterations` is when n8n's node throws it.
 */
function callsOutAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    const round = ctx.input(g.dispatched!) as RoundPayload;
    const queue = ctx.input(g.queue!) as RequestPayload;
    const next: RunPayload = {
      executionData: round.resume, attempt: 0, roundId: round.roundId,
      toolCallsExceeded: { undispatched: queue.pending.length, budget: g.maxToolCalls ?? 0 },
    };
    ctx.output(g.running, next);
  };
}

/**
 * `A_resume`: nothing left to dispatch and nothing still out, so the agent re-enters `X_run`
 * with the entry n8n built for it — `metadata.nodeWasResumed` suppresses the second
 * `nodeExecuteBefore` hook and `metadata.subNodeExecutionData` is what
 * `host.collectSubNodeResults` reads the round's `EngineResponse` back out of.
 */
function resumeAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    const payload = ctx.input(g.dispatched!) as RoundPayload;
    const next: RunPayload = { executionData: payload.resume, attempt: 0, roundId: payload.roundId };
    ctx.output(g.running, next);
  };
}

/**
 * `A_rounds_out`: the agent has spent its round budget with a round still open, so nothing can
 * resume it. The re-entry goes back through `X/stopped` with `ran: false` — the shape the codec
 * already writes onto `nodeExecutionStack` for an activation that never ran — and `_pause` makes
 * the run a designed stop rather than a silent quiesce.
 */
function roundsOutAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const payload = ctx.input(g.dispatched!) as RoundPayload;
    const env = envOf(ctx);
    env.diagnostic(
      `agent '${g.node}': round budget spent with a round still open; the re-entry and any ` +
      'undispatched tool calls are written back to nodeExecutionStack');
    const stopped: StoppedPayload = { executionData: payload.resume, ran: false };
    ctx.output(g.stopped, stopped);
    ctx.output(map.shared.pause, null);
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

/** Per-output routing only (`splitRouting`): `X_route_o` drains one `X/ok_o`. */
function routeAction(g: NodeGadget, info: TransitionInfo): TransitionAction {
  const out = g.outputs.find((o) => o.index === info.port)!;
  return async (ctx) => {
    routeOutput(ctx, g, out, ctx.input(out.ok!) as OkPayload);
    ctx.output(out.routed!, null);
  };
}

/**
 * The scheduler's binder. Structural roles (`skip`, `arm`, `clear`, `sink`, `done`) keep the
 * compiler's placeholders (`null`).
 */
export function schedulerActions(): ActionBinder {
  return (info, map) => {
    if (info.node === null) return null;
    const g = map.node(info.node);
    switch (info.role) {
      case 'start': return startAction(g, map);
      case 'start-unmet': return startAction(g, map, info.reference!);
      case 'run': return runAction(g, map);
      case 'route': return routeAction(g, info);
      case 'retry': return retryWaitAction(g);
      case 'exhausted': return exhaustedAction(g, map);
      case 'done-request': return doneRequestAction(g, map);
      case 'dispatch': return dispatchAction(g, map);
      case 'resume': return resumeAction(g);
      case 'rounds-out': return roundsOutAction(g, map);
      case 'calls-out': return callsOutAction(g);
      // `collect` produces nothing (a genuine sink, CORE-043 AC4): pairing one response with
      // one outstanding marker is the whole of its effect, and the marking is where it lands.
      default: return null;
    }
  };
}
