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
 */
import { scanExpressionReferences, LOOP_NODE_TYPES } from '../n8n/adapter.js';
import type {
  MainConnection, NodeDescription, NodeTypeShape, OnError, ToolConnection, WorkflowDescription,
} from '../compiler/index.js';

/** The node-type shapes a `--node-types` file may carry. Both maps are optional. */
export interface NodeTypesFile {
  /** Keyed by `type@typeVersion` or bare `type`. */
  readonly types?: Readonly<Record<string, NodeTypeShape>>;
  /** Keyed by node name; wins over `types`. */
  readonly nodes?: Readonly<Record<string, NodeTypeShape>>;
}

export interface WorkflowJsonResult {
  readonly description: WorkflowDescription;
  /** Every node whose shape was guessed, and how. Printed by the CLI, never swallowed. */
  readonly warnings: readonly string[];
}

/**
 * Core node types whose port counts a JSON export cannot reveal and whose miscount would
 * change the compiled model. Deliberately short: everything else is better served by
 * `--node-types` than by a guess this file cannot keep in step with n8n.
 */
export const BUILT_IN_SHAPES: Readonly<Record<string, (parameters: Record<string, unknown>) => NodeTypeShape>> = {
  'n8n-nodes-base.if': () => ({ inputCount: 1, outputCount: 2, outputNames: ['true', 'false'] }),
  'n8n-nodes-base.filter': () => ({ inputCount: 1, outputCount: 1 }),
  'n8n-nodes-base.splitInBatches': () => ({
    inputCount: 1, outputCount: 2, loopNode: true, outputNames: ['done', 'loop'],
  }),
  'n8n-nodes-base.compareDatasets': () => ({ inputCount: 2, outputCount: 4 }),
  'n8n-nodes-base.merge': (parameters) => {
    const declared = parameters['numberInputs'];
    const inputCount = typeof declared === 'number' && Number.isInteger(declared) && declared >= 2 ? declared : 2;
    // Merge's own `requiredInputs` expression is `mode === 'chooseBranch' ? [0, 1] : …`
    // (n8n `Merge.node.ts`); nothing else in it is readable from an export.
    const chooseBranch = parameters['mode'] === 'chooseBranch';
    return { inputCount, outputCount: 1, ...(chooseBranch ? { requiredInputs: [0, 1] } : {}) };
  },
};

/** n8n's own convention: a trigger type ends in `Trigger`, plus the fixed legacy names. */
const TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'n8n-nodes-base.start',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.interval',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.formTrigger',
]);

export function looksLikeTrigger(type: string): boolean {
  return TRIGGER_TYPES.has(type) || /trigger$/i.test(type);
}

// ==================== parsing ====================

interface RawNode {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly typeVersion?: unknown;
  readonly position?: unknown;
  readonly disabled?: unknown;
  readonly onError?: unknown;
  readonly retryOnFail?: unknown;
  readonly maxTries?: unknown;
  readonly waitBetweenTries?: unknown;
  readonly parameters?: unknown;
}

