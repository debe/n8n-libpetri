/**
 * The agent round (README "Agent tool dispatch", ADR 0008; `patterns.md` §5): the places of an
 * agent node with at least one `ai_tool` producer, and `A_done_req`, `A_dispatch`, `A_collect`,
 * `A_resume`, `A_calls_out` and `A_rounds_out`.
 */
import { Transition, and, one, outPlace, xor } from 'libpetri';
import type { Place } from 'libpetri';
import { InternalCompilerError } from '../errors.js';
import { AGENT_PLACE, TRANSITION } from '../names.js';
import { xorOf, type GadgetContext, type LocalAgent } from './context.js';
import type { Markers, SharedPorts } from './ports.js';

/** The transition names of the agent round; all `null` on a node that is not an agent. */
export interface AgentRoundNames {
  readonly doneRequestName: string | null;
  readonly dispatchName: string | null;
  readonly collectName: string | null;
  readonly resumeName: string | null;
  readonly roundsOutName: string | null;
  readonly callsOutName: string | null;
}

/** The agent's round places, `A/response` exposed; `null` unless the node is an agent. */
export function declareAgentPlaces(ctx: GadgetContext): LocalAgent | null {
  const { a, name, tools, internal, portDecls } = ctx;

  // ---- agent round places (patterns.md §5, "fan-out and join with pending markers") ----
  // `routed_req` phases the budget refund exactly as `routed` does for every other outcome;
  // `queue` carries the undispatched actions and `drained` marks that there are none;
  // `outstanding` is the pattern's `JOB_PENDING`; `dispatched` its `ROUTING_DONE`; `rounds`
  // is the round budget, seeded from the agent's own `options.maxIterations`; `calls` is the
  // tool-call budget, the scheduler's own, consumed one unit per dispatch and never refunded.
  //
  // Why a budget and not a count. The number of tool calls in a round is decided at run time,
  // and an `Out` branch cannot carry a number — IO-015 validates the *set* of places a firing
  // writes. A count deposited as tokens is therefore invisible to the state-class graph, which
  // fires the branch as one token and explores one call in flight where the executor reaches
  // many: an under-approximation, the direction that yields a false `proven` on a safety
  // property. Consumed one unit per firing of `A_dispatch`, the count becomes a path length
  // instead, and the graph explores every round size up to the budget (`peak(A/outstanding)`
  // equals the budget, `tests/spikes/agent-round.test.ts`). Never refunding it is what keeps
  // that finite: a refund at the join lets a round dispatch without bound and `T/done`
  // accumulates — measured, the graph truncates. This is NU-040's decidability lever, the
  // budget place, without ν-names because one round is live per agent (`A/idle`).
  let agent: LocalAgent | null = null;
  if (tools !== null) {
    if (a.maxRounds === null || a.maxToolCalls === null) {
      throw new InternalCompilerError(`internal: agent '${name}' has tools but no round or tool-call budget`);
    }
    agent = {
      routedRequest: internal(AGENT_PLACE.routedRequest, 'routed-request', null),
      queue: internal(AGENT_PLACE.queue, 'queue', null),
      calls: internal(AGENT_PLACE.calls, 'calls', null),
      drained: internal(AGENT_PLACE.drained, 'drained', null),
      outstanding: internal(AGENT_PLACE.outstanding, 'outstanding', null),
      dispatched: internal(AGENT_PLACE.dispatched, 'dispatched', null),
      rounds: internal(AGENT_PLACE.rounds, 'rounds', null),
      // Owned by the agent, written by every tool it dispatches — exposed like `done` and bound
      // by each tool's own output port.
      response: internal(AGENT_PLACE.response, 'response', null),
      tools, maxRounds: a.maxRounds, roundsAssumed: a.roundsAssumed,
      maxToolCalls: a.maxToolCalls, toolCallsAssumed: a.toolCallsAssumed,
    };
    portDecls.push({ name: AGENT_PLACE.response, local: agent.response, direction: 'output' });
  }
  return agent;
}

