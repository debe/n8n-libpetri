/**
 * Arrivals routed by the encoder (`cancelled` only): the tokens a `close()` caught on a
 * per-output routing node's `X/ok_o`, between `X_run` and `X_route_o`, turned into the
 * arrivals `X_route_o` would have deposited on each consumer's input.
 *
 * Every input form places them through one match, {@link slotOfArrival} (and
 * {@link assertDirectArrival} for the direct form's single edge): an arrival over an edge
 * the consumer does not carry is a structural impossibility and a {@link CodecError}, in
 * every form — never a fallback onto some other place of the consumer.
 */
import type { Marking, Place } from 'libpetri';
import type { CompiledWorkflow, DirectGadget, EdgeRef, EdgeSlot, InputGadget, NodeGadget } from '../compiler/index.js';
import { isOkPayload, type EdgePayload } from '../scheduler/payloads.js';
import { CodecError } from './errors.js';
import { directInputIndex, type Diagnostic } from './shared.js';

/** An arrival a token on `X/ok_o` (routed by the encoder) adds to a consumer's input. */
export interface RoutedArrival {
  /** The edge it travels: `inputIndex` and `id` are what the consumer's input pairs it on. */
  readonly edge: EdgeRef;
  /** `null`: the output was empty (the consumer's `empty` place would have received a unit). */
  readonly payload: EdgePayload | null;
  /** The `X/ok_o` place the token was read from, named when the consumer cannot place the arrival. */
  readonly ok: Place<unknown>;
}

/**
 * A routed arrival over an edge the consumer's input does not carry. Producer and consumer
 * gadgets are cut from one analysis, so a compile never produces the pair; dropping the
 * arrival would lose its items from the execution, so it is refused by node, edge and place.
 */
export function unmatchedArrival(g: NodeGadget, inputIndex: number, r: RoutedArrival): CodecError {
  const e = r.edge;
  return new CodecError(
    `node '${g.node}' input ${inputIndex}: an arrival routed from '${r.ok.name}' over edge #${e.id} ` +
    `(${e.from}.${e.outputIndex} -> ${e.to}.${e.inputIndex}) matches none of the input's edges`);
}

/** The edge slot of a join or OR input that `r` travels; {@link unmatchedArrival} when the input does not carry it. */
export function slotOfArrival(g: NodeGadget, i: InputGadget, r: RoutedArrival): EdgeSlot {
  const e = i.edges.find((s) => s.edge.id === r.edge.id);
  if (e === undefined) throw unmatchedArrival(g, i.index, r);
  return e;
}

/** A direct-form node's `X/in` serves one edge: {@link unmatchedArrival} for an arrival over any other. */
export function assertDirectArrival(compiled: CompiledWorkflow, g: DirectGadget, r: RoutedArrival): void {
  if (compiled.netMap.place(g.in.name)?.edge?.id !== r.edge.id) throw unmatchedArrival(g, directInputIndex(compiled, g), r);
}

/**
 * The arrivals the tokens still on `X/ok_o` (`close()` stopped a **per-output routing** node
 * between `X_run` and `X_route_o`) would have produced, per consumer, in canonical edge
 * order — where n8n's `addNodeToBeExecuted` had put them before the next iteration's
 * cancellation check.
 *
 * Only a node above {@link SPLIT_ROUTING_ABOVE} has such a place: everywhere else `X_run`
 * deposits the edge tokens itself, so a cancellation catches them already on the consumer's
 * edge places, where `joinQueue` and the direct-form arrival list read them. A token on
 * `X/ok_o` that carries no ok payload is a foreign token shape: reported and skipped.
 */
export function collectRouted(marking: Marking, nodes: readonly NodeGadget[], diag: Diagnostic): Map<string, RoutedArrival[]> {
  const routed = new Map<string, RoutedArrival[]>();
  for (const g of nodes) {
    if (g.routing.kind !== 'split') continue;
    const okTokens = g.routing.outputs.flatMap((o) => marking.peekTokens(o.ok).map((t) => ({ t, outputs: [o] })));
    for (const { t, outputs } of okTokens) {
      const v = t.value;
      if (!isOkPayload(v)) {
        diag(`node '${g.node}': token on '${outputs.map((o) => o.ok.name).join("', '")}' carries no ok payload; dropped`);
        continue;
      }
      for (const out of outputs) {
        const items = v.nodeSuccessData[out.index];
        const payload: EdgePayload | null = items !== undefined && items !== null && items.length !== 0
          ? { kind: 'edge', items, source: { previousNode: g.node, previousNodeOutput: out.index, previousNodeRun: v.runIndex } }
          : null;
        if (payload === null && out.nil !== null) continue; // a cycle edge carries nothing on nil
        for (const e of out.edges) {
          const list = routed.get(e.edge.to) ?? [];
          list.push({ edge: e.edge, payload, ok: out.ok });
          routed.set(e.edge.to, list);
        }
      }
    }
  }
  for (const list of routed.values()) list.sort((a, b) => a.edge.id - b.edge.id);
  return routed;
}
