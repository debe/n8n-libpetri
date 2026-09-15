/**
 * The first part of the data gate: `resultData.runData`, node by node — a run-count
 * difference, or each run's first differing field — and which nodes' runs came out
 * permuted rather than different (divergence #11's signature).
 */
import type { IRunData, ITaskData } from 'n8n-workflow';
import { firstDifference, isPermutation, type DataDifference } from '../diff-value.js';
import type { NodeDifference } from './node-difference.js';

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

/** What the `runData` comparison found. */
export interface RunDataComparison {
  readonly differences: NodeDifference[];
  /** Nodes whose run count differs, a node only one engine ran included. */
  readonly countDiffers: Set<string>;
  /** Nodes whose runs differ position by position but are a permutation of each other. */
  readonly permuted: string[];
}

const runsLabel = (runs: readonly ITaskData[] | undefined): string =>
  runs === undefined ? '<never ran>' : `${runs.length} run(s)`;

/** A node only one engine ran, or the two ran a different number of times. */
function countDifference(node: string, left: readonly ITaskData[] | undefined, right: readonly ITaskData[] | undefined): DataDifference {
  if (left !== undefined && right !== undefined) {
    return { path: `runData.${node}.length`, n8n: String(left.length), libpetri: String(right.length) };
  }
  return { path: `runData.${node}`, n8n: runsLabel(left), libpetri: runsLabel(right) };
}

/** The first differing field of each run of `node`, position by position. */
function runDifferences(node: string, left: readonly ITaskData[], right: readonly ITaskData[]): DataDifference[] {
  const out: DataDifference[] = [];
  left.forEach((task, i) => {
    const d = firstDifference(comparableTask(task), comparableTask(right[i]!), `runData.${node}[${i}]`);
    if (d !== null) out.push(d);
  });
  return out;
}

/** Compare one node's runs and record what differs into `into`. */
function compareNode(node: string, left: ITaskData[] | undefined, right: ITaskData[] | undefined, into: RunDataComparison): void {
  if (left === undefined || right === undefined || left.length !== right.length) {
    into.countDiffers.add(node);
    into.differences.push({ node, d: countDifference(node, left, right) });
    return;
  }
  const differences = runDifferences(node, left, right);
  into.differences.push(...differences.map((d) => ({ node, d })));
  if (differences.length > 0 && left.length > 1 && isPermutation(left.map(comparableTask), right.map(comparableTask))) {
    into.permuted.push(node);
  }
}

/** Compare every node either engine ran, in sorted order. */
export function compareRunData(reference: IRunData, candidate: IRunData): RunDataComparison {
  const result: RunDataComparison = { differences: [], countDiffers: new Set(), permuted: [] };
  const nodes = [...new Set([...Object.keys(reference), ...Object.keys(candidate)])].sort();
  for (const node of nodes) compareNode(node, reference[node], candidate[node], result);
  return result;
}