const ON_ERROR: ReadonlySet<string> = new Set(['stopWorkflow', 'continueRegularOutput', 'continueErrorOutput']);

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what} must be an object`);
  return v as Record<string, unknown>;
}

/**
 * `connections` in n8n's export shape: `{ "<from>": { "main": [ [ {node,type,index} ] ] } }`.
 *
 * Also reads the `ai_tool` key, which n8n stores on the same map keyed *from the tool into the
 * agent*. It has to: the compiled net gives an agent a dispatch arm per `ai_tool` connection,
 * so a verifier that read only `main` would analyse a net without the agent's round — a
 * different net from the one the scheduler runs, reported with the same confidence. One net
 * serves execution and verification, and that includes this path.
 */
export function connectionsOf(raw: unknown, names: ReadonlySet<string>): {
  connections: MainConnection[]; toolConnections: ToolConnection[]; warnings: string[];
} {
  const connections: MainConnection[] = [];
  const toolConnections: ToolConnection[] = [];
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { connections, toolConnections, warnings };
  const byNode = asRecord(raw, 'connections');
  for (const [from, value] of Object.entries(byNode)) {
    if (!names.has(from)) {
      warnings.push(`connections list '${from}', which is not a node of this workflow; dropped`);
      continue;
    }
    const byType = asRecord(value ?? {}, `connections['${from}']`);
    const main = byType['main'];
    if (Array.isArray(main)) main.forEach((targets, outputIndex) => {
      if (!Array.isArray(targets)) return;
      for (const t of targets) {
        if (typeof t !== 'object' || t === null) continue;
        const target = t as Record<string, unknown>;
        if (target['type'] !== undefined && target['type'] !== 'main') continue;
        const to = target['node'];
        if (typeof to !== 'string' || !names.has(to)) {
          warnings.push(`connection ${from}.${outputIndex} -> '${String(to)}' names an unknown node; dropped`);
          continue;
        }
        const index = target['index'];
        connections.push({
          from, outputIndex, to, inputIndex: typeof index === 'number' ? index : 0,
        });
      }
    });
    // `ai_tool`: the same map, but n8n keys it from the tool node into the agent, so `from` is
    // the tool here. Every other `ai_*` type is resolved by `supplyData` inside `runNode` and
    // never reaches a scheduler, so it is right to ignore them.
    const aiTool = byType['ai_tool'];
    if (!Array.isArray(aiTool)) continue;
    for (const targets of aiTool) {
      if (!Array.isArray(targets)) continue;
      for (const t of targets) {
        if (typeof t !== 'object' || t === null) continue;
        const target = t as Record<string, unknown>;
        if (target['type'] !== undefined && target['type'] !== 'ai_tool') continue;
        const agent = target['node'];
        if (typeof agent !== 'string' || !names.has(agent)) {
          warnings.push(`ai_tool connection ${from} -> '${String(agent)}' names an unknown node; dropped`);
          continue;
        }
        toolConnections.push({ agent, tool: from });
      }
    }
  }
  return { connections, toolConnections, warnings };
}

function nodeDescriptionOf(raw: RawNode, index: number, used: Set<string>): NodeDescription {
  const name = raw.name;
  if (typeof name !== 'string' || name === '') throw new Error(`nodes[${index}] has no name`);
  const type = typeof raw.type === 'string' ? raw.type : 'unknown';
  const position = Array.isArray(raw.position) && raw.position.length >= 2
    ? [Number(raw.position[0]) || 0, Number(raw.position[1]) || 0] as const
    : [0, index * 100] as const;
  // MOD-010 reserves `/` in a prefix, and the prefix must be unique.
  const rawId = raw.id;
  const id = typeof rawId === 'string' && rawId !== '' && !rawId.includes('/') && !used.has(rawId)
    ? rawId
    : `n${index}`;
  used.add(id);
  const onError = typeof raw.onError === 'string' && ON_ERROR.has(raw.onError) ? raw.onError as OnError : undefined;
  return {
    id,
    name,
    type,
    typeVersion: typeof raw.typeVersion === 'number' ? raw.typeVersion : 1,
    position: [position[0], position[1]],
    ...(raw.disabled === true ? { disabled: true } : {}),
    ...(onError === undefined ? {} : { onError }),
    ...(raw.retryOnFail === true ? { retryOnFail: true } : {}),
    ...(typeof raw.maxTries === 'number' ? { maxTries: raw.maxTries } : {}),
    ...(typeof raw.waitBetweenTries === 'number' ? { waitBetweenTries: raw.waitBetweenTries } : {}),
  };
}

// ==================== shapes ====================

interface PortUse {
  readonly maxInput: number;
  readonly maxOutput: number;
  readonly hasIncoming: boolean;
}

function portUse(node: string, connections: readonly MainConnection[]): PortUse {
  let maxInput = -1;
  let maxOutput = -1;
  let hasIncoming = false;
  for (const c of connections) {
    if (c.to === node) {
      hasIncoming = true;
      if (c.inputIndex > maxInput) maxInput = c.inputIndex;
    }
    if (c.from === node && c.outputIndex > maxOutput) maxOutput = c.outputIndex;
  }
  return { maxInput, maxOutput, hasIncoming };
}

/** Resolution order 1–4 of the module doc. Pushes a warning whenever it reaches step 4. */
export function shapeOf(
  node: NodeDescription,
  parameters: Record<string, unknown>,
  connections: readonly MainConnection[],
  types: NodeTypesFile,
  warnings: string[],
): NodeTypeShape {
  const byName = types.nodes?.[node.name];
  if (byName !== undefined) return byName;
  const byVersion = types.types?.[`${node.type}@${node.typeVersion}`] ?? types.types?.[node.type];
  if (byVersion !== undefined) return byVersion;
  const builtIn = BUILT_IN_SHAPES[node.type];
  if (builtIn !== undefined) {
    const shape = builtIn(parameters);
    return {
      ...shape,
      ...(LOOP_NODE_TYPES.has(node.type) ? { loopNode: true } : {}),
    };
  }
  const use = portUse(node.name, connections);
  const inputCount = use.maxInput >= 0
    ? use.maxInput + 1
    : looksLikeTrigger(node.type) ? 0 : 1;
  const connectedOutputs = use.maxOutput + 1;
  // The compiler appends the error output at index `outputCount`, so a node that has one
  // must not count it among its declared outputs: the highest connected index is it.
  const errorOutput = node.onError === 'continueErrorOutput' ? 1 : 0;
  const outputCount = Math.max(1, connectedOutputs - errorOutput);
  warnings.push(
    `${node.name} (${node.type}): no node-type shape supplied, guessed ${inputCount} input(s) / ` +
    `${outputCount} output(s) from the connections` +
    (errorOutput === 1 ? ' (highest connected output taken to be the error output)' : ''),
  );
  return {
    inputCount,
    outputCount,
    ...(LOOP_NODE_TYPES.has(node.type) ? { loopNode: true } : {}),
  };
}

// ==================== entry point ====================

export interface WorkflowJsonOptions {
  readonly nodeTypes?: NodeTypesFile;
  /** Overrides the start-node choice. */
  readonly startNode?: string;
}

/** The first node with no incoming connection, triggers first, in canvas (y, x) order. */
export function pickStartNode(
  nodes: readonly NodeDescription[], connections: readonly MainConnection[],
): string {
  const fed = new Set(connections.map((c) => c.to));
  const ordered = [...nodes].sort((a, b) =>
    a.position[1] - b.position[1] || a.position[0] - b.position[0] || a.name.localeCompare(b.name));
  const roots = ordered.filter((n) => !fed.has(n.name) && n.disabled !== true);
  const trigger = roots.find((n) => looksLikeTrigger(n.type));
  const start = trigger ?? roots[0] ?? ordered[0];
  if (start === undefined) throw new Error('workflow has no nodes');
  return start.name;
}

/** Parses an n8n workflow JSON export (the object, not the text). */
export function describeWorkflowJson(raw: unknown, options: WorkflowJsonOptions = {}): WorkflowJsonResult {
  const root = asRecord(raw, 'workflow');
  const rawNodes = root['nodes'];
  if (!Array.isArray(rawNodes)) throw new Error('workflow has no `nodes` array');
  const warnings: string[] = [];
  const used = new Set<string>();
  const nodes = rawNodes.map((n, i) => nodeDescriptionOf(asRecord(n, `nodes[${i}]`) as RawNode, i, used));
  const names = new Set(nodes.map((n) => n.name));
  if (names.size !== nodes.length) throw new Error('workflow has two nodes of the same name');

  const parsed = connectionsOf(root['connections'], names);
  warnings.push(...parsed.warnings);
  const connections = parsed.connections;

  const parametersOf = new Map<string, Record<string, unknown>>();
  rawNodes.forEach((n, i) => {
    const record = asRecord(n, `nodes[${i}]`);
    const p = record['parameters'];
    parametersOf.set(nodes[i]!.name, typeof p === 'object' && p !== null ? p as Record<string, unknown> : {});
  });

  const shapes = new Map<string, NodeTypeShape>();
  for (const node of nodes) {
    shapes.set(node.name, shapeOf(node, parametersOf.get(node.name) ?? {}, connections, options.nodeTypes ?? {}, warnings));
  }

  const startNode = options.startNode ?? pickStartNode(nodes, connections);
  if (!names.has(startNode)) throw new Error(`start node '${startNode}' is not a node of this workflow`);

  const references = new Map<string, string[]>();
  for (const node of nodes) {
    references.set(node.name, scanExpressionReferences(parametersOf.get(node.name) ?? {}, names));
  }

  const name = root['name'];
  const id = root['id'];
  const description: WorkflowDescription = {
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    nodes: nodes.map((n) => {
      // The agent's round budget, where n8n keeps it. Only a literal counts: an expression is
      // resolved per item at execution time, so the compiler falls back and marks the agent
      // unbounded for verification rather than reporting a bound it guessed.
      const options = parametersOf.get(n.name)?.['options'];
      const literal = (key: string): number | undefined => {
        const raw = typeof options === 'object' && options !== null
          ? (options as Record<string, unknown>)[key] : undefined;
        return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
      };
      const maxRounds = literal('maxIterations');
      const maxToolCalls = literal('maxToolCalls');
      return {
        ...n,
        ...(maxRounds === undefined ? {} : { maxRounds }),
        ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
      };
    }),
    connections,
    toolConnections: parsed.toolConnections,
    startNode,
    nodeTypes: (n) => shapes.get(n.name)!,
    expressionReferences: (n) => references.get(n.name) ?? [],
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
