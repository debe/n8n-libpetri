/**
 * The agent's tool round (ADR 0008): n8n's `EngineRequest` planned into the round's tokens, and
 * the actions of `A_done_req`, `A_dispatch`, `A_calls_out`, `A_resume` and `A_rounds_out`. The
 * round is the net's, not a host loop: nothing here enqueues on the host.
 */
import type { TransitionAction, TransitionContext } from 'libpetri';
import type { EngineRequest, IExecuteData, INodeExecutionData, ITaskDataConnections } from 'n8n-workflow';
import type { AgentGadget, NetMapView, NodeGadget } from '../compiler/index.js';
import type { PlannedNode } from '../n8n/host.js';
import { envOf, type ExecutionEnv } from './env.js';
import { engineRequestUnsupported, InternalSchedulerError } from './errors.js';
import { dispatchOf, take, type Outcome } from './outcomes.js';
import {
  isRequestPayload, isRoundPayload,
  type DispatchPayload, type RequestPayload, type RoundPayload, type RunPayload, type StoppedPayload,
} from './payloads.js';

/**
 * The `IExecuteData` of one planned activation, exactly as `addNodeToBeExecuted` builds it for a
 * node with at most one `main` input (`workflow-execute.ts:800-855`).
 *
 * Every entry of a round is such a node: a tool has no `main` producer at all, and an agent has
 * one. The multi-input half of that function — `waitingExecution`, the sibling walk — is
 * therefore unreachable here, and {@link planRound} refuses rather than guesses if a workflow
 * ever presents an agent wired otherwise.
 */
function plannedEntry(env: ExecutionEnv, e: PlannedNode): IExecuteData {
  const node = env.workflow.nodes[e.inputConnectionData.node];
  if (node === undefined) {
    throw new Error(`n8n-libpetri: planned activation for unknown node '${e.inputConnectionData.node}'`);
  }
  const main: Array<INodeExecutionData[] | null> = [];
  for (let i = e.inputConnectionData.index; i >= 0; i--) main[i] = null;
  main[e.inputConnectionData.index] = e.parentOutputData[e.parentOutputIndex] ?? null;
  return {
    node,
    data: { main } as ITaskDataConnections,
    source: {
      main: [{
        previousNode: e.parentNode,
        previousNodeOutput: e.parentOutputIndex,
        previousNodeRun: e.runIndex,
      }],
    },
    runIndex: e.nodeRunIndex,
    ...(e.metadata === undefined ? {} : { metadata: e.metadata }),
  } as IExecuteData;
}

/**
 * Lines 163–174: the agent's `EngineRequest`, planned but not dispatched.
 *
 * n8n's `handleEngineRequest` plans the round *and* pushes it onto `nodeExecutionStack`.
 * `planEngineRequest` is the same call without the push, so we get n8n's own plan — the
 * reserved `runData` slots, the `rewireOutputLogTo` tag, the `preservedSourceOverwrite`
 * metadata — and the net decides when any of it runs. Nothing is ever enqueued on the host:
 * `FakeHost.addNodeToBeExecuted` throws precisely to keep that true.
 *
 * `handleRequest` reverses the actions under v1 and `unshift`s the agent's own re-entry first,
 * so the plan reads `[agent, tool_m … tool_1]`. Reversing it back gives the request order the
 * queue dispatches in, with the agent's re-entry separated out.
 */
