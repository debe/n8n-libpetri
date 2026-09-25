/**
 * Engine v2's step rows → a marking of the `engineV2` net (`tasks/v2-profile-plan.md` decision 12,
 * ADR 0012 §2's stateless planner). Engine v2 keeps no plan: every node activation is a row keyed
 * `(execution, node, iteration)`, and `StepSettledHandler` re-plans from the rows' settled flags
 * (`StepSummary`, `packages/@n8n/engine/src/execution/step-store.ts`). If the net is to be a v2
 * planner, a row set has to determine a marking; this module builds it.
 *
 * **Guided replay.** The marking is not written down by formula: the rows are replayed through the
 * net. Starting from `initialMarking`, the decoder repeatedly takes any row not yet applied whose
 * first transition is enabled — `X_start` for a row that was queued, and so for every row that
 * ran, `X_skip` for a skipped one; on a batch node the entry pair at pass 0 and the back pair
 * after — and fires it along the branch the row fixes:
 *
 * | row | fired |
 * |---|---|
 * | `queued`, `running` | the start: the step is in flight, its token on `X/running` |
 * | `completed` | the start, then `X_run`'s success branch filling exactly the row's `filledOutputSlots`; under split routing `X_run` then every `X_route_o` |
 * | `failed` | the start, then `X_run`'s halt branch |
 * | `skipped` | the skip |
 * | `cancelled` | the start only: v2 cancels a queued step after a failure (`cancelQueuedSteps`), and the net does not model the cancellation, so the step stays in flight |
 *
 * A batch node's completed row takes `B_run`'s `loop` branch when its loop slot is filled,
 * `doneData` when its done slot is, and `doneEmpty` when neither is (`runBatchStep`,
 * `execution/batch-step.ts`).
 *
 * Why replay rather than a closed formula or the state equation: `X_start` takes `all(X/live)`, a
 * count fixed only when it fires. Replay also lets the net itself find a row set it cannot have
 * produced — a row whose transition is never enabled is left over — instead of a port of
 * `classifyEdge` finding it.
 *
 * Three orderings are imposed, and each is a firing order the net has:
 * - a node's rows are applied in iteration order (at most one step per node is in flight,
 *   decision 6);
 * - a row is applied whole — start, run and routes together — because once `X/running` is marked
 *   the run is enabled, and `X_route_o` is the only consumer of its `X/ok_o`;
 * - the `_halt` a failed row writes is deposited after every row: `_halt` inhibits only starts and
 *   skips, and nothing reads the failed run's other outputs, so a run that failed can always
 *   have been the last to settle. Rows v2 created before it saw the failure then replay.
 *
 * Rows use n8n's graph node ids. A description built by `graphToDescription`
 * (`conformance/v2/graph.ts`) keeps them as node ids, so a row's `nodeId` is its
 * {@link SettlementGadget}`.id`.
 *
 * The decoder is exact and refuses rather than guesses: every refusal is a {@link CodecError}
 * naming the row. The replay's own refusal (a row left over) and the checks made before it:
 * - a node the net does not compile;
 * - a status engine v2 does not have at the pin — `waiting` included, which `STEP_STATUSES` lacks;
 * - an iteration that is not a whole number, a repeated `(node, iteration)`, a gap in a node's
 *   iterations, and an iteration above 0 on a node outside every loop;
 * - a filled slot on a row that did not complete (`filledOutputSlots` is "empty unless
 *   completed");
 * - a trigger row that failed or was skipped (`ExecutionStartHandler` records it completed at
 *   birth, decision 7);
 * - a batch row that filled both its done and its loop slot, which `runBatchStep` never returns;
 * - a loop member's row at a pass whose batch row is terminal (`isPastLoopEnd`: body steps exist
 *   for running passes only);
 * - a cancelled row with no failed row (v2 cancels only after a failure).
 *
 * The marking alone does not say how many rows a node has — a loop is folded, not unrolled, and
 * its members carry no per-pass marker (decision 6) — so the decoder returns the row count per
 * node beside it: a planner keys its answers `(node, rowCount(node))`.
 */
import type { Place, Token, Transition } from 'libpetri';
import { assertProfile, DONE_SLOT, InternalCompilerError, LOOP_SLOT } from '../../compiler/index.js';
import type { CompiledWorkflow, SettlementGadget } from '../../compiler/index.js';
import { CodecError } from '../errors.js';
import { branchOf, fire, isEnabled, TokenCounts } from './net.js';

/** `STEP_STATUSES` (`packages/@n8n/engine/src/execution/execution.types.ts`) at the pin `n8n@2.41.3`. */
export const V2_STEP_STATUSES = ['queued', 'running', 'completed', 'failed', 'skipped', 'cancelled'] as const;

/** `StepStatus` at the pin. There is no `waiting`. */
export type V2StepStatus = (typeof V2_STEP_STATUSES)[number];

/** `SETTLED_STEP_STATUSES` at the pin. */
const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'skipped', 'cancelled']);

