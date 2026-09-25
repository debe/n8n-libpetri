/**
 * n8n `Workflow` → the compiler's structural {@link WorkflowDescription}. Everything
 * n8n-specific the compiler must not know lives here and under `adapter/`:
 *
 * - nodes from `workflow.nodes` (`id`, `name`, `type`, `typeVersion`, `position`,
 *   `disabled`, `onError`, `retryOnFail`, `maxTries`, `waitBetweenTries`);
 * - main connections from `workflow.connectionsBySourceNode[*].main`; a connection to a
 *   node the workflow does not contain is dropped (n8n throws `Destination node not found`
 *   only when the producer runs; the compiler would reject the whole workflow up front) —
 *   `adapter/graph.ts`;
 * - node-type shapes through `workflow.nodeTypes.getByNameAndVersion` and the injected
 *   `NodeHelpers.getNodeInputs` / `getNodeOutputs` (evaluated against the node's
 *   parameters), counting `main` connections only. `getNodeOutputs` already appends the
 *   error output under `onError: 'continueErrorOutput'` (`node-helpers.ts`, the
 *   `{ category: 'error' }` entry), and the compiler appends it too, so one is subtracted:
 *   the shape's `outputCount` is the declared main outputs without the error output —
 *   `adapter/shape.ts`;
 * - `requiredInputs` from the type description; a string form is evaluated with
 *   `workflow.expression.getSimpleParameterValue(node, expr, mode, { $version }, undefined,
 *   [])`, the call `stack-scheduler.ts`'s stuck-join fallback makes (lines 396–404), and the
 *   result is narrowed to the shapes that fallback can act on (`adapter/shape.ts`);
 * - `loopNode` for `n8n-nodes-base.splitInBatches` (every version);
 * - expression references by scanning every string in the node's parameters for
 *   `$('name')` / `$("name")` / `` $(`name`) ``, `$node["name"]` / `$node['name']`,
 *   `$node.name` and `$items("name")` / `$items('name')`, kept when `name` is a node of
 *   the workflow (self references are classified by the compiler) — `adapter/references.ts`;
 * - the execution policy, resolved once for this adapter and the verify CLI —
 *   `adapter/policy.ts`;
 * - what only an `engineV2` compile reads: a Merge's `mode`, a Split In Batches' batch
 *   configuration and the non-`main` connection types a node is the source of — `adapter/engine-v2.ts`;
 * - start nodes: every node on `executionData.nodeExecutionStack` (the first one is the
 *   primary) plus every node with `runData`, so a resumed execution is compiled from what
 *   already ran — `adapter/start-nodes.ts`.
 */
import type { IRunExecutionData, Workflow } from 'n8n-workflow';
import type { NodeDescription, NodeTypeShape, WorkflowDescription } from '../compiler/index.js';
import { mainConnectionsOf, scheduledNodesOf, subNodeSourcesOf, toolConnectionsOf } from './adapter/graph.js';
import { liveNodeDescription, nodePrefixOf } from './adapter/node.js';
import { nodePolicyOf, workflowPolicyOf } from './adapter/policy.js';
import { scanExpressionReferences } from './adapter/references.js';
import { nodeShapeOf, recordedLookups } from './adapter/shape.js';
import type { AdapterOptions } from './adapter/shape.js';
import { startNodesOf } from './adapter/start-nodes.js';

// The adapter's surface is this module. `readers`, `references`, `shape` and `start-nodes`
// are re-exported entire; `graph`, `policy` and `node` name what they add to it.
export * from './adapter/readers.js';
export * from './adapter/references.js';
export * from './adapter/shape.js';
export * from './adapter/start-nodes.js';
export {
  NON_EXECUTABLE_TYPES, isSchedulerNode, mainConnectionsOf, subNodeSourcesIn, subNodeSourcesOf, toolConnectionsOf,
} from './adapter/graph.js';
export {
  inheritableWorkflowPolicy, nodePolicyOf, parseWorkflowPolicy, resolveNodePolicy, workflowPolicyOf,
} from './adapter/policy.js';
export { nodePrefixOf } from './adapter/node.js';
export { aiOutputsOf, batchDescriptionOf, engineV2FieldsOf, strayConnectionsIn } from './adapter/engine-v2.js';

export function describeWorkflow(
  workflow: Workflow,
  runExecutionData: IRunExecutionData,
  options: AdapterOptions,
): WorkflowDescription {
  const names = new Set(Object.keys(workflow.nodes));
  const used = new Set<string>();
  const shapes = new Map<string, NodeTypeShape>();
  const references = new Map<string, string[]>();
  const policyDiagnostics: string[] = [];
  const workflowPolicy = workflowPolicyOf(workflow, policyDiagnostics);

  // The scheduler's graph, not the canvas's: annotations and `supplyData` sub-nodes are
  // dropped before anything is compiled, so the net holds only nodes that can run.
  const mainConnections = mainConnectionsOf(workflow);
  const toolConnections = toolConnectionsOf(workflow);
  const { scheduled, diagnostics: dropped } = scheduledNodesOf(
    Object.values(workflow.nodes), mainConnections, toolConnections, subNodeSourcesOf(workflow));
  policyDiagnostics.push(...dropped);

  const nodes: NodeDescription[] = scheduled.map((node, index) => {
    shapes.set(node.name, nodeShapeOf(workflow, node, options));
    references.set(node.name, scanExpressionReferences(node.parameters, names));
    const policy = nodePolicyOf(node, workflow, workflowPolicy, policyDiagnostics);
    return liveNodeDescription(node, nodePrefixOf(node.id, index, used), policy,
      workflow.connectionsBySourceNode[node.name]);
  });
  return {
    ...(policyDiagnostics.length === 0 ? {} : { diagnostics: policyDiagnostics }),
    id: workflow.id,
    ...(workflow.name === undefined ? {} : { name: workflow.name }),
    nodes,
    connections: mainConnections,
    toolConnections,
    startNodes: startNodesOf(runExecutionData),
    ...recordedLookups(shapes, references),
  };
}
