/**
 * The host places `compile()` creates before composition for the consumer side of every edge:
 * {@link hostEdgePlaces} for a v1 net, {@link v2EdgePlaces} for an `engineV2` one.
 *
 * Consumer-owned edge places, named after the consumer port they bind to (`names.ts`). The
 * direct form names them `X/in` / `X/in_empty` (README); a join input names them per edge.
 * Cycle edges carry no empty place (emission rule). A node with no producer gets a synthetic
 * `X/in` (the start node's trigger data lands there).
 */
import { place } from 'libpetri';
import type { Place } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import { arrivedPlaceOf, consumerPortOf, emptyTwinOf, inPlaceOf, livePlaceOf, qualified } from '../names.js';
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

/** The host places of an `engineV2` net (`tasks/v2-profile-plan.md` decision 3). */
export interface SettlementHostPlaces {
  /** Edge id → `e{id}/arrived`, for every edge into a compiled node. */
  readonly arrived: ReadonlyMap<number, Place<unknown>>;
  /** Node name → `X/live`, for every compiled node but the trigger. */
  readonly live: ReadonlyMap<string, Place<unknown>>;
  /** The trigger's synthetic arrival `T/in`, which the initial marking seeds (decision 7). */
  readonly triggerIn: Place<unknown>;
}

/**
 * Every host place of an `engineV2` net, in canvas order: an `arrived` place per edge and a
 * `live` place per compiled node, both written by the producer and consumed by the consumer, and
 * the trigger's synthetic arrival. The compiled node set is `analysis.reachable` (decision 9): an
 * edge into it comes from inside it, because an edge from a node the trigger cannot reach is
 * refused (`v2-unreachable-feeder`).
 */
export function v2EdgePlaces(analysis: WorkflowAnalysis): SettlementHostPlaces {
  const trigger = analysis.engineV2?.trigger;
  if (trigger === undefined) throw new InternalCompilerError('internal: v2EdgePlaces on an analysis without engine v2 facts');
  const arrived = new Map<number, Place<unknown>>();
  const live = new Map<string, Place<unknown>>();
  let triggerIn: Place<unknown> | null = null;
  for (const a of analysis.nodes) {
    const name = a.node.name;
    if (!analysis.reachable.has(name)) continue;
    if (name === trigger) {
      triggerIn = place<unknown>(inPlaceOf(a.node.id));
      continue;
    }
    live.set(name, place<unknown>(livePlaceOf(a.node.id)));
    for (const e of analysis.incoming.get(name) ?? []) arrived.set(e.id, place<unknown>(arrivedPlaceOf(e.id)));
  }
  if (triggerIn === null) throw new InternalCompilerError(`internal: the trigger '${trigger}' is not a compiled node`);
  return { arrived, live, triggerIn };
}
