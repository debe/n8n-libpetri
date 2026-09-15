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
import type { Place, TransitionAction, TransitionContext } from 'libpetri';
import { assertNever } from '../internal/assert.js';
import { readySlot } from './gadget.js';
import type {
  ActionBinder, ArmTransition, AttemptTransition, DeadlineTransition, NetMapView, NodeGadget, OutputGadget,
  AgentGadget, AttemptGadget, RouteTransition, SlottedGadget, StartUnmetTransition, UnmetReferencePayload,
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

/** Consumes the start inputs and returns the value to put on `X/running`, refunding the join slots. */
function startInput(ctx: TransitionContext, g: NodeGadget): unknown {
  switch (g.form) {
    case 'direct': return ctx.input(g.in);
    case 'tool': return ctx.input(g.inTool);
    case 'or': {
      const [i] = g.inputs;
      ctx.output(i.ran, null);
      return ctx.input(i.hasdata);
    }
    case 'join':
    case 'choose-branch': return startJoin(ctx, g);
    default: return assertNever(g, 'gadget form');
  }
}

function startJoin(ctx: TransitionContext, g: SlottedGadget): unknown[] {
  const values = g.inputs.map((i) => ctx.input(readySlot(g, i, 'data')));
  for (const i of g.inputs) ctx.output(i.free, null);
  return values;
}

function startAction(g: NodeGadget): TransitionAction {
  return async (ctx) => {
    ctx.output(g.running, startInput(ctx, g));
  };
}

function startUnmetAction(g: NodeGadget, info: StartUnmetTransition): TransitionAction {
  const { reference: unmetReference } = info;
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
    ctx.output(responseOf(map, g.agents[0]), value);
    if (g.routing.kind === 'split') throw new Error(`internal: tool '${g.node}' routes per output`);
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

/** The `A/response` place of `agent`, which every node a tool is wired to has by construction. */
function responseOf(map: NetMapView, agent: string): Place<unknown> {
  const owner = map.node(agent);
  if (owner.agent === null) throw new Error(`internal: '${agent}' is wired as an agent but compiled without an agent side`);
  return owner.agent.response;
}

function runAction(g: NodeGadget, policy: RoutingPolicy, map: NetMapView): TransitionAction {
  return async (ctx) => {
    succeed(ctx, g, policy, ctx.input(g.running), map);
    ctx.output(g.idle, null);
  };
}

/** Per-output routing only (`routing.kind === 'split'`): `X_route_o` drains one `X/ok_o`. */
function routeAction(g: NodeGadget, info: RouteTransition, policy: RoutingPolicy): TransitionAction {
  if (g.routing.kind !== 'split') throw new Error(`internal: node '${g.node}' has a route transition but routes in X_run`);
  const out = g.routing.outputs.find((o) => o.index === info.port);
  if (out === undefined) throw new Error(`internal: node '${g.node}' has no output ${info.port} for '${info.name}'`);
  return async (ctx) => {
    routeOutput(ctx, g, out, policy(g, out), ctx.input(out.ok));
    ctx.output(out.routed, null);
  };
}

function doneAction(g: NodeGadget, map: NetMapView): TransitionAction {
  return async (ctx) => {
    ctx.output(map.shared.budget, null);
    ctx.output(g.done, null);
  };
}

function exhaustedAction(g: NodeGadget, policy: RoutingPolicy, map: NetMapView): TransitionAction {
  const { retry } = g;
  if (retry === null) throw new Error(`internal: node '${g.node}' has an exhausted transition but no retry gadget`);
  return async (ctx) => {
    succeed(ctx, g, policy, ctx.input(retry.retry), map);
  };
}

function skipAction(g: NodeGadget): TransitionAction {
  const { skipped } = g;
  if (skipped === null) throw new Error(`internal: node '${g.node}' has a skip transition but no skipped place`);
  const refunds = g.form === 'join' || g.form === 'choose-branch' ? g.inputs.map((i) => i.free) : [];
  return async (ctx) => {
    for (const out of g.outputs) for (const e of out.edges) if (e.empty !== null) ctx.output(e.empty, null);
    ctx.output(skipped, null);
    for (const free of refunds) ctx.output(free, null);
  };
}

function armAction(g: NodeGadget, info: ArmTransition): TransitionAction {
  const { edge, variant } = info;
  if (g.form === 'direct' || g.form === 'tool') throw new Error(`internal: node '${g.node}' has an arm but no join input`);
  const input = g.inputs.find((i) => i.index === edge.inputIndex);
  const slot = input?.edges.find((e) => e.edge.id === edge.id);
  if (input === undefined || slot === undefined) {
    throw new Error(`internal: node '${g.node}' has no input ${edge.inputIndex} edge ${edge.id} for '${info.name}'`);
  }
  if (input.slot === 'or') {
    if (variant === 'data') {
      return async (ctx) => {
        ctx.output(input.hasdata, ctx.input(slot.data));
        if (slot.empty !== null) ctx.output(input.ready, null);
      };
    }
    return async (ctx) => { ctx.output(input.ready, null); };
  }
  const ready = readySlot(g, input, variant);
  if (variant === 'data') {
    const hasdata = g.form === 'join' ? g.hasdata : null;
    return async (ctx) => {
      ctx.output(ready, ctx.input(slot.data));
      if (hasdata !== null) ctx.output(hasdata, null);
    };
  }
  return async (ctx) => {
    ctx.output(ready, null);
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
  const agent = agentOf(g);
  return async (ctx) => {
    const value = ctx.input(agent.routedRequest);
    ctx.output(map.shared.budget, null);
    ctx.output(agent.drained, value);
    ctx.output(agent.dispatched, value);
  };
}

/** The agent side of a node whose round transitions are being bound: the gadget built them only for an agent. */
function agentOf(g: NodeGadget): AgentGadget {
  if (g.agent === null) throw new Error(`internal: node '${g.node}' has a round transition but no agent side`);
  return g.agent;
}

/**
 * `A_dispatch`: one action off `A/queue` onto one tool's `T/in_tool`, one unit onto
 * `A/outstanding`, one unit of `A/calls` consumed, and either the queue back or `A/drained`.
 * The placeholder takes the first tool and calls the round drained; the scheduler's action
 * takes the tool the action names and knows whether the queue has more.
 */
function dispatchAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const agent = agentOf(g);
  const firstTool = map.node(agent.tools[0]);
  if (firstTool.form !== 'tool') throw new Error(`internal: agent '${g.node}' dispatches to '${firstTool.node}', which is not a tool`);
  return async (ctx) => {
    const value = ctx.input(agent.queue);
    ctx.output(firstTool.inTool, value);
    ctx.output(agent.drained, value);
    ctx.output(agent.outstanding, null);
  };
}

/** `A_calls_out`: the budget is spent with calls queued, so the agent re-enters to fail. */
function callsOutAction(g: NodeGadget): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    ctx.output(g.running, ctx.input(agent.dispatched));
  };
}

