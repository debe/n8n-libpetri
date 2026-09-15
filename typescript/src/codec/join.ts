/**
 * Join slots (README "Join gadget") in both directions, for the two slotted forms — the
 * generic join and choose-branch. Each input is a `free_i` / `ready_i` slot; n8n keeps a
 * partial slot as a `waitingExecution[X][k]` row and a complete one as a stack entry.
 *
 * Decode ({@link JoinQueues}) collects every input's arrivals positionally — stack entries
 * (the entry heads input 0, a unit companion every other input), then the rows in ascending
 * `k` — and materialises them once all are read: the head takes the `ready` place and
 * withholds `free_i`, every later arrival queues on the input's first edge place, behind
 * `free_i`, as a live second arrival would (ADR 0003). Encode ({@link encodeJoin}) reads the
 * same positional queues back out of the marking and pairs them into rows and entries.
 */
import { tokenOf, type Place, type Token } from 'libpetri';
import {
  CompileError, readyPlacesOf, readySlot,
  type ReadyInput, type SlottedGadget, type SplitReadyInput, type Variant,
} from '../compiler/index.js';
import { messageOf } from '../internal/errors.js';
import { unit } from '../internal/tokens.js';
import { isEdgePayload, isEntryPayload, type EntryPayload } from '../scheduler/payloads.js';
import { CodecError } from './errors.js';
import { slotOfArrival, unmatchedArrival, type RoutedArrival } from './routed.js';
import { add, edgePayload, inputCountOf, type MarkingMap, type SlotMain, type SlotSource, type WaitingRow } from './shared.js';
import type { Cell, NodeWriter } from './writer.js';

/** A join input: the two slot shapes a positional queue is read from. */
export type JoinInput = ReadyInput | SplitReadyInput;

// ==================== decode ====================

/** One arrival of a join input's positional queue, before it is placed. */
type JoinArrival =
  | { readonly kind: 'entry'; readonly token: Token<unknown> }
  | { readonly kind: 'companion' }
  | { readonly kind: 'data'; readonly token: Token<unknown> }
  | { readonly kind: 'empty' };

function tokenOfArrival(a: JoinArrival): Token<unknown> {
  return a.kind === 'entry' || a.kind === 'data' ? a.token : unit();
}

/**
 * `readySlot` as a codec error: the variant has no place on this input, so the data and the
 * compiled net disagree. The compiler's message names the missing place.
 */
function slotPlace(g: SlottedGadget, i: JoinInput, variant: Variant): Place<unknown> {
  try {
    return readySlot(g, i, variant);
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    throw new CodecError(`node '${g.node}' input ${i.index} cannot receive an ${variant} arrival (${messageOf(error)})`);
  }
}

/** The positional arrivals of every join input one decode reads, placed by {@link JoinQueues.materialise}. */
export class JoinQueues {
  private readonly queues = new Map<SlottedGadget, Map<number, JoinArrival[]>>();

  enqueue(g: SlottedGadget, i: JoinInput, arrival: JoinArrival): void {
    let queues = this.queues.get(g);
    if (queues === undefined) this.queues.set(g, (queues = new Map()));
    const q = queues.get(i.index);
    if (q === undefined) queues.set(i.index, [arrival]);
    else q.push(arrival);
  }

  /** The head takes the slot, the rest queue behind `free_i`. */
  materialise(marking: MarkingMap): void {
    for (const [g, queues] of this.queues) {
      for (const i of g.inputs) {
        const q = queues.get(i.index);
        const head = q?.[0];
        if (q === undefined || head === undefined) continue;
        // The decoded head replaces the seeded empty of an unreachable input and withholds free_i.
        marking.delete(i.free);
        for (const p of readyPlacesOf(i)) marking.delete(p);
        const headPlace = slotPlace(g, i, head.kind === 'empty' ? 'empty' : 'data');
        add(marking, headPlace, tokenOfArrival(head));
        if (g.form === 'join' && (head.kind === 'data' || head.kind === 'entry')) add(marking, g.hasdata, unit());
        for (const a of q.slice(1)) {
          const place = a.kind === 'empty' ? (i.edges.find((e) => e.empty !== null)?.empty ?? null) : (i.edges[0]?.data ?? null);
          if (place === null) {
            throw new CodecError(
              `node '${g.node}' input ${i.index}: a second pending ${a.kind === 'empty' ? 'empty' : 'arrival'} cannot queue ` +
              `behind '${headPlace.name}' (the input has no ${a.kind === 'empty' ? 'empty-capable ' : ''}producer edge)`);
          }
          add(marking, place, tokenOfArrival(a));
        }
      }
    }
  }
}

/**
 * A stack entry of a slotted node. n8n runs an entry unconditionally: the entry heads the
 * first input's slot and every other input takes a unit companion on its data slot, so
 * `X_start` fires and the start action passes the entry through (`startInput`).
 */
export function decodeJoinEntry(g: SlottedGadget, token: Token<unknown>, joins: JoinQueues): void {
  g.inputs.forEach((i, k) => joins.enqueue(g, i, k === 0 ? { kind: 'entry', token } : { kind: 'companion' }));
}

/** A `waitingExecution` row of a slotted node: one arrival per input that has one, `[]` an arrived empty. */
export function decodeJoinRow(g: SlottedGadget, row: WaitingRow, joins: JoinQueues, pendingNodes: Set<string>): void {
  row.foreign((idx) => g.inputs.some((i) => i.index === idx));
  let any = false;
  for (const i of g.inputs) {
    const v = row.valueAt(i.index);
    if (v === null) continue;
    any = true;
    joins.enqueue(g, i, v.length > 0 ? { kind: 'data', token: tokenOf<unknown>(edgePayload(v, row.sourceAt(i.index))) } : { kind: 'empty' });
  }
  if (any) pendingNodes.add(g.node);
}

