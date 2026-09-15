/**
 * An n8n workflow **JSON export** → the compiler's `WorkflowDescription`.
 *
 * `src/n8n/adapter.ts` builds a description from a live `Workflow` object, where
 * `NodeHelpers.getNodeInputs` / `getNodeOutputs` evaluate the node type's `inputs` /
 * `outputs` expressions against the node's parameters. A JSON export carries **no node type
 * descriptions at all**, so those counts cannot be read — they have to be supplied or
 * guessed. That is the one real limitation of the CLI, and it is not hidden: every node
 * whose shape was guessed lands in {@link WorkflowJsonResult.warnings}, and the CLI prints
 * them above the table.
 *
 * Resolution order per node, first hit wins:
 *
 * 1. an entry in the `--node-types` file keyed by node **name** (`"nodes"` map);
 * 2. an entry keyed by `type@typeVersion`, then by `type` (`"types"` map);
 * 3. {@link BUILT_IN_SHAPES} — the handful of core n8n types whose port counts are fixed
 *    and whose miscount would change the compiled model (If, Filter, Merge, Loop Over
 *    Items, Compare Datasets), plus the trigger rule below;
 * 4. the **connection heuristic**: `inputCount` = one more than the highest `inputIndex`
 *    any connection targets (0 for a node with no incoming connection whose type looks like
 *    a trigger, 1 otherwise), `outputCount` = one more than the highest `outputIndex` any
 *    connection leaves from (1 when none).
 *
 * What the heuristic cannot see, and what it costs:
 *
 * - **An unconnected output.** n8n's emission rule only ever writes to connected outputs
 *   (unconnected outputs get no places), so a missed output changes nothing — except for a
 *   node with `onError: 'continueErrorOutput'`, where the compiler appends the error output
 *   at index `outputCount`. The heuristic therefore treats the highest connected index of
 *   such a node as the error output and reports `outputCount = maxIndex`. If the error
 *   output is not wired, that guess is wrong by one and the error branch would be modelled
 *   as a normal output.
 * - **`requiredInputs`.** A Merge in `chooseBranch` mode requires data on the inputs it
 *   names; nothing in the export says so except `parameters.mode`, so
 *   {@link BUILT_IN_SHAPES} reads that one parameter and nothing else. Any other node type
 *   with a `requiredInputs` description compiles as a generic join.
 * - **A dynamic `inputs` expression.** Merge's `numberInputs` is read; every other dynamic
 *   port count falls to the connection heuristic, which cannot see an input nobody wired —
 *   and an all-required node with an unwired lower input is exactly the workflow the dead
 *   join diagnostic is for. Supply `--node-types` for such a workflow.
 *
 * The start node is the first node with no incoming main connection, preferring one whose
 * type looks like a trigger, in canvas order; `--start` overrides it.
 *
 * The parts live under `workflow-json/`: the `--node-types` file, node entries, connections,
 * shapes and the start node. This module assembles the description and re-exports them.
 */
import type { ExecutionPolicy, NodeTypeShape, WorkflowDescription } from '../compiler/index.js';
import { scheduledNodesOf } from '../n8n/adapter/graph.js';
import { parseWorkflowPolicy, policyFieldsOf, resolveNodePolicy } from '../n8n/adapter/policy.js';
import { recordOf } from '../n8n/adapter/readers.js';
import { scanExpressionReferences } from '../n8n/adapter/references.js';
import { recordedLookups } from '../n8n/adapter/shape.js';
import { asRecord } from './workflow-json/checked.js';
import { connectionsOf } from './workflow-json/connections.js';
import type { NodeTypesFile } from './workflow-json/node-types-file.js';
import { nodesOf } from './workflow-json/nodes.js';
import type { JsonNodes } from './workflow-json/nodes.js';
import { shapeOf } from './workflow-json/shapes.js';
import { startNodeOf } from './workflow-json/start-node.js';

export { parseNodeTypesFile } from './workflow-json/node-types-file.js';
export type { NodeTypesFile } from './workflow-json/node-types-file.js';
export { connectionsOf } from './workflow-json/connections.js';
export { BUILT_IN_SHAPES, shapeOf } from './workflow-json/shapes.js';
export { looksLikeTrigger, pickStartNode } from './workflow-json/start-node.js';

