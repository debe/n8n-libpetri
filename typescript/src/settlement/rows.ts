/**
 * The row snapshot a settlement decides from (`tasks/v2-seam-plan.md` decision 9): two of the
 * reader's existing queries, no `StepStore` change.
 *
 * 1. `loadLatestStepSummaries(every node id of the graph)`: each node's highest-iteration row.
 * 2. `loadStepSummariesByKeys` over `0 .. latest − 1` of each node whose latest row is past
 *    iteration 0. Skipped when no node is: on a graph without a loop, or before a loop's second
 *    pass, the snapshot is one read.
 *
 * Iterations are contiguous per node, so the two reads name every row the execution had at the
 * first read. A key the second read does not return is left absent, and the decoder refuses the
 * gap (`CodecError`); nothing is filled in.
 *
 * **Skew.** Rows are only ever created and their statuses only progress, so the second read can
 * see a row later than the first did, never earlier. Live shadow mode measures whether that
 * matters (F6).
 *
 * **Order.** The rows come back in a fixed order whatever order the store returned them in: by
 * iteration, then by the node's rank in the graph without its back edges (`CompiledGraph.rank`).
 * That makes the policy's input a function of the row set, and lets the decoder replay a loop's
 * passes in one sweep. The decoder's answer does not depend on the order; its cost does.
 *
 * What a store returns is checked against what was asked: a row under another node's key, for a
 * node or a key not asked about, or twice, is a {@link SettlementSnapshotError}, not a row.
 */
import type { StepKey, StepRow } from '../codec/v2/step-rows.js';
import type { V2SettlementReader, V2StepSummary } from '../n8n/v2-host.js';
import type { CompiledGraph } from './compile-cache.js';

/** A store answer that is not an answer to the question asked (see the module doc). */
export class SettlementSnapshotError extends Error {
  override readonly name = 'SettlementSnapshotError';
}

/** A snapshot and how many reads it took. */
export interface Snapshot {
  readonly rows: readonly StepRow[];
  /** Reader calls made: 1 or 2. */
  readonly reads: number;
}

const idOf = (k: StepKey): string => `${k.nodeId}\u0000${k.iteration}`;

/** The row a summary describes, without its id. */
function rowOf(summary: V2StepSummary): StepRow {
  return {
    nodeId: summary.nodeId,
    iteration: summary.iteration,
    status: summary.status,
    filledOutputSlots: [...summary.filledOutputSlots],
  };
}

/** The rows `rows` in the snapshot's order (see the module doc). */
export function orderRows(entry: CompiledGraph, rows: readonly StepRow[]): StepRow[] {
  const rank = (r: StepRow) => entry.rank.get(r.nodeId) ?? Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) => a.iteration - b.iteration || rank(a) - rank(b) || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}

/** Every row of the execution `reader` is bound to, of the nodes of `entry.graph` (see the module doc). */
export async function readSnapshot(entry: CompiledGraph, reader: V2SettlementReader): Promise<Snapshot> {
  const nodeIds = entry.graph.nodes.map((n) => n.id);
  const asked = new Set(nodeIds);
  const latest = await reader.loadLatestStepSummaries(nodeIds);
  const rows: StepRow[] = [];
  const keys: StepKey[] = [];
  for (const [nodeId, summary] of Object.entries(latest)) {
    if (!asked.has(nodeId)) throw new SettlementSnapshotError(`loadLatestStepSummaries returned node '${nodeId}', which the graph does not have`);
    if (summary.nodeId !== nodeId) throw new SettlementSnapshotError(`loadLatestStepSummaries returned node '${summary.nodeId}''s row under node '${nodeId}'`);
    if (!Number.isInteger(summary.iteration) || summary.iteration < 0) {
      throw new SettlementSnapshotError(`loadLatestStepSummaries returned node '${nodeId}' at iteration ${summary.iteration}; iterations are non-negative integers`);
    }
    rows.push(rowOf(summary));
    for (let i = 0; i < summary.iteration; i++) keys.push({ nodeId, iteration: i });
  }
  if (keys.length === 0) return { rows: orderRows(entry, rows), reads: 1 };

  const wanted = new Set(keys.map(idOf));
  const seen = new Set<string>();
  const earlier = await reader.loadStepSummariesByKeys(keys);
  for (const summary of Object.values(earlier)) {
    const id = idOf(summary);
    if (!wanted.has(id)) throw new SettlementSnapshotError(`loadStepSummariesByKeys returned (${summary.nodeId}, ${summary.iteration}), which was not asked for`);
    if (seen.has(id)) throw new SettlementSnapshotError(`loadStepSummariesByKeys returned (${summary.nodeId}, ${summary.iteration}) twice`);
    seen.add(id);
    rows.push(rowOf(summary));
  }
  return { rows: orderRows(entry, rows), reads: 2 };
}

/**
 * The two row sets decision 8 decides rather than decodes, or `null` for any other:
 * - `failure`: a row has failed. `_halt` inhibits every start and skip, so the plan is ∅, and
 *   decision 7 as amended says the execution is not finished: the failure's own settlement ends it.
 * - `cancel`: a row is cancelled and none has failed, a cancel on request (`CancelExecutionService`).
 *   The plan is ∅ and the execution is not finished: the cancel path ends it.
 */
export function namedRace(rows: readonly StepRow[]): 'failure' | 'cancel' | null {
  if (rows.some((r) => r.status === 'failed')) return 'failure';
  if (rows.some((r) => r.status === 'cancelled')) return 'cancel';
  return null;
}
