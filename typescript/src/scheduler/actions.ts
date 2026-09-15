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
 */
import type { Place, TransitionAction, TransitionContext } from 'libpetri';
import type {
  EngineRequest, EngineResponse, ExecutionBaseError, IExecuteData, INode, INodeExecutionData, IRunExecutionData,
  IRunNodeResponse, ISourceData, ITaskDataConnections, ITaskStartedData, Workflow,
} from 'n8n-workflow';
import { entryForEdge } from '../codec.js';
import { readySlot } from '../compiler/index.js';
import type {
  ActionBinder, AgentGadget, AttemptGadget, AttemptTransition, DeadlineTransition, NetMapView, NodeGadget,
  RouteTransition, RunTransition, SlottedGadget, ToolGadget,
} from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import type { PlannedNode, SchedulerHooks, SchedulerHost } from '../n8n/host.js';
import type { ToolDispatch } from './payloads.js';
import {
  asExecutionError, attemptDeadlineExceeded, engineRequestUnsupported, toolCallBudgetExceeded, UnmetReferenceError,
} from './errors.js';
import {
  isDispatchPayload, isEdgePayload, isEntryPayload, isOkPayload, isRequestPayload, isRetryPayload, isRoundPayload,
  isRunPayload,
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
  /**
   * Node runs currently in flight: activations inside an `X_run` action, which is the only
   * transition that calls `host.runNode`. A retry *wait* (`X_retry_wait`) and the exhausted
   * recording (`X_exhausted`) hold a budget unit without running the node, and are not
   * counted — README "Concurrency" defines the observable as concurrent **runs**.
   */
  inFlight: number;
  /** The high-water mark of {@link SchedulerState.inFlight}: never above the budget k. */
  maxInFlight: number;
  /**
   * Run payloads whose firing a deadline abandoned (ADR 0009 §4).
   *
   * IO-013 discards what the abandoned firing wrote to the *marking*, but our action is not
   * only a computation: it goes on to call `upsertTaskData`, `nodeExecuteAfter` and
   * `handleNodeExecutionError`. A `runNode` that resolves after the budget expired would write
   * task data for an attempt the net has already disowned, and the execution would end holding
   * it. Membership here is what those writes check.
   *
   * Keyed on the payload object's identity, which is unique per activation and which
   * `forwardInput` (IO-014) preserves into the timeout place — so the funnel and the late
   * completion are talking about the same run.
   */
  readonly abandoned: WeakSet<object>;
  /**
   * The `ITaskStartedData` of each in-flight run, by run-payload identity.
   *
   * A deadline can abandon attempt 1's firing *before* the action has put anything back into
   * the marking, and `createTaskStartedData` is what assigns n8n's `executionIndex` — called
   * once per activation, never once per attempt. So the step answering the expiry cannot
   * recreate it and cannot read it off the token: it reads it here, keyed on the very payload
   * `forwardInput` carried into the timeout place.
   */
  readonly startedData: WeakMap<object, ITaskStartedData>;
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
  run: RunPayload,
  runIndex: number,
  request: EngineRequest,
): Outcome | null {
  const { host, workflow, runExecutionData } = env;
  const { executionData } = run;
  const executionNode = executionData.node;
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
  const tools: readonly string[] = g.agent?.tools ?? [];
  for (const entry of pending) {
    if (!tools.includes(entry.node.name)) {
      // n8n dispatches by node *name* and never consults the connections; the net dispatches by
      // the `ai_tool` connection the workflow draws, so an action naming an unwired node cannot
      // be routed (divergence #22). Fail by name rather than dispatching a prefix of the round.
      throw engineRequestUnsupported(executionNode, entry.node.name);
    }
  }
  if (g.agent === null) throw engineRequestUnsupported(executionNode);
  const resume = plannedEntry(env, resumePlan);
  const payload: RequestPayload = {
    kind: 'request',
    pending,
    resume,
    roundId: `${executionNode.name}#${runIndex}`,
    // A tool that is itself an agent opens its own round, but its answer still goes to the agent
    // that dispatched it: the address rides on the round's tokens ({@link RequestPayload.answers}).
    ...(g.form === 'tool' ? { answers: dispatchOf(g, run) } : {}),
  };
  return { kind: 'request', payload };
}

