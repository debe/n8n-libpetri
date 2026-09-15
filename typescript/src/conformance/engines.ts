/**
 * The two legs of a differential run. One fixture runs once through n8n's own loop
 * ({@link StackReferenceScheduler}) and once through the {@link PetriScheduler}, each on a
 * fresh {@link TracingHost} built from the same fixture, so the two runs share one workflow
 * and one set of node behaviours and nothing else. What a leg produced — run data, resumable
 * state, contract values, trace — is collected into an {@link EngineRun} for the comparisons.
 */
import type { IRunData, IRunExecutionData, Workflow } from 'n8n-workflow';
import type { BudgetRestriction, WorkflowDescription } from '../compiler/index.js';
import type { SchedulerHooks, SchedulerHost, WorkflowScheduler } from '../n8n/host.js';
import { PetriScheduler, type SchedulerOutcome } from '../scheduler/index.js';
import type { FakeHostOptions } from './harness/fake-host.js';
import { fakeHooks } from './harness/hooks.js';
import { newRunExecutionData, type RunDataOptions } from './harness/run-data.js';
import type { NodeScript } from './harness/scripts.js';
import { fakeNodeHelpers, fakeWorkflow, type FakeWorkflowOptions } from './harness/workflow.js';
import { ReferenceHost, StackReferenceScheduler } from './stack-reference.js';
import {
  activationKey, activationsOf, dependencyEdges, type Activation, type DependencyEdge, type TraceEvent,
} from './trace.js';

// ==================== fixtures ====================

/** Everything the differ needs to run one workflow through both engines. */
export interface DifferFixture {
  readonly name: string;
  readonly workflow: WorkflowDescription;
  /** Node behaviours; a node without one passes its first input through. */
  readonly scripts?: Readonly<Record<string, NodeScript>>;
  /** Harness options (start items, node parameters, run-node filter, …). */
  readonly options?: FakeWorkflowOptions & RunDataOptions & FakeHostOptions;
  /** Budgets this fixture is meaningful at. Default `[1, 2, 4]`. */
  readonly budgets?: readonly number[];
}

/** A fixture the differ cannot run as written. */
export class DifferFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DifferFixtureError';
  }
}

/**
 * The node the run starts at: `startNodes[0]`, or the one-element alias `startNode`. A
 * fixture that names neither used to reach `workflow.nodes[undefined]` and fail inside the
 * engine with a `TypeError` about `name`; it is refused at the door instead.
 */
export function startNodeOf(fixture: DifferFixture): string {
  const name = fixture.workflow.startNodes?.[0] ?? fixture.workflow.startNode;
  if (name === undefined) {
    throw new DifferFixtureError(`differ: fixture '${fixture.name}' names no start node (startNodes or startNode)`);
  }
  return name;
}

/** The engine label used everywhere in the report. */
export type EngineName = 'n8n' | 'libpetri';

// ==================== the traced host ====================

/** The host both engines run on: the `FakeHost` mirror plus a `runNode` trace. */
class TracingHost extends ReferenceHost {
  readonly trace: TraceEvent[] = [];
  private seq = 0;
  private readonly t0 = performance.now();
  private readonly attempts = new Map<string, number>();

  override async runNode(
    ...args: Parameters<SchedulerHost['runNode']>
  ): ReturnType<SchedulerHost['runNode']> {
    const node = args[1].node.name;
    const runIndex = args[3];
    const key = activationKey(node, runIndex);
    const attempt = this.attempts.get(key) ?? 0;
    this.attempts.set(key, attempt + 1);
    this.mark('start', node, runIndex, attempt);
    try {
      return await super.runNode(...args);
    } finally {
      this.mark('finish', node, runIndex, attempt);
    }
  }

  private mark(kind: TraceEvent['kind'], node: string, runIndex: number, attempt: number): void {
    this.trace.push({ seq: this.seq++, kind, node, runIndex, attempt, at: performance.now() - this.t0 });
  }
}

// ==================== running both engines ====================

/**
 * The two values `WorkflowScheduler` promises `processRunExecutionData` after `run()`
 * resolves (patch 0001): `executionError` decides whether the execution is persisted as a
 * success or as a failure (`workflow-execute.ts:2250-2255`), and `closeFunction` deactivates
 * a trigger. Neither is part of `IRunExecutionData`, so nothing else in this harness sees
 * them — a scheduler that lost the halting error would have passed every gate.
 */
export interface SchedulerContract {
  readonly executionError: { readonly name?: string; readonly message?: string } | undefined;
  readonly closeFunction: boolean;
}

function contractOf(scheduler: WorkflowScheduler): SchedulerContract {
  const e = scheduler.executionError as { name?: string; message?: string } | undefined;
  return {
    executionError: e === undefined ? undefined : { name: e.name, message: e.message },
    closeFunction: scheduler.closeFunction !== undefined,
  };
}

