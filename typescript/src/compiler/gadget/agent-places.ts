/**
 * The agent round's places (README "Agent tool dispatch", ADR 0008; `patterns.md` §5): an agent
 * node with at least one `ai_tool` producer gets them, with `A/response` exposed as the port
 * its tools write.
 */
import { InternalCompilerError } from '../errors.js';
import { AGENT_PLACE } from '../names.js';
import type { GadgetContext } from './context.js';
import type { LocalAgent } from './local-shapes.js';

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
  if (tools === null) return null;
  if (a.maxRounds === null || a.maxToolCalls === null) {
    throw new InternalCompilerError(`internal: agent '${name}' has tools but no round or tool-call budget`);
  }
  const agent: LocalAgent = {
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
    // The running place `A_calls_out`'s re-entry lands on, consumed only by `A_run_failed`, so
    // the primary run is structurally unreachable from `A_calls_out` (no inhibitor, so a linear
    // ranking can bound the round). It carries the re-entry unit for one step and never rests.
    runningFailed: internal(AGENT_PLACE.runningFailed, 'running-failed', null),
    tools, maxRounds: a.maxRounds, roundsAssumed: a.roundsAssumed,
    maxToolCalls: a.maxToolCalls, toolCallsAssumed: a.toolCallsAssumed,
  };
  portDecls.push({ name: AGENT_PLACE.response, local: agent.response, direction: 'output' });
  return agent;
}
