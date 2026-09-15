/**
 * The per-execution state the actions read — the host, the workflow, the hooks and the fields
 * `StackScheduler` keeps on itself. The compiled workflow and its actions are shared by every
 * execution of the workflow version, so this reaches them through the executor's execution
 * context under {@link ENV_KEY} (`executionContextProvider`), never through a closure.
 */
import type { TransitionContext } from 'libpetri';
import type { ExecutionBaseError, INode, IRunExecutionData, ITaskStartedData, Workflow } from 'n8n-workflow';
import type { NodeGadget } from '../compiler/index.js';
import type { SchedulerHooks, SchedulerHost } from '../n8n/host.js';

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

export function envOf(ctx: TransitionContext): ExecutionEnv {
  const env = ctx.executionContext<ExecutionEnv>(ENV_KEY);
  if (env === undefined) throw new Error(`n8n-libpetri: no '${ENV_KEY}' execution context installed on the executor`);
  return env;
}

export function liveNode(env: ExecutionEnv, g: NodeGadget): INode {
  const node = env.workflow.nodes[g.node];
  if (node === undefined) throw new Error(`n8n-libpetri: workflow has no node '${g.node}'`);
  return node;
}
