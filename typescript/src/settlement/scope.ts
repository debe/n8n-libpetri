/**
 * Key-scoped successors (`tasks/v2-seam-plan.md` decisions 6 and 7, measured by decision 13's
 * legs). The stateless planner answers R(S): every step the rows S leave to plan, whichever
 * settlement got there (`codec/v2/plan.ts`). n8n's seam asks a narrower question, per settled step
 * s: `decideSuccessors(s)` (`@n8n/engine` `execution/settlement.ts` at the pin, n8n master
 * `944afe5`) decides only the keys s's own out-edges reach, in edge order. This module narrows the
 * one answer to the other.
 *
 * - {@link candidateKeys}: the keys `decideSuccessors(s)` would decide, in its order. It walks the
 *   settled node's out-edges in graph order and ports, edge for edge, what picks a key there:
 *   `classifyEdge` and `targetKey` (`execution/iteration-mapping.ts`), `batchStepDecides` (a batch
 *   row decides one side of its loop), the dedupe of two edges into one key, and the skip of a key
 *   that already has a row. It does **not** port `decideNodeFate`: which candidate runs, is
 *   skipped or waits is the net's answer, not this module's.
 * - {@link scopePlan}: R(S) restricted to those candidates, in candidate order — queue and skip
 *   lists in the order `decideSuccessors` builds them.
 * - {@link isFinished}: decision 7's completion as amended after F3 fired at step 2: false on a
 *   row set with a failed row, otherwise every row settled and R(S) empty.
 *
 * The candidate list is structure, not scheduling: it says which keys a settlement may speak
 * about, never what becomes of them, so the "net decides what runs" rule holds.
 *
 * The graph is n8n's own `WorkflowGraph` (the mirror in `n8n/v2-graph.ts`), back edges
 * marked by the converter: like `classifyEdge`, this reads `isBackEdge` rather than deriving it.
 */
import type { StepPlan } from '../codec/v2/plan.js';
import { V2_SETTLED_STEP_STATUSES } from '../codec/v2/step-rows.js';
import type { StepKey, StepRow } from '../codec/v2/step-rows.js';
import { LOOP_SLOT } from '../compiler/index.js';
import { tarjan } from '../compiler/analysis/scc.js';
import type { V2Edge, V2Graph } from '../n8n/v2-graph.js';

/** `EdgeClass` (`execution/iteration-mapping.ts`): which rows an edge connects. */
export type ScopeEdgeClass = 'plain' | 'entry' | 'intra' | 'back' | 'exit';

/** `WorkflowLoop` (`graph/loops.ts`), the two fields a candidate needs. */
interface ScopeLoop {
  readonly batchNodeId: string;
  readonly memberIds: ReadonlySet<string>;
}

/** One out-edge, classified once. */
interface ClassifiedEdge {
  readonly edge: V2Edge;
  readonly edgeClass: ScopeEdgeClass;
}

/** What a graph's candidates are read from: its loops and each node's classified out-edges. */
interface Scope {
  readonly batchNodes: ReadonlySet<string>;
  /** Out-edges per node id, in graph edge order. */
  readonly outgoing: ReadonlyMap<string, readonly ClassifiedEdge[]>;
}

const SETTLED: ReadonlySet<string> = new Set(V2_SETTLED_STEP_STATUSES);

/**
 * `deriveLoops`: one loop per back-edge target, in edge order of the targets, its members the
 * target's strongly connected component over every edge.
 */
function loopsOf(graph: V2Graph): ScopeLoop[] {
  const targets = [...new Set(graph.edges.filter((e) => e.isBackEdge === true).map((e) => e.to))];
  if (targets.length === 0) return [];
  const succ = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) succ.get(e.from)?.push(e.to);
  const { sccOf, sccs } = tarjan(graph.nodes.map((n) => n.id), succ);
  return targets.map((batchNodeId) => {
    const scc = sccOf.get(batchNodeId);
    return { batchNodeId, memberIds: new Set((scc === undefined ? undefined : sccs[scc]) ?? [batchNodeId]) };
  });
}

/** `classifyEdge`: an edge leaving one loop into another is `exit`. */
function classifyScopeEdge(edge: V2Edge, loops: readonly ScopeLoop[]): ScopeEdgeClass {
  if (edge.isBackEdge === true) return 'back';
  const sourceLoop = loops.find((l) => l.memberIds.has(edge.from));
  const targetLoop = loops.find((l) => l.memberIds.has(edge.to));
  if (sourceLoop !== undefined && sourceLoop === targetLoop) return 'intra';
  if (sourceLoop !== undefined) return 'exit';
  if (targetLoop !== undefined) return 'entry';
  return 'plain';
}

/** `targetKey`: the row an edge reaches from the source row `source`. */
function targetKey(edge: V2Edge, edgeClass: ScopeEdgeClass, source: StepKey): StepKey {
  switch (edgeClass) {
    case 'back':
      return { nodeId: edge.to, iteration: source.iteration + 1 };
    case 'exit':
    case 'entry':
      return { nodeId: edge.to, iteration: 0 };
    default:
      return { nodeId: edge.to, iteration: source.iteration };
  }
}

