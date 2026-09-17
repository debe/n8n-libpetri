/**
 * The agent's tool round (ADR 0008): the actions of `A_done_req`, `A_dispatch`, `A_calls_out`,
 * `A_resume` and `A_rounds_out`. The round is the net's, not a host loop: nothing here enqueues
 * on the host. Planning n8n's `EngineRequest` into the round's tokens is `round-plan.ts`, whose
 * {@link planRound} this module exports as it always has.
 */
import type { TransitionAction, TransitionContext } from 'libpetri';
import type { AgentGadget, NetMapView, NodeGadget } from '../compiler/index.js';
import { envOf } from './env.js';
import { InternalSchedulerError } from './errors.js';
import { take } from './outcomes.js';
import {
  isRequestPayload, isRoundPayload,
  type DispatchPayload, type RequestPayload, type RoundPayload, type RunPayload, type StoppedPayload,
} from './payloads.js';

export { planRound } from './round-plan.js';

/** The agent side of a node whose round transitions are being bound: the gadget built them only for an agent. */
function agentOf(g: NodeGadget): AgentGadget {
  if (g.agent === null) throw new InternalSchedulerError(`internal: node '${g.node}' has a round transition but no agent side`);
  return g.agent;
}

/**
 * Where the rest of a request goes: `A/drained` once nothing is left to dispatch, otherwise back
 * onto `A/queue`. The one decision `A_done_req` and `A_dispatch` make that the graph cannot —
 * whether the queue has more. The graph explores both; see the gadget for why neither spurious
 * branch can strand.
 */
function requeue(ctx: TransitionContext, agent: AgentGadget, rest: RequestPayload): void {
  if (rest.pending.length === 0) ctx.output(agent.drained, null);
  else ctx.output(agent.queue, rest);
}

/**
 * `A_done_req`: the round opens — with the queue when there is something to dispatch, or
 * already drained for an empty request, in which case `A_resume` fires next and the agent
 * re-runs with an empty `EngineResponse`. No count is deposited: the number of tool calls is
 * discovered by `A_dispatch` firing, one budget unit at a time.
 */
export function doneRequestAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    const payload = take(ctx, agent.routedRequest, isRequestPayload);
    ctx.output(map.shared.budget, null);
    const round: RoundPayload = {
      kind: 'round', resume: payload.resume, roundId: payload.roundId,
      ...(payload.answers === undefined ? {} : { answers: payload.answers }),
    };
    ctx.output(agent.dispatched, round);
    requeue(ctx, agent, payload);
  };
}

/**
 * `A_dispatch`: the head of the queue onto its tool's `T/in_tool`, the tail back onto
 * `A/queue`, one unit onto `A/outstanding`.
 *
 * One firing per action, in request order, because `A/queue` holds a single token. n8n's own
 * `executes requested tools in the order the actions were requested` is what that preserves;
 * the tools then run at whatever width `_budget` allows, which is where this differs from a
 * stack that runs them one at a time.
 */
export function dispatchAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    const payload = take(ctx, agent.queue, isRequestPayload);
    const [head, ...tail] = payload.pending;
    if (head === undefined) {
      throw new InternalSchedulerError(`internal: agent '${g.node}' dispatched with an empty queue; the queue token should have been drained`);
    }
    const target = map.node(head.node.name);
    if (target.form !== 'tool') {
      throw new InternalSchedulerError(`internal: agent '${g.node}' dispatched to '${head.node.name}', which is not a tool`);
    }
    const dispatch: DispatchPayload = {
      kind: 'dispatch', executionData: head, agent: g.node, roundId: payload.roundId,
    };
    ctx.output(target.inTool, dispatch);
    ctx.output(agent.outstanding, null);
    requeue(ctx, agent, { ...payload, pending: tail });
  };
}

/**
 * `A_calls_out`: the tool-call budget is spent and the queue still holds actions. The agent
 * re-enters `X_run` carrying the fact; `attempt()` then fails the activation with
 * `toolCallBudgetExceeded` before `runNode`, so the error is recorded and routed under the
 * node's `onError` policy exactly as `maxIterations` is when n8n's node throws it.
 */
export function callsOutAction(g: NodeGadget): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    const round = take(ctx, agent.dispatched, isRoundPayload);
    const queue = take(ctx, agent.queue, isRequestPayload);
    const exceeded = { undispatched: queue.pending.length, budget: agent.maxToolCalls };
    // Onto `A/running_failed`, which only `A_run_failed` consumes, so the re-entry runs a node
    // with no request branch; `A_run_failed` reads this payload exactly as the primary run reads
    // `A/running`.
    ctx.output(agent.runningFailed, reentryRun(g, round, { toolCallsExceeded: exceeded }));
  };
}

/**
 * The dispatch fields of an agent's re-entry. An agent on a main edge has none; a tool that is
 * itself an agent answers the agent that dispatched it, which the round token carries
 * ({@link RoundPayload.answers}). Its `roundId` replaces the tool's own: a tool's run payload
 * names the round it answers into — the one `A/response` names — as the dispatch token did.
 */
function reentry(g: NodeGadget, round: RoundPayload): { readonly agent?: string; readonly roundId?: string } {
  if (g.form !== 'tool') return {};
  if (round.answers === undefined) {
    throw new InternalSchedulerError(`internal: tool '${g.node}' resumes round '${round.roundId}' without the agent that dispatched it`);
  }
  return round.answers;
}

/**
 * The agent's run payload when a round ends: its own re-entry as attempt 0, under the round it
 * opened, with the dispatch fields of {@link reentry}. `extra` is what `A_calls_out` adds.
 */
function reentryRun(g: NodeGadget, round: RoundPayload, extra: Pick<RunPayload, 'toolCallsExceeded'> = {}): RunPayload {
  return { kind: 'run', executionData: round.resume, attempt: 0, roundId: round.roundId, ...extra, ...reentry(g, round) };
}

/**
 * `A_resume`: nothing left to dispatch and nothing still out, so the agent re-enters `X_run`
 * with the entry n8n built for it — `metadata.nodeWasResumed` suppresses the second
 * `nodeExecuteBefore` hook and `metadata.subNodeExecutionData` is what
 * `host.collectSubNodeResults` reads the round's `EngineResponse` back out of.
 */
export function resumeAction(g: NodeGadget): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    const payload = take(ctx, agent.dispatched, isRoundPayload);
    ctx.output(g.running, reentryRun(g, payload));
  };
}

/**
 * `A_rounds_out`: the agent has spent its round budget with a round still open, so nothing can
 * resume it. The re-entry goes back through `X/stopped` with `ran: false` — the shape the codec
 * already writes onto `nodeExecutionStack` for an activation that never ran — and `_pause` makes
 * the run a designed stop rather than a silent quiesce.
 */
export function roundsOutAction(g: NodeGadget, map: NetMapView): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    const payload = take(ctx, agent.dispatched, isRoundPayload);
    const env = envOf(ctx);
    env.diagnostic(
      `agent '${g.node}': round budget spent with a round still open; the re-entry and any ` +
      'undispatched tool calls are written back to nodeExecutionStack');
    const stopped: StoppedPayload = { kind: 'stopped', executionData: payload.resume, ran: false };
    ctx.output(g.stopped, stopped);
    ctx.output(map.shared.pause, null);
  };
}
