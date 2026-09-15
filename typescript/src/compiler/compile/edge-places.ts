/**
 * The host places `compile()` creates before composition for the consumer side of every edge.
 *
 * Consumer-owned edge places, named after the consumer port they bind to (`names.ts`). The
 * direct form names them `X/in` / `X/in_empty` (README); a join input names them per edge.
 * Cycle edges carry no empty place (emission rule). A node with no producer gets a synthetic
 * `X/in` (the start node's trigger data lands there).
 */
import { place } from 'libpetri';
import type { Place } from 'libpetri';
import { consumerPortOf, emptyTwinOf, inPlaceOf, qualified } from '../names.js';
import type { AnalysedNode, EdgeRef, EdgeSlot, WorkflowAnalysis } from '../types.js';

export interface HostEdgePlaces {
  /** Edge id → the consumer's `data` place and, for a tree edge, its `empty` twin. */
  readonly edgeSlots: ReadonlyMap<number, EdgeSlot>;
  /** Node name → the synthetic `X/in` of a node with no producer. */
  readonly syntheticIn: ReadonlyMap<string, Place<unknown>>;
}

/** The consumer-owned places of one incoming edge `e` of node `a`. */
function edgeSlotOf(a: AnalysedNode, e: EdgeRef): EdgeSlot {
  const port = consumerPortOf(a.form === 'direct', e.inputIndex, e.id);
  return {
    edge: e,
    data: place<unknown>(qualified(a.node.id, port)),
    empty: e.kind === 'tree' ? place<unknown>(qualified(a.node.id, emptyTwinOf(port))) : null,
  };
}

/** Every consumer-owned edge place and synthetic `X/in` of the workflow, in canvas order. */
export function hostEdgePlaces(analysis: WorkflowAnalysis): HostEdgePlaces {
  const edgeSlots = new Map<number, EdgeSlot>();
  const syntheticIn = new Map<string, Place<unknown>>();
  for (const a of analysis.nodes) {
    // A tool node has no main producer *and* no synthetic in: an agent's `A_dispatch` writes
    // its `T/in_tool` instead, so a synthetic `X/in` would be an orphan nothing ever seeds.
    if (a.isTool) continue;
    const incoming = analysis.incoming.get(a.node.name) ?? [];
    if (incoming.length === 0) {
      syntheticIn.set(a.node.name, place<unknown>(inPlaceOf(a.node.id)));
      continue;
    }
    for (const e of incoming) edgeSlots.set(e.id, edgeSlotOf(a, e));
  }
  return { edgeSlots, syntheticIn };
}
