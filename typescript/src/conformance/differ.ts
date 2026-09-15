/**
 * The differential harness: one workflow, one set of node behaviours, both engines, in one
 * process. The reference engine is `StackReferenceScheduler` (n8n's own loop at the pinned
 * commit); the candidate is the `PetriScheduler`. Both drive the same `FakeHost` mirror of
 * `WorkflowExecute`, so every difference in the result is a difference between the two
 * schedulers and nothing else.
 *
 * Three comparisons, in this order (README "Principles", `docs/divergences.md` #5):
 *
 * 1. **Data equivalence — the gate** (`gate-data.ts`). Three things: (a)
 *    `resultData.runData` — for every node and run index, `data` (including `pairedItem`),
 *    `source` (`previousNode` / `previousNodeOutput` / `previousNodeRun`), `executionStatus`,
 *    `metadata` and the error shape; (b) the **resumable state** — `executionData`
 *    (`nodeExecutionStack`, `waitingExecution`, `waitingExecutionSource`, `contextData`) and
 *    `waitTill`, which is what n8n persists and replays and what the marking codec exists to
 *    produce; (c) the `WorkflowScheduler` **contract values** `executionError` and
 *    `closeFunction`, which are not part of `IRunExecutionData` at all —
 *    `processRunExecutionData` reads them off the scheduler after `run()` and persists the
 *    execution as a success or a failure by the first (`workflow-execute.ts:2250-2255`).
 *    `resultData.error` is deliberately *not* compared: nothing in either leg writes it
 *    (`processSuccessExecution` does, and that is outside both engines), so comparing it
 *    compared `undefined` with `undefined`. The first difference is reported with a path. A
 *    data difference is never excused as a divergence — the registered rows that touch this
 *    section excuse a *run count*, never what a run produced.
 * 2. **Happens-before** (`gate-order.ts`). Each engine's trace gives a partial order over
 *    activations (`start` / `finish` of every `runNode`). Every data dependency the run
 *    actually realised — read off each `ITaskData.source` — must be respected in the engine
 *    that produced it (`finish(producer) < start(consumer)`), and every dependency n8n
 *    ordered must be ordered the same way under the net: the net's partial order is a
 *    *weakening* of n8n's total order, never a reordering of it. An inversion is a failure,
 *    and so is an edge whose activation left no `runNode` observation at all.
 * 3. **Ordering report — not a gate** (`gate-order.ts`). The `executionIndex` sequences side
 *    by side. Every activation whose rank differs is attributed to a `docs/divergences.md`
 *    row, or to the concurrency the budget bought, or flagged `unattributed` — which is a
 *    finding.
 *
 * The gate is (1) and (2) plus "no unattributed ordering difference". A run is `pass` when
 * nothing differs, `divergent` when every difference is attributed to a registered
 * `docs/divergences.md` row (`attribution.ts`), and `fail` otherwise — an unattributed
 * difference is a finding, never a pass.
 *
 * This module is the orchestrator ({@link diffFixture}) and the one import path for the
 * differ's whole surface: the legs (`engines.ts`), the trace vocabulary (`trace.ts`), the
 * value comparison (`diff-value.ts`), both gates, the register and the report
 * (`differ-report.ts`) are re-exported from here.
 */
import type { BudgetRestriction } from '../compiler/index.js';
import { fixtureStatics, type FixtureStatics } from './attribution.js';
import { runPetri, runReference, type DifferFixture } from './engines.js';
import { compareData, type DataComparison } from './gate-data.js';
import { checkHappensBefore, compareOrdering, type HappensBefore, type OrderingReport } from './gate-order.js';

export {
  DifferFixtureError, runPetri, runReference, startNodeOf,
  type DifferFixture, type EngineName, type EngineRun, type SchedulerContract,
} from './engines.js';
export {
  activationKey, activationNodeOf, activationsOf, dependencyEdges,
  type Activation, type DependencyEdge, type TraceEvent,
} from './trace.js';
export { firstDifference, type DataDifference } from './diff-value.js';
export {
  comparableTask, compareData, type AttributedDifference, type DataComparison, type DataContext,
} from './gate-data.js';
export {
  checkHappensBefore, compareOrdering, executionOrder, reachableOf,
  type HappensBefore, type HappensBeforeViolation, type LastNodeExecuted, type OrderDifference, type OrderingReport,
} from './gate-order.js';
export {
  attribute, descendantsOf, fixtureStatics, isStoppedOutcome, orInputNodesOf, strandedNodesOf,
  type Attribution, type AttributionContext, type DataAttribution, type FixtureStatics,
} from './attribution.js';
export { novelMechanismsOf, renderDiffReport } from './differ-report.js';

export interface DiffResult {
  readonly fixture: string;
  readonly requestedBudget: number;
  readonly effectiveBudget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  readonly data: DataComparison;
  readonly happensBefore: HappensBefore;
  readonly ordering: OrderingReport;
  /**
   * `pass` — nothing differs. `divergent` — every difference is attributed to a registered
   * `docs/divergences.md` row. `fail` — something is unattributed, or happens-before broke.
   */
  readonly verdict: 'pass' | 'divergent' | 'fail';
  readonly elapsed: { readonly n8n: number; readonly libpetri: number };
  readonly errors: { readonly n8n: string | null; readonly libpetri: string | null };
  readonly diagnostics: readonly string[];
}

const describeError = (e: unknown): string | null =>
  e === undefined ? null : e instanceof Error ? `${e.name}: ${e.message}` : String(e);

/** Run one fixture through both engines at `budget` and compare. */
export async function diffFixture(
  fixture: DifferFixture,
  budget = 1,
  statics: FixtureStatics = fixtureStatics(fixture.workflow),
): Promise<DiffResult> {
  const reference = await runReference(fixture);
  const candidate = await runPetri(fixture, budget);
  const data = compareData(reference, candidate, { descendants: statics.descendants });
  const happensBefore = checkHappensBefore(reference, candidate);
  const ordering = compareOrdering(reference, candidate, data, statics.orInputNodes);
  const errors = { n8n: describeError(reference.error), libpetri: describeError(candidate.error) };
  const clean = happensBefore.respected && ordering.unattributed === 0 && errors.n8n === errors.libpetri;
  const verdict = !clean || data.unattributed > 0
    ? 'fail'
    : data.equal && ordering.equal ? 'pass' : 'divergent';
  return {
    fixture: fixture.name,
    requestedBudget: budget,
    effectiveBudget: candidate.effectiveBudget,
    budgetRestriction: candidate.budgetRestriction,
    data, happensBefore, ordering, verdict,
    elapsed: { n8n: reference.elapsedMs, libpetri: candidate.elapsedMs },
    errors,
    diagnostics: candidate.diagnostics,
  };
}
