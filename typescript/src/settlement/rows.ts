/**
 * The row snapshot a settlement decides from (`tasks/v2-seam-plan.md` decision 9, step 14's
 * frontier, and step 12's scoped read): two of the reader's existing queries, no `StepStore` change.
 *
 * **The scoped read ({@link readSnapshot}, the default).** Only a loop's nodes can have a row past
 * iteration 0: `targetKey` (`execution/iteration-mapping.ts`) gives a `plain` edge its source's
 * iteration, an `entry` or `exit` edge iteration 0, and only `intra` and `back` edges carry a pass,
 * so a node outside every loop has at most the row `(node, 0)`. So:
 * 1. `loadLatestStepSummaries(the batch node ids)`, skipped on a graph without a loop. This is the
 *    query n8n's own default asks, for the same nodes. It only picks which keys the second read asks.
 *    None of its rows enters the snapshot.
 * 2. `loadStepSummariesByKeys` of every key the snapshot needs, in one statement: `(node, 0)` for each
 *    node outside a loop; and for a loop whose batch node was at pass L (−1 when it had no row),
 *    the passes `0, L − 1, L, L + 1` of every member (every pass up to L + 1 while L ≤ 2), the same
 *    for the batch node plus the probe `L + 2`. The settled row is added when it is not among them.
 *
 * Every row of the snapshot comes from the second read, one statement, so the snapshot is a subset
 * of the row set U(t) at one instant t. It holds U(t)'s frontier (`codec/v2/frontier.ts`) as long as
 * the batch node advanced at most one pass between the two reads: then its latest pass at t is L or
 * L + 1, its members' latest rows are at that pass or the one before, and the frontier passes of
 * either case are all asked. The probe says whether that held. **When the probe row exists** (the
 * loop ran two passes between the reads) the snapshot may miss rows, so it is discarded, and the
 * snapshot is read again by {@link readLatestSnapshot}, which is consistent whatever the timing. That
 * call makes 4 reads instead of 2 and reports `overrun`.
 *
 * Keys asked: one per node outside a loop, and at most 4 per member and 5 per batch node, whatever
 * the number of passes. The first read touches only batch rows, as n8n's own does.
 *
 * **The latest-row snapshot ({@link readLatestSnapshot}).** This was the default until step 12:
 * `loadLatestStepSummaries(every node id)`, then the frontier's older keys. Rows outside a node's
 * latest are completed or skipped and never change, so the two reads are consistent. Its first query
 * sorts every row of the execution (`DISTINCT ON … ORDER BY node_id, iteration DESC`), so its cost
 * grows with the passes (step 12, first run). It is kept as the scoped read's overrun path.
 *
 * {@link readFullSnapshot} is the snapshot as decision 9 first had it: every row `0 .. latest − 1`
 * of every node. It is the global decoder's input, kept for verification
 * (`createSettlementPolicy({ snapshot: 'full' })`).
 *
 * Iterations are contiguous per node, so the latest rows say which keys exist. A key a read does not
 * return is left absent, and the decoder refuses the gap (`CodecError`). Nothing is filled in.
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
import { frontierKeys } from '../codec/v2/frontier.js';
import type { CompiledGraph } from './compile-cache.js';

/** A store answer that is not an answer to the question asked (see the module doc). */
export class SettlementSnapshotError extends Error {
  override readonly name = 'SettlementSnapshotError';
}

/** A snapshot and how many reads it took. */
export interface Snapshot {
  readonly rows: readonly StepRow[];
  /** Reader calls that reached the store with a non-empty question: 0 to 2, or 4 on an overrun. */
  readonly reads: number;
  /** Keys asked of `loadStepSummariesByKeys`, summed over its calls: 0 when it was not called. */
  readonly keys: number;
  /** The scoped read's probe found the loop two passes on, and the snapshot was read again. */
  readonly overrun: boolean;
}

/** Which rows a snapshot reads: the frontier (step 14), or every row (decision 9 as first written). */
export type SnapshotScope = 'frontier' | 'full';

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

