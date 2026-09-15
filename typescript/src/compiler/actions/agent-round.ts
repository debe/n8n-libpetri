/**
 * An agent's round transitions (README "Agent tool dispatch", ADR 0008): `A_done_req` opens the
 * round, `A_dispatch` hands one call to a tool, and `A_resume` / `A_calls_out` /
 * `A_rounds_out` close it. The placeholders take the branch that keeps every structural net
 * terminating; the scheduler's own actions decide from the queue.
 */
import type { TransitionAction } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import type { AgentGadget, NetMapView, NodeGadget } from '../types.js';

/** The agent side of a node whose round transitions are being bound: the gadget built them only for an agent. */
function agentOf(g: NodeGadget): AgentGadget {
  if (g.agent === null) throw new InternalCompilerError(`internal: node '${g.node}' has a round transition but no agent side`);
  return g.agent;
}

/**
 * `A_done_req`: refunds the budget one cycle after `X_run` marked `A/routed_req` (the phase
 * `X_done` keeps for every other node, ADR 0004) and opens the round.
 *
 * The placeholder takes the **empty-request** branch, so a placeholder round dispatches nothing
 * and `A_resume` fires in the next cycle. That keeps every structural net terminating, which is
 * the placeholders' whole job; the scheduler's own action puts the queue up when there is one.
 */
export function doneRequestAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    const value = ctx.input(agent.routedRequest);
    ctx.output(map.shared.budget, null);
    ctx.output(agent.drained, value);
    ctx.output(agent.dispatched, value);
  };
}

/**
 * `A_dispatch`: one action off `A/queue` onto one tool's `T/in_tool`, one unit onto
 * `A/outstanding`, one unit of `A/calls` consumed, and either the queue back or `A/drained`.
 * The placeholder takes the first tool and calls the round drained; the scheduler's action
 * takes the tool the action names and knows whether the queue has more.
 */
export function dispatchAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const agent = agentOf(g);
  const firstTool = map.node(agent.tools[0]);
  if (firstTool.form !== 'tool') throw new InternalCompilerError(`internal: agent '${g.node}' dispatches to '${firstTool.node}', which is not a tool`);
  return async (ctx) => {
    const value = ctx.input(agent.queue);
    ctx.output(firstTool.inTool, value);
    ctx.output(agent.drained, value);
    ctx.output(agent.outstanding, null);
  };
}

/**
 * The agent re-enters `X_run` with the open round's entry, off `A/dispatched`. Two roles take it:
 * `A_resume`, when the round is complete, and `A_calls_out`, when the call budget is spent with
 * calls still queued, so the agent re-enters to fail.
 */
export function reenterAction(g: NodeGadget): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    ctx.output(g.running, ctx.input(agent.dispatched));
  };
}

/** `A_rounds_out`: the budget is spent, so the open round becomes a designed pause. */
export function roundsOutAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    ctx.output(g.stopped, ctx.input(agent.dispatched));
    ctx.output(map.shared.pause, null);
  };
}
