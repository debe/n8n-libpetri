/**
 * n8n `Workflow` → the compiler's structural {@link WorkflowDescription}. Everything
 * n8n-specific the compiler must not know lives here:
 *
 * - nodes from `workflow.nodes` (`id`, `name`, `type`, `typeVersion`, `position`,
 *   `disabled`, `onError`, `retryOnFail`, `maxTries`, `waitBetweenTries`);
 * - main connections from `workflow.connectionsBySourceNode[*].main`; a connection to a
 *   node the workflow does not contain is dropped (n8n throws `Destination node not found`
 *   only when the producer runs; the compiler would reject the whole workflow up front);
 * - node-type shapes through `workflow.nodeTypes.getByNameAndVersion` and the injected
 *   `NodeHelpers.getNodeInputs` / `getNodeOutputs` (evaluated against the node's
 *   parameters), counting `main` connections only. `getNodeOutputs` already appends the
 *   error output under `onError: 'continueErrorOutput'` (`node-helpers.ts`, the
 *   `{ category: 'error' }` entry), and the compiler appends it too, so one is subtracted:
 *   the shape's `outputCount` is the declared main outputs without the error output;
 * - `requiredInputs` from the type description; a string form is evaluated with
 *   `workflow.expression.getSimpleParameterValue(node, expr, mode, { $version }, undefined,
 *   [])`, the call `stack-scheduler.ts`'s stuck-join fallback makes (lines 396–404), and the
 *   result is narrowed to the shapes that fallback can act on ({@link normaliseRequiredInputs});
 * - `loopNode` for `n8n-nodes-base.splitInBatches` (every version);
 * - expression references by scanning every string in the node's parameters for
 *   `$('name')` / `$("name")` / `` $(`name`) ``, `$node["name"]` / `$node['name']`,
 *   `$node.name` and `$items("name")` / `$items('name')`, kept when `name` is a node of
 *   the workflow (self references are classified by the compiler);
 * - start nodes: every node on `executionData.nodeExecutionStack` (the first one is the
 *   primary) plus every node with `runData`, so a resumed execution is compiled from what
 *   already ran.
 */
import type {
  INode, IRunExecutionData, Workflow, WorkflowExecuteMode, INodeInputConfiguration, INodeOutputConfiguration,
  NodeConnectionType,
} from 'n8n-workflow';
import type { MainConnection, NodeDescription, NodeTypeShape, WorkflowDescription } from '../compiler/index.js';
import type { NodeHelpersLike } from './host.js';

/** Node types compiled as Loop Over Items (informational, carried into `NetMap`). */
export const LOOP_NODE_TYPES: ReadonlySet<string> = new Set(['n8n-nodes-base.splitInBatches']);

export interface AdapterOptions {
  readonly nodeHelpers: NodeHelpersLike;
  /** The mode `requiredInputs` expressions are evaluated under (n8n uses the execution's). Default `'internal'`. */
  readonly mode?: WorkflowExecuteMode;
}

const isMain = (c: NodeConnectionType | INodeInputConfiguration | INodeOutputConfiguration): boolean =>
  (typeof c === 'string' ? c : c.type) === 'main';

/**
 * The reference patterns, applied to every string parameter value:
 * 1. `$('name')`, `$("name")`, `` $(`name`) `` — the modern node accessor;
 * 2. `$node["name"]`, `$node['name']` — the legacy accessor, bracket form;
 * 3. `$node.name` — the legacy accessor, dot form (identifier names only);
 * 4. `$items("name", …)`, `$items('name', …)` — the legacy items helper.
 */
