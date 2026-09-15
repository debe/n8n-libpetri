/**
 * An outcome as the complete list of tokens its firing deposits.
 *
 * {@link deposits} is a pure function of the outcome and the gadget, and `guarded` (in
 * `outcomes.ts`) computes the whole list before it emits anything (EXEC-030). {@link dispatchOf}
 * lives here rather than with the round because a tool's success branch is where the dispatch
 * it carries is spent, and keeping it here leaves the round depending on this module and not
 * the other way round.
 */
import type { Place } from 'libpetri';
import type { ISourceData } from 'n8n-workflow';
import type { NetMapView, NodeGadget, SharedPlaces, ToolGadget } from '../compiler/index.js';
import { assertNever } from '../internal/assert.js';
import { InternalSchedulerError } from './errors.js';
import type { Outcome } from './outcomes.js';
import type {
  EdgePayload, OkPayload, ResponsePayload, RunPayload, StoppedPayload, ToolDispatch, WaitingPayload,
} from './payloads.js';

/**
 * The dispatch a tool's run payload carries: the agent whose `A/response` its success branch
 * writes, and the round it belongs to. Every producer of a tool's `RunPayload` sets both — the
 * dispatch token at `T_start`, and every retry, step, deadline and re-entry after it — so a
 * payload without them is an invariant of the scheduler broken, not a workflow condition.
 */
export function dispatchOf(g: ToolGadget, run: RunPayload | undefined): ToolDispatch {
  if (run?.agent === undefined || run.roundId === undefined) {
    throw new InternalSchedulerError(`internal: tool '${g.node}' ran without the agent that dispatched it; its run payload carries no dispatch`);
  }
  if (!g.agents.includes(run.agent)) {
    throw new InternalSchedulerError(`internal: tool '${g.node}' has no ai_tool connection to '${run.agent}'`);
  }
  return { agent: run.agent, roundId: run.roundId };
}

/**
 * One token a firing deposits. An outcome is turned into a complete list of these *before*
 * anything is emitted, so the writer is a pure function of the outcome and the gadget: a list
 * that cannot be computed leaves the marking untouched and takes the fallback branch instead,
 * where a throw mid-way through a sequence of `ctx.output` calls would reject the transition
 * after the firing consumed its tokens and its budget unit (EXEC-030).
 */
export interface Deposit {
  readonly place: Place<unknown>;
  readonly value: unknown;
}

/**
 * A tool's success. Its output goes to the agent that dispatched it, not to a main edge. The
 * `xor` over the agents is resolved by the dispatch the run payload carries, which the dispatch
 * token named when `T_start` fired and every attempt since has kept. The place is the agent's
 * own `A/response`: composition funnelled this tool's `resp_k` port onto it, so addressing it
 * through the map is addressing the same place (CORE-002).
 */
function respond(g: ToolGadget, map: NetMapView, run: RunPayload | undefined): Deposit[] {
  const dispatch = dispatchOf(g, run);
  const agent = map.node(dispatch.agent).agent;
  if (agent === null) {
    throw new InternalSchedulerError(`internal: '${dispatch.agent}' is wired as an agent of '${g.node}' but compiled without an agent side`);
  }
  if (g.routing.kind === 'split') throw new InternalSchedulerError(`internal: tool '${g.node}' routes per output`);
  const payload: ResponsePayload = { kind: 'response', tool: g.node, roundId: dispatch.roundId };
  return [{ place: agent.response, value: payload }, { place: g.routing.routed, value: null }];
}

/**
 * The success outcome. Unless the node routes per output ({@link SPLIT_ROUTING_ABOVE}),
 * `X_run` carries the routing in its own `Out` spec, so the edge tokens are deposited here
 * and `X/routed` marks the outcome for `X_done` to refund the budget one cycle later
 * (ADR 0004). A split node writes one `X/ok_o` per output for its `X_route_o` instead.
 */
function succeed(g: NodeGadget, value: OkPayload, map: NetMapView, run?: RunPayload): Deposit[] {
  if (g.form === 'tool') return respond(g, map, run);
  if (g.routing.kind === 'split') return g.routing.outputs.map((out) => ({ place: out.ok, value }));
  return [...g.routing.outputs.flatMap((out) => routeOutput(g, out, value)), { place: g.routing.routed, value: null }];
}

