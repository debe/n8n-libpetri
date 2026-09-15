/**
 * The data gate, the differ's first comparison: everything the two engines are supposed to
 * produce identically — `resultData.runData`, the resumable state and the
 * `WorkflowScheduler` contract values — compared first difference first, and every
 * difference attributed by the register's data rules ({@link attributeDataDifference}). A
 * data difference is never excused as a divergence of what a run produced: the rows that
 * touch this gate excuse a *run count*, never a result.
 */
import type { ITaskData } from 'n8n-workflow';
import {
  attributeDataDifference, strandedNodesOf, type DataAttribution, type DataAttributionFacts,
} from './attribution.js';
import { firstDifference, isPermutation, MISSING, type DataDifference } from './diff-value.js';
import type { EngineRun } from './engines.js';

/** An error as it is compared: the stack and the class identity are host-side noise. */
function errorShape(task: ITaskData): unknown {
  const error = task.error as { name?: string; message?: string } | undefined;
  return error === undefined ? undefined : { name: error.name, message: error.message };
}

/**
 * The fields of an `ITaskData` the data gate compares. Left out, and listed here rather than
 * left implicit: `startTime` / `executionTime` (clocks), `executionIndex` (the order, which
 * is the ordering report's business), `hints`, `inputOverride`, `redactedError`, and
 * `usedDynamicCredentials` / `attemptedDynamicCredentials` — divergence #18's observable,
 * which no scheduler can scope above k = 1 and which this host does not mirror anyway.
 */
export function comparableTask(task: ITaskData): Record<string, unknown> {
  return {
    data: task.data,
    source: task.source,
    executionStatus: task.executionStatus,
    metadata: task.metadata,
    error: errorShape(task),
  };
}

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

/** One raw difference plus the node it is about (`''` when it is about neither). */
interface NodeDifference {
  readonly d: DataDifference;
  readonly node: string;
}

/** The `IExecuteData` fields a stack entry is compared by: the node, its input, its source. */
function entryShape(entry: { node: { name: string }; data?: unknown; source?: unknown }): unknown {
  return { node: entry.node.name, data: (entry as { data?: { main?: unknown } }).data?.main, source: entry.source };
}

/**
 * The **resumable state**: `IRunExecutionData.executionData` plus `waitTill`. This is what
 * n8n persists with a paused, waiting or failed execution and what "Retry execution" and a
 * Wait-node resume replay, and producing it is the marking codec's whole job (README
 * "Initial marking and the marking codec"). It is data, not order, so it belongs in the gate:
 * two engines that agree on every `ITaskData` and leave different `nodeExecutionStack` /
 * `waitingExecution` behind have not produced the same execution.
 *
 * Skipped when either side has no `executionData` (a hand-built {@link EngineRun}).
 */
function compareResumableState(reference: EngineRun, candidate: EngineRun): NodeDifference[] {
  const left = reference.runExecutionData.executionData;
  const right = candidate.runExecutionData.executionData;
  if (left === undefined || right === undefined) return [];
  const out: NodeDifference[] = [];
  const push = (d: DataDifference | null, node: string): void => { if (d !== null) out.push({ d, node }); };

  const names = (e: typeof left): string[] => e.nodeExecutionStack.map((x) => x.node.name);
  const stackNames = firstDifference(names(left), names(right), 'executionData.nodeExecutionStack');
  if (stackNames !== null) {
    const at = /\[(\d+)\]$/.exec(stackNames.path);
    const index = at === null ? -1 : Number(at[1]);
    push(stackNames, index < 0 ? '' : (left.nodeExecutionStack[index] ?? right.nodeExecutionStack[index])?.node.name ?? '');
  } else {
    left.nodeExecutionStack.forEach((entry, i) => {
      push(firstDifference(entryShape(entry), entryShape(right.nodeExecutionStack[i]!), `executionData.nodeExecutionStack[${i}]`), entry.node.name);
    });
  }
  for (const field of ['waitingExecution', 'waitingExecutionSource'] as const) {
    const a = (left[field] ?? {}) as Record<string, unknown>;
    const b = (right[field] ?? {}) as Record<string, unknown>;
    for (const node of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      push(firstDifference(
        Object.hasOwn(a, node) ? a[node] : MISSING,
        Object.hasOwn(b, node) ? b[node] : MISSING,
        `executionData.${field}.${node}`,
      ), node);
    }
  }
  push(firstDifference(left.contextData, right.contextData, 'executionData.contextData'), '');
  push(firstDifference(reference.runExecutionData.waitTill, candidate.runExecutionData.waitTill, 'waitTill'), '');
  return out;
}