/** What one engine leg produced. */
export interface EngineRun {
  readonly engine: EngineName;
  readonly scheduler: WorkflowScheduler;
  /** The contract values read off the scheduler after `run()` (part of the data gate). */
  readonly contract: SchedulerContract;
  /** `PetriScheduler.outcome` — how the net's run ended; `null` for the n8n leg. */
  readonly outcome: SchedulerOutcome | null;
  readonly host: TracingHost;
  readonly runExecutionData: IRunExecutionData;
  readonly runData: IRunData;
  readonly trace: readonly TraceEvent[];
  readonly activations: Map<string, Activation>;
  /** `dependencyEdges(runData)`, read once: every comparison walks it. */
  readonly edges: readonly DependencyEdge[];
  /** Wall-clock milliseconds of `run()`. */
  readonly elapsedMs: number;
  /** The rejection of `run()`, if it rejected (n8n's loop rejects the same way). */
  readonly error: unknown;
  /** `k` the net actually ran at; `1` for the n8n leg, which has no budget. */
  readonly effectiveBudget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  readonly diagnostics: readonly string[];
}

/**
 * The payload objects a fixture supplies, copied for one leg. A token holds the very array
 * n8n produced and `addPairedItemLineage` copies items only shallowly (README "Concurrency":
 * *a node's input items are read-only*), so a fixture whose script writes into its input
 * would otherwise mutate objects the **other** leg had already recorded — the legs run one
 * after the other and the comparison happens after both. That erased the difference it was
 * built to find: the two engines produced `i: 100` and `i: 200` and `compareData` reported
 * `equal`, because both `runData`s pointed at the same item object. Cloning the fixture's
 * start items and pin data per leg is what keeps the two runs disjoint (and keeps the
 * fixture module's own `START` array unmutated for every later fixture in the process).
 */
function perLegPayloads<T extends RunDataOptions>(options: T): T {
  return {
    ...options,
    ...(options.startItems === undefined ? {} : { startItems: structuredClone(options.startItems) }),
    ...(options.pinData === undefined ? {} : { pinData: structuredClone(options.pinData) }),
  };
}

function buildHost(fixture: DifferFixture): { host: TracingHost; workflow: Workflow; data: IRunExecutionData } {
  const options = perLegPayloads(fixture.options ?? {});
  const workflow = fakeWorkflow(fixture.workflow, options);
  const startName = startNodeOf(fixture);
  const startNode = workflow.nodes[startName];
  if (startNode === undefined) {
    throw new DifferFixtureError(`differ: fixture '${fixture.name}' starts at '${startName}', which is not one of its nodes`);
  }
  const data = newRunExecutionData(startNode, options);
  const host = new TracingHost(workflow, data, fixture.scripts ?? {}, options);
  return { host, workflow, data };
}

async function runLeg(
  engine: EngineName,
  fixture: DifferFixture,
  scheduler: WorkflowScheduler,
  hooksOf: (host: TracingHost) => SchedulerHooks,
  prepare: (host: TracingHost) => void,
): Promise<Omit<EngineRun, 'effectiveBudget' | 'budgetRestriction' | 'diagnostics' | 'outcome'>> {
  const { host, workflow, data } = buildHost(fixture);
  prepare(host);
  const hooks = hooksOf(host);
  let error: unknown;
  const t0 = performance.now();
  await scheduler.run(host, workflow, data, hooks).catch((e: unknown) => { error = e; });
  const elapsedMs = performance.now() - t0;
  const runData = data.resultData.runData;
  return {
    engine, scheduler, contract: contractOf(scheduler), host, runExecutionData: data, runData,
    trace: host.trace, activations: activationsOf(host.trace), edges: dependencyEdges(runData), elapsedMs, error,
  };
}

/** Run `fixture` through n8n's own loop. */
export async function runReference(fixture: DifferFixture): Promise<EngineRun> {
  const scheduler = new StackReferenceScheduler();
  const leg = await runLeg('n8n', fixture, scheduler, (h) => fakeHooks(h.calls), (h) => { h.enableEnqueue(); });
  return { ...leg, effectiveBudget: 1, budgetRestriction: null, diagnostics: [], outcome: null };
}

/**
 * Run `fixture` through the `PetriScheduler` at budget `k`.
 *
 * Nothing bounds this leg but the fixture itself: the reference leg stops at its
 * 10 000-activation valve, so a net that never quiesces hangs here instead. A valve belongs
 * in this function, and libpetri's `run(ms, 'close')` is the tool for it — a harness safety
 * valve is not n8n's timeout, so the rule that keeps one out of the scheduler does not
 * apply here.
 */
export async function runPetri(fixture: DifferFixture, budget: number): Promise<EngineRun> {
  const scheduler = new PetriScheduler({
    nodeHelpers: fakeNodeHelpers,
    legacy: () => { throw new Error('differ: v1 only, the legacy scheduler must not be reached'); },
    budget,
  });
  // `enableEnqueue` is deliberately NOT called: `addNodeToBeExecuted` stays fatal, so a
  // scheduler that reached for n8n's dispatch queue would fail the run, not pass quietly.
  const leg = await runLeg('libpetri', fixture, scheduler, (h) => fakeHooks(h.calls), () => {});
  return {
    ...leg,
    effectiveBudget: scheduler.compiled?.effectiveBudget ?? budget,
    budgetRestriction: scheduler.compiled?.budgetRestriction ?? null,
    diagnostics: [...scheduler.diagnostics],
    outcome: scheduler.outcome ?? null,
  };
}
