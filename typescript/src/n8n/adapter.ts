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
 * Thrown when a description is asked about a node it does not hold. The compiler only ever
 * asks about the nodes the description lists, so reaching this is a caller mixing two
 * descriptions — a bug to surface, not a shape to invent.
 */
export class UnknownNodeError extends Error {
  constructor(name: string) {
    super(`node '${name}' is not part of this workflow description`);
    this.name = 'UnknownNodeError';
  }
}

// ==================== the two readers every carrier goes through ====================
//
// n8n hands the adapter typed objects whose *policy* fields are untyped passthroughs
// (`workflow.settings.executionPolicy`, `node.executionPolicy`, `parameters.options.*`), and
// the verify CLI hands the same readers raw JSON. Both are `unknown` at the edge; these two
// functions are the only place that edge is narrowed, so no call site casts.

/** `v` as a string-keyed record, or `undefined` when it is not a plain object. */
export function recordOf(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

/** `v[key]` when `v` is a plain object; `undefined` otherwise. */
export function fieldOf(v: unknown, key: string): unknown {
  return recordOf(v)?.[key];
}

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

/**
 * Nodes that are the source of an `ai_*` connection other than `ai_tool`, read off a
 * connections-by-source map in n8n's shape (`{ "<from>": { "<type>": [ [ … ] ] } }`) — the
 * live `Workflow`'s or a JSON export's, which is why it takes the map and not the workflow.
 */
export function subNodeSourcesIn(bySource: Readonly<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const [from, byType] of Object.entries(bySource)) {
    for (const [key, groups] of Object.entries(recordOf(byType) ?? {})) {
      if (key === 'main' || key === 'ai_tool') continue;
      if (Array.isArray(groups) && groups.some((g) => Array.isArray(g) && g.length > 0)) out.add(from);
    }
  }
  return out;
}

/** {@link subNodeSourcesIn} over `workflow.connectionsBySourceNode`. */
export function subNodeSourcesOf(workflow: Workflow): Set<string> {
  return subNodeSourcesIn(workflow.connectionsBySourceNode);
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
    const byAiTool = fieldOf(byType, 'ai_tool');
    if (!Array.isArray(byAiTool)) continue;
    for (const connections of byAiTool as Array<IConnection[] | null>) {
      for (const c of connections ?? []) {
        if (c.type !== 'ai_tool' || !Object.hasOwn(workflow.nodes, c.node)) continue;
        out.push({ agent: c.node, tool: from });
      }
    }
  }
  return out;
}

/**
 * `parameters.options[key]` when it is a literal positive integer; `undefined` otherwise.
 *
 * The two keys read this way are an agent's `maxIterations` — the bound n8n's own
 * `checkMaxIterations` enforces (`V3/helpers/executeBatch.ts`, default 10) — and
 * `maxToolCalls`, which n8n's agent does not declare and which is forward-compatible plumbing
 * for the scheduler's own bound (a workflow that sets it gets that budget, one that does not
 * gets `maxAgentToolCalls`). It is the path the verify CLI's raw-JSON fixtures still use; a
 * live workflow carries `maxToolCalls` in the policy instead, see {@link workflowPolicyOf}.
 *
 * Only a literal counts. n8n allows an expression on any parameter and resolves it per item at
 * execution time, so a compiled seed taken from one would be a guess; `undefined` then lets the
 * compiler fall back and mark the agent unbounded for verification rather than claim a bound.
 */
