/**
 * Join slots, decode half ({@link JoinQueues}): collects every input's arrivals positionally
 * — stack entries (the entry heads input 0, a unit companion every other input), then the
 * rows in ascending `k` — and materialises them once all are read: the head takes the `ready`
 * place and withholds `free_i`, every later arrival queues on the input's first edge place,
 * behind `free_i`, as a live second arrival would (ADR 0003).
 */
import { tokenOf, type Place, type Token } from 'libpetri';
import {
  CompileError, readyPlacesOf, readySlot,
  type ReadyInput, type SlottedGadget, type SplitReadyInput, type Variant,
} from '../compiler/index.js';
import { messageOf } from '../internal/errors.js';
import { unit } from '../internal/tokens.js';
import { CodecError } from './errors.js';
import { add, edgePayload, type MarkingMap, type WaitingRow } from './shared.js';

/** A join input: the two slot shapes a positional queue is read from. */
export type JoinInput = ReadyInput | SplitReadyInput;

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

/**
 * Where an arrival behind the head queues: a data arrival on the input's first edge place, an
 * empty on the first `empty` place — a {@link CodecError} naming the head's place when the
 * input has no such edge.
 */
function queuePlaceOf(g: SlottedGadget, i: JoinInput, headPlace: Place<unknown>, a: JoinArrival): Place<unknown> {
  const empty = a.kind === 'empty';
  const place = empty ? (i.edges.find((e) => e.empty !== null)?.empty ?? null) : (i.edges[0]?.data ?? null);
  if (place !== null) return place;
  throw new CodecError(
    `node '${g.node}' input ${i.index}: a second pending ${empty ? 'empty' : 'arrival'} cannot queue ` +
    `behind '${headPlace.name}' (the input has no ${empty ? 'empty-capable ' : ''}producer edge)`);
}

/** One input's queue: the head takes the slot, the rest queue behind `free_i`. */
function materialiseInput(marking: MarkingMap, g: SlottedGadget, i: JoinInput, q: readonly JoinArrival[]): void {
  const [head, ...rest] = q;
  if (head === undefined) return;
  // The decoded head replaces the seeded empty of an unreachable input and withholds free_i.
  marking.delete(i.free);
  for (const p of readyPlacesOf(i)) marking.delete(p);
  const headPlace = slotPlace(g, i, head.kind === 'empty' ? 'empty' : 'data');
  add(marking, headPlace, tokenOfArrival(head));
  if (g.form === 'join' && (head.kind === 'data' || head.kind === 'entry')) add(marking, g.hasdata, unit());
  for (const a of rest) add(marking, queuePlaceOf(g, i, headPlace, a), tokenOfArrival(a));
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
        if (q !== undefined) materialiseInput(marking, g, i, q);
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
