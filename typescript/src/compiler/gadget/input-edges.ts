/**
 * The producer edges of a modelled input, shared by the OR, join and choose-branch forms: each
 * edge's data (and, for a tree edge, empty) place as an input port bound to the consumer-owned
 * host slot (MOD-020), and the common input fields derived from them.
 */
import type { EdgeRef } from '../types.js';
import { edgeInPortOf, emptyTwinOf } from '../names.js';
import { boundPort } from './builder.js';
import type { GadgetContext } from './context.js';
import { hostSlotOf } from './facts.js';
import type { LocalEdge, LocalInputCommon } from './local-shapes.js';

/** One producer edge of input `i` as local places, its host places declared and mapped. */
function declareInputEdge(ctx: GadgetContext, i: number, e: EdgeRef): LocalEdge {
  const slot = hostSlotOf(ctx, e);
  const dataPort = edgeInPortOf(i, e.id);
  const data = boundPort(ctx, dataPort, slot.data, 'input');
  ctx.hostOwned(slot.data.name, 'edge-data', i, { edge: e });
  if (slot.empty === null) return { edge: e, data, empty: null, host: slot };
  const empty = boundPort(ctx, emptyTwinOf(dataPort), slot.empty, 'input');
  ctx.hostOwned(slot.empty.name, 'edge-empty', i, { edge: e });
  return { edge: e, data, empty, host: slot };
}

/** The common fields of input `i`, its producer edges declared in edge order. */
export function inputCommon(ctx: GadgetContext, i: number): LocalInputCommon {
  const { analysis, reachable, required } = ctx;
  const producers = ctx.incoming.filter((e) => e.inputIndex === i);
  const edges = producers.map((e) => declareInputEdge(ctx, i, e));
  const wired = edges.length > 0;
  const allUnreachable = producers.every((e) => !analysis.reachable.has(e.from));
  return {
    index: i, edges, wired, required: required.has(i),
    emptyCapable: edges.some((e) => e.empty !== null),
    seedEmpty: reachable && wired && allUnreachable,
    unreachableEdges: edges.filter((e) => e.empty !== null && !analysis.reachable.has(e.edge.from)).length,
  };
}

/** Modelled input indexes, ascending: connected ones plus dead required ones. */
export function inputIndexes(ctx: GadgetContext): number[] {
  return [...new Set([...ctx.incoming.map((e) => e.inputIndex), ...ctx.a.deadInputs])].sort((x, y) => x - y);
}
