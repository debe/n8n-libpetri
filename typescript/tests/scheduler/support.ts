/**
 * Harness for the scheduler suite. The fake `Workflow`, the `FakeHost` mirror of
 * `WorkflowExecute` at n8n `441970b`, the node scripts and the fake hooks moved to
 * `src/conformance/harness.ts` in milestone M3, where the differ (`src/conformance/differ.ts`)
 * needs them too; they are re-exported here unchanged, so this module's surface is what it
 * always was. What stays is the scheduler-specific part: `execute()`, which wires a fresh
 * `PetriScheduler` to a `FakeHost`, and the call-trace readers the ordering tests use.
 */
import { InMemoryEventStore } from 'libpetri';
import type { IRunData, IRunExecutionData, Workflow } from 'n8n-workflow';
import type { WorkflowDescription } from '../../src/compiler/index.js';
import {
  FakeHost, fakeHooks, fakeNodeHelpers, fakeWorkflow, newRunExecutionData,
  type FakeHostOptions, type FakeWorkflowOptions, type HookFailures, type NodeScript,
  type RunDataOptions,
} from '../../src/conformance/harness.js';
import type { SchedulerHooks, WorkflowScheduler } from '../../src/n8n/host.js';
import { PetriScheduler, type PetriSchedulerOptions } from '../../src/scheduler/index.js';

export * from '../../src/conformance/harness.js';

// ==================== running ====================

export interface ExecuteOptions extends RunDataOptions, FakeWorkflowOptions, FakeHostOptions {
  readonly budget?: number;
  readonly scheduler?: Partial<PetriSchedulerOptions>;
  readonly legacy?: () => WorkflowScheduler;
  /** Called after `run()` started (before it resolves), e.g. to cancel. */
  readonly during?: (host: FakeHost) => void | Promise<void>;
  /** Lifecycle hooks that reject (n8n's loop has no `try` around them: `run()` rejects). */
  readonly hookFailures?: HookFailures;
  /**
   * Builds the host the run is driven with, in place of a plain {@link FakeHost} — a
   * subclass that overrides one mirrored method. The payload suite uses it to run the same
   * workflow against an `addPairedItemLineage` that stamps in place instead of copying
   * (ADR 0006).
   */
  readonly host?: (
    workflow: Workflow,
    runExecutionData: IRunExecutionData,
    scripts: Readonly<Record<string, NodeScript>>,
    options: FakeHostOptions,
  ) => FakeHost;
}

export interface Execution {
  readonly scheduler: PetriScheduler;
  readonly host: FakeHost;
  readonly hooks: SchedulerHooks;
  readonly workflow: Workflow;
  readonly runExecutionData: IRunExecutionData;
  readonly calls: string[];
  readonly store: InMemoryEventStore;
  readonly runData: IRunData;
  /** The `run()` rejection, if any. */
  readonly error: unknown;
}

/** Runs `desc` on a fresh `PetriScheduler` with the given node scripts. */
export async function execute(
  desc: WorkflowDescription,
  scripts: Readonly<Record<string, NodeScript>> = {},
  options: ExecuteOptions = {},
): Promise<Execution> {
  const workflow = fakeWorkflow(desc, options);
  const startName = desc.startNodes?.[0] ?? desc.startNode!;
  const runExecutionData = newRunExecutionData(workflow.nodes[startName]!, options);
  const host = options.host === undefined
    ? new FakeHost(workflow, runExecutionData, scripts, options)
    : options.host(workflow, runExecutionData, scripts, options);
  const hooks = fakeHooks(host.calls, options.hookFailures ?? {});
  const store = new InMemoryEventStore();
  const scheduler = new PetriScheduler({
    nodeHelpers: fakeNodeHelpers,
    legacy: options.legacy ?? (() => { throw new Error('legacy scheduler requested'); }),
    budget: options.budget ?? 1,
    eventStore: store,
    ...options.scheduler,
  });
  let error: unknown;
  const running = scheduler.run(host, workflow, runExecutionData, hooks).catch((e: unknown) => { error = e; });
  if (options.during !== undefined) await options.during(host);
  await running;
  return { scheduler, host, hooks, workflow, runExecutionData, calls: host.calls, store, runData: runExecutionData.resultData.runData, error };
}

/**
 * A recorded stack with the runtime's own frames dropped.
 *
 * `FakeHost.reportNodeExecutionError` keeps `e.stack` (`harness.ts:392`), and V8 splices its
 * internal frames — `at runNextTicks (node:internal/process/task_queues)`, `at processTimers
 * (node:internal/timers)` — into a stack only when the throw happened to unwind through them.
 * Whether a node that throws after an `await sleep()` was resumed from the timer queue or from
 * an already-draining microtask checkpoint is a fact about that tick, not about the run, so the
 * frames appear or not between two runs of the same script. Only `node:` frames are dropped:
 * the project frames are what makes the comparison worth anything.
 */