// ==================== encode ====================

/** A {@link Cell} whose token is a stack entry: the head of an entry-headed slot. */
interface EntryCell extends Cell {
  readonly value: EntryPayload;
}

/** A value a join place holds: an edge payload, a stack entry, or an empty (a unit token). */
function isArrival(v: unknown): boolean {
  return v === null || v === undefined || isEdgePayload(v) || isEntryPayload(v);
}

/** A unit token on the `ready` place of an input whose producers are all unreachable: the shared marking's seed. */
function isSeed(i: JoinInput, c: Cell): boolean {
  const seedPlace = i.slot === 'ready' ? i.ready : i.readyEmpty;
  return i.seedEmpty && !isEdgePayload(c.value) && !isEntryPayload(c.value) && c.place === seedPlace;
}

/**
 * The positional queue of one join input: the `ready` head, then the edge places in
 * canonical order (per edge `data` before `empty`), then routed arrivals. That is the order
 * the arms fire in when `free_i` returns to simultaneously waiting arrivals (equal priority,
 * declaration order), so it is also the pairing a resumed net produces for them. A token
 * that is no arrival is a foreign shape: reported by node and place and left out of the queue.
 */
function joinQueue(w: NodeWriter, g: SlottedGadget, i: JoinInput, routedHere: readonly RoutedArrival[]): Cell[] {
  const q: Cell[] = [];
  const read = (p: Place<unknown>): void => {
    for (const t of w.marking.peekTokens(p)) {
      if (isArrival(t.value)) q.push({ value: t.value, place: p });
      else w.diag(`node '${g.node}': token on '${p.name}' carries no arrival; dropped`);
    }
  };
  for (const p of readyPlacesOf(i)) read(p);
  for (const e of i.edges) {
    read(e.data);
    if (e.empty !== null) read(e.empty);
  }
  for (const r of routedHere) {
    if (r.edge.inputIndex !== i.index) continue;
    const e = slotOfArrival(g, i, r);
    q.push({ value: r.payload, place: r.payload === null ? (e.empty ?? e.data) : e.data });
  }
  return q;
}

/**
 * A slotted node's positional slots over the per-input queues: a complete slot with data is
 * n8n's `allDataFound` stack entry, an entry-headed slot the entry verbatim, anything else a
 * `waitingExecution` row.
 */
export function encodeJoin(w: NodeWriter, g: SlottedGadget, routedHere: readonly RoutedArrival[]): void {
  const { compiled, mode } = w;
  // An arrival routed onto an input the gadget does not model has no slot to wait in.
  for (const r of routedHere) {
    if (!g.inputs.some((i) => i.index === r.edge.inputIndex)) throw unmatchedArrival(g, r.edge.inputIndex, r);
  }
  const queues = g.inputs.map((i) => ({ input: i, cells: joinQueue(w, g, i, routedHere) }));
  if (queues.some((q) => q.cells.length > 0) && queues.every((q) => q.cells.every((c) => isSeed(q.input, c)))) {
    // Nothing but the seeded empties of inputs fed by unreachable producers:
    // `sharedMarking()` re-seeds them on decode, and n8n never had them. (With anything
    // else queued the seed is written as `[]` in its row, so positions are kept.)
    if (mode === 'stranded') {
      w.diag(`node '${g.node}': join never completed; only the seeded empty of input ` +
        `${queues.filter((q) => q.cells.length > 0 && q.input.seedEmpty).map((q) => q.input.index).join(', ')} (unreachable producers) arrived; not written`);
    }
    return;
  }
  const depth = Math.max(0, ...queues.map((q) => q.cells.length));
  for (let j = 0; j < depth; j++) {
    const cells = queues.map((q) => q.cells[j]);
    const entries = cells.flatMap((c): EntryCell[] => c !== undefined && isEntryPayload(c.value) ? [{ value: c.value, place: c.place }] : []);
    const head = entries[0];
    if (head !== undefined) {
      const e = head.value.executionData;
      if (entries.some((c) => c.value.executionData !== e)) {
        throw new CodecError(`node '${g.node}': slot ${j} pairs two different stack entries ('${entries.map((c) => c.place.name).join("', '")}')`);
      }
      if (mode === 'stranded') {
        w.diag(`node '${g.node}': stranded entry on '${head.place.name}' (divergence #2); written to waitingExecution`);
        const s = w.nextSlot();
        for (const i of g.inputs) {
          s.main[i.index] = e.data.main?.[i.index] ?? null;
          s.source[i.index] = e.source?.main?.[i.index] ?? null;
        }
      } else {
        w.push(e);
      }
      continue;
    }
    const complete = cells.every((c) => c !== undefined);
    const inputCount = inputCountOf(compiled, g);
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
      if (mode === 'stranded') w.diag(`node '${g.node}': stranded token on '${c.place.name}' input ${i.index} (divergence #2); written to waitingExecution`);
    });
    if (complete && anyData && mode !== 'stranded') {
      // n8n's `allDataFound`: the node goes on the stack with the slot as its data.
      w.push({ node: w.liveNode(), data: { main }, source: { main: sources } });
    } else {
      // Partial, or complete without data: the latter is a skip (`X_skip`, only seen under
      // `cancelled`), which n8n's R6 drops from `waitingExecution` and decode restores;
      // a stack entry would run the node on empties.
      const s = w.nextSlot();
      for (const i of g.inputs) {
        s.main[i.index] = main[i.index] ?? null;
        s.source[i.index] = sources[i.index] ?? null;
      }
    }
  }
}
