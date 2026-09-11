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
  IConnection, INode, IRunExecutionData, Workflow, WorkflowExecuteMode, INodeInputConfiguration,
  INodeOutputConfiguration, NodeConnectionType,
} from 'n8n-workflow';
import type {
  MainConnection, NodeDescription, NodeTypeShape, ToolConnection, WorkflowDescription,
} from '../compiler/index.js';
import type { ExecutionPolicy } from '../compiler/index.js';
import { mergePolicies, parseExecutionPolicy, POLICY_SCHEMA_VERSION } from '../compiler/index.js';
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
/**
 * n8n node types that are annotations, not work: the canvas draws them and the engine never
 * schedules them. A quarter of the nodes in n8n's public template library are sticky notes,
 * and compiling one produces a gadget that can never fire — dead weight in the net and a
 * "this node can never run" finding that is true and useless.
 */
export const NON_EXECUTABLE_TYPES: ReadonlySet<string> = new Set([
  'n8n-nodes-base.stickyNote',
]);

/**
 * Whether a node belongs to the *scheduler's* graph at all.
 *
 * Two kinds do not. An annotation ({@link NON_EXECUTABLE_TYPES}) never runs. And a **sub-node**
 * — a language model, a memory, an output parser, an embedding — reaches its consumer over an
 * `ai_*` connection that is *not* `ai_tool`, and every one of those is resolved by `supplyData`
 * inside `runNode`, never by a scheduler (CLAUDE.md; ADR 0008). Such a node has no `main`
 * connection either way, so compiling it yields an unreachable gadget and a false dead-node
 * report — measured at 523 sticky notes and ~100 sub-nodes across 200 published templates.
 *
 * The test is deliberately conservative: a node is dropped only when it has **no** `main`
 * connection in either direction and **no** `ai_tool` connection, and does appear as the source
 * of some other `ai_*` connection. A node wired both ways keeps its gadget.
 */
export function isSchedulerNode(
  name: string,
  type: string,
  hasMain: (node: string) => boolean,
  hasToolWiring: (node: string) => boolean,
  isSubNodeSource: (node: string) => boolean,
): boolean {
  if (NON_EXECUTABLE_TYPES.has(type)) return false;
  if (hasMain(name) || hasToolWiring(name)) return true;
  return !isSubNodeSource(name);
}

/** Nodes that are the source of an `ai_*` connection other than `ai_tool`. */
export function subNodeSourcesOf(workflow: Workflow): Set<string> {
  const out = new Set<string>();
  for (const [from, byType] of Object.entries(workflow.connectionsBySourceNode)) {
    for (const key of Object.keys(byType ?? {})) {
      if (key === 'main' || key === 'ai_tool') continue;
      const groups = (byType as Record<string, unknown>)[key];
      if (Array.isArray(groups) && groups.some((g) => Array.isArray(g) && g.length > 0)) out.add(from);
    }
  }
  return out;
}

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
 * `workflow.connectionsBySourceNode[*].ai_tool` as compiler tool connections: n8n wires these
 * from the tool node into the agent, which is the direction {@link ToolConnection} keeps.
 *
 * This is the only non-`main` connection type the scheduler ever sees. Every other `ai_*` type
 * is resolved by `supplyData` inside `runNode` (`get-input-connection-data.ts`) and never
 * reaches a scheduler, so reading only this one is the whole story, not an approximation.
 */
export function toolConnectionsOf(workflow: Workflow): ToolConnection[] {
  const out: ToolConnection[] = [];
  for (const [from, byType] of Object.entries(workflow.connectionsBySourceNode)) {
    if (!Object.hasOwn(workflow.nodes, from)) continue;
    const byAiTool = (byType as Record<string, Array<IConnection[] | null> | undefined>)?.ai_tool ?? [];
    for (const connections of byAiTool) {
      for (const c of connections ?? []) {
        if (c.type !== 'ai_tool' || !Object.hasOwn(workflow.nodes, c.node)) continue;
        out.push({ agent: c.node, tool: from });
      }
    }
  }
  return out;
}

/**
 * An agent's `options.maxIterations` when it is a literal number in the workflow JSON — the
 * bound n8n's own `checkMaxIterations` enforces (`V3/helpers/executeBatch.ts`, default 10).
 *
 * Only a literal counts. n8n allows an expression on any parameter and resolves it per item at
 * execution time, so a compiled seed taken from one would be a guess; `undefined` then lets the
 * compiler fall back and mark the agent unbounded for verification rather than claim a bound.
 */