/**
 * The dispatch a tool's run payload carries: the agent whose `A/response` its success branch
 * writes, and the round it belongs to. Every producer of a tool's `RunPayload` sets both — the
 * dispatch token at `T_start`, and every retry, step, deadline and re-entry after it — so a
 * payload without them is an invariant of this file broken, not a workflow condition.
 */
function dispatchOf(g: ToolGadget, run: RunPayload | undefined): ToolDispatch {
  if (run?.agent === undefined || run.roundId === undefined) {
    throw new Error(`internal: tool '${g.node}' ran without the agent that dispatched it; its run payload carries no dispatch`);
  }
  if (!g.agents.includes(run.agent)) {
    throw new Error(`internal: tool '${g.node}' has no ai_tool connection to '${run.agent}'`);
  }
  return { agent: run.agent, roundId: run.roundId };
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
function carried(p: { readonly agent?: string; readonly roundId?: string }): { readonly agent?: string; readonly roundId?: string } {
  return {
    ...(p.agent === undefined ? {} : { agent: p.agent }),
    ...(p.roundId === undefined ? {} : { roundId: p.roundId }),
  };
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
  const again = (reason: RetryReason): Outcome => retryOutcome(payload, taskStartedData, waitTillBefore, reason);
  try {
    const runNodeData = await host.runNode(
      workflow, executionData, runExecutionData, runIndex, host.additionalData, host.mode, host.abortSignal);
    wait(); // claim in the same turn as the resolution (divergence #15)
    if (isEngineRequest(runNodeData)) {
      const round = planRound(env, g, payload, runIndex, runNodeData);
      if (round !== null) return round;
      return { kind: 'ok', nodeSuccessData: [], runIndex };
    }
    if (g.retry !== null && checkFailure(runNodeData)) return again({ kind: 'soft', runNodeData });
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

function abandoned(env: ExecutionEnv, payload: RunPayload): boolean {
  if (!isAbandoned(env, payload)) return false;
  env.diagnostic(
    `node '${payload.executionData.node.name}': attempt ${payload.attempt + 1} finished after its ` +
    'deadline abandoned it; the late result is discarded and nothing is recorded for it');
  return true;
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
    return record(env, executionNode, executionData, taskStartedData, runIndex, nodeSuccessData, executionError, wait);
  }
}

/** `X_exhausted`: the after-loop handling of the last attempt. */
async function exhaust(
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

// ==================== writing outcomes ====================

/**
 * One token a firing deposits. An outcome is turned into a complete list of these *before*
 * anything is emitted, so the writer is a pure function of the outcome and the gadget: a list
 * that cannot be computed leaves the marking untouched and takes the fallback branch instead,
 * where a throw mid-way through a sequence of `ctx.output` calls would reject the transition
 * after the firing consumed its tokens and its budget unit (EXEC-030).
 */
interface Deposit {
  readonly place: Place<unknown>;
  readonly value: unknown;
}

/**
 * The success outcome. Unless the node routes per output ({@link SPLIT_ROUTING_ABOVE}),
 * `X_run` carries the routing in its own `Out` spec, so the edge tokens are deposited here
 * and `X/routed` marks the outcome for `X_done` to refund the budget one cycle later
 * (ADR 0004). A split node writes one `X/ok_o` per output for its `X_route_o` instead.
 */
function succeed(g: NodeGadget, value: OkPayload, map: NetMapView, run?: RunPayload): Deposit[] {
  if (g.form === 'tool') {
    // A tool's output goes to the agent that dispatched it, not to a main edge. The `xor` over
    // the agents is resolved by the dispatch the run payload carries, which the dispatch token
    // named when `T_start` fired and every attempt since has kept. The place is the agent's own
    // `A/response`: composition funnelled this tool's `resp_k` port onto it, so addressing it
    // through the map is addressing the same place (CORE-002).
    const dispatch = dispatchOf(g, run);
    const agent = map.node(dispatch.agent).agent;
    if (agent === null) {
      throw new Error(`internal: '${dispatch.agent}' is wired as an agent of '${g.node}' but compiled without an agent side`);
    }
    if (g.routing.kind === 'split') throw new Error(`internal: tool '${g.node}' routes per output`);
    const payload: ResponsePayload = { kind: 'response', tool: g.node, roundId: dispatch.roundId };
    return [{ place: agent.response, value: payload }, { place: g.routing.routed, value: null }];
  }
  if (g.routing.kind === 'split') return g.routing.outputs.map((out) => ({ place: out.ok, value }));
  return [...g.routing.outputs.flatMap((out) => routeOutput(g, out, value)), { place: g.routing.routed, value: null }];
}

/** Whether `X_run` was compiled with a halt branch (`compiler/gadget.ts`: `stopWorkflow`, or any `onFailure` chain). */
function hasHaltBranch(g: NodeGadget): boolean {
  return g.onError === 'stopWorkflow' || g.attempts.length > 0;
}

/** The tokens `outcome` deposits on `g`'s branch for it; throws only on an invariant of the compiled net broken. */
function deposits(g: NodeGadget, map: NetMapView, outcome: Outcome, run?: RunPayload): Deposit[] {
  const shared = map.shared;
  switch (outcome.kind) {
    case 'ok':
      return succeed(g, { kind: 'ok', nodeSuccessData: outcome.nodeSuccessData, runIndex: outcome.runIndex }, map, run);
    case 'retry': {
      // With a chain the failure is a *position*, not a counter decrement: it goes to the
      // place belonging to the attempt that just failed, which `run.attempt` names (0-based,
      // as `X_start` seeds it). Without one it is n8n's single `X/retry`.
      if (g.attempts.length > 0) {
        const failing = g.attempts[run?.attempt ?? 0];
        if (failing === undefined) {
          throw new Error(`internal: node '${g.node}' has no attempt ${run?.attempt ?? 0} in its onFailure chain`);
        }
        return [{ place: failing.failed, value: outcome.payload }];
      }
      if (g.retry === null) throw new Error(`internal: node '${g.node}' produced a retry outcome without a retry gadget or an onFailure chain`);
      return [{ place: g.retry.retry, value: outcome.payload }];
    }
    case 'halt':
      // Unreachable for a gadget without the branch: {@link admissible} has already mapped it.
      if (!hasHaltBranch(g)) throw new Error(`internal: node '${g.node}' (onError ${g.onError}) has no halt branch`);
      return [{ place: shared.halt, value: null }, { place: shared.budget, value: null }];
    case 'waiting': {
      const v: WaitingPayload = { kind: 'waiting', executionData: outcome.executionData };
      return [{ place: g.waiting, value: v }, { place: shared.pause, value: null }, { place: shared.budget, value: null }];
    }
    case 'stopped': {
      const v: StoppedPayload = { kind: 'stopped', executionData: outcome.executionData, ran: outcome.ran };
      return [{ place: g.stopped, value: v }, { place: shared.pause, value: null }, { place: shared.budget, value: null }];
    }
    case 'request':
      // Phased like the success outcome: the marker here, the budget refunded by `A_done_req`
      // one cycle later (ADR 0004), so the agent releases its slot for the tools it asked for.
      if (g.agent === null) throw new Error(`internal: node '${g.node}' produced a request outcome but is not an agent`);
      return [{ place: g.agent.routedRequest, value: outcome.payload }];
    default: return assertNever(outcome, 'outcome');
  }
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
async function guarded(
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

// ==================== reading tokens ====================

/**
 * A token a transition consumed that is not the payload the gadget puts on that place. The
 * compiler builds every place for one payload and the actions in this file are its only
 * writers, so this is an invariant of the compiled net broken, never an n8n condition: it
 * names the transition and the place so the gadget that wired them can be found.
 */
export class UnexpectedTokenError extends Error {
  constructor(transition: string, place: string) {
    super(`internal: '${transition}' consumed a token on '${place}' that is not the payload the place carries`);
    this.name = 'UnexpectedTokenError';
  }
}

/** The token `ctx` consumed from `place`, narrowed by `guard`; anything else is an {@link UnexpectedTokenError}. */
function take<T>(ctx: TransitionContext, place: Place<unknown>, guard: (v: unknown) => v is T): T {
  const v = ctx.input(place);
  if (!guard(v)) throw new UnexpectedTokenError(ctx.transitionName(), place.name);
  return v;
}

// ==================== start: IExecuteData from the input tokens ====================

function liveNode(env: ExecutionEnv, g: NodeGadget): INode {
  const node = env.workflow.nodes[g.node];
  if (node === undefined) throw new Error(`n8n-libpetri: workflow has no node '${g.node}'`);
  return node;
}

/**
 * The tool form's input side: one dispatch token, which carries the activation n8n's own
 * `addNodeToBeExecuted` built *and* the agent that asked for it. The agent travels on the token
 * because a tool can serve several agents and `T_run`'s success is an `xor` over their
 * `A/response` places.
 */
function startInputTool(ctx: TransitionContext, g: ToolGadget): DispatchPayload {
  const v = ctx.input(g.inTool);
  if (!isDispatchPayload(v)) throw new UnexpectedTokenError(ctx.transitionName(), g.inTool.name);
  return v;
}

/** What one form's `X_start` consumes and builds, bound once per gadget: the per-firing part is the read. */
type StartInput = (ctx: TransitionContext, env: ExecutionEnv) => IExecuteData;

/**
 * Consumes the start inputs and builds the node's `IExecuteData`, refunding the join slots.
 * Everything that does not depend on the tokens — which input a direct edge lands on, the
 * width of a join's `main` — is computed here, at bind time, not per firing.
 */
function startInput(g: NodeGadget, map: NetMapView): StartInput {
  switch (g.form) {
    case 'tool': return (ctx) => startInputTool(ctx, g).executionData;
    case 'direct': {
      const inputIndex = map.place(g.in.name)?.edge?.inputIndex ?? 0;
      return (ctx, env) => {
        const v = ctx.input(g.in);
        if (isEntryPayload(v)) return v.executionData;
        if (!isEdgePayload(v)) throw new UnexpectedTokenError(ctx.transitionName(), g.in.name);
        return entryForEdge(liveNode(env, g), inputIndex, v);
      };
    }
    case 'or': {
      const [i] = g.inputs;
      return (ctx, env) => {
        ctx.output(i.ran, null);
        const v = ctx.input(i.hasdata);
        if (isEntryPayload(v)) return v.executionData;
        if (!isEdgePayload(v)) throw new UnexpectedTokenError(ctx.transitionName(), i.hasdata.name);
        return entryForEdge(liveNode(env, g), i.index, v);
      };
    }
    case 'join':
    case 'choose-branch': return startInputJoin(g);
    default: return assertNever(g, 'gadget form');
  }
}

function startInputJoin(g: SlottedGadget): StartInput {
  const slots = g.inputs.map((i) => readySlot(g, i, 'data'));
  // n8n's waitingExecution shape: items per arrived input, `[]` for an empty (R6's null → []
  // substitution done once), sources alongside.
  const inputCount = Math.max(...g.inputs.map((i) => i.index + 1));
  return (ctx, env) => {
    const values = slots.map((slot) => ctx.input(slot));
    for (const i of g.inputs) ctx.output(i.free, null);
    const first = values[0];
    if (isEntryPayload(first)) return first.executionData;
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
  };
}

function startAction(g: NodeGadget, map: NetMapView, unmetReference?: string): TransitionAction {
  const read = startInput(g, map);
  const unmet = unmetReference === undefined ? {} : { unmetReference };
  if (g.form === 'tool') {
    // The tool form consumes a dispatch token that names the agent it answers to, so the run
    // can route its success back to the right `A/response`.
    return async (ctx) => {
      const dispatch = startInputTool(ctx, g);
      const payload: RunPayload = {
        kind: 'run', executionData: dispatch.executionData, attempt: 0, ...unmet,
        agent: dispatch.agent, roundId: dispatch.roundId,
      };
      ctx.output(g.running, payload);
    };
  }
  return async (ctx) => {
    const payload: RunPayload = { kind: 'run', executionData: read(ctx, envOf(ctx)), attempt: 0, ...unmet };
    ctx.output(g.running, payload);
  };
}

// ==================== the other roles ====================

function runAction(g: NodeGadget, map: NetMapView, info: RunTransition): TransitionAction {
  // With a chain each attempt has its own run transition and its own `X/running_i`; attempt 1
  // reuses `X/running`, so a policy-free node is untouched.
  const from = g.attempts.length === 0 ? g.running : attemptOf(g, info).running;
  return async (ctx) => {
    const env = envOf(ctx);
    const { state } = env;
    const payload = take(ctx, from, isRunPayload);
    state.inFlight++;
    if (state.inFlight > state.maxInFlight) state.maxInFlight = state.inFlight;
    try {
      await guarded(ctx, env, g, map, payload.executionData, () => attempt(env, g, payload), payload);
    } finally {
      state.inFlight--;
    }
    ctx.output(g.idle, null);
  };
}

/** The retry gadget of a node whose `X_retry_wait` / `X_exhausted` is being bound: the gadget built them only with one. */
function retryOf(g: NodeGadget): Place<unknown> {
  if (g.retry === null) throw new Error(`internal: node '${g.node}' has a retry transition but no retry gadget`);
  return g.retry.retry;
}

/** The agent side of a node whose round transitions are being bound: the gadget built them only for an agent. */
function agentOf(g: NodeGadget): AgentGadget {
  if (g.agent === null) throw new Error(`internal: node '${g.node}' has a round transition but no agent side`);
  return g.agent;
}

/** The attempt a chain transition serves; the gadget names one per attempt it built. */
function attemptOf(g: NodeGadget, info: RunTransition | AttemptTransition | DeadlineTransition): AttemptGadget {
  const attempt = g.attempts.find((a) => a.index === info.attempt);
  if (attempt === undefined) throw new Error(`internal: node '${g.node}' has no attempt ${info.attempt} for '${info.name}'`);
  return attempt;
}

function exhaustedAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const retry = retryOf(g);
  return async (ctx) => {
    const env = envOf(ctx);
    const payload = take(ctx, retry, isRetryPayload);
    await guarded(ctx, env, g, map, payload.executionData, () => exhaust(env, payload),
      { kind: 'run', executionData: payload.executionData, attempt: payload.attempt, ...carried(payload) });
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
  const agent = agentOf(g);
  return async (ctx) => {
    const payload = take(ctx, agent.routedRequest, isRequestPayload);
    ctx.output(map.shared.budget, null);
    const round: RoundPayload = {
      kind: 'round', resume: payload.resume, roundId: payload.roundId,
      ...(payload.answers === undefined ? {} : { answers: payload.answers }),
    };
    ctx.output(agent.dispatched, round);
    if (payload.pending.length === 0) ctx.output(agent.drained, null);
    else ctx.output(agent.queue, payload);
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
  const agent = agentOf(g);
  return async (ctx) => {
    const payload = take(ctx, agent.queue, isRequestPayload);
    const [head, ...tail] = payload.pending;
    if (head === undefined) {
      throw new Error(`internal: agent '${g.node}' dispatched with an empty queue; the queue token should have been drained`);
    }
    const target = map.node(head.node.name);
    if (target.form !== 'tool') {
      throw new Error(`internal: agent '${g.node}' dispatched to '${head.node.name}', which is not a tool`);
    }
    const dispatch: DispatchPayload = {
      kind: 'dispatch', executionData: head, agent: g.node, roundId: payload.roundId,
    };
    ctx.output(target.inTool, dispatch);
    ctx.output(agent.outstanding, null);
    // The one decision this action makes that the graph cannot: whether the queue has more.
    // The graph explores both; see the gadget for why neither spurious branch can strand.
    if (tail.length === 0) ctx.output(agent.drained, null);
    else ctx.output(agent.queue, { ...payload, pending: tail });
  };
}

/**
 * `A_calls_out`: the tool-call budget is spent and the queue still holds actions. The agent
 * re-enters `X_run` carrying the fact; `attempt()` then fails the activation with
 * `toolCallBudgetExceeded` before `runNode`, so the error is recorded and routed under the
 * node's `onError` policy exactly as `maxIterations` is when n8n's node throws it.
 */
function callsOutAction(g: NodeGadget): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    const round = take(ctx, agent.dispatched, isRoundPayload);
    const queue = take(ctx, agent.queue, isRequestPayload);
    const next: RunPayload = {
      kind: 'run', executionData: round.resume, attempt: 0, roundId: round.roundId,
      toolCallsExceeded: { undispatched: queue.pending.length, budget: agent.maxToolCalls },
      ...reentry(g, round),
    };
    ctx.output(g.running, next);
  };
}

/**
 * The dispatch fields of an agent's re-entry. An agent on a main edge has none; a tool that is
 * itself an agent answers the agent that dispatched it, which the round token carries
 * ({@link RoundPayload.answers}). Its `roundId` replaces the tool's own: a tool's run payload
 * names the round it answers into — the one `A/response` names — as the dispatch token did.
 */
function reentry(g: NodeGadget, round: RoundPayload): { readonly agent?: string; readonly roundId?: string } {
  if (g.form !== 'tool') return {};
  if (round.answers === undefined) {
    throw new Error(`internal: tool '${g.node}' resumes round '${round.roundId}' without the agent that dispatched it`);
  }
  return round.answers;
}

/**
 * `A_resume`: nothing left to dispatch and nothing still out, so the agent re-enters `X_run`
 * with the entry n8n built for it — `metadata.nodeWasResumed` suppresses the second
 * `nodeExecuteBefore` hook and `metadata.subNodeExecutionData` is what
 * `host.collectSubNodeResults` reads the round's `EngineResponse` back out of.
 */
function resumeAction(g: NodeGadget): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    const payload = take(ctx, agent.dispatched, isRoundPayload);
    const next: RunPayload = {
      kind: 'run', executionData: payload.resume, attempt: 0, roundId: payload.roundId, ...reentry(g, payload),
    };
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
  const agent = agentOf(g);
  return async (ctx) => {
    const payload = take(ctx, agent.dispatched, isRoundPayload);
    const env = envOf(ctx);
    env.diagnostic(
      `agent '${g.node}': round budget spent with a round still open; the re-entry and any ` +
      'undispatched tool calls are written back to nodeExecutionStack');
    const stopped: StoppedPayload = { kind: 'stopped', executionData: payload.resume, ran: false };
    ctx.output(g.stopped, stopped);
    ctx.output(map.shared.pause, null);
  };
}

/**
 * `X/timedout_i` into `X/failed_i`: the deadline funnel (ADR 0009 §4).
 *
 * The token it moves is the very `RunPayload` the abandoned firing consumed — `forwardInput`
 * (IO-014) reproduces it, where IO-013's plain timeout child would have deposited a sentinel
 * and left the step with no `executionData`. Registering it as abandoned is what stops the
 * still-running `runNode` writing to n8n when it eventually resolves.
 */
function deadlineAction(g: NodeGadget, info: DeadlineTransition): TransitionAction {
  const attempt = attemptOf(g, info);
  const { timedOut, failed } = attempt;
  const timeoutMs = g.attemptTimeoutMs;
  if (timedOut === null || timeoutMs === null) {
    throw new Error(`internal: node '${g.node}' has a deadline funnel but attempt ${info.attempt} has no deadline`);
  }
  return async (ctx) => {
    const { state } = envOf(ctx);
    const run = take(ctx, timedOut, isRunPayload);
    state.abandoned.add(run);
    const started = state.startedData.get(run) ?? run.taskStartedData;
    if (started === undefined) {
      throw new Error(
        `internal: node '${g.node}' timed out before its task-started data was recorded`);
    }
    const failure: RetryPayload = {
      kind: 'retry',
      executionData: run.executionData,
      // Same convention as `retryOutcome`: a failure carries the *next* attempt's number.
      attempt: run.attempt + 1,
      taskStartedData: started,
      reason: { kind: 'timeout', timeoutMs },
      ...carried(run),
    };
    ctx.output(failed, failure);
  };
}

/** Why this attempt failed, in one line, for the item a `route` step emits. */
function failureMessage(payload: RetryPayload): string {
  const reason = payload.reason;
  if (reason.kind === 'timeout') return `did not finish within ${reason.timeoutMs} ms`;
  if (reason.kind === 'error') {
    // `.message` rather than `instanceof Error`: `reportNodeExecutionError` is the host's, and it
    // is only contracted to return something error-*shaped* — `FakeHost` returns a plain object.
    const message = (reason.error as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string' && message !== '' ? message : String(reason.error);
  }
  const item = reason.runNodeData.data?.[0]?.[0]?.json?.['error'];
  return typeof item === 'string' ? item : 'the attempt returned an error item';
}

/**
 * One step of an `onFailure` chain (ADR 0009 §3).
 *
 * The mapping is exact rather than new machinery: a `retry` step **is** `X_retry_wait` with the
 * step's own delay, and a terminal step **is** `X_exhausted` with the outcome the workflow chose
 * instead of the one `onError` fixed.
 */
function attemptStepAction(g: NodeGadget, info: AttemptTransition, map: NetMapView): TransitionAction {
  const attempt = attemptOf(g, info);
  if (attempt.action === 'retry') {
    return async (ctx) => {
      const r = take(ctx, attempt.failed, isRetryPayload);
      const payload: RunPayload = {
        kind: 'run',
        // `retryOutcome` already advanced the counter when it built this failure, so the next
        // run carries `r.attempt` as it stands — the same convention `X_retry_wait` uses.
        executionData: r.executionData, attempt: r.attempt, taskStartedData: r.taskStartedData,
        // A soft failure resumes inside n8n's inner loop; a thrown or timed-out one re-enters
        // the whole try body, since neither left a `runNodeData` to resume from.
        softRetry: r.reason.kind === 'soft',
        ...carried(r),
      };
      ctx.output(attempt.next, payload);
    };
  }
  return async (ctx) => {
    const env = envOf(ctx);
    const payload = take(ctx, attempt.failed, isRetryPayload);
    // The terminal step *is* this node's error policy, so n8n's own `handleNodeExecutionError`
    // is reused rather than reimplemented — with `executionData.node.onError` set to the value
    // the step named. n8n reads `onError` off `executionData.node` (`continuesOnError`), not off
    // the `executionNode` argument, which is why the clone is on the execution data.
    // `route` borrows n8n's `continueErrorOutput`, `continue` its `continueRegularOutput`.
    // Both make `continuesOnError` true, so n8n's own handler continues the execution; which
    // output the payload lands on is decided below, because n8n itself never routes a *thrown*
    // failure to the error output — `handleNodeErrorOutput` only sorts per-item errors out of
    // an otherwise successful run (divergence #27).
    const onError = attempt.action === 'stop' ? 'stopWorkflow'
      : attempt.action === 'route' ? 'continueErrorOutput' : 'continueRegularOutput';
    const executionData: IExecuteData = {
      ...payload.executionData,
      node: { ...payload.executionData.node, onError },
    };
    const routed: RetryPayload = { ...payload, executionData };
    // `route` names the output; `continue` leaves n8n's input passthrough on output 0.
    const routeTo = attempt.action === 'route'
      ? { index: attempt.outputIndex, message: failureMessage(payload) }
      : undefined;
    await guarded(ctx, env, g, map, executionData,
      async () => await exhaust(env, routed, routeTo),
      { kind: 'run', executionData, attempt: payload.attempt, taskStartedData: payload.taskStartedData, ...carried(payload) });
  };
}

function retryWaitAction(g: NodeGadget): TransitionAction {
  const retry = retryOf(g);
  return async (ctx) => {
    const r = take(ctx, retry, isRetryPayload);
    const next: RunPayload = {
      kind: 'run', executionData: r.executionData, attempt: r.attempt, taskStartedData: r.taskStartedData,
      // A soft failure resumes inside n8n's inner loop; a thrown one re-enters the try body.
      softRetry: r.reason.kind === 'soft',
      // A tool's next attempt still answers the agent that dispatched it.
      ...carried(r),
    };
    ctx.output(g.running, next);
  };
}

/** Lines 272–331 per connected output: the v1 gate `nodeSuccessData[o].length !== 0`. */
function routeOutput(g: NodeGadget, out: NodeGadget['outputs'][number], value: OkPayload): Deposit[] {
  const items = value.nodeSuccessData[out.index];
  if (items !== undefined && items !== null && items.length !== 0) {
    const source: ISourceData = { previousNode: g.node, previousNodeOutput: out.index, previousNodeRun: value.runIndex };
    const payload: EdgePayload = { kind: 'edge', items, source };
    return out.edges.map((e) => ({ place: e.data, value: payload }));
  }
  if (out.nil !== null) return [{ place: out.nil, value: null }];
  return out.edges.map((e) => {
    // An acyclic producer's edges are all tree edges, each with its empty place (`compiler/gadget.ts`).
    if (e.empty === null) throw new Error(`internal: node '${g.node}' output ${out.index} has a cycle edge but no nil place`);
    return { place: e.empty, value: null };
  });
}

/** Per-output routing only (`routing.kind === 'split'`): `X_route_o` drains one `X/ok_o`. */
function routeAction(g: NodeGadget, info: RouteTransition): TransitionAction {
  if (g.routing.kind !== 'split') throw new Error(`internal: node '${g.node}' has a route transition but routes in X_run`);
  const out = g.routing.outputs.find((o) => o.index === info.port);
  if (out === undefined) throw new Error(`internal: node '${g.node}' has no output ${info.port} for '${info.name}'`);
  return async (ctx) => {
    for (const d of routeOutput(g, out, take(ctx, out.ok, isOkPayload))) ctx.output(d.place, d.value);
    ctx.output(out.routed, null);
  };
}

/**
 * The scheduler's binder. Structural roles (`skip`, `arm`, `clear`, `sink`, `done`) keep the
 * compiler's placeholders (`null`).
 *
 * Only `X_run`, `X_exhausted` and a terminal `onFailure` step await anything (the node run and
 * the hooks). Every other action here is `async` solely because libpetri's `TransitionAction`
 * is a promise-returning signature; they resolve in the same turn they start.
 */
export function schedulerActions(): ActionBinder {
  return (info, map) => {
    const g = map.node(info.node);
    switch (info.role) {
      case 'start': return startAction(g, map);
      case 'start-unmet': return startAction(g, map, info.reference);
      case 'run': return runAction(g, map, info);
      case 'attempt': return attemptStepAction(g, info, map);
      case 'deadline': return deadlineAction(g, info);
      case 'route': return routeAction(g, info);
      case 'retry': return retryWaitAction(g);
      case 'exhausted': return exhaustedAction(g, map);
      case 'done-request': return doneRequestAction(g, map);
      case 'dispatch': return dispatchAction(g, map);
      case 'resume': return resumeAction(g);
      case 'rounds-out': return roundsOutAction(g, map);
      case 'calls-out': return callsOutAction(g);
      // The structural roles keep the compiler's placeholders. `collect` produces nothing (a
      // genuine sink, CORE-043 AC4): pairing one response with one outstanding marker is the
      // whole of its effect, and the marking is where it lands.
      case 'done':
      case 'skip':
      case 'arm':
      case 'clear':
      case 'sink':
      case 'collect': return null;
      default: return assertNever(info, 'transition role');
    }
  };
}
