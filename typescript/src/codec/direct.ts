/**
 * Direct-form nodes (one `X/in`, with `X/in_empty` beside it where the edge can carry an
 * empty) in both directions. n8n keeps a pending arrival as an ordinary stack entry and never
 * writes a single-input node to `waitingExecution`; the stranded encoder does (divergence #2).
 *
 * Decode ({@link decodeDirectRow}) places such a row back on `X/in` / `X/in_empty` (a stack
 * entry goes straight onto `X/in`, in `decode.ts`). Encode ({@link encodeDirect}) writes the
 * pending arrivals as stack entries, or as rows when stranded.
 */
import { tokenOf } from 'libpetri';
import type { CompiledWorkflow, DirectGadget } from '../compiler/index.js';
import { unit } from '../internal/tokens.js';
import { CodecError } from './errors.js';
import { assertDirectArrival, type RoutedArrival } from './routed.js';
import { add, directInputIndex, edgePayload, type MarkingMap, type WaitingRow } from './shared.js';
import type { Cell, NodeWriter } from './writer.js';

// ==================== decode ====================

/**
 * A `waitingExecution` row of a direct-form node. n8n never writes a single-input node here;
 * the stranded encoder does (divergence #2). Items go on `X/in`, `[]` on `X/in_empty`; a `[]`
 * for an input with no empty place is the same impossibility a join input refuses.
 */
export function decodeDirectRow(
  compiled: CompiledWorkflow, g: DirectGadget, row: WaitingRow, marking: MarkingMap, pendingNodes: Set<string>,
): void {
  const index = directInputIndex(compiled, g);
  row.foreign((idx) => idx === index);
  const v = row.valueAt(index);
  if (v === null) return;
  pendingNodes.add(g.node);
  if (v.length > 0) add(marking, g.in, tokenOf<unknown>(edgePayload(v, row.sourceAt(index))));
  else if (g.inEmpty !== null) add(marking, g.inEmpty, unit());
  else {
    throw new CodecError(
      `node '${g.node}' input ${index}: waitingExecution[${row.k}] holds [] but '${g.in.name}' has no empty place ` +
      `beside it (a cycle edge or a synthetic input cannot carry an empty)`);
  }
}

// ==================== encode ====================

/**
 * A direct-form node's pending arrivals, `X/in` then the routed ones, as stack entries
 * (stranded: rows). A pending empty is dropped with a report: n8n never enqueues one.
 */
export function encodeDirect(w: NodeWriter, g: DirectGadget, routedHere: readonly RoutedArrival[]): void {
  const { compiled, marking, mode } = w;
  for (const r of routedHere) assertDirectArrival(compiled, g, r);
  const inputIndex = directInputIndex(compiled, g);
  const arrivals: Cell[] = [
    ...marking.peekTokens(g.in).map((t): Cell => ({ value: t.value, place: g.in })),
    ...routedHere.filter((r) => r.payload !== null).map((r): Cell => ({ value: r.payload, place: g.in })),
  ];
  for (const a of arrivals) {
    const e = w.entryOf(inputIndex, a.value, a.place);
    if (e === null) continue;
    if (mode === 'stranded') w.strand(inputIndex, e, a.place);
    else w.push(e);
  }
  if (g.inEmpty !== null && marking.tokenCount(g.inEmpty) > 0) {
    w.diag(`node '${g.node}': ${marking.tokenCount(g.inEmpty)} pending empty token(s) on '${g.inEmpty.name}'; n8n never enqueues an empty, dropped`);
  }
}
