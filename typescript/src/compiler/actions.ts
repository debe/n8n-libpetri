/**
 * Structural action binders. Every transition that declares an `Out` spec must carry an
 * action that produces it (CORE-043), so `compile()` binds a placeholder per role that
 * selects exactly one branch of every `xor` by the places it writes (IO-015). M2's
 * scheduler layers its real actions over these with `CompiledWorkflow.withActions()` (or
 * `CompileOptions.actions`); a binder returning `null` for a role keeps the placeholder.
 *
 * Routing is a policy per (node, connected output):
 * - `placeholderActions()` — every output takes the no-data alternative (`empty` / `nil`),
 *   so any net, cyclic ones included, quiesces (EXEC-040). The default.
 * - `forwardAllActions()` — every edge receives the consumed value as `data`. Runs an
 *   acyclic workflow end to end; a cycle never terminates under it.
 * - `routingActions(policy)` — the policy decides per output (an IF routing one way).
 *
 * All of them take the success outcome in `X_run` and `X_exhausted` — which, unless the node
 * routes per output ({@link SPLIT_ROUTING_ABOVE}), is where the routing itself happens: the
 * placeholders never halt and never retry, so the net's only decisions are the structural ones. The
 * `start-unmet` twin tags the running token with an {@link UnmetReferencePayload}, as M2's
 * action will.
 *
 * Places are addressed through the canonical objects of the flat net (`NetMap`); the
 * context resolves them by name (CORE-002), so no MOD-031 alias is involved.
 */
import type { TransitionAction, TransitionContext } from 'libpetri';
import type {
  ActionBinder, InputGadget, NetMapView, NodeGadget, OutputGadget, TransitionInfo, UnmetReferencePayload,
} from './types.js';

export type RoutingMode = 'no-data' | 'data';

/** Decides, per connected output, whether the placeholder routes the value as data or emits empty / nil. */
export type RoutingPolicy = (node: NodeGadget, output: OutputGadget) => RoutingMode;

function routeOutput(ctx: TransitionContext, g: NodeGadget, out: OutputGadget, mode: RoutingMode, value: unknown): void {
  if (mode === 'data') {
    for (const e of out.edges) ctx.output(e.data, value);
  } else if (out.nil !== null) {
    ctx.output(out.nil, null);
  } else {
    for (const e of out.edges) {
      if (e.empty === null) throw new Error(`internal: acyclic producer '${g.node}' has a cycle edge`);
      ctx.output(e.empty, null);
    }
  }
}

/** The place `X_start` consumes for input `i` (README join gadget / chooseBranch enumeration). */
function readyOf(g: NodeGadget, i: InputGadget) {
  return g.form === 'choose-branch' && i.required ? i.readyData! : i.ready!;
}

/** Consumes the start inputs and returns the value to put on `X/running`, refunding the join slots. */
function startInput(ctx: TransitionContext, g: NodeGadget): unknown {
  if (g.form === 'direct') return ctx.input(g.in!);
  if (g.form === 'or') {
    const i = g.inputs[0]!;
    ctx.output(i.ran!, null);
    return ctx.input(i.hasdata!);
  }
  const values = g.inputs.map((i) => ctx.input(readyOf(g, i)));
  for (const i of g.inputs) ctx.output(i.free!, null);
  return values;
}

function startAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    ctx.output(g.running, startInput(ctx, g));
  };
}

function startUnmetAction(g: NodeGadget, info: TransitionInfo): TransitionAction {
  const unmetReference = info.reference!;
  return async (ctx) => {
    const payload: UnmetReferencePayload = { unmetReference, input: startInput(ctx, g) };
    ctx.output(g.running, payload);
  };
}

/**
 * Writes the success outcome: the routing of every connected output plus `X/routed`, or —
 * under per-output routing — one `X/ok_o` per output for `X_route_o` to route.
 */
function succeed(ctx: TransitionContext, g: NodeGadget, policy: RoutingPolicy, value: unknown, map: NetMapView): void {
  if (g.form === 'tool') {
    // A tool's output is its agent's `A/response`, not a main edge. Several agents can share a
    // tool, so the outcome is an `xor` over them; the placeholder takes the first branch, and
    // the scheduler's action reads the agent off the dispatch token.
    ctx.output(map.node(g.agents[0]!).response!, value);
    ctx.output(g.routed!, null);
    return;
  }
  if (g.splitRouting) {
    for (const out of g.outputs) ctx.output(out.ok!, value);
    return;
  }
  for (const out of g.outputs) routeOutput(ctx, g, out, policy(g, out), value);
  ctx.output(g.routed!, null);
}

function runAction(g: NodeGadget, policy: RoutingPolicy, map: NetMapView): TransitionAction {
  return async (ctx) => {
    succeed(ctx, g, policy, ctx.input(g.running), map);
    ctx.output(g.idle, null);
  };
}

/** Per-output routing only (`splitRouting`): `X_route_o` drains one `X/ok_o`. */
function routeAction(g: NodeGadget, info: TransitionInfo, policy: RoutingPolicy): TransitionAction {
  const out = g.outputs.find((o) => o.index === info.port)!;
  return async (ctx) => {
    routeOutput(ctx, g, out, policy(g, out), ctx.input(out.ok!));
    ctx.output(out.routed!, null);
  };
}

function doneAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    ctx.output(map.shared.budget, null);
    ctx.output(g.done, null);
  };
}

function exhaustedAction(g: NodeGadget, policy: RoutingPolicy, map: NetMapView): TransitionAction {
  return async (ctx) => {
    succeed(ctx, g, policy, ctx.input(g.retry!), map);
  };
}

function skipAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    for (const out of g.outputs) for (const e of out.edges) if (e.empty !== null) ctx.output(e.empty, null);
    ctx.output(g.skipped!, null);
    if (g.form !== 'or') for (const i of g.inputs) ctx.output(i.free!, null);
  };
}

function armAction(g: NodeGadget, info: TransitionInfo): TransitionAction {
  const edge = info.edge!;
  const input = g.inputs.find((i) => i.index === edge.inputIndex)!;
  const slot = input.edges.find((e) => e.edge.id === edge.id)!;
  if (g.form === 'or') {
    if (info.variant === 'data') {
      return async (ctx) => {
        ctx.output(input.hasdata!, ctx.input(slot.data));
        if (slot.empty !== null) ctx.output(input.ready!, null);
      };
    }
    return async (ctx) => { ctx.output(input.ready!, null); };
  }
  if (info.variant === 'data') {
    return async (ctx) => {
      ctx.output(readyOf(g, input), ctx.input(slot.data));
      if (g.hasdata !== null) ctx.output(g.hasdata, null);
    };
  }
  return async (ctx) => {
    ctx.output(g.form === 'choose-branch' && input.required ? input.readyEmpty! : input.ready!, null);
  };
}

/**
 * `A_done_req`: refunds the budget one cycle after `X_run` marked `A/routed_req` (the phase
 * `X_done` keeps for every other node, ADR 0004) and opens the round.
 *
 * The placeholder takes the **empty-request** branch, so a placeholder round dispatches nothing
 * and `A_resume` fires in the next cycle. That keeps every structural net terminating, which is
 * the placeholders' whole job; the scheduler's own action puts the queue up when there is one.
 */
function doneRequestAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const value = ctx.input(g.routedRequest!);
    ctx.output(map.shared.budget, null);
    ctx.output(g.drained!, value);
    ctx.output(g.dispatched!, value);
  };
}

/**
 * `A_dispatch`: one action off `A/queue` onto one tool's `T/in_tool`, one unit onto
 * `A/outstanding`, one unit of `A/calls` consumed, and either the queue back or `A/drained`.
 * The placeholder takes the first tool and calls the round drained; the scheduler's action
 * takes the tool the action names and knows whether the queue has more.
 */
function dispatchAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    const value = ctx.input(g.queue!);
    ctx.output(map.node(g.tools[0]!).inTool!, value);
    ctx.output(g.drained!, value);
    ctx.output(g.outstanding!, null);
  };
}

/** `A_calls_out`: the budget is spent with calls queued, so the agent re-enters to fail. */
function callsOutAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    ctx.output(g.running, ctx.input(g.dispatched!));
  };
}

/** `A_resume`: the round is complete, so the agent re-enters `X_run` with its resume entry. */
function resumeAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    ctx.output(g.running, ctx.input(g.dispatched!));
  };
}

/** `A_rounds_out`: the budget is spent, so the open round becomes a designed pause. */
function roundsOutAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    ctx.output(g.stopped, ctx.input(g.dispatched!));
    ctx.output(map.shared.pause, null);
  };
}

function retryWaitAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    ctx.output(g.running, ctx.input(g.retry!));
  };
}

/** Binds a structural action for every role that declares an `Out` spec; sinks and `clear` keep passthrough. */
export function structuralActions(policy: RoutingPolicy): ActionBinder {
  return (info, map) => {
    // `clear` and `collect` close a round and produce nothing: genuine sinks (CORE-043 AC4),
    // so they keep libpetri's passthrough rather than a placeholder that would have to invent
    // an output.
    if (info.role === 'sink' || info.role === 'clear' || info.role === 'collect') return null;
    const g = map.node(info.node!);
    switch (info.role) {
      case 'start': return startAction(g);
      case 'start-unmet': return startUnmetAction(g, info);
      case 'run': return runAction(g, policy, map);
      case 'route': return routeAction(g, info, policy);
      case 'done': return doneAction(g, map);
      case 'exhausted': return exhaustedAction(g, policy, map);
      case 'skip': return skipAction(g);
      case 'arm': return armAction(g, info);
      case 'retry': return retryWaitAction(g);
      case 'done-request': return doneRequestAction(g, map);
      case 'dispatch': return dispatchAction(g, map);
      case 'resume': return resumeAction(g);
      case 'rounds-out': return roundsOutAction(g, map);
      case 'calls-out': return callsOutAction(g);
    }
  };
}

/** `structuralActions` with a per-output policy. */
export function routingActions(policy: RoutingPolicy): ActionBinder {
  return structuralActions(policy);
}

export function placeholderActions(): ActionBinder {
  return structuralActions(() => 'no-data');
}

export function forwardAllActions(): ActionBinder {
  return structuralActions(() => 'data');
}