/** `StepKey` (`execution.types.ts`): one row's identity within an execution, by n8n graph node id. */
export interface StepKey {
  readonly nodeId: string;
  readonly iteration: number;
}

/**
 * `StepSummary` (`execution/step-store.ts`), the slim view `decideSuccessors` reads: status and
 * which output slots a completed step filled. `status` is typed loosely on purpose: rows come from
 * n8n, and one the pin does not know is a {@link CodecError}, not a type error at a distance.
 */
export interface StepRow extends StepKey {
  readonly status: V2StepStatus | (string & {});
  readonly filledOutputSlots: readonly boolean[];
}

/** A decoded row set: the marking, and each node's number of rows by n8n node id. */
export interface StepMarking {
  readonly marking: Map<Place<unknown>, Token<unknown>[]>;
  /** Rows per node id; a node without rows is absent. */
  readonly rowCounts: ReadonlyMap<string, number>;
}

/** `isTerminalStep` (`execution/loop-ledger.ts`): a batch row settled with its loop slot unfilled. */
function isTerminalRow(row: StepRow): boolean {
  return SETTLED.has(row.status) && !row.filledOutputSlots[LOOP_SLOT];
}

const rowName = (row: StepKey): string => `(${row.nodeId}, ${row.iteration})`;

/** One row, validated, with its gadget. */
interface Pending {
  readonly row: StepRow;
  readonly g: SettlementGadget;
}

/** The checks made before replay (see the module doc), in the order listed there. */
function validate(compiled: CompiledWorkflow, rows: readonly StepRow[]): Pending[] {
  const byId = new Map(compiled.netMap.settlements.map((g) => [g.id, g]));
  const known: ReadonlySet<string> = new Set(V2_STEP_STATUSES);
  const pending: Pending[] = [];
  const perNode = new Map<string, Map<number, StepRow>>();
  for (const row of rows) {
    const g = byId.get(row.nodeId);
    if (g === undefined) throw new CodecError(`row ${rowName(row)}: node '${row.nodeId}' is not compiled in the engineV2 net`);
    if (!known.has(row.status)) {
      throw new CodecError(`row ${rowName(row)} of node '${g.node}': status '${row.status}' is not an engine v2 step status at n8n@2.41.3 (${V2_STEP_STATUSES.join(', ')})`);
    }
    if (!Number.isInteger(row.iteration) || row.iteration < 0) {
      throw new CodecError(`row ${rowName(row)} of node '${g.node}': the iteration is not a non-negative integer`);
    }
    const own = perNode.get(row.nodeId) ?? new Map<number, StepRow>();
    if (own.has(row.iteration)) throw new CodecError(`row ${rowName(row)} of node '${g.node}' appears twice; (node, iteration) is unique`);
    own.set(row.iteration, row);
    perNode.set(row.nodeId, own);
    if (row.status !== 'completed' && row.filledOutputSlots.some(Boolean)) {
      throw new CodecError(`row ${rowName(row)} of node '${g.node}': a ${row.status} row fills output slots, which only a completed row does`);
    }
    if (g.isTrigger && (row.status === 'failed' || row.status === 'skipped')) {
      throw new CodecError(`row ${rowName(row)} of trigger '${g.node}' is ${row.status}; the trigger's row is completed at birth`);
    }
    if (g.batch !== null && row.status === 'completed' && row.filledOutputSlots[DONE_SLOT] && row.filledOutputSlots[LOOP_SLOT]) {
      throw new CodecError(`row ${rowName(row)} of batch node '${g.node}' fills both its done and its loop slot; runBatchStep fills one at most`);
    }
    pending.push({ row, g });
  }
  for (const [nodeId, own] of perNode) {
    const g = byId.get(nodeId)!;
    for (let i = 0; i < own.size; i++) {
      if (!own.has(i)) {
        throw new CodecError(`node '${g.node}' has ${own.size} rows but none at iteration ${i}; a node's iterations run 0, 1, … without a gap`);
      }
    }
    if (g.loop === null && own.size > 1) {
      throw new CodecError(`node '${g.node}' is outside every loop and has ${own.size} rows; it has one`);
    }
    if (g.loop !== null && g.batch === null) {
      const batchRows = perNode.get(compiled.netMap.settlement(g.loop).id);
      for (const row of own.values()) {
        const batchRow = batchRows?.get(row.iteration);
        if (batchRow !== undefined && isTerminalRow(batchRow)) {
          throw new CodecError(`row ${rowName(row)} of loop member '${g.node}' is at pass ${row.iteration}, where batch node '${g.loop}' ended its loop; body steps exist for running passes only`);
        }
      }
    }
  }
  if (rows.some((r) => r.status === 'cancelled') && !rows.some((r) => r.status === 'failed')) {
    const r = rows.find((x) => x.status === 'cancelled')!;
    throw new CodecError(`row ${rowName(r)} is cancelled but no row failed; engine v2 cancels queued steps only after a failure`);
  }
  return pending;
}

