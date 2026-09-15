/**
 * Join slots, the encoder's read side: the positional queue of every join input as it stands
 * in the marking ({@link joinQueue}), and the one queue content that is not written back —
 * nothing but the seeded empties of inputs fed by unreachable producers ({@link holdsOnlySeeds}).
 */
import type { Place } from 'libpetri';
import { readyPlacesOf, type SlottedGadget } from '../compiler/index.js';
import { isEdgePayload, isEntryPayload } from '../scheduler/payloads.js';
import type { JoinInput } from './join-decode.js';
import { slotOfArrival, type RoutedArrival } from './routed.js';
import type { Cell, NodeWriter } from './writer.js';

/** One join input and its positional queue. */
export interface InputQueue {
  readonly input: JoinInput;
  readonly cells: readonly Cell[];
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

/** Something is queued, and all of it is the seeded empties of inputs fed by unreachable producers. */
export function holdsOnlySeeds(queues: readonly InputQueue[]): boolean {
  return queues.some((q) => q.cells.length > 0) && queues.every((q) => q.cells.every((c) => isSeed(q.input, c)));
}

/**
 * The positional queue of one join input: the `ready` head, then the edge places in
 * canonical order (per edge `data` before `empty`), then routed arrivals. That is the order
 * the arms fire in when `free_i` returns to simultaneously waiting arrivals (equal priority,
 * declaration order), so it is also the pairing a resumed net produces for them. A token
 * that is no arrival is a foreign shape: reported by node and place and left out of the queue.
 */
export function joinQueue(w: NodeWriter, g: SlottedGadget, i: JoinInput, routedHere: readonly RoutedArrival[]): Cell[] {
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