const REFERENCE_PATTERNS: readonly RegExp[] = [
  /\$\(\s*'([^']+)'\s*\)/g,
  /\$\(\s*"([^"]+)"\s*\)/g,
  /\$\(\s*`([^`]+)`\s*\)/g,
  /\$node\[\s*'([^']+)'\s*\]/g,
  /\$node\[\s*"([^"]+)"\s*\]/g,
  /\$node\.([A-Za-z_$][\w$]*)/g,
  /\$items\(\s*'([^']+)'/g,
  /\$items\(\s*"([^"]+)"/g,
];

/** Node names referenced by the expressions in `parameters` (any nesting), in first-seen order. */
export function scanExpressionReferences(parameters: unknown, nodeNames: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const re of REFERENCE_PATTERNS) {
        re.lastIndex = 0;
        for (let m = re.exec(v); m !== null; m = re.exec(v)) {
          const name = m[1]!;
          if (nodeNames.has(name) && !found.includes(name)) found.push(name);
        }
      }
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x);
    } else if (typeof v === 'object' && v !== null) {
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(parameters);
  return found;
}

/** `workflow.connectionsBySourceNode[*].main` as compiler connections; dangling targets dropped. */
export function mainConnectionsOf(workflow: Workflow): MainConnection[] {
  const out: MainConnection[] = [];
  for (const [from, byType] of Object.entries(workflow.connectionsBySourceNode)) {
    if (!Object.hasOwn(workflow.nodes, from)) continue;
    const main = byType?.main ?? [];
    main.forEach((connections, outputIndex) => {
      for (const c of connections ?? []) {
        if (c.type !== 'main' || !Object.hasOwn(workflow.nodes, c.node)) continue;
        out.push({ from, outputIndex, to: c.node, inputIndex: c.index });
      }
    });
  }
  return out;
}

/**
 * `requiredInputs` in the only two shapes n8n's stuck-join fallback can act on: an array of
 * input indexes, or a count (`stack-scheduler.ts:395-416` and `444-465`). n8n reaches those
 * lines with whatever the type description holds — the string form already evaluated — and
 * every other value falls through every branch there: `Array.isArray` is false, `=== inputs.length`
 * is false for a non-number, and `inputsWithData.length < value` is false for a non-number. So
 * anything else means the same as `undefined`, and a node type built by a test mock (a proxy on
 * every property) must not reach the compiler, whose contract is `number | readonly number[]`.
 */
function normaliseRequiredInputs(raw: unknown): number | number[] | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (!Array.isArray(raw)) return undefined;
  return raw.every((i) => typeof i === 'number' && Number.isFinite(i)) ? [...(raw as number[])] : undefined;
}

/** The compiler's view of one node type, evaluated for `node`. */
export function nodeShapeOf(workflow: Workflow, node: INode, options: AdapterOptions): NodeTypeShape {
  const description = workflow.nodeTypes.getByNameAndVersion(node.type, node.typeVersion).description;
  const inputs = options.nodeHelpers.getNodeInputs(workflow, node, description).filter(isMain);
  const outputs = options.nodeHelpers.getNodeOutputs(workflow, node, description).filter(isMain);
  const errorOutputs = node.onError === 'continueErrorOutput' ? 1 : 0;
  const declaredOutputs = outputs.slice(0, outputs.length - errorOutputs);
  const raw = typeof description.requiredInputs === 'string'
    ? workflow.expression.getSimpleParameterValue(
      node, description.requiredInputs, options.mode ?? 'internal', { $version: node.typeVersion }, undefined, [])
    : description.requiredInputs;
  const requiredInputs = normaliseRequiredInputs(raw);
  // Labels only (NetMap, and part of the structural hash): a non-string is no name.
  const named = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const outputNames = declaredOutputs.map((o, i) =>
    (typeof o === 'string' ? named(description.outputNames?.[i]) : named(o.displayName ?? description.outputNames?.[i])));
  return {
    inputCount: inputs.length,
    outputCount: declaredOutputs.length,
    ...(requiredInputs === undefined ? {} : { requiredInputs }),
    ...(LOOP_NODE_TYPES.has(node.type) ? { loopNode: true } : {}),
    ...(outputNames.some((n) => n !== null) ? { outputNames: outputNames.map((n) => n ?? '') } : {}),
  };
}

/** Every node on `nodeExecutionStack` (the first is the primary) plus every node with `runData`. */
export function startNodesOf(runExecutionData: IRunExecutionData): string[] {
  const names: string[] = [];
  for (const e of runExecutionData.executionData?.nodeExecutionStack ?? []) {
    if (!names.includes(e.node.name)) names.push(e.node.name);
  }
  for (const [name, tasks] of Object.entries(runExecutionData.resultData?.runData ?? {})) {
    if (tasks.length > 0 && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The subnet prefix of a node: its `id` (a UUID in n8n), unless it is missing, contains the
 * MOD-010 separator `/` or repeats an earlier node's — then `n<index>` in `workflow.nodes` order.
 */
function prefixOf(node: INode, index: number, used: Set<string>): string {
  const id = typeof node.id === 'string' && node.id.length > 0 && !node.id.includes('/') && !used.has(node.id)
    ? node.id
    : `n${index}`;
  used.add(id);
  return id;
}

export function describeWorkflow(
  workflow: Workflow,
  runExecutionData: IRunExecutionData,
  options: AdapterOptions,
): WorkflowDescription {
  const names = new Set(Object.keys(workflow.nodes));
  const used = new Set<string>();
  const shapes = new Map<string, NodeTypeShape>();
  const references = new Map<string, string[]>();
  const nodes: NodeDescription[] = Object.values(workflow.nodes).map((node, index) => {
    shapes.set(node.name, nodeShapeOf(workflow, node, options));
    references.set(node.name, scanExpressionReferences(node.parameters, names));
    return {
      id: prefixOf(node, index, used),
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
      position: [node.position[0], node.position[1]],
      ...(node.disabled === undefined ? {} : { disabled: node.disabled }),
      ...(node.onError === undefined ? {} : { onError: node.onError }),
      ...(node.retryOnFail === undefined ? {} : { retryOnFail: node.retryOnFail }),
      ...(node.maxTries === undefined ? {} : { maxTries: node.maxTries }),
      ...(node.waitBetweenTries === undefined ? {} : { waitBetweenTries: node.waitBetweenTries }),
    };
  });
  const startNodes = startNodesOf(runExecutionData);
  return {
    id: workflow.id,
    ...(workflow.name === undefined ? {} : { name: workflow.name }),
    nodes,
    connections: mainConnectionsOf(workflow),
    startNodes,
    nodeTypes: (n) => shapes.get(n.name)!,
    expressionReferences: (n) => references.get(n.name) ?? [],
  };
}
