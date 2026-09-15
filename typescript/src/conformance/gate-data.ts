/**
 * The data gate, the differ's first comparison: everything the two engines are supposed to
 * produce identically — `resultData.runData`, the resumable state and the
 * `WorkflowScheduler` contract values — compared first difference first, and every
 * difference attributed by the register's data rules ({@link attributeDataDifference}). A
 * data difference is never excused as a divergence of what a run produced: the rows that
 * touch this gate excuse a *run count*, never a result.
 *
 * The parts live under `gates/`: `run-data.ts` (with {@link comparableTask}, the fields of a
 * run that are compared), `resumable-state.ts`, and `data-facts.ts`, what the data rules read
 * besides the difference itself.
 */
import { attributeDataDifference, type DataAttribution } from './attribution.js';
import { firstDifference, type DataDifference } from './diff-value.js';
import type { EngineRun } from './engines.js';
import { dataFactsOf } from './gates/data-facts.js';
import { differenceAt, type NodeDifference } from './gates/node-difference.js';
import { compareResumableState } from './gates/resumable-state.js';
import { compareRunData } from './gates/run-data.js';

export { comparableTask } from './gates/run-data.js';

export interface AttributedDifference extends DataDifference {
  readonly attribution: DataAttribution;
}

export interface DataComparison {
  readonly equal: boolean;
  readonly differences: readonly AttributedDifference[];
  /** Differences no registered row covers: the gate fails on these and only these. */
  readonly unattributed: number;
  /**
   * Nodes whose runs are a permutation of each other rather than equal position by
   * position: divergence #11's signature (n8n `unshift`s onto a stack it `shift`s from, so
   * the most recent arrival runs first; the net's `hasdata` place is FIFO).
   */
  readonly permutedNodes: readonly string[];
  /** Nodes the engine reported a stranded token for, and everything downstream of them. */
  readonly strandedNodes: readonly string[];
  /**
   * Nodes n8n left sitting in `waitingExecution`, and everything downstream of them: a join
   * n8n never completed. Divergence #1 — the net propagates an explicit empty token, so its
   * AND-join completes and the node runs where n8n's did not.
   */
  readonly starvedNodes: readonly string[];
}

/** What the attribution rules need beyond the two runs themselves. */
export interface DataContext {
  /** The static main-connection closure, for the divergence #2 rule. */
  readonly descendants?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The third part: the `WorkflowScheduler` contract values, about no node. */
function contractDifferences(reference: EngineRun, candidate: EngineRun): NodeDifference[] {
  return [
    ...differenceAt(firstDifference(
      reference.contract.executionError, candidate.contract.executionError, 'scheduler.executionError'), ''),
    ...differenceAt(firstDifference(
      reference.contract.closeFunction, candidate.contract.closeFunction, 'scheduler.closeFunction'), ''),
  ];
}

/**
 * Compare everything the two engines are supposed to produce identically, first difference
 * first, and attribute each one. Three parts, all of them the gate:
 *
 * 1. `resultData.runData` — every `ITaskData` field but the clocks and `executionIndex`;
 * 2. the **resumable state** (`executionData`, `waitTill`) — `compareResumableState`;
 * 3. the `WorkflowScheduler` **contract values** (`executionError`, `closeFunction`), which
 *    decide whether n8n persists the execution as a success or as a failure.
 *
 * Each difference is attributed by {@link attributeDataDifference}; one no registered row
 * covers is `unattributed` and fails the gate.
 */
export function compareData(
  reference: EngineRun,
  candidate: EngineRun,
  context: DataContext | Map<string, ReadonlySet<string>> = {},
): DataComparison {
  const ctx: DataContext = context instanceof Map ? { descendants: context } : context;
  const descendants = ctx.descendants ?? new Map<string, ReadonlySet<string>>();
  const runData = compareRunData(reference.runData, candidate.runData);
  const facts = dataFactsOf(reference, candidate, runData, descendants);
  // `resultData.lastNodeExecuted` is not compared here: it records *which node ran last*,
  // a fact about the total order and nothing about any node's result, so it belongs to the
  // ordering report (row #5) — `compareOrdering` checks it there.
  const raw = [
    ...runData.differences,
    ...compareResumableState(reference, candidate),
    ...contractDifferences(reference, candidate),
  ];
  const differences: AttributedDifference[] = raw.map(({ d, node }) => ({ ...d, attribution: attributeDataDifference(d, node, facts) }));
  return {
    equal: differences.length === 0,
    differences,
    unattributed: differences.filter((d) => d.attribution.kind === 'unattributed').length,
    permutedNodes: runData.permuted,
    strandedNodes: [...facts.strandedClosure].sort(),
    starvedNodes: [...facts.starvedClosure].sort(),
  };
}
