/**
 * The transitions that take the success outcome ({@link succeed}): `X_run`, the per-output
 * `X_route_o`, `X_exhausted`, and `X_done`'s budget refund one cycle after the run (ADR 0004).
 */
import type { TransitionAction } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import type { NetMapView, NodeGadget, RouteTransition } from '../types.js';
import { routeOutput, succeed, type RoutingPolicy } from './routing.js';

export function runAction(g: NodeGadget, policy: RoutingPolicy, map: NetMapView): TransitionAction {
  return async (ctx) => {
    succeed(ctx, g, policy, ctx.input(g.running), map);
    ctx.output(g.idle, null);
  };
}

/**
 * `A_run_failed`: the placeholder for an agent's budget-exceeded re-entry. It reads the
 * re-entry off `A/running_failed` and takes the success outcome like any placeholder run; the
 * scheduler's own action fails the activation instead. Its out spec has no request branch.
 */
export function runFailedAction(g: NodeGadget, policy: RoutingPolicy, map: NetMapView): TransitionAction {
  if (g.agent === null) throw new InternalCompilerError(`internal: node '${g.node}' has a run-failed transition but no agent side`);
  const runningFailed = g.agent.runningFailed;
  return async (ctx) => {
    succeed(ctx, g, policy, ctx.input(runningFailed), map);
    ctx.output(g.idle, null);
  };
}

/** Per-output routing only (`routing.kind === 'split'`): `X_route_o` drains one `X/ok_o`. */
export function routeAction(g: NodeGadget, info: RouteTransition, policy: RoutingPolicy): TransitionAction {
  if (g.routing.kind !== 'split') throw new InternalCompilerError(`internal: node '${g.node}' has a route transition but routes in X_run`);
  const out = g.routing.outputs.find((o) => o.index === info.port);
  if (out === undefined) throw new InternalCompilerError(`internal: node '${g.node}' has no output ${info.port} for '${info.name}'`);
  return async (ctx) => {
    routeOutput(ctx, g, out, policy(g, out), ctx.input(out.ok));
    ctx.output(out.routed, null);
  };
}

export function doneAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    ctx.output(map.shared.budget, null);
    ctx.output(g.done, null);
  };
}

export function exhaustedAction(g: NodeGadget, policy: RoutingPolicy, map: NetMapView): TransitionAction {
  const { retry } = g;
  if (retry === null) throw new InternalCompilerError(`internal: node '${g.node}' has an exhausted transition but no retry gadget`);
  return async (ctx) => {
    succeed(ctx, g, policy, ctx.input(retry.retry), map);
  };
}