/** The latest row of each of `nodeIds`, checked against the question (see the module doc). */
async function readLatest(reader: V2SettlementReader, nodeIds: readonly string[]): Promise<Map<string, StepRow>> {
  if (nodeIds.length === 0) return new Map();
  const asked = new Set(nodeIds);
  const latest = await reader.loadLatestStepSummaries([...nodeIds]);
  const rows = new Map<string, StepRow>();
  for (const [nodeId, summary] of Object.entries(latest)) {
    if (!asked.has(nodeId)) throw new SettlementSnapshotError(`loadLatestStepSummaries returned node '${nodeId}', which was not asked for`);
    if (summary.nodeId !== nodeId) throw new SettlementSnapshotError(`loadLatestStepSummaries returned node '${summary.nodeId}''s row under node '${nodeId}'`);
    if (!Number.isInteger(summary.iteration) || summary.iteration < 0) {
      throw new SettlementSnapshotError(`loadLatestStepSummaries returned node '${nodeId}' at iteration ${summary.iteration}; iterations are non-negative integers`);
    }
    rows.set(nodeId, rowOf(summary));
  }
  return rows;
}

/** The rows of `keys`, in one keyed call when `keys` is not empty, checked against the question. */
async function readByKeys(reader: V2SettlementReader, keys: readonly StepKey[]): Promise<StepRow[]> {
  if (keys.length === 0) return [];
  const wanted = new Set(keys.map(idOf));
  const seen = new Set<string>();
  const rows: StepRow[] = [];
  const found = await reader.loadStepSummariesByKeys([...keys]);
  for (const summary of Object.values(found)) {
    const id = idOf(summary);
    if (!wanted.has(id)) throw new SettlementSnapshotError(`loadStepSummariesByKeys returned (${summary.nodeId}, ${summary.iteration}), which was not asked for`);
    if (seen.has(id)) throw new SettlementSnapshotError(`loadStepSummariesByKeys returned (${summary.nodeId}, ${summary.iteration}) twice`);
    if (!Number.isInteger(summary.iteration) || summary.iteration < 0) {
      throw new SettlementSnapshotError(`loadStepSummariesByKeys returned (${summary.nodeId}, ${summary.iteration}); iterations are non-negative integers`);
    }
    seen.add(id);
    rows.push(rowOf(summary));
  }
  return rows;
}

/** The latest rows plus the rows of `keys`: 1 read, or 2 when `keys` is not empty. */
async function readKeys(entry: CompiledGraph, reader: V2SettlementReader, latest: ReadonlyMap<string, StepRow>, keys: readonly StepKey[]): Promise<Snapshot> {
  const rows = [...latest.values(), ...await readByKeys(reader, keys)];
  return { rows: orderRows(entry, rows), reads: keys.length === 0 ? 1 : 2, keys: keys.length, overrun: false };
}

/** One loop of the compiled net, by n8n node id: its batch node and its other members. */
interface ScopeLoop {
  readonly batchId: string;
  readonly memberIds: readonly string[];
}

/** What the scoped read needs of a compiled graph, derived once per compiled net. */
interface ReadScope {
  readonly loops: readonly ScopeLoop[];
  readonly batchIds: readonly string[];
  /** Nodes outside every loop: at most the row `(node, 0)`. */
  readonly flatIds: readonly string[];
}

const scopes = new WeakMap<CompiledGraph['compiled'], ReadScope>();

function scopeOf(entry: CompiledGraph): ReadScope {
  const known = scopes.get(entry.compiled);
  if (known !== undefined) return known;
  const settlements = entry.compiled.netMap.settlements;
  const loops = settlements
    .filter((g) => g.batch !== null)
    .map((b) => ({ batchId: b.id, memberIds: settlements.filter((g) => g.loop === b.node && g.id !== b.id).map((g) => g.id) }));
  const inLoop = new Set(loops.flatMap((l) => [l.batchId, ...l.memberIds]));
  // Every graph node, compiled or not: a node the net leaves out has no row to read either, and
  // asking for it keeps a stray row visible to the decoder rather than silently unread.
  const flatIds = entry.graph.nodes.map((n) => n.id).filter((id) => !inLoop.has(id));
  const scope: ReadScope = { loops, batchIds: loops.map((l) => l.batchId), flatIds };
  scopes.set(entry.compiled, scope);
  return scope;
}

/**
 * The passes the scoped read asks of a loop's members when the batch node was at pass `last` (−1
 * for no row): those the frontier keeps if the batch node is still at `last` or one pass on, and
 * the members' possible latest passes, `last − 1 .. last + 1`.
 */
