/**
 * The local frontier decode (`tasks/v2-seam-plan.md` step 14): the marking {@link decodeStepRows}
 * gives for a row set S, computed from a subset of S whose size does not grow with a loop's passes.
 *
 * The global decoder replays every row. A settlement under it reads every row of every node, so a
 * Loop Over Items at batch size 1 costs O(passes) keys and O(passes) decode work per settlement,
 * O(passes²) per run, and n8n's TypeORM store turns a key list that long into a query past
 * Postgres' 65,535 bind parameters (2 per key) at about 6,600 passes of a 4-node body.
 *
 * **The frontier of S.** Every node's latest row, and for each loop whose batch node's latest row is
 * at pass L ≥ 3, the rows of the loop's nodes (batch node and members) at passes 0 and L − 1. With
 * L ≤ 2 that is already every row of the loop. Outside a loop a node has one row, its latest. The
 * frontier is at most 3 rows per loop node and 1 per other node, whatever L is.
 * {@link frontierKeys} names the rows beyond the latest ones, so a reader asks for them in one
 * keyed read after the latest-row read.
 *
 * **Why the marking is a function of the frontier.** `validateLoops` leaves a loop one way in (the
 * batch node's entry), one way back (the return edge `K` into the batch node) and no way out but
 * the batch node's done slot, and refuses nested loops (`analysis/engine-v2/shape.ts`). The loop
 * is folded (decision 6): its members carry no markers, and every place a pass writes in the body
 * is consumed in that pass. So, in any row set the global decoder accepts:
 *
 * 1. Every member is an ancestor of `K`'s source inside the pass (it is in the batch node's strongly
 *    connected component, and the only edge into the batch node from the body is `K`). A start or
 *    skip takes one `arrived` per incoming edge, and only a completed run or a skip writes its
 *    out-edges' `arrived`. So the batch row at pass p + 1 replays only if every member's row at
 *    pass p is `completed` or `skipped`, and the batch row at pass p is `completed` with its loop
 *    slot filled (a terminal batch row writes nothing into the body).
 * 2. When the batch row at pass p + 1 starts or skips, the body's places are empty, as at pass 1:
 *    each member's `live` went to its start or kept its skip from firing, its `arrived` tokens to its
 *    start or skip, its `running` to its run; the body has no other place. What stands is `K/arrived`
 *    and, when `K` arrived live, `B/live`; nothing else in the net is written by the body.
 * 3. A pass p with 1 ≤ p ≤ L − 2 therefore starts by `B_start_back` (its batch row is not
 *    terminal, and the pass before sent `K` live, or there would be no row at p + 1) and ends by
 *    putting back the `K/arrived` and `B/live` it took: its firings change no place. Removing passes
 *    1 .. L − 2 and replaying pass L − 1 as pass 1 and pass L as pass 2 fires the same transitions
 *    on the same marking everywhere else, so the replay ends in the same marking. Pass 0 stays, for
 *    the entry pair; pass L − 1 stays, because whether `K` arrived live decides how pass L starts.
 *
 * The decoder's own answer does not depend on row order (`decodeStepRows`), and the other nodes'
 * rows are the same in both replays, so interleaving does not matter. What the marking does not
 * hold, the row count per node, is each node's latest iteration + 1 (iterations are contiguous).
 *
 * The same argument gives the facts the policy reads besides the marking: every row of S that is
 * not its node's latest row is `completed` or `skipped` (1., and a node outside a loop has one
 * row). So whether S has a failed, cancelled or unsettled row is decided by the latest rows, which
 * the frontier holds, and a key exists in S exactly when its iteration is at most its node's latest.
 *
 * **What the frontier does not check.** Rows outside it are not read, so a row set the global
 * decoder refuses for a fault in a removed pass (a gap, an unsettled or cancelled row deep in a
 * loop's history) can decode here. Such a row set is not one engine v2 produces, by 1.; the store
 * contract is iterations contiguous per node and statuses that only progress. Every refusal the
 * frontier does raise is the global decoder's on the compressed rows, re-labelled.
 *
 * The equality `decodeFrontier(S) = decodeStepRows(S)` (marking and row counts) is checked, not
 * only argued: on every state of the differential, the exhaustive spike and the golden, and on long
 * synthetic loops (`tests/codec/v2-frontier.test.ts`).
 */
import { assertProfile } from '../../compiler/index.js';
import type { CompiledWorkflow } from '../../compiler/index.js';
import { CodecError } from '../errors.js';
import { decodeStepRows } from './step-rows.js';
import type { StepKey, StepMarking, StepRow } from './step-rows.js';

/** One loop of the net, by n8n node id: its batch node and every node in it, the batch node included. */
interface FrontierLoop {
  readonly batchId: string;
  readonly nodeIds: readonly string[];
}

