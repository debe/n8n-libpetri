/**
 * The success outcome the placeholders write: a node's value routed down its connected outputs
 * under a {@link RoutingPolicy} — in `X_run`, or, when the node routes per output
 * ({@link SPLIT_ROUTING_ABOVE}), one `X/ok_o` per output for `X_route_o` to route. Every `xor`
 * branch it picks is selected by the places it writes (IO-015).
 */
import type { Place, TransitionContext } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import type { NetMapView, NodeGadget, OutputGadget } from '../types.js';

export type RoutingMode = 'no-data' | 'data';

/** Decides, per connected output, whether the placeholder routes the value as data or emits empty / nil. */
export type RoutingPolicy = (node: NodeGadget, output: OutputGadget) => RoutingMode;

/** Routes `value` down one connected output: as data on every edge, or as its `nil` / per-edge `empty`. */
export function routeOutput(ctx: TransitionContext, g: NodeGadget, out: OutputGadget, mode: RoutingMode, value: unknown): void {
  if (mode === 'data') {
    for (const e of out.edges) ctx.output(e.data, value);
  } else if (out.nil !== null) {
    ctx.output(out.nil, null);
  } else {
    for (const e of out.edges) {
      if (e.empty === null) throw new InternalCompilerError(`internal: acyclic producer '${g.node}' has a cycle edge`);
      ctx.output(e.empty, null);
    }
  }
}

/** The `A/response` place of `agent`, which every node a tool is wired to has by construction. */
function responseOf(map: NetMapView, agent: string): Place<unknown> {
  const owner = map.node(agent);
  if (owner.agent === null) throw new InternalCompilerError(`internal: '${agent}' is wired as an agent but compiled without an agent side`);
  return owner.agent.response;
}

/**
 * Writes the success outcome: the routing of every connected output plus `X/routed`, or —
 * under per-output routing — one `X/ok_o` per output for `X_route_o` to route.
 */
export function succeed(ctx: TransitionContext, g: NodeGadget, policy: RoutingPolicy, value: unknown, map: NetMapView): void {
  if (g.form === 'tool') {
    // A tool's output is its agent's `A/response`, not a main edge. Several agents can share a
    // tool, so the outcome is an `xor` over them; the placeholder takes the first branch, and
    // the scheduler's action reads the agent off the dispatch token.
    ctx.output(responseOf(map, g.agents[0]), value);
    if (g.routing.kind === 'split') throw new InternalCompilerError(`internal: tool '${g.node}' routes per output`);
    ctx.output(g.routing.routed, null);
    return;
  }
  if (g.routing.kind === 'split') {
    for (const out of g.routing.outputs) ctx.output(out.ok, value);
    return;
  }
  for (const out of g.routing.outputs) routeOutput(ctx, g, out, policy(g, out), value);
  ctx.output(g.routing.routed, null);
}