export function planRound(
  env: ExecutionEnv,
  g: NodeGadget,
  run: RunPayload,
  runIndex: number,
  request: EngineRequest,
): Outcome | null {
  const { host, workflow, runExecutionData } = env;
  const { executionData } = run;
  const executionNode = executionData.node;
  // Whether the node has a round to open is decided *after* the plan, not before it: n8n
  // reserves the requested nodes' run-data slots inside `handleRequest` even on the path where
  // it then schedules nothing, and a request that plans nothing dispatches nothing, so it needs
  // no round and no `ai_tool` connection. The per-entry check below is what refuses a dispatch
  // the net cannot route.
  const planned = host.planEngineRequest({
    workflow, currentNode: executionNode, request, runIndex, executionData,
    runData: runExecutionData.resultData.runData,
  });
  // n8n returns nothing when the parent node cannot be found and reports it; the round never
  // opens and the activation produced no output, which is what its own loop does next.
  if (planned.length === 0) {
    env.diagnostic(
      `node '${executionNode.name}': engine request could not be planned (no parent node); ` +
      'no tool round is opened and the activation produces no output, as n8n does');
    return null;
  }
  const [resumePlan, ...toolPlans] = planned;
  if (resumePlan === undefined || resumePlan.inputConnectionData.node !== executionNode.name) {
    throw new InternalSchedulerError(
      `internal: node '${executionNode.name}' planned a round whose first entry is ` +
      `'${resumePlan?.inputConnectionData.node}'; expected the agent's own re-entry`);
  }
  for (const e of planned) {
    // The single-input assumption `plannedEntry` rests on. n8n would route a multi-input node
    // through `waitingExecution` instead, and no agent or tool node is one.
    const inputs = workflow.connectionsByDestinationNode[e.inputConnectionData.node]?.main?.length ?? 0;
    if (inputs > 1) {
      throw new Error(
        `n8n-libpetri: tool round for '${executionNode.name}' includes '${e.inputConnectionData.node}', ` +
        `which has ${inputs} main inputs; agent and tool activations must have at most one`);
    }
  }
  // `handleRequest` reversed the actions so a LIFO stack would run them in request order; we
  // dispatch from the head of a queue, so reverse them back.
  const pending = toolPlans.reverse().map((e) => plannedEntry(env, e));
  const tools: readonly string[] = g.agent?.tools ?? [];
  for (const entry of pending) {
    if (!tools.includes(entry.node.name)) {
      // n8n dispatches by node *name* and never consults the connections; the net dispatches by
      // the `ai_tool` connection the workflow draws, so an action naming an unwired node cannot
      // be routed (divergence #22). Fail by name rather than dispatching a prefix of the round.
      throw engineRequestUnsupported(executionNode, entry.node.name);
    }
  }
  if (g.agent === null) throw engineRequestUnsupported(executionNode);
  const resume = plannedEntry(env, resumePlan);
  const payload: RequestPayload = {
    kind: 'request',
    pending,
    resume,
    roundId: `${executionNode.name}#${runIndex}`,
    // A tool that is itself an agent opens its own round, but its answer still goes to the agent
    // that dispatched it: the address rides on the round's tokens ({@link RequestPayload.answers}).
    ...(g.form === 'tool' ? { answers: dispatchOf(g, run) } : {}),
  };
  return { kind: 'request', payload };
}

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
    const next: RunPayload = {
      kind: 'run', executionData: round.resume, attempt: 0, roundId: round.roundId,
      toolCallsExceeded: { undispatched: queue.pending.length, budget: agent.maxToolCalls },
      ...reentry(g, round),
    };
    ctx.output(g.running, next);
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
 * `A_resume`: nothing left to dispatch and nothing still out, so the agent re-enters `X_run`
 * with the entry n8n built for it — `metadata.nodeWasResumed` suppresses the second
 * `nodeExecuteBefore` hook and `metadata.subNodeExecutionData` is what
 * `host.collectSubNodeResults` reads the round's `EngineResponse` back out of.
 */
export function resumeAction(g: NodeGadget): TransitionAction {
  const agent = agentOf(g);
  return async (ctx) => {
    const payload = take(ctx, agent.dispatched, isRoundPayload);
    const next: RunPayload = {
      kind: 'run', executionData: payload.resume, attempt: 0, roundId: payload.roundId, ...reentry(g, payload),
    };
    ctx.output(g.running, next);
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
