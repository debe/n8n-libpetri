/**
 * Structural analysis of the main-connection graph: validation, canvas order, SCC
 * decomposition (Tarjan), edge classification for the emission rule, reachability from the
 * start node, depth (longest path in the SCC condensation, the `X_start` priority under
 * EXEC-002), the classification of `$('Y')` references (README "Expression references"),
 * the required-input facts of the join gadget and the k-safety facts the budget check needs.
 *
 * `analyse()` orchestrates the phases, each in `analysis/`; the failure vocabulary it reads per
 * node is in `failure-chain.ts`. What the compiler barrel takes from here is re-exported below.
 */
import type { WorkflowAnalysis, WorkflowDescription } from './types.js';
import { CompileError } from './errors.js';
import { canonicaliseConnections } from './analysis/connections.js';
import { findDeadInputs } from './analysis/dead-inputs.js';
import { depthOf } from './analysis/depth.js';
import { multiProducerInputsOf } from './analysis/k-safety.js';
import { assembleNodes } from './analysis/nodes.js';
import { reachableFromStarts } from './analysis/reachability.js';
import { classifyReferences } from './analysis/references.js';
import { decompose } from './analysis/scc.js';
import { wireTools } from './analysis/tools.js';
import { requirePositiveInt, validateNodes } from './analysis/validate.js';

export { retryParamsOf } from './failure-chain.js';
export { isAllRequired, joinFormOf, requiredInputsOf } from './analysis/inputs.js';
export { reachableFrom } from './analysis/reachability.js';

/**
 * The seed of `A/rounds` when the adapter could not read `options.maxIterations` statically —
 * n8n's own default for that parameter (`agents/ToolsAgent/options.ts`), so an agent left at
 * the default compiles to the bound it actually runs under.
 *
 * When the fallback is used the agent is marked {@link AnalysedNode.roundsAssumed}: the place
 * might then bind before the node's own `checkMaxIterations` does, so the verifier must not
 * claim a bound it cannot justify. It stays a *runtime* safety net either way — an agent that
 * exhausts an assumed budget stops rather than looping forever.
 */
export const DEFAULT_MAX_AGENT_ROUNDS = 10;

/**
 * The seed of `A/calls` when a workflow declares no `options.maxToolCalls`: the tool calls an
 * agent may dispatch in one execution, across every round. n8n has no such bound, so this is
 * not a fallback for one — it is the bound, and the scheduler's.
 *
 * Two pressures set it, in opposite directions, and the number serves the runtime one.
 *
 * At run time it must not bite a legitimate agent: n8n's `maxIterations` default is 10, a model
 * may make several tool calls per turn, and an agent that trips a cap it never asked for is an
 * agent whose scheduler gets switched off. Sixty-four is above any ordinary execution and still
 * a runaway guard; a run that reaches it fails by name, with the knob in the message.
 *
 * For verification it is far too large. The state-class graph explores every round size up to
 * the budget, and the state space is a product of independent counters — `A/calls`,
 * `A/outstanding`, `A/response`, and `T/in_tool` and `T/done` per tool, each 0…K — so it grows
 * polynomially, about K^3.7 in the budget and m^2.8 in the tool count: on the real two-tool
 * net, K = 4 is 7 968 classes, K = 6 is 41 697, K = 8 is 149 958, and a four-tool agent
 * truncates at 8 (`tests/spikes/agent-round.test.ts`, `docs/verification.md`). So an agent left
 * at this default verifies as `unknown` — truncated, with a report that names the assumed
 * budget and says to declare a small `options.maxToolCalls` for a complete graph. A declared
 * budget is both the runtime cap the workflow chose and the width of the claim its `proven`
 * makes; the compiler marks an assumed one so the verifier never reports a bound it invented.
 */
export const DEFAULT_MAX_AGENT_TOOL_CALLS = 64;

/** Options `analyse` reads. Kept separate from `CompileOptions`, which carries the action binder. */
export interface AnalysisOptions {
  /** Fallback seed for `A/rounds`; default {@link DEFAULT_MAX_AGENT_ROUNDS}. */
  readonly maxAgentRounds?: number;
  /** Default seed for `A/calls`; default {@link DEFAULT_MAX_AGENT_TOOL_CALLS}. */
  readonly maxAgentToolCalls?: number;
}

export function analyse(workflow: WorkflowDescription, options: AnalysisOptions = {}): WorkflowAnalysis {
  // Whatever the adapter already had to say — a policy at a version this build does not know,
  // an unknown key it ignored — carried forward so the CLI and the scheduler report it beside
  // the analysis's own findings instead of the adapter dropping it on the floor.
  const diagnostics: string[] = [...(workflow.diagnostics ?? [])];
  if (workflow.nodes.length === 0) throw new CompileError('empty-workflow', 'compile: workflow has no nodes');
  const { primaryStart, startNodes, raws, rawByName } = validateNodes(workflow, diagnostics);
  const raw = canonicaliseConnections(workflow, rawByName, diagnostics);
  const { toolConnections, toolsOf, agentsOf, mainEdges } = wireTools(workflow, rawByName, raw, diagnostics);
  const { succ, sccOf, sccs, cyclic, edges, incoming, outgoing } = decompose(raws, mainEdges);
  const reachable = reachableFromStarts(startNodes, succ, toolConnections);
  const { depth, maxDepth } = depthOf(raws, startNodes, sccs, sccOf, outgoing, toolConnections, diagnostics);
  const { referenced, seededSkipped, referencesOf } = classifyReferences(raws, startNodes, succ, reachable, diagnostics);
  const deadInputsOf = findDeadInputs(raws, incoming, diagnostics);

  const fallbackRounds = options.maxAgentRounds ?? DEFAULT_MAX_AGENT_ROUNDS;
  requirePositiveInt(fallbackRounds, 'maxAgentRounds');
  const defaultCalls = options.maxAgentToolCalls ?? DEFAULT_MAX_AGENT_TOOL_CALLS;
  requirePositiveInt(defaultCalls, 'maxAgentToolCalls');
  const { analysed, byName } = assembleNodes(
    { raws, toolsOf, agentsOf, incoming, outgoing, referencesOf, deadInputsOf, fallbackRounds, defaultCalls }, diagnostics);
  const multiProducerInputs = multiProducerInputsOf(edges);

  return {
    startNode: primaryStart, startNodes, startNodeSet: new Set(startNodes),
    nodes: analysed, byName, edges, incoming, outgoing, sccOf, sccs, cyclic, reachable,
    depth, maxDepth, hasCycle: cyclic.size > 0, multiProducerInputs, referenced, seededSkipped,
    toolConnections, agentsOf, hasAgents: toolConnections.length > 0, diagnostics,
  };
}