export function scopedPasses(last: number): number[] {
  if (last < 0) return [0];
  if (last <= 2) return Array.from({ length: last + 2 }, (_, i) => i);
  return [0, last - 1, last, last + 1];
}

/** The probe pass of a batch node that was at pass `last`: its row means the loop ran two passes on. */
export function probePass(last: number): number {
  return last < 0 ? 1 : last + 2;
}

/** The keys of the scoped read's second query (see the module doc), given each batch node's pass. */
export function scopedKeys(entry: CompiledGraph, batchLatest: ReadonlyMap<string, number>, settled?: StepKey): StepKey[] {
  const scope = scopeOf(entry);
  const keys: StepKey[] = scope.flatIds.map((nodeId) => ({ nodeId, iteration: 0 }));
  for (const loop of scope.loops) {
    const last = batchLatest.get(loop.batchId) ?? -1;
    const passes = scopedPasses(last);
    for (const p of [...passes, probePass(last)]) keys.push({ nodeId: loop.batchId, iteration: p });
    for (const nodeId of loop.memberIds) for (const p of passes) keys.push({ nodeId, iteration: p });
  }
  if (settled !== undefined && !keys.some((k) => k.nodeId === settled.nodeId && k.iteration === settled.iteration)) {
    keys.push({ nodeId: settled.nodeId, iteration: settled.iteration });
  }
  return keys;
}

/**
 * The scoped read (see the module doc): the frontier of the execution `reader` is bound to, of the
 * nodes of `entry.graph`, and the row of `settled` when given, from one keyed statement. 1 or 2
 * reader calls; 4 when the probe finds the loop two passes on (`overrun`).
 */
export async function readSnapshot(entry: CompiledGraph, reader: V2SettlementReader, settled?: StepKey): Promise<Snapshot> {
  const scope = scopeOf(entry);
  const batch = await readLatest(reader, scope.batchIds);
  const batchLatest = new Map([...batch].map(([id, r]) => [id, r.iteration]));
  const keys = scopedKeys(entry, batchLatest, settled);
  const rows = await readByKeys(reader, keys);
  const reads = (scope.batchIds.length > 0 ? 1 : 0) + (keys.length > 0 ? 1 : 0);
  const overrun = scope.loops.some((loop) => {
    const probe = probePass(batchLatest.get(loop.batchId) ?? -1);
    return rows.some((r) => r.nodeId === loop.batchId && r.iteration === probe);
  });
  if (!overrun) return { rows: orderRows(entry, rows), reads, keys: keys.length, overrun: false };
  const again = await readLatestSnapshot(entry, reader, settled);
  return { rows: again.rows, reads: reads + again.reads, keys: keys.length + again.keys, overrun: true };
}

/**
 * The latest-row snapshot (see the module doc): each node's latest row, then the frontier's older
 * keys and the row of `settled` when it is not its node's latest. At most 2 reader calls and 2 keys
 * per loop node + 1. Its first query sorts every row of the execution.
 */
export async function readLatestSnapshot(entry: CompiledGraph, reader: V2SettlementReader, settled?: StepKey): Promise<Snapshot> {
  const latest = await readLatest(reader, entry.graph.nodes.map((n) => n.id));
  const iterations = new Map([...latest].map(([id, r]) => [id, r.iteration]));
  const keys = frontierKeys(entry.compiled, iterations);
  if (settled !== undefined) {
    const own = iterations.get(settled.nodeId);
    if (own !== undefined && settled.iteration < own && !keys.some((k) => k.nodeId === settled.nodeId && k.iteration === settled.iteration)) {
      keys.push({ nodeId: settled.nodeId, iteration: settled.iteration });
    }
  }
  return readKeys(entry, reader, latest, keys);
}

/**
 * Every row of the execution `reader` is bound to, of the nodes of `entry.graph`: the latest rows,
 * then every key `0 .. latest − 1` of each node (decision 9 as first written). The global decoder's
 * input, for verification; its key count grows with a loop's passes.
 */
export async function readFullSnapshot(entry: CompiledGraph, reader: V2SettlementReader): Promise<Snapshot> {
  const latest = await readLatest(reader, entry.graph.nodes.map((n) => n.id));
  const keys: StepKey[] = [];
  for (const [nodeId, row] of latest) for (let i = 0; i < row.iteration; i++) keys.push({ nodeId, iteration: i });
  return readKeys(entry, reader, latest, keys);
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
