/**
 * `analyse()` under the `engineV2` profile (`tasks/v2-profile-plan.md` step 4). The v1 phases
 * that model `WorkflowExecute` have no counterpart in engine v2 and are not run:
 *
 * - expression references: v2 orders a step after its incoming edges only; a `$('Y')` read
 *   does not delay it (the race is a recorded divergence, step 14);
 * - dead inputs and `requiredInputs`: v2 queues a node once every incoming edge is decided and
 *   one is live (`decideSuccessors`, `execution/settlement.ts`), whatever the node declares;
 * - skip observers: v2 announces every skip (`step:settled` for a skipped row), so there is no
 *   subset of nodes that must hear of one;
 * - `ai_tool` wiring: the converter roots the graph at the trigger through `main` only
 *   (`rootAt`, `v1-workflow-converter.ts`), so sub-nodes never become steps, and an agent fails
 *   at its first tool call (`EngineRequestNotSupportedError`, `v1-step-executor.ts`);
 * - depth: v2 has no ordering priority, so every node sits at depth 0;
 * - k-safety: v2 has no concurrency budget (`compile/options.ts` refuses one);
 * - retry and the failure policy: v2 has no retry (`api.types.ts`: "has no retry mechanism"),
 *   and a failed step fails the execution (decision 8).
 *
 * A node that declares one of those is diagnosed, never silently read. What replaces them is
 * n8n's own refusals — per node (`nodes.ts`) and per graph shape (`shape.ts`) — the loops, and
 * the compiled node set of decision 9.
 */
import { InternalCompilerError } from '../../errors.js';
import type { AnalysedNode, WorkflowAnalysis, WorkflowDescription } from '../../types.js';
import type { RawEdge } from '../connections.js';
import { joinFormOf } from '../inputs.js';
import { reachFrom } from '../reachability.js';
import { decompose } from '../scc.js';
import type { ValidatedNodes } from '../validate.js';
import { checkV2ConvertedNodes, checkV2DisabledNodes, checkV2Steps } from './nodes.js';
import { checkV2Shape } from './shape.js';

/** The profile-neutral phases' results `analyse()` hands over. */
export interface EngineV2Input {
  readonly workflow: WorkflowDescription;
  readonly validated: ValidatedNodes;
  /** The validated, deduplicated main connections in canonical order. */
  readonly raw: readonly RawEdge[];
  /** `v2TriggerOf(workflow)`, which is also `validated.primaryStart`. */
  readonly trigger: string;
}

/** The `engineV2` analysis of a workflow the profile-neutral phases accepted. */
export function analyseEngineV2(
  { workflow, validated, raw, trigger }: EngineV2Input,
  diagnostics: string[],
): WorkflowAnalysis {
  const { raws, startNodes } = validated;
  for (const c of workflow.toolConnections ?? []) {
    diagnostics.push(
      `ai_tool connection ${c.tool} -> ${c.agent} is ignored under engineV2: engine v2 roots the graph at the ` +
      'trigger through main connections only, and fails an agent at its first tool call');
  }
  const { sccOf, sccs, cyclic, edges, incoming, outgoing } = decompose(raws, raw);
  // The refusals, in the order n8n reaches them (`nodes.ts`): `rootAt` keeps what the trigger
  // reaches, the converter checks each live node, splices the disabled ones and marks the back
  // edges; the engine validates the graph; a step with no executor fails to settle at run time.
  const succ = new Map<string, string[]>(raws.map((r) => [r.node.name, []]));
  for (const e of edges) succ.get(e.from)!.push(e.to);
  const rooted = reachFrom([trigger], succ, null);
  checkV2ConvertedNodes(raws, rooted, trigger, incoming);
  checkV2DisabledNodes(raws, rooted);
  const { reachable, engineV2 } = checkV2Shape({ nodes: raws.map((r) => r.node), edges, trigger });
  checkV2Steps(raws, reachable);

  // Decision 9: every compiled node other than the trigger has an incoming edge. A node without
  // one would get a skip whose only arcs are inhibitors, enabled forever. Reachability over the
  // edges makes this true by construction; the assertion keeps it true.
  for (const n of reachable) {
    if (n !== trigger && incoming.get(n)!.length === 0) {
      throw new InternalCompilerError(`internal: engineV2 node '${n}' is compiled but has no incoming edge`);
    }
  }

  const nodes: AnalysedNode[] = [];
  const byName = new Map<string, AnalysedNode>();
  for (const r of raws) {
    const name = r.node.name;
    if (!reachable.has(name)) {
      diagnostics.push(
        `node '${name}' is not reachable from the trigger; engine v2 owes it no step ` +
        '(countExpectedSettledSteps), so it is not compiled under engineV2');
    }
    if (r.node.retryOnFail === true) {
      diagnostics.push(`node '${name}' has retryOnFail; engine v2 has no retry, so it is ignored under engineV2`);
    }
    if (r.node.executionPolicy !== undefined) {
      diagnostics.push(`node '${name}' declares an executionPolicy; engine v2 has none, so it is ignored under engineV2`);
    }
    if (r.shape.requiredInputs !== undefined) {
      diagnostics.push(
        `node '${name}' declares requiredInputs; engine v2 queues a node once any input is live, so they are ` +
        'ignored under engineV2');
    }
    for (const ref of r.rawReferences) {
      diagnostics.push(
        `node '${name}' references '${ref}'; engine v2 does not order a step after the nodes its expressions ` +
        'read, so the reference is ignored under engineV2');
    }
    const a: AnalysedNode = {
      node: r.node, shape: r.shape, index: r.index, outputCount: r.outputCount,
      errorOutputIndex: r.errorOutputIndex, onError: r.onError, retry: null, references: [],
      allRequired: false, requiredInputs: null, deadInputs: [], isTool: false,
      // The v1 input form, kept because the field is required; the settlement gadget does not
      // read it (decision 3: every incoming edge is its own `arrived` place).
      form: joinFormOf({ isTool: false, deadInputs: [], requiredInputs: null }, incoming.get(name)!),
      tools: [], maxRounds: null, roundsAssumed: false, maxToolCalls: null, toolCallsAssumed: false,
      failure: null,
    };
    nodes.push(a);
    byName.set(name, a);
  }

  return {
    profile: 'engineV2', startNode: trigger, startNodes, startNodeSet: new Set(startNodes),
    nodes, byName, edges, incoming, outgoing, sccOf, sccs, cyclic, reachable,
    depth: new Map(raws.map((r) => [r.node.name, 0])), maxDepth: 0, hasCycle: cyclic.size > 0,
    multiProducerInputs: [], referenced: new Set(), seededSkipped: new Set(), skipObservable: new Set(),
    toolConnections: [], agentsOf: new Map(), hasAgents: false, engineV2, diagnostics,
  };
}