export function maxRoundsOf(node: INode): number | undefined {
  const options = (node.parameters as Record<string, unknown> | undefined)?.['options'];
  if (typeof options !== 'object' || options === null) return undefined;
  const raw = (options as Record<string, unknown>)['maxIterations'];
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * An agent's `options.maxToolCalls` when a workflow declares one as a literal. n8n's agent has
 * no such parameter, so this is forward-compatible plumbing for the scheduler's own bound: a
 * workflow that sets it gets that budget, one that does not gets `maxAgentToolCalls`.
 */
export function maxToolCallsOf(node: INode, policy?: ExecutionPolicy): number | undefined {
  if (policy?.maxToolCalls !== undefined) return policy.maxToolCalls;
  const options = (node.parameters as Record<string, unknown> | undefined)?.['options'];
  if (typeof options !== 'object' || options === null) return undefined;
  const raw = (options as Record<string, unknown>)['maxToolCalls'];
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * The workflow's declared execution policy, and the per-node policy resolved against it.
 *
 * **The carrier, and why it is where it is.** Both keys round-trip through n8n untouched:
 * `workflow.settings.executionPolicy` survives the REST DTO's `.passthrough()` schema, the
 * `@JsonColumn` on `WorkflowEntity` and the editor's spread-based settings modal, and
 * `Workflow.setSettings` stores it verbatim; a top-level `node.executionPolicy` survives the
 * DTO (which validates only that `nodes` is an array), `normalizeNodeShape`'s `{...node}` and
 * the editor's own copy loop in `nodeTransforms.ts`, which skips a fixed list of keys and
 * anything beginning with `_` — so the name must not start with an underscore.
 *
 * **`node.parameters` is not a carrier**, which is why the policy is not there.
 * `getNodeParameters` rebuilds a `collection` from the node type's *declared* options into a
 * fresh object, so an undeclared key inside `parameters.options` is dropped on the editor's
 * save path and again in the `Workflow` constructor. That is why `options.maxToolCalls` — the
 * knob the README's known limits tell users to declare — cannot be set in a live n8n at all,
 * and why {@link maxToolCallsOf} now reads the policy first and keeps the old path only for
 * the verify CLI's raw-JSON fixtures.
 */
export function workflowPolicyOf(workflow: Workflow, diagnostics: string[]): ExecutionPolicy | undefined {
  const settings = workflow.settings as Record<string, unknown> | undefined;
  const parsed = parseExecutionPolicy(settings?.['executionPolicy'], 'workflow settings');
  diagnostics.push(...parsed.diagnostics);
  return parsed.policy;
}

/** A group's policy from `settings.executionPolicy.groups`, by name. */
function groupPolicyOf(
  workflowPolicy: ExecutionPolicy | undefined, raw: unknown, group: string, diagnostics: string[],
): ExecutionPolicy | undefined {
  void workflowPolicy;
  const settings = raw as Record<string, unknown> | undefined;
  const declared = settings?.['executionPolicy'] as Record<string, unknown> | undefined;
  const groups = declared?.['groups'];
  if (typeof groups !== 'object' || groups === null) return undefined;
  const entry = (groups as Record<string, unknown>)[group];
  if (entry === undefined) return undefined;
  const parsed = parseExecutionPolicy(
    { v: POLICY_SCHEMA_VERSION, ...(entry as Record<string, unknown>) }, `group '${group}'`);
  diagnostics.push(...parsed.diagnostics);
  return parsed.policy;
}

/**
 * One node's resolved policy: workflow default, then the group it names, then its own — node
 * wins over group wins over workflow, per key.
 *
 * The group is named by the *node's* policy, so a node opts into a shared limit rather than a
 * workflow assigning one to it. That keeps the node readable on its own, which is the same
 * reason the policy sits on the node rather than in a settings map keyed by node name.
 */
export function nodePolicyOf(
  node: INode, workflow: Workflow, workflowPolicy: ExecutionPolicy | undefined, diagnostics: string[],
): ExecutionPolicy | undefined {
  const parsed = parseExecutionPolicy(
    (node as unknown as Record<string, unknown>)['executionPolicy'], `node '${node.name}'`);
  diagnostics.push(...parsed.diagnostics);
  const own = parsed.policy;
  const group = own?.concurrency?.group ?? own?.rate?.group;
  const groupPolicy = group === undefined
    ? undefined
    : groupPolicyOf(workflowPolicy, workflow.settings, group, diagnostics);
  return mergePolicies(workflowPolicy, groupPolicy, own);
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
  const policyDiagnostics: string[] = [];
  const workflowPolicy = workflowPolicyOf(workflow, policyDiagnostics);

  // The scheduler's graph, not the canvas's: annotations and `supplyData` sub-nodes are
  // dropped before anything is compiled, so the net holds only nodes that can run.
  const mainConnections = mainConnectionsOf(workflow);
  const toolConnections = toolConnectionsOf(workflow);
  const wiredMain = new Set<string>();
  for (const c of mainConnections) { wiredMain.add(c.from); wiredMain.add(c.to); }
  const wiredTool = new Set(toolConnections.flatMap((c) => [c.agent, c.tool]));
  const subNodes = subNodeSourcesOf(workflow);
  const scheduled = Object.values(workflow.nodes).filter((node) => isSchedulerNode(
    node.name, node.type, (n) => wiredMain.has(n), (n) => wiredTool.has(n), (n) => subNodes.has(n)));
  const dropped = Object.values(workflow.nodes).length - scheduled.length;
  if (dropped > 0) {
    policyDiagnostics.push(
      `${dropped} node(s) are not part of the scheduler's graph (annotations, or sub-nodes ` +
      'resolved by supplyData inside runNode) and are not compiled');
  }

  const nodes: NodeDescription[] = scheduled.map((node, index) => {
    shapes.set(node.name, nodeShapeOf(workflow, node, options));
    references.set(node.name, scanExpressionReferences(node.parameters, names));
    const policy = nodePolicyOf(node, workflow, workflowPolicy, policyDiagnostics);
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
      ...(maxRoundsOf(node) === undefined ? {} : { maxRounds: maxRoundsOf(node) }),
      ...(maxToolCallsOf(node, policy) === undefined
        ? {} : { maxToolCalls: maxToolCallsOf(node, policy) }),
      ...(policy === undefined ? {} : { executionPolicy: policy }),
    };
  });
  const startNodes = startNodesOf(runExecutionData);
  return {
    ...(policyDiagnostics.length === 0 ? {} : { diagnostics: policyDiagnostics }),
    id: workflow.id,
    ...(workflow.name === undefined ? {} : { name: workflow.name }),
    nodes,
    connections: mainConnections,
    toolConnections,
    startNodes,
    nodeTypes: (n) => shapes.get(n.name)!,
    expressionReferences: (n) => references.get(n.name) ?? [],
  };
}