const loopCache = new WeakMap<CompiledWorkflow, readonly FrontierLoop[]>();

/** The loops of `compiled`, derived once per compiled net. */
function loopsOf(compiled: CompiledWorkflow): readonly FrontierLoop[] {
  const known = loopCache.get(compiled);
  if (known !== undefined) return known;
  const settlements = compiled.netMap.settlements;
  const loops = settlements
    .filter((g) => g.batch !== null)
    .map((b) => ({ batchId: b.id, nodeIds: settlements.filter((g) => g.loop === b.node).map((g) => g.id) }));
  loopCache.set(compiled, loops);
  return loops;
}

/**
 * The passes of a loop whose batch node's latest row is at pass `last` that the frontier keeps, in
 * order: every pass up to 2, else 0, `last − 1` and `last`.
 */
function keptPasses(last: number): readonly number[] {
  return last <= 2 ? Array.from({ length: last + 1 }, (_, i) => i) : [0, last - 1, last];
}

/**
 * The keys a frontier decode needs beyond each node's latest row (see the module doc), given each
 * node's latest iteration by node id (a node without rows absent). In net declaration order, loop by
 * loop; at most 2 per loop node, none outside a loop. Throws `ProfileMismatchError` for a v1 net.
 */
export function frontierKeys(compiled: CompiledWorkflow, latest: ReadonlyMap<string, number>): StepKey[] {
  assertProfile('frontierKeys', 'engineV2', compiled.netMap.profile);
  const keys: StepKey[] = [];
  for (const loop of loopsOf(compiled)) {
    const last = latest.get(loop.batchId);
    if (last === undefined || last === 0) continue;
    for (const nodeId of loop.nodeIds) {
      const own = latest.get(nodeId);
      if (own === undefined) continue;
      for (const p of keptPasses(last)) if (p < own) keys.push({ nodeId, iteration: p });
    }
  }
  return keys;
}

/** Each node's latest iteration in `rows`, by node id. */
export function latestIterations(rows: readonly StepKey[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const r of rows) latest.set(r.nodeId, Math.max(latest.get(r.nodeId) ?? -1, r.iteration));
  return latest;
}

/** The frontier of `rows` (see the module doc): the rows of `rows` a frontier decode reads. */
export function frontierOf(compiled: CompiledWorkflow, rows: readonly StepRow[]): StepRow[] {
  const latest = latestIterations(rows);
  const wanted = new Set(frontierKeys(compiled, latest).map((k) => `${k.nodeId}\u0000${k.iteration}`));
  return rows.filter((r) => r.iteration === latest.get(r.nodeId) || wanted.has(`${r.nodeId}\u0000${r.iteration}`));
}

/**
 * The marking and row counts `decodeStepRows` gives for a row set S, from `rows`, any subset of S
 * that holds its frontier (S itself included). Loop passes outside the frontier are dropped, and the
 * passes kept are replayed as 0, 1, 2 (see the module doc); the row counts are each node's latest
 * iteration + 1.
 *
 * Throws {@link CodecError} where the global decoder refuses the compressed rows, with the
 * renumbering named, and `ProfileMismatchError` for a v1 net.
 */
export function decodeFrontier(compiled: CompiledWorkflow, rows: readonly StepRow[]): StepMarking {
  assertProfile('decodeFrontier', 'engineV2', compiled.netMap.profile);
  const latest = latestIterations(rows);
  /** Per loop node id: its loop's batch latest pass, when that is past 2. */
  const compressed = new Map<string, number>();
  for (const loop of loopsOf(compiled)) {
    const last = latest.get(loop.batchId);
    if (last !== undefined && last > 2) for (const id of loop.nodeIds) compressed.set(id, last);
  }
  let replay: readonly StepRow[] = rows;
  if (compressed.size > 0) {
    const out: StepRow[] = [];
    for (const r of rows) {
      const last = compressed.get(r.nodeId);
      if (last === undefined || r.iteration === 0) out.push(r);
      else if (r.iteration >= last - 1) out.push({ ...r, iteration: r.iteration - last + 2 });
    }
    replay = out;
  }
  let decoded: StepMarking;
  try {
    decoded = decodeStepRows(compiled, replay);
  } catch (e) {
    if (!(e instanceof CodecError) || compressed.size === 0) throw e;
    const passes = [...new Set(compressed.values())].map((L) => `0, ${L - 1}, ${L} as 0, 1, 2`).join('; ');
    throw new CodecError(`${e.message.replace(/^n8n-libpetri codec: /, '')} (frontier decode: loop passes ${passes})`);
  }
  const rowCounts = new Map<string, number>();
  for (const [id, it] of latest) rowCounts.set(id, it + 1);
  return { marking: decoded.marking, rowCounts };
}