/** `isTerminalStep` (`execution/loop-ledger.ts`): a batch row settled with its loop slot unfilled. */
function isTerminalRow(row: StepRow): boolean {
  return SETTLED.has(row.status) && !row.filledOutputSlots[LOOP_SLOT];
}

/** `batchStepDecides`: a running loop's batch row decides the body, its terminal row what follows. */
function batchStepDecides(edgeClass: ScopeEdgeClass, batchRow: StepRow): boolean {
  return isTerminalRow(batchRow) ? edgeClass === 'exit' : edgeClass !== 'exit';
}

const scopes = new WeakMap<V2Graph, Scope>();

/** The graph's scope, derived once per graph object: a graph is immutable once converted. */
function scopeOf(graph: V2Graph): Scope {
  const known = scopes.get(graph);
  if (known !== undefined) return known;
  const loops = loopsOf(graph);
  const outgoing = new Map<string, ClassifiedEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push({ edge, edgeClass: classifyScopeEdge(edge, loops) });
    outgoing.set(edge.from, list);
  }
  const scope: Scope = { batchNodes: new Set(loops.map((l) => l.batchNodeId)), outgoing };
  scopes.set(graph, scope);
  return scope;
}

const idOf = (k: StepKey): string => `${k.nodeId}\u0000${k.iteration}`;

/**
 * The keys `decideSuccessors(graph, loops, settled, S, …)` decides, in its order, from the rows S:
 * for each out-edge of `settled.nodeId` in graph edge order, its class, the batch filter, its
 * target key, then the two skips — a key S already has a row for (decided by an earlier
 * settlement) and a key an earlier edge already named.
 *
 * As in n8n, the batch filter applies only when `settled` is a batch node **and** S holds its row;
 * a batch node whose row is absent walks every edge.
 *
 * `rows` is S or any subset of S holding each node's latest row and the settled row (the frontier
 * snapshot, `rows.ts`): iterations are contiguous per node, so a key has a row in S exactly when its
 * iteration is at most its node's latest. On S itself that is the same test as looking the key up.
 */
export function candidateKeys(graph: V2Graph, settled: StepKey, rows: readonly StepRow[]): StepKey[] {
  const scope = scopeOf(graph);
  const latest = new Map<string, number>();
  for (const r of rows) latest.set(r.nodeId, Math.max(latest.get(r.nodeId) ?? -1, r.iteration));
  const exists = (k: StepKey): boolean => k.iteration <= (latest.get(k.nodeId) ?? -1);
  const batchRow = scope.batchNodes.has(settled.nodeId)
    ? rows.find((r) => r.nodeId === settled.nodeId && r.iteration === settled.iteration)
    : undefined;
  const decided = new Set<string>();
  const out: StepKey[] = [];
  for (const { edge, edgeClass } of scope.outgoing.get(settled.nodeId) ?? []) {
    if (batchRow !== undefined && !batchStepDecides(edgeClass, batchRow)) continue;
    const target = targetKey(edge, edgeClass, settled);
    const id = idOf(target);
    if (exists(target) || decided.has(id)) continue;
    decided.add(id);
    out.push(target);
  }
  return out;
}

/**
 * `plan` (R(S), the net's answer) restricted to `candidates`, in candidate order: a candidate the
 * net would queue goes to `toQueue`, one it would skip to `toSkip`, one it leaves undecided to
 * neither. A key the net put in both lists stays in both, so a comparison sees it.
 */
export function scopePlan(plan: StepPlan, candidates: readonly StepKey[]): StepPlan {
  const queue = new Set(plan.toQueue.map(idOf));
  const skip = new Set(plan.toSkip.map(idOf));
  const toQueue: StepKey[] = [];
  const toSkip: StepKey[] = [];
  for (const k of candidates) {
    const key = { nodeId: k.nodeId, iteration: k.iteration };
    if (queue.has(idOf(k))) toQueue.push(key);
    if (skip.has(idOf(k))) toSkip.push(key);
  }
  return { toQueue, toSkip };
}

/**
 * Decision 7, amended after F3 fired at step 2 (`tasks/v2-seam-plan.md`): the execution is finished
 * when no row has failed, every row has settled and the net plans nothing more, `plan` being R(S)
 * at `rows`.
 *
 * `rows` may be the frontier of S rather than S (`codec/v2/frontier.ts`): every row of S that is not
 * its node's latest is completed or skipped, so the failed and unsettled tests read the same there.
 *
 * A row set with a failed row is never finished here. In n8n such a row set does not reach
 * `finishExecutionIfDone`: the failed step's own settlement goes to `failExecution`, and every
 * other settlement checks `hasFailedSteps` first. It reaches the completion test only when a
 * failure lands between the planning read and `hasFailedSteps`, F2's named race; there `false`
 * leaves the ending to the failure's settlement, which ends the execution as `failed`. The halted
 * net would otherwise say finished on every failed row set whose rows have all settled, where n8n's
 * count still owes the steps the failure kept from being decided.
 */
export function isFinished(rows: readonly StepRow[], plan: StepPlan): boolean {
  if (rows.some((r) => r.status === 'failed')) return false;
  return rows.every((r) => SETTLED.has(r.status)) && plan.toQueue.length === 0 && plan.toSkip.length === 0;
}
