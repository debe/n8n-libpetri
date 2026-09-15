/**
 * Join slots, encode half ({@link encodeJoin}): pairs the positional queues the marking holds
 * (`join-queue.ts`) into rows and entries — a complete slot with data is n8n's `allDataFound`
 * stack entry, an entry-headed slot the entry verbatim, anything else a `waitingExecution` row.
 */
import type { ISourceData } from 'n8n-workflow';
import type { SlottedGadget } from '../compiler/index.js';
import { isEdgePayload, isEntryPayload, type EntryPayload } from '../scheduler/payloads.js';
import { CodecError } from './errors.js';
import { holdsOnlySeeds, joinQueue, type InputQueue } from './join-queue.js';
import { unmatchedArrival, type RoutedArrival } from './routed.js';
import { inputCountOf, type Items, type SlotMain, type SlotSource } from './shared.js';
import type { Cell, NodeWriter } from './writer.js';

/** A {@link Cell} whose token is a stack entry: the head of an entry-headed slot. */
interface EntryCell extends Cell {
  readonly value: EntryPayload;
}

/** An arrival routed onto an input the gadget does not model has no slot to wait in. */
function assertRoutedOnInputs(g: SlottedGadget, routedHere: readonly RoutedArrival[]): void {
  for (const r of routedHere) {
    if (!g.inputs.some((i) => i.index === r.edge.inputIndex)) throw unmatchedArrival(g, r.edge.inputIndex, r);
  }
}

/** The node's next `waitingExecution` row, filled per input from `mainAt` / `sourceAt`. */
function writeRow(
  w: NodeWriter, g: SlottedGadget,
  mainAt: (index: number) => Items | null, sourceAt: (index: number) => ISourceData | null,
): void {
  const s = w.nextSlot();
  for (const i of g.inputs) {
    s.main[i.index] = mainAt(i.index);
    s.source[i.index] = sourceAt(i.index);
  }
}

/** The stack entries among one slot's cells, in input order. */
function entryCellsOf(cells: ReadonlyArray<Cell | undefined>): EntryCell[] {
  return cells.flatMap((c): EntryCell[] => c !== undefined && isEntryPayload(c.value) ? [{ value: c.value, place: c.place }] : []);
}

/** An entry-headed slot: the entry verbatim (stranded: its data as a row); two different entries cannot pair. */
function encodeEntrySlot(w: NodeWriter, g: SlottedGadget, j: number, head: EntryCell, entries: readonly EntryCell[]): void {
  const e = head.value.executionData;
  if (entries.some((c) => c.value.executionData !== e)) {
    throw new CodecError(`node '${g.node}': slot ${j} pairs two different stack entries ('${entries.map((c) => c.place.name).join("', '")}')`);
  }
  if (w.mode !== 'stranded') {
    w.push(e);
    return;
  }
  w.diag(`node '${g.node}': stranded entry on '${head.place.name}' (divergence #2); written to waitingExecution`);
  writeRow(w, g, (index) => e.data.main?.[index] ?? null, (index) => e.source?.main?.[index] ?? null);
}

/** A slot of edge payloads and empties: n8n's `allDataFound` stack entry when complete with data, else a row. */
function encodeArrivalSlot(w: NodeWriter, g: SlottedGadget, cells: ReadonlyArray<Cell | undefined>): void {
  const inputCount = inputCountOf(w.compiled, g);
  const main: SlotMain = Array.from({ length: inputCount }, () => null);
  const sources: SlotSource = Array.from({ length: inputCount }, () => null);
  let anyData = false;
  g.inputs.forEach((i, k) => {
    const c = cells[k];
    if (c === undefined) return;
    if (isEdgePayload(c.value)) {
      main[i.index] = c.value.items;
      sources[i.index] = c.value.source;
      anyData = true;
    } else {
      main[i.index] = []; // an empty token: n8n's "arrived empty"
    }
    if (w.mode === 'stranded') w.diag(`node '${g.node}': stranded token on '${c.place.name}' input ${i.index} (divergence #2); written to waitingExecution`);
  });
  const complete = cells.every((c) => c !== undefined);
  if (complete && anyData && w.mode !== 'stranded') {
    // n8n's `allDataFound`: the node goes on the stack with the slot as its data.
    w.push({ node: w.liveNode(), data: { main }, source: { main: sources } });
    return;
  }
  // Partial, or complete without data: the latter is a skip (`X_skip`, only seen under
  // `cancelled`), which n8n's R6 drops from `waitingExecution` and decode restores;
  // a stack entry would run the node on empties.
  writeRow(w, g, (index) => main[index] ?? null, (index) => sources[index] ?? null);
}

/** Slot `j` across the per-input queues: entry-headed, or edge payloads and empties. */
function encodeSlot(w: NodeWriter, g: SlottedGadget, j: number, cells: ReadonlyArray<Cell | undefined>): void {
  const entries = entryCellsOf(cells);
  const head = entries[0];
  if (head !== undefined) encodeEntrySlot(w, g, j, head, entries);
  else encodeArrivalSlot(w, g, cells);
}

/**
 * A slotted node's positional slots over the per-input queues: a complete slot with data is
 * n8n's `allDataFound` stack entry, an entry-headed slot the entry verbatim, anything else a
 * `waitingExecution` row.
 */
export function encodeJoin(w: NodeWriter, g: SlottedGadget, routedHere: readonly RoutedArrival[]): void {
  assertRoutedOnInputs(g, routedHere);
  const queues = g.inputs.map((i): InputQueue => ({ input: i, cells: joinQueue(w, g, i, routedHere) }));
  if (holdsOnlySeeds(queues)) {
    // Nothing but the seeded empties of inputs fed by unreachable producers:
    // `sharedMarking()` re-seeds them on decode, and n8n never had them. (With anything
    // else queued the seed is written as `[]` in its row, so positions are kept.)
    if (w.mode === 'stranded') {
      w.diag(`node '${g.node}': join never completed; only the seeded empty of input ` +
        `${queues.filter((q) => q.cells.length > 0 && q.input.seedEmpty).map((q) => q.input.index).join(', ')} (unreachable producers) arrived; not written`);
    }
    return;
  }
  const depth = Math.max(0, ...queues.map((q) => q.cells.length));
  for (let j = 0; j < depth; j++) encodeSlot(w, g, j, queues.map((q) => q.cells[j]));
}