/** The round's transitions; none unless the node is an agent. */
export function buildAgentRound(
  ctx: GadgetContext,
  shared: SharedPorts,
  markers: Markers,
  agent: LocalAgent | null,
  toolInPorts: readonly Place<unknown>[],
): AgentRoundNames {
  const { depth, body, tinfo } = ctx;
  const { budget, halt, pause } = shared;
  const { idle, running, stopped } = markers;

  // ---- the agent round: done_req, dispatch, collect, resume ----
  let doneRequestName: string | null = null;
  let dispatchName: string | null = null;
  let collectName: string | null = null;
  let resumeName: string | null = null;
  let roundsOutName: string | null = null;
  let callsOutName: string | null = null;
  if (agent !== null) {
    // `A_done_req`: the round opens with something to dispatch, or — an empty request — with
    // nothing, in which case it is already drained and `A_resume` fires next.
    body.push(Transition.builder(TRANSITION.doneRequest)
      .inputs(one(agent.routedRequest))
      .outputs(xor(
        and(outPlace(budget), outPlace(agent.queue), outPlace(agent.dispatched)),
        and(outPlace(budget), outPlace(agent.drained), outPlace(agent.dispatched)),
      ))
      .priority(depth + 1).build());
    doneRequestName = tinfo(TRANSITION.doneRequest, { role: 'done-request' });

    // `A_dispatch`: one action per firing, one budget unit per firing. `A/queue` holds a single
    // token, so dispatch is serialised and pops in the order the model requested — which is
    // what n8n's own "executes requested tools in the order the actions were requested"
    // asserts — while the tools themselves then run at whatever width `_budget` allows. The
    // action says whether more remain (the queue goes back) or that was the last (`drained`).
    //
    // That last choice is the one `patterns.md` warns about — "never decide 'is this the last
    // one' inside an action and expose it as an Xor" — and here it is safe, because of what
    // each spurious branch leads to in the graph. Taking `drained` early is a smaller round, a
    // subset. Taking the queue past the real end spends budget until `A/calls` is empty, and
    // `A_calls_out` then re-enters the agent: a designed exit, not the stranded batch the
    // warning is about. Both directions are explored, so the graph is an over-approximation of
    // the executor — the sound direction for a safety property.
    body.push(Transition.builder(TRANSITION.dispatch)
      .inputs(one(agent.queue), one(agent.calls))
      .inhibitors(halt, pause)
      .outputs(and(
        xorOf(toolInPorts.map((t) => outPlace(t))),
        outPlace(agent.outstanding),
        xor(outPlace(agent.queue), outPlace(agent.drained)),
      ))
      .priority(depth + 1).build());
    dispatchName = tinfo(TRANSITION.dispatch, { role: 'dispatch' });

    // `A_collect`: pairs one arrived response with one outstanding dispatch and produces
    // nothing — a genuine sink (CORE-043 AC4), the same category as the OR form's `X_clear`.
    // An accumulator drained by `A_resume` would race: `collect` consumes `A/outstanding` when
    // it fires but would deposit on completion, and `A_resume` — no longer inhibited — can fire
    // inside that window and leak a marker into the next round. High priority, because the
    // pattern's order is store before resolve.
    body.push(Transition.builder(TRANSITION.collect)
      .inputs(one(agent.outstanding), one(agent.response))
      .priority(depth + 2).build());
    collectName = tinfo(TRANSITION.collect, { role: 'collect' });

    // `A_resume`: the round is complete — nothing left to dispatch, nothing still out — so the
    // agent re-enters `X_run` with the resume entry `A/dispatched` carries. It takes a budget
    // unit and a round unit; when `A/rounds` is empty the loop stops, which is what makes the
    // whole cycle structurally bounded.
    body.push(Transition.builder(TRANSITION.resume)
      .inputs(one(agent.dispatched), one(agent.drained), one(agent.rounds), one(idle))
      .inhibitors(agent.outstanding, halt, pause)
      .inputs(one(budget))
      .outputs(outPlace(running))
      .priority(depth).build());
    resumeName = tinfo(TRANSITION.resume, { role: 'resume' });

    // `A_calls_out`: the tool-call budget is spent and the queue still holds actions. The agent
    // re-enters `X_run` — taking its budget unit as any start does — carrying the fact, and
    // that run fails with `toolCallBudgetExceeded` under the node's own `onError` policy: the
    // same shape as `maxIterations` throwing inside n8n's node, and it is what gives the
    // graph's spurious "more remain" path an exit that is not a stranding. Below `A_resume` in
    // priority, though the two are structurally exclusive: one needs `drained`, this one needs
    // the queue.
    body.push(Transition.builder(TRANSITION.callsOut)
      .inputs(one(agent.dispatched), one(agent.queue), one(idle), one(budget))
      .inhibitors(agent.calls, agent.outstanding, halt, pause)
      .outputs(outPlace(running))
      .priority(depth - 1).build());
    callsOutName = tinfo(TRANSITION.callsOut, { role: 'calls-out' });

    // `A_rounds_out`: the round budget is spent and a round is still open, so the agent can
    // never resume. Rather than let the net quiesce holding work nothing will ever take, this
    // makes it a **designed terminal**: `_pause` marks the stop, and the agent's re-entry goes
    // back through `A/stopped` (`ran: false`) the way any un-run activation does, so the codec
    // writes it — and the tool calls still on `A/queue` — onto `nodeExecutionStack`.
    //
    // Only a mock reaches it. A real agent counts its own `iterationCount` and throws "Max
    // iterations reached" first, which is why `A/rounds` is seeded with exactly that number.
    // The verifier cannot know that, so without this transition every agent workflow reports a
    // stranding — measured, `tests/verify/measure-graph.ts`.
    body.push(Transition.builder(TRANSITION.roundsOut)
      .inputs(one(agent.dispatched), one(agent.drained))
      .inhibitors(agent.outstanding, agent.rounds, halt)
      .outputs(and(outPlace(stopped), outPlace(pause)))
      .priority(depth - 1).build());
    roundsOutName = tinfo(TRANSITION.roundsOut, { role: 'rounds-out' });
  }
  return { doneRequestName, dispatchName, collectName, resumeName, roundsOutName, callsOutName };
}