/**
 * Compare everything the two engines are supposed to produce identically, first difference
 * first, and attribute each one. Three parts, all of them the gate:
 *
 * 1. `resultData.runData` — every `ITaskData` field but the clocks and `executionIndex`;
 * 2. the **resumable state** (`executionData`, `waitTill`) — {@link compareResumableState};
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
  const raw: NodeDifference[] = [];
  const permuted: string[] = [];
  const stranded = strandedNodesOf(candidate.diagnostics);
  const strandedClosure = new Set<string>(stranded);
  for (const node of stranded) for (const d of descendants.get(node) ?? []) strandedClosure.add(d);
  // The other direction: a join n8n left in `waitingExecution` and never ran (divergence #1).
  const starved = Object.keys(reference.runExecutionData.executionData?.waitingExecution ?? {});
  const starvedClosure = new Set<string>(starved);
  for (const node of starved) for (const d of descendants.get(node) ?? []) starvedClosure.add(d);
  /** Nodes whose run count differs, and in which direction. */
  const countOnly = new Set<string>();

  const nodes = [...new Set([...Object.keys(reference.runData), ...Object.keys(candidate.runData)])].sort();
  for (const node of nodes) {
    const left = reference.runData[node];
    const right = candidate.runData[node];
    if (left === undefined || right === undefined) {
      countOnly.add(node);
      raw.push({
        node,
        d: {
          path: `runData.${node}`,
          n8n: left === undefined ? '<never ran>' : `${left.length} run(s)`,
          libpetri: right === undefined ? '<never ran>' : `${right.length} run(s)`,
        },
      });
      continue;
    }
    if (left.length !== right.length) {
      countOnly.add(node);
      raw.push({ node, d: { path: `runData.${node}.length`, n8n: String(left.length), libpetri: String(right.length) } });
      continue;
    }
    const before = raw.length;
    for (let i = 0; i < left.length; i++) {
      const d = firstDifference(comparableTask(left[i]!), comparableTask(right[i]!), `runData.${node}[${i}]`);
      if (d !== null) raw.push({ node, d });
    }
    if (raw.length > before && left.length > 1 && isPermutation(left.map(comparableTask), right.map(comparableTask))) {
      permuted.push(node);
    }
  }
  // `resultData.lastNodeExecuted` is not compared here: it records *which node ran last*,
  // a fact about the total order and nothing about any node's result, so it belongs to the
  // ordering report (row #5) — `compareOrdering` checks it there.
  raw.push(...compareResumableState(reference, candidate));
  const contractError = firstDifference(
    reference.contract.executionError, candidate.contract.executionError, 'scheduler.executionError');
  if (contractError !== null) raw.push({ node: '', d: contractError });
  const contractClose = firstDifference(
    reference.contract.closeFunction, candidate.contract.closeFunction, 'scheduler.closeFunction');
  if (contractClose !== null) raw.push({ node: '', d: contractClose });

  const facts: DataAttributionFacts = {
    permutedNodes: permuted,
    strandedNodes: stranded,
    strandedClosure,
    starvedNodes: starved,
    starvedClosure,
    countDiffers: countOnly,
    runData: { n8n: reference.runData, libpetri: candidate.runData },
    candidateOutcome: candidate.outcome,
    destinationNode: reference.runExecutionData.startData?.destinationNode?.nodeName,
  };
  const differences: AttributedDifference[] = raw.map(({ d, node }) => ({ ...d, attribution: attributeDataDifference(d, node, facts) }));
  return {
    equal: differences.length === 0,
    differences,
    unattributed: differences.filter((d) => d.attribution.kind === 'unattributed').length,
    permutedNodes: permuted,
    strandedNodes: [...strandedClosure].sort(),
    starvedNodes: [...starvedClosure].sort(),
  };
}
