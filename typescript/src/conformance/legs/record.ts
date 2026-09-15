/**
 * What a leg of a differential run produced, as the comparisons read it: the engine label,
 * the contract values read off the scheduler, and the whole record, {@link EngineRun}.
 * `leg.ts` collects one; the gates and the attribution consume them through `engines.ts`.
 */
import type { IRunData, IRunExecutionData } from 'n8n-workflow';
import type { BudgetRestriction } from '../../compiler/index.js';
import type { WorkflowScheduler } from '../../n8n/host.js';
import type { SchedulerOutcome } from '../../scheduler/index.js';
import type { Activation, DependencyEdge, TraceEvent } from '../trace.js';
import type { TracingHost } from './tracing-host.js';

/** The engine label used everywhere in the report. */
export type EngineName = 'n8n' | 'libpetri';

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

/** What `runLeg` collects; the engine-specific rest is its caller's. */
export type LegRun = Omit<EngineRun, 'effectiveBudget' | 'budgetRestriction' | 'diagnostics' | 'outcome'>;
