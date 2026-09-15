/**
 * OR rounds (README "OR-inputs") in both directions. An OR-form node aggregates the
 * deliveries of one round on `X/ready_i` (one per delivery, data or empty) and carries each
 * data arrival on `X/hasdata_i`; n8n keeps the data as ordinary stack entries and the empties
 * as `waitingExecution[C][k].main = [[]]` rows, one per delivery.
 *
 * Decode ({@link decodeOrEntry}, {@link decodeOrRow}, {@link RoundDeliveries}) counts a
 * delivery for every `[]` row and for every data arrival over a tree edge from a reachable
 * producer ({@link countsTowardRound}), and rebuilds `X/ran_i` for an open round the node
 * already ran in. Encode ({@link encodeOr}) is the inverse: every activation decode would
 * count again is subtracted from `X/ready_i`, and the rest become `[]` rows.
 */
import { tokenOf, type Token } from 'libpetri';
import type { IExecuteData, ISourceData } from 'n8n-workflow';
import type { CompiledWorkflow, NodeGadget, OrGadget, OrInput } from '../compiler/index.js';
import { unit } from '../internal/tokens.js';
import { sourceOfEntry, sourceOfValue } from './entry.js';
import { slotOfArrival, type RoutedArrival } from './routed.js';
import { add, count, edgePayload, type MarkingMap, type WaitingRow } from './shared.js';
import type { Cell, NodeWriter } from './writer.js';

/**
 * README "OR-inputs": a delivery over a tree edge counts towards the round's `n`; a
 * producer the compile cannot reach is already represented by the seeded deliveries of
 * `sharedMarking()`, so only a reachable producer's delivery is counted again.
 */
function countsTowardRound(compiled: CompiledWorkflow, i: OrInput, source: ISourceData | null): boolean {
  if (source === null) return false;
  const e = i.edges.find((s) => s.edge.from === source.previousNode && s.edge.outputIndex === (source.previousNodeOutput ?? 0));
  return e !== undefined && e.empty !== null && compiled.analysis.reachable.has(source.previousNode);
}

// ==================== decode ====================

/** The deliveries of open OR rounds one decode adds to `X/ready_i`, materialised after every row is read. */
export class RoundDeliveries {
  private readonly deliveries = new Map<OrInput, number>();

  deliver(i: OrInput, n = 1): void {
    this.deliveries.set(i, (this.deliveries.get(i) ?? 0) + n);
  }

  /** The deliveries, then the `X/ran_i` marker of an open round whose node already ran. */
  materialise(marking: MarkingMap, nodes: readonly NodeGadget[], hasRun: (name: string) => boolean): void {
    for (const [i, n] of this.deliveries) {
      for (let k = 0; k < n; k++) add(marking, i.ready, unit());
    }
    for (const g of nodes) {
      if (g.form !== 'or') continue;
      const [i] = g.inputs;
      if (count(marking, i.ready) > 0 && hasRun(g.node)) add(marking, i.ran, unit());
    }
  }
}

/** A stack entry of an OR-form node: the arrival on `X/hasdata_i`, and a delivery of the round when it counts. */
export function decodeOrEntry(
  compiled: CompiledWorkflow, g: OrGadget, token: Token<unknown>, entry: IExecuteData,
  marking: MarkingMap, rounds: RoundDeliveries,
): void {
  const [i] = g.inputs;
  add(marking, i.hasdata, token);
  if (countsTowardRound(compiled, i, sourceOfEntry(entry))) rounds.deliver(i);
}

/** A `waitingExecution` row of an OR-form node: `[]` is a delivered empty of the open round, items an arrival. */
export function decodeOrRow(
  compiled: CompiledWorkflow, g: OrGadget, row: WaitingRow,
  marking: MarkingMap, rounds: RoundDeliveries, pendingNodes: Set<string>,
): void {
  const [i] = g.inputs;
  row.foreign((idx) => idx === i.index);
  const v = row.valueAt(i.index);
  if (v === null) return;
  if (v.length === 0) {
    rounds.deliver(i); // a delivered empty of the open round
    return;
  }
  pendingNodes.add(g.node);
  const source = row.sourceAt(i.index);
  add(marking, i.hasdata, tokenOf<unknown>(edgePayload(v, source)));
  if (countsTowardRound(compiled, i, source)) rounds.deliver(i);
}

// ==================== encode ====================

/**
 * An OR-form node's pending arrivals as stack entries (stranded: rows), and the open round's
 * other deliveries as one `[]` row each (n8n's R6 discards them; decode counts them).
 * `activations` are the node's own entries already written, which decode counts again.
 */
export function encodeOr(w: NodeWriter, g: OrGadget, activations: readonly IExecuteData[], routedHere: readonly RoutedArrival[]): void {
  const { compiled, marking, mode } = w;
  const [i] = g.inputs;
  // Armed arrivals were counted in the round; arrivals still on an edge (cancelled) were not.
  const armed = marking.peekTokens(i.hasdata).map((t): Cell => ({ value: t.value, place: i.hasdata }));
  const unarmed: Cell[] = [];
  let unarmedEmpties = 0;
  for (const e of i.edges) {
    for (const t of marking.peekTokens(e.data)) unarmed.push({ value: t.value, place: e.data });
    if (e.empty !== null) unarmedEmpties += marking.tokenCount(e.empty);
  }
  for (const r of routedHere) {
    const e = slotOfArrival(g, i, r);
    if (r.payload !== null) unarmed.push({ value: r.payload, place: e.data });
    else if (e.empty !== null) unarmedEmpties++;
  }
  // Every activation decode turns back into a stack entry was armed once — waiting,
  // stopped before its run, retrying, running (cancelled) or still on hasdata_i — and
  // decode counts its delivery again, so the encoder subtracts all of them.
  const activationSources: Array<ISourceData | null> = [
    ...activations.map(sourceOfEntry),
    ...armed.map((a) => sourceOfValue(a.value)),
  ];
  const counted = activationSources.filter((source) => countsTowardRound(compiled, i, source)).length;
  for (const a of [...armed, ...unarmed]) {
    const e = w.entryOf(i.index, a.value, a.place);
    if (e === null) continue;
    if (mode === 'stranded') w.strand(i.index, e, a.place);
    else w.push(e);
  }
  // The open round's other deliveries: one `[]` slot each (n8n's R6 discards them; decode counts them).
  const seeds = g.reachable ? i.unreachableEdges : 0;
  const deliveries = Math.max(0, marking.tokenCount(i.ready) - counted - seeds) + unarmedEmpties;
  if (deliveries > 0 && mode === 'stranded') {
    w.diag(`node '${g.node}': OR-input round left open on '${i.ready.name}' (${deliveries} delivered empties, divergence #2); written to waitingExecution`);
  }
  for (let k = 0; k < deliveries; k++) w.nextSlot().main[i.index] = [];
}
