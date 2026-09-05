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
 * All of them take the success outcome in `X_run` and `X_exhausted`: the placeholders never
 * halt and never retry, so the net's only decisions are the structural ones. The
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

/** Writes the success outcome: `X/ok`, or every `X/ok_o` under split routing. */
function succeed(ctx: TransitionContext, g: NodeGadget, value: unknown): void {
  if (g.splitRouting) for (const out of g.outputs) ctx.output(out.ok!, value);
  else ctx.output(g.ok!, value);
}

function runAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    succeed(ctx, g, ctx.input(g.running));
    ctx.output(g.idle, null);
  };
}

function routeAction(g: NodeGadget, map: NetMapView, info: TransitionInfo, policy: RoutingPolicy): TransitionAction {
  if (g.splitRouting) {
    const out = g.outputs.find((o) => o.index === info.port)!;
    return async (ctx) => {
      routeOutput(ctx, g, out, policy(g, out), ctx.input(out.ok!));
      ctx.output(out.routed!, null);
    };
  }
  return async (ctx) => {
    const value = ctx.input(g.ok!);
    for (const out of g.outputs) routeOutput(ctx, g, out, policy(g, out), value);
    ctx.output(map.shared.budget, null);
    ctx.output(g.done, null);
  };
}

function doneAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    ctx.output(map.shared.budget, null);
    ctx.output(g.done, null);
  };
}

function exhaustedAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    succeed(ctx, g, ctx.input(g.retry!));
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

function retryWaitAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    ctx.output(g.running, ctx.input(g.retry!));
  };
}

/** Binds a structural action for every role that declares an `Out` spec; sinks and `clear` keep passthrough. */
export function structuralActions(policy: RoutingPolicy): ActionBinder {
  return (info, map) => {
    if (info.role === 'reap') return async (ctx) => { ctx.output(map.shared.halted, null); };
    if (info.role === 'sink' || info.role === 'clear') return null;
    const g = map.node(info.node!);
    switch (info.role) {
      case 'start': return startAction(g);
      case 'start-unmet': return startUnmetAction(g, info);
      case 'run': return runAction(g);
      case 'route': return routeAction(g, map, info, policy);
      case 'done': return doneAction(g, map);
      case 'exhausted': return exhaustedAction(g);
      case 'skip': return skipAction(g);
      case 'arm': return armAction(g, info);
      case 'retry': return retryWaitAction(g);
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
