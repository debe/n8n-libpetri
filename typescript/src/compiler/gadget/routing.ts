/**
 * The delivery of a routed outcome (README "Per-node gadget", ADR 0004): `X_route_o` per
 * connected output under the split shape, `X_done` — the budget refund, one scheduling cycle
 * after the edge tokens land (see `SPLIT_ROUTING_ABOVE`) — and one sink per `nil` place.
 */
import { Transition, and, one, outPlace } from 'libpetri';
import type { Out } from 'libpetri';
import { TRANSITION, routeOf, sinkOf } from '../names.js';
import type { GadgetContext } from './context.js';
import type { LocalOutput, LocalRouting } from './local-shapes.js';
import type { Markers, SharedPorts } from './ports.js';

/** `X_route_o` per connected output under the split shape, and `X_done`. */
export function buildRouteAndDone(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  routing: LocalRouting,
  routingOf: (out: LocalOutput) => Out,
): { readonly routeNames: readonly string[]; readonly doneName: string } {
  const { depth, emit } = ctx;

  // ---- X_route_o (split shape only) and X_done: the budget refund, one cycle later ----
  const routeNames = routing.kind !== 'split' ? [] : routing.outputs.map((out) => emit(Transition.builder(routeOf(out.index))
    .inputs(one(out.ok))
    .outputs(and(routingOf(out), outPlace(out.routed)))
    .priority(depth + 1).build(), { role: 'route', port: out.index }));
  const doneName = emit(Transition.builder(TRANSITION.done)
    .inputs(...(routing.kind === 'split' ? routing.outputs.map((o) => one(o.routed)) : [one(routing.routed)]))
    .outputs(and(outPlace(shared.budget), outPlace(markers.done)))
    .priority(depth + 1).build(), { role: 'done' });
  return { routeNames, doneName };
}

/** One sink per `nil` place (CORE-043 AC4: genuine sinks carry no Out spec). */
export function buildSinks(ctx: GadgetContext, outputs: readonly LocalOutput[]): readonly string[] {
  const sinkNames: string[] = [];
  for (const out of outputs) {
    if (out.nil === null) continue;
    sinkNames.push(ctx.emit(Transition.builder(sinkOf(out.index)).inputs(one(out.nil)).priority(ctx.depth).build(), { role: 'sink' }));
  }
  return sinkNames;
}
