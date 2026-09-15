/**
 * Planning an agent's tool round (ADR 0008): n8n's `EngineRequest`, planned by n8n's own
 * `planEngineRequest`, turned into the {@link RequestPayload} that opens the round. The round's
 * actions (`round.ts`) take it from there; nothing here enqueues on the host.
 */
import type { EngineRequest, IExecuteData, INode, INodeExecutionData, ITaskDataConnections } from 'n8n-workflow';
import type { NodeGadget } from '../compiler/index.js';
import type { PlannedNode } from '../n8n/host.js';
import type { ExecutionEnv } from './env.js';
import { engineRequestUnsupported, InternalSchedulerError } from './errors.js';
import { dispatchOf, type Outcome } from './outcomes.js';
import type { RequestPayload, RunPayload } from './payloads.js';

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

/** The plan's first entry, which `handleRequest` makes the agent's own re-entry; anything else is a broken plan. */
function resumeOf(executionNode: INode, resumePlan: PlannedNode | undefined): PlannedNode {
  if (resumePlan === undefined || resumePlan.inputConnectionData.node !== executionNode.name) {
    throw new InternalSchedulerError(
      `internal: node '${executionNode.name}' planned a round whose first entry is ` +
      `'${resumePlan?.inputConnectionData.node}'; expected the agent's own re-entry`);
  }
  return resumePlan;
}

/**
 * The single-input assumption {@link plannedEntry} rests on. n8n would route a multi-input node
 * through `waitingExecution` instead, and no agent or tool node is one.
 */
function assertSingleInputs(env: ExecutionEnv, executionNode: INode, planned: readonly PlannedNode[]): void {
  for (const e of planned) {
    const inputs = env.workflow.connectionsByDestinationNode[e.inputConnectionData.node]?.main?.length ?? 0;
    if (inputs > 1) {
      throw new Error(
        `n8n-libpetri: tool round for '${executionNode.name}' includes '${e.inputConnectionData.node}', ` +
        `which has ${inputs} main inputs; agent and tool activations must have at most one`);
    }
  }
}

/**
 * n8n dispatches by node *name* and never consults the connections; the net dispatches by the
 * `ai_tool` connection the workflow draws, so an action naming an unwired node cannot be routed
 * (divergence #22). Fail by name rather than dispatching a prefix of the round.
 */
function assertWired(g: NodeGadget, executionNode: INode, pending: readonly IExecuteData[]): void {
  const tools: readonly string[] = g.agent?.tools ?? [];
  for (const entry of pending) {
    if (!tools.includes(entry.node.name)) throw engineRequestUnsupported(executionNode, entry.node.name);
  }
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
  const [first, ...toolPlans] = planned;
  const resumePlan = resumeOf(executionNode, first);
  assertSingleInputs(env, executionNode, planned);
  // `handleRequest` reversed the actions so a LIFO stack would run them in request order; we
  // dispatch from the head of a queue, so reverse them back.
  const pending = toolPlans.reverse().map((e) => plannedEntry(env, e));
  assertWired(g, executionNode, pending);
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