function stackAsData(stack: string): string {
  return stack.split('\n').filter((line) => !/^\s*at .*\bnode:/.test(line)).join('\n');
}

/**
 * `runData` with the fields that are clocks or scheduling order removed, so two runs at
 * different budgets can be compared for **data** equivalence: `startTime` and
 * `executionTime` are clocks, `executionIndex` is the order
 * (`additionalData.currentNodeExecutionIndex++`), which is exactly what concurrency
 * reorders (divergences #5 / #12), and an error's runtime frames are neither (`stackAsData`).
 * Node keys are sorted, so the record order does not count.
 */
export function dataOf(runData: IRunData): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const node of Object.keys(runData).sort()) {
    out[node] = runData[node]!.map((task) => {
      const { startTime: _s, executionTime: _e, executionIndex: _i, ...rest } =
        task as typeof task & { executionIndex?: number };
      const error = rest.error as { stack?: unknown } | undefined;
      if (error === undefined || typeof error.stack !== 'string') return rest;
      return { ...rest, error: { ...error, stack: stackAsData(error.stack) } };
    });
  }
  return out;
}

/** The recorded calls for one node, in order (host calls named with the node plus the hooks). */
export function callsOf(calls: readonly string[], node: string): string[] {
  return calls.filter((c) => c.endsWith(`(${node})`));
}

/** Node names in the order their `runNode` was called. */
export function ranNodes(calls: readonly string[]): string[] {
  return calls.filter((c) => c.startsWith('runNode(')).map((c) => c.slice('runNode('.length, -1));
}

/**
 * The per-node host-call sequence of a successful run, read off `stack-scheduler.ts`
 * (n8n `441970b`, patch 0001) with the stack machinery left out (`isExecutionStackNotEmpty`,
 * `popExecutionStack`, `addNodeToBeExecuted` are the loop's own bookkeeping the net
 * replaces). Line numbers refer to that file.
 */
export function expectedSuccessSequence(node: string): string[] {
  return [
    'shouldStopExecuting',                     // 49
    `resetDynamicCredentialsUsage(${node})`,   // 60
    `createTaskStartedData(${node})`,          // 62
    `addPairedItemLineage(${node})`,           // 65
    `computeRunIndex(${node})`,                // 67
    `isNodeFilteredOut(${node})`,              // 74
    `ensureInputData(${node})`,                // 78
    `hook:nodeExecuteBefore(${node})`,         // 96
    `getRetryParams(${node})`,                 // 101
    `getPinnedOutput(${node})`,                // 120
    `collectSubNodeResults(${node})`,          // 125
    `runNode(${node})`,                        // 132
    `processNodeOutput(${node})`,              // 176
    `assignPairedItems(${node})`,              // 193
    `ensureAlwaysOutputData(${node})`,         // 199
    `createTaskData(${node})`,                 // 221
    'recordDynamicCredentialsUser',            // 222
    'normalizeNodeErrors',                     // 240
    `rewireOutputLog(${node})`,                // 248
    `upsertTaskData(${node})`,                 // 250
    `hook:nodeExecuteAfter(${node})`,          // 368 (after the enqueue, which lands next cycle)
  ];
}

/** Every recorded call except the stack machinery the net replaces. */
export function withoutStackMachinery(calls: readonly string[]): string[] {
  return calls.filter((c) => !c.startsWith('isExecutionStackNotEmpty') && !c.startsWith('popExecutionStack'));
}

export function transitionsStarted(store: InMemoryEventStore, filter?: (name: string) => boolean): string[] {
  const names: string[] = [];
  for (const e of store.events()) {
    if (e.type === 'transition-started' && (filter === undefined || filter(e.transitionName))) names.push(e.transitionName);
  }
  return names;
}

/**
 * Tokens the run left on `place`: `token-added` minus `token-removed`. The halted-run
 * assertions use it on `_halt`, which nothing consumes (`compiler/compile.ts`), in place of
 * the `_halt_reap` firing they used to count.
 */
export function tokensResting(store: InMemoryEventStore, place: string): number {
  let n = 0;
  for (const e of store.events()) {
    if (e.type === 'token-added' && e.placeName === place) n += 1;
    if (e.type === 'token-removed' && e.placeName === place) n -= 1;
  }
  return n;
}

export function transitionsFailed(store: InMemoryEventStore): string[] {
  return store.events().filter((e) => e.type === 'transition-failed').map((e) => `${(e as { transitionName: string }).transitionName}: ${(e as { errorMessage: string }).errorMessage}`);
}