export function readPositiveIntOption(parameters: unknown, key: string): number | undefined {
  const raw = fieldOf(fieldOf(parameters, 'options'), key);
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
 * and why the resolved `maxToolCalls` reads the policy first and keeps the `options` path
 * ({@link readPositiveIntOption}) only for the verify CLI's raw-JSON fixtures.
 *
 * **One resolution, two callers.** The verify CLI reads the same carrier off a JSON export, and
 * one net serves execution and verification: a CLI that resolved the policy differently would
 * analyse a different net and report it with the same confidence. So the rule and the
 * precedence live here once, over raw `settings` and a raw node — {@link parseWorkflowPolicy}
 * and {@link resolveNodePolicy} — and the `Workflow` forms below only hand them the fields.
 */
export function workflowPolicyOf(workflow: Workflow, diagnostics: string[]): ExecutionPolicy | undefined {
  return parseWorkflowPolicy(workflow.settings, diagnostics);
}

/** `settings.executionPolicy` parsed and narrowed by {@link inheritableWorkflowPolicy}. */
export function parseWorkflowPolicy(settings: unknown, diagnostics: string[]): ExecutionPolicy | undefined {
  const parsed = parseExecutionPolicy(fieldOf(settings, 'executionPolicy'), 'workflow settings');
  diagnostics.push(...parsed.diagnostics);
  return inheritableWorkflowPolicy(parsed.policy, diagnostics);
}

/**
 * The part of a workflow-level policy every node inherits.
 *
 * **The failure policy does not inherit from workflow scope.** The resource knobs do —
 * `concurrency`, `rate`, `maxRuns`, `maxToolCalls`, `maxRounds` all mean something sensible as
 * a workflow-wide default. `onFailure` and `timeoutMs` do not, for the reason this ADR gives
 * for refusing `onFailure` beside `retryOnFail`: it would invent "a precedence a workflow
 * author cannot see". A single `timeoutMs` here would otherwise arm a deadline on every node,
 * and since a deadline needs a chain to say what an expired attempt does, the *whole workflow*
 * would fail to compile over a key the author set as a default. A workflow-wide `onFailure`
 * would likewise rewrite the failure behaviour of every node, and throw on the first one that
 * declares `retryOnFail` or lacks the output a `route` step names.
 *
 * Declared per node, or per group where a node names one. Said once here rather than per node.
 */
export function inheritableWorkflowPolicy(
  policy: ExecutionPolicy | undefined, diagnostics: string[],
): ExecutionPolicy | undefined {
  if (policy === undefined) return undefined;
  const { onFailure, timeoutMs, ...rest } = policy;
  if (onFailure === undefined && timeoutMs === undefined) return policy;
  diagnostics.push(
    'workflow settings: executionPolicy' +
    `${onFailure !== undefined ? '.onFailure' : ''}${timeoutMs !== undefined ? '.timeoutMs' : ''}` +
    ' is not inherited by every node — a failure chain and its deadline are declared on the node ' +
    'they govern, or on a group a node names. The rest of the workflow policy still applies.');
  return rest;
}

/** A group's policy from `settings.executionPolicy.groups`, by name. */
function groupPolicyOf(
  settings: unknown, group: string, diagnostics: string[],
): ExecutionPolicy | undefined {
  const entry = recordOf(fieldOf(fieldOf(fieldOf(settings, 'executionPolicy'), 'groups'), group));
  if (entry === undefined) return undefined;
  const parsed = parseExecutionPolicy({ v: POLICY_SCHEMA_VERSION, ...entry }, `group '${group}'`);
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
 *
 * `declared` is the node's raw `executionPolicy` carrier and `settings` the workflow's raw
 * settings, so the JSON path and the live path decide precedence in this one function.
 */
export function resolveNodePolicy(
  declared: unknown,
  nodeName: string,
  settings: unknown,
  workflowPolicy: ExecutionPolicy | undefined,
  diagnostics: string[],
): ExecutionPolicy | undefined {
  const parsed = parseExecutionPolicy(declared, `node '${nodeName}'`);
  diagnostics.push(...parsed.diagnostics);
  const own = parsed.policy;
  const group = own?.concurrency?.group ?? own?.rate?.group;
  const groupPolicy = group === undefined ? undefined : groupPolicyOf(settings, group, diagnostics);
  return mergePolicies(workflowPolicy, groupPolicy, own);
}

/** {@link resolveNodePolicy} for a live node: its `executionPolicy` against `workflow.settings`. */
export function nodePolicyOf(
  node: INode, workflow: Workflow, workflowPolicy: ExecutionPolicy | undefined, diagnostics: string[],
): ExecutionPolicy | undefined {
  return resolveNodePolicy(fieldOf(node, 'executionPolicy'), node.name, workflow.settings, workflowPolicy, diagnostics);
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
 * MOD-010 separator `/` or repeats an earlier node's — then `n<k>` for the first `k >= index`
 * (the node's position in `workflow.nodes`) no node already owns. The fallback is checked
 * against `used` like a real id, because a workflow may carry the literal id `n1` beside a
 * node with none: n8n runs that workflow, and `analyse()` refuses a duplicate prefix.
 */
export function nodePrefixOf(id: unknown, index: number, used: Set<string>): string {
  let prefix = typeof id === 'string' && id.length > 0 && !id.includes('/') && !used.has(id) ? id : undefined;
  for (let k = index; prefix === undefined; k++) if (!used.has(`n${k}`)) prefix = `n${k}`;
  used.add(prefix);
  return prefix;
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
    // Computed once each so the spread below evaluates one read per field rather than two.
    const maxRounds = readPositiveIntOption(node.parameters, 'maxIterations');
    const maxToolCalls = policy?.maxToolCalls ?? readPositiveIntOption(node.parameters, 'maxToolCalls');
    return {
      id: nodePrefixOf(node.id, index, used),
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
      position: [node.position[0], node.position[1]],
      ...(node.disabled === undefined ? {} : { disabled: node.disabled }),
      ...(node.onError === undefined ? {} : { onError: node.onError }),
      ...(node.retryOnFail === undefined ? {} : { retryOnFail: node.retryOnFail }),
      ...(node.maxTries === undefined ? {} : { maxTries: node.maxTries }),
      ...(node.waitBetweenTries === undefined ? {} : { waitBetweenTries: node.waitBetweenTries }),
      ...(maxRounds === undefined ? {} : { maxRounds }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
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
    nodeTypes: (n) => recordedShapeOf(shapes, n.name),
    expressionReferences: (n) => references.get(n.name) ?? [],
  };
}

/** The shape recorded for `name`, or {@link UnknownNodeError}: no node gets an invented shape. */
export function recordedShapeOf(shapes: ReadonlyMap<string, NodeTypeShape>, name: string): NodeTypeShape {
  const shape = shapes.get(name);
  if (shape === undefined) throw new UnknownNodeError(name);
  return shape;
}