/** `A_resume`: the round is complete, so the agent re-enters `X_run` with its resume entry. */
function resumeAction(g: NodeGadget): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    ctx.output(g.running, ctx.input(agent.dispatched));
  };
}

/** `A_rounds_out`: the budget is spent, so the open round becomes a designed pause. */
function roundsOutAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    ctx.output(g.stopped, ctx.input(agent.dispatched));
    ctx.output(map.shared.pause, null);
  };
}

function retryWaitAction(g: NodeGadget): TransitionAction {
  const { retry } = g;
  if (retry === null) throw new Error(`internal: node '${g.node}' has a retry_wait transition but no retry gadget`);
  return async (ctx) => {
    ctx.output(g.running, ctx.input(retry.retry));
  };
}

/** The attempt a chain transition serves; the gadget names one per attempt it built. */
function attemptOf(g: NodeGadget, info: AttemptTransition | DeadlineTransition): AttemptGadget {
  const attempt = g.attempts.find((att) => att.index === info.attempt);
  if (attempt === undefined) throw new Error(`internal: node '${g.node}' has no attempt ${info.attempt} for '${info.name}'`);
  return attempt;
}

/** The `onFailure` step for one attempt: escalate to the next, or take the terminal arm. */
function attemptAction(
  g: NodeGadget, info: AttemptTransition, policy: RoutingPolicy, map: NetMapView,
): TransitionAction {
  const attempt = attemptOf(g, info);
  switch (attempt.action) {
    case 'retry':
      // The chain is unrolled, so "the next attempt" is a place rather than a decrement.
      return async (ctx) => {
        ctx.output(attempt.next, ctx.input(attempt.failed));
      };
    case 'stop':
      return async (ctx) => {
        ctx.input(attempt.failed);
        ctx.output(map.shared.halt, null);
        ctx.output(map.shared.budget, null);
      };
    case 'route':
    case 'continue':
      // `route` and `continue` share the success spec; which output carries the data is the
      // scheduler's decision, and the placeholder keeps its usual no-data routing.
      return async (ctx) => {
        succeed(ctx, g, policy, ctx.input(attempt.failed), map);
      };
    default: return assertNever(attempt, 'attempt');
  }
}

/** The deadline funnel: an expired attempt becomes the ordinary failure its step answers. */
function deadlineAction(g: NodeGadget, info: DeadlineTransition): TransitionAction {
  const attempt = attemptOf(g, info);
  const { timedOut } = attempt;
  if (timedOut === null) throw new Error(`internal: node '${g.node}' has a deadline funnel but attempt ${info.attempt} has no timedout place`);
  return async (ctx) => {
    ctx.output(attempt.failed, ctx.input(timedOut));
  };
}

/** Binds a structural action for every role that declares an `Out` spec; sinks and `clear` keep passthrough. */
export function structuralActions(policy: RoutingPolicy): ActionBinder {
  return (info, map) => {
    const g = map.node(info.node);
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
      case 'attempt': return attemptAction(g, info, policy, map);
      case 'deadline': return deadlineAction(g, info);
      case 'done-request': return doneRequestAction(g, map);
      case 'dispatch': return dispatchAction(g, map);
      case 'resume': return resumeAction(g);
      case 'rounds-out': return roundsOutAction(g, map);
      case 'calls-out': return callsOutAction(g);
      // `sink`, `clear` and `collect` close a round or drain a `nil` and produce nothing:
      // genuine sinks (CORE-043 AC4), so they keep libpetri's passthrough rather than a
      // placeholder that would have to invent an output.
      case 'sink':
      case 'clear':
      case 'collect': return null;
      default: return assertNever(info, 'transition role');
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