/** The start or the skip a row fires first: a batch node's entry pair at pass 0, its back pair after. */
function firstTransition(compiled: CompiledWorkflow, { row, g }: Pending): Transition {
  const skipping = row.status === 'skipped';
  let name: string | null;
  if (g.batch !== null && row.iteration > 0) name = skipping ? g.batch.transitions.skipBack : g.batch.transitions.startBack;
  else name = skipping ? g.transitions.skip : g.transitions.start;
  if (name === null) throw new InternalCompilerError(`internal: node '${g.node}' has no skip transition`);
  return compiled.netMap.transitionObject(name);
}

/** Names of the places of a set of edges' `arrived`, and with `live` their consumers' `live`. */
function slotPlaces(edges: SettlementGadget['incoming'], live: boolean): string[] {
  return [...edges.map((e) => e.arrived.name), ...(live ? edges.map((e) => e.live.name) : [])];
}

/** The places `X_run`'s branch for `row` writes (see the module doc's table). */
function runBranch(compiled: CompiledWorkflow, { row, g }: Pending): Set<string> {
  const filled = (o: number): boolean => Boolean(row.filledOutputSlots[o]);
  const halt = compiled.netMap.halt.name;
  if (g.batch !== null) {
    if (row.status === 'failed') return new Set([halt, g.batch.ended.name]);
    const slot = (index: number) => g.outputs.find((o) => o.index === index)?.edges ?? [];
    if (filled(LOOP_SLOT)) return new Set(slotPlaces(slot(LOOP_SLOT), true));
    return new Set([...slotPlaces(slot(DONE_SLOT), filled(DONE_SLOT)), g.batch.ended.name]);
  }
  const marker = g.done === null ? [] : [g.done.name];
  if (row.status === 'failed') return new Set([halt, ...marker]);
  return new Set([
    ...g.outputs.flatMap((o) => (o.ok !== null ? [o.ok.name] : slotPlaces(o.edges, filled(o.index)))),
    ...marker,
  ]);
}

/** Fires row `p` whole (see the module doc), withholding `_halt`, which the caller deposits last. */
function apply(compiled: CompiledWorkflow, counts: TokenCounts, p: Pending, first: Transition): void {
  const { row, g } = p;
  const only = (t: Transition): ReadonlySet<Place<unknown>> => branchOf(t, new Set([...t.outputPlaces()].map((x) => x.name)));
  fire(first, counts, only(first));
  if (row.status !== 'completed' && row.status !== 'failed') return;
  const run = compiled.netMap.transitionObject(g.transitions.run);
  fire(run, counts, branchOf(run, runBranch(compiled, p)), new Set([compiled.netMap.halt.name]));
  if (row.status === 'failed' || g.routing !== 'split') return;
  for (const out of g.outputs) {
    const route = compiled.netMap.transitionFor(g.node, 'route', out.index);
    if (route === undefined) throw new InternalCompilerError(`internal: split output ${out.index} of '${g.node}' has no route`);
    const t = compiled.netMap.transitionObject(route.name);
    fire(t, counts, branchOf(t, new Set(slotPlaces(out.edges, Boolean(row.filledOutputSlots[out.index])))));
  }
}

/**
 * The marking engine v2's rows `rows` put the `engineV2` net in, by guided replay (see the module
 * doc), and each node's row count. Rows are tried in the order given, so a caller can vary the
 * replay order by permuting them; a consistent row set gives one marking whatever the order.
 * Throws {@link CodecError} for a row set the net cannot have produced, and
 * `ProfileMismatchError` for a v1 net.
 */
export function decodeStepRows(compiled: CompiledWorkflow, rows: readonly StepRow[]): StepMarking {
  assertProfile('decodeStepRows', 'engineV2', compiled.netMap.profile);
  let pending = validate(compiled, rows);
  const counts = TokenCounts.of(compiled.initialMarking(null));
  const applied = new Map<string, number>();
  let halts = 0;
  for (let progress = true; progress && pending.length > 0;) {
    progress = false;
    const left: Pending[] = [];
    for (const p of pending) {
      const first = firstTransition(compiled, p);
      if ((applied.get(p.row.nodeId) ?? 0) !== p.row.iteration || !isEnabled(first, counts)) {
        left.push(p);
        continue;
      }
      apply(compiled, counts, p, first);
      applied.set(p.row.nodeId, p.row.iteration + 1);
      if (p.row.status === 'failed') halts++;
      progress = true;
    }
    pending = left;
  }
  if (pending.length > 0) {
    const names = pending.map(({ row, g }) => `${rowName(row)} '${g.node}' ${row.status}`).join('; ');
    throw new CodecError(`rows the engineV2 net cannot have produced: the replay never found the start or skip of ${names} enabled`);
  }
  counts.add(compiled.netMap.halt, halts);
  const rowCounts = new Map<string, number>();
  for (const row of rows) rowCounts.set(row.nodeId, (rowCounts.get(row.nodeId) ?? 0) + 1);
  return { marking: counts.toMarking(compiled), rowCounts };
}