/**
 * Where a retry outcome's token goes. With a chain the failure is a *position*, not a counter
 * decrement: it goes to the place belonging to the attempt that just failed, which `run.attempt`
 * names (0-based, as `X_start` seeds it). Without one it is n8n's single `X/retry`.
 */
function retryPlace(g: NodeGadget, run: RunPayload | undefined): Place<unknown> {
  if (g.attempts.length > 0) {
    const failing = g.attempts[run?.attempt ?? 0];
    if (failing === undefined) {
      throw new InternalSchedulerError(`internal: node '${g.node}' has no attempt ${run?.attempt ?? 0} in its onFailure chain`);
    }
    return failing.failed;
  }
  if (g.retry === null) throw new InternalSchedulerError(`internal: node '${g.node}' produced a retry outcome without a retry gadget or an onFailure chain`);
  return g.retry.retry;
}

/** A `waiting` or `stopped` outcome: its token on `place`, the `_pause` marker, and the budget unit back. */
function pauseOn(place: Place<unknown>, value: WaitingPayload | StoppedPayload, shared: SharedPlaces): Deposit[] {
  return [{ place, value }, { place: shared.pause, value: null }, { place: shared.budget, value: null }];
}

/** Whether `X_run` was compiled with a halt branch (`compiler/gadget.ts`: `stopWorkflow`, or any `onFailure` chain). */
export function hasHaltBranch(g: NodeGadget): boolean {
  return g.onError === 'stopWorkflow' || g.attempts.length > 0;
}

/** The tokens `outcome` deposits on `g`'s branch for it; throws only on an invariant of the compiled net broken. */
export function deposits(g: NodeGadget, map: NetMapView, outcome: Outcome, run?: RunPayload): Deposit[] {
  const shared = map.shared;
  switch (outcome.kind) {
    case 'ok':
      return succeed(g, { kind: 'ok', nodeSuccessData: outcome.nodeSuccessData, runIndex: outcome.runIndex }, map, run);
    case 'retry':
      return [{ place: retryPlace(g, run), value: outcome.payload }];
    case 'halt':
      // Unreachable for a gadget without the branch: `admissible` has already mapped it.
      if (!hasHaltBranch(g)) throw new InternalSchedulerError(`internal: node '${g.node}' (onError ${g.onError}) has no halt branch`);
      return [{ place: shared.halt, value: null }, { place: shared.budget, value: null }];
    case 'waiting':
      return pauseOn(g.waiting, { kind: 'waiting', executionData: outcome.executionData }, shared);
    case 'stopped':
      return pauseOn(g.stopped, { kind: 'stopped', executionData: outcome.executionData, ran: outcome.ran }, shared);
    case 'request':
      // Phased like the success outcome: the marker here, the budget refunded by `A_done_req`
      // one cycle later (ADR 0004), so the agent releases its slot for the tools it asked for.
      if (g.agent === null) throw new InternalSchedulerError(`internal: node '${g.node}' produced a request outcome but is not an agent`);
      return [{ place: g.agent.routedRequest, value: outcome.payload }];
    default: return assertNever(outcome, 'outcome');
  }
}

/** Lines 272–331 per connected output: the v1 gate `nodeSuccessData[o].length !== 0`. */
export function routeOutput(g: NodeGadget, out: NodeGadget['outputs'][number], value: OkPayload): Deposit[] {
  const items = value.nodeSuccessData[out.index];
  if (items !== undefined && items !== null && items.length !== 0) {
    const source: ISourceData = { previousNode: g.node, previousNodeOutput: out.index, previousNodeRun: value.runIndex };
    const payload: EdgePayload = { kind: 'edge', items, source };
    return out.edges.map((e) => ({ place: e.data, value: payload }));
  }
  if (out.nil !== null) return [{ place: out.nil, value: null }];
  return out.edges.map((e) => {
    // An acyclic producer's edges are all tree edges, each with its empty place (`compiler/gadget.ts`).
    if (e.empty === null) throw new InternalSchedulerError(`internal: node '${g.node}' output ${out.index} has a cycle edge but no nil place`);
    return { place: e.empty, value: null };
  });
}