export interface WorkflowJsonResult {
  readonly description: WorkflowDescription;
  /**
   * Every node whose shape was guessed, and how. Printed by the CLI, never swallowed, and
   * carried into the report as its `shapeWarnings` — so *only* shape guesses belong here.
   * Anything else read off the export that is worth saying (a dropped connection, a policy
   * this build does not inherit) rides {@link WorkflowDescription.diagnostics} instead.
   */
  readonly warnings: readonly string[];
}

export interface WorkflowJsonOptions {
  readonly nodeTypes?: NodeTypesFile;
  /** Overrides the start-node choice. */
  readonly startNode?: string;
}

/**
 * Every node's resolved policy, by name — the dropped nodes' included.
 *
 * The same carrier, the same non-inheritance rule and the same precedence the live adapter
 * uses — `parseWorkflowPolicy` and `resolveNodePolicy` *are* the adapter's, handed the raw
 * JSON. One net serves execution and verification, and a CLI that read the policy
 * differently — or not at all — would analyse a different net and report it with the same
 * confidence.
 */
function policiesOf(settings: unknown, { nodes, records }: JsonNodes, diagnostics: string[]): Map<string, ExecutionPolicy> {
  const workflowPolicy = parseWorkflowPolicy(settings, diagnostics);
  const policies = new Map<string, ExecutionPolicy>();
  nodes.forEach((node, i) => {
    const merged = resolveNodePolicy(records[i]!['executionPolicy'], node.name, settings, workflowPolicy, diagnostics);
    if (merged !== undefined) policies.set(node.name, merged);
  });
  return policies;
}

/** Parses an n8n workflow JSON export (the object, not the text). */
export function describeWorkflowJson(raw: unknown, options: WorkflowJsonOptions = {}): WorkflowJsonResult {
  const root = asRecord(raw, 'workflow');
  const json = nodesOf(root);
  const { names } = json;
  const parsed = connectionsOf(root['connections'], names);
  const connections = parsed.connections;

  // The scheduler's graph, not the canvas's — the same rule `n8n/adapter.ts` applies to a live
  // `Workflow`, because one net serves execution and verification and a CLI that analysed a
  // different set of nodes would report about a different net.
  const { scheduled, diagnostics: dropped } = scheduledNodesOf(
    json.nodes, connections, parsed.toolConnections, parsed.subNodeSources);

  // Keyed by name off the **unfiltered** list: the records and `nodes` are index-aligned, and
  // dropping entries from `nodes` first would desynchronise them.
  const parametersOf = new Map<string, Record<string, unknown>>(
    json.nodes.map((n, i) => [n.name, recordOf(json.records[i]!['parameters']) ?? {}]));

  const warnings: string[] = [];
  const shapes = new Map<string, NodeTypeShape>(scheduled.map((node) => [
    node.name, shapeOf(node, parametersOf.get(node.name) ?? {}, connections, options.nodeTypes ?? {}, warnings)]));

  // Policy notes and dropped connections are *diagnostics*, not shape guesses: `warnings` is
  // the CLI's "the compiled net may differ from the workflow" list, and a policy this build
  // chose to ignore is a different kind of statement. They ride the description's own channel.
  const policyDiagnostics: string[] = [...parsed.diagnostics];
  const policies = policiesOf(root['settings'], json, policyDiagnostics);

  const startNode = startNodeOf(options.startNode, scheduled, names, connections);

  const references = new Map<string, string[]>(scheduled.map((node) => [
    node.name, scanExpressionReferences(parametersOf.get(node.name) ?? {}, names)]));

  const diagnostics = [...dropped, ...policyDiagnostics];
  const name = root['name'];
  const id = root['id'];
  const description: WorkflowDescription = {
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    // The agent's round budget, where n8n keeps it, read by the adapter's own reader: only a
    // literal counts, and the policy's `maxToolCalls` wins over the `options` path.
    nodes: scheduled.map((n) => ({ ...n, ...policyFieldsOf(parametersOf.get(n.name), policies.get(n.name)) })),
    connections,
    toolConnections: parsed.toolConnections,
    startNode,
    ...recordedLookups(shapes, references),
  };
  return { description, warnings };
}

/** `describeWorkflowJson(JSON.parse(text))`, with a clearer error on bad JSON. */
export function parseWorkflowJson(text: string, options: WorkflowJsonOptions = {}): WorkflowJsonResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`workflow file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return describeWorkflowJson(raw, options);
}
