/**
 * The fake n8n `Workflow` built from a compiler `WorkflowDescription`, with the members the
 * adapter and both schedulers read, and the `NodeHelpers` the adapter calls. What each node
 * becomes — its `INode` and its type's description — is `workflow-nodes.ts`.
 */
import type { IConnection, INode, INodeParameters, Workflow } from 'n8n-workflow';
import type { WorkflowDescription } from '../../compiler/index.js';
import type { NodeHelpersLike } from '../../n8n/host.js';
import { nodeTypeDescriptions, toINode } from './workflow-nodes.js';

export interface FakeWorkflowOptions {
  readonly executionOrder?: 'v0' | 'v1';
  /** Node parameters (scanned for `$('X')` references by the adapter). */
  readonly parameters?: Readonly<Record<string, INodeParameters>>;
  /** Extra `INode` fields per node (e.g. `alwaysOutputData`, `continueOnFail`). */
  readonly nodeExtras?: Readonly<Record<string, Partial<INode>>>;
  /** A string `requiredInputs` (expression) per node type name, for the adapter test. */
  readonly requiredInputsExpression?: Readonly<Record<string, string>>;
}

/** One node's entry in n8n's connection maps: per connection type, per port, the connections. */
type ConnectionMap = { main: Array<IConnection[] | null>; ai_tool?: Array<IConnection[] | null> };
type ConnectionMaps = Record<string, ConnectionMap>;

/** Add a `main` connection on `port` of `node`, growing the port list to reach it. */
function addMainConnection(map: ConnectionMaps, node: string, port: number, connection: IConnection): void {
  const entry = (map[node] ??= { main: [] });
  while (entry.main.length <= port) entry.main.push([]);
  entry.main[port]!.push(connection);
}

/** Add an `ai_tool` connection of `node`; a tool has the one port. */
function addToolConnection(map: ConnectionMaps, node: string, connection: IConnection): void {
  const entry = (map[node] ??= { main: [] });
  (entry.ai_tool ??= [[]])[0]!.push(connection);
}

/** `connectionsBySourceNode` and `connectionsByDestinationNode`, as n8n keeps them. */
function connectionMapsOf(desc: WorkflowDescription): { bySource: ConnectionMaps; byDestination: ConnectionMaps } {
  const bySource: ConnectionMaps = {};
  const byDestination: ConnectionMaps = {};
  for (const c of desc.connections) {
    addMainConnection(bySource, c.from, c.outputIndex, { node: c.to, type: 'main', index: c.inputIndex });
    addMainConnection(byDestination, c.to, c.inputIndex, { node: c.from, type: 'main', index: c.outputIndex });
  }
  // `ai_tool` sits on the same maps as `main`, keyed from the tool into the agent, which is how
  // n8n stores it — and why `mainConnectionsOf` has to filter by type rather than by key.
  for (const c of desc.toolConnections ?? []) {
    addToolConnection(bySource, c.tool, { node: c.agent, type: 'ai_tool', index: 0 });
    addToolConnection(byDestination, c.agent, { node: c.tool, type: 'ai_tool', index: 0 });
  }
  return { bySource, byDestination };
}

/**
 * `Workflow.getParentNodes(name)` (n8n-workflow `common/get-connected-nodes.ts`):
 * every transitive ancestor over main connections. n8n's own implementation also
 * fixes an order the reference loop never reads — its single caller, the R6
 * quiescence fallback (`stack-scheduler.ts:404`), only asks `parentNodes.some(...)`
 * — so this returns the same set, sorted, and not n8n's unshift order.
 */
function parentNodesOf(byDestination: ConnectionMaps, name: string): string[] {
  const seen = new Set<string>();
  const walk = (current: string): void => {
    for (const input of byDestination[current]?.main ?? []) {
      for (const c of input ?? []) {
        if (seen.has(c.node)) continue;
        seen.add(c.node);
        walk(c.node);
      }
    }
  };
  walk(name);
  return [...seen].sort();
}

/** A minimal `Workflow` with the members the adapter and the scheduler read. */
export function fakeWorkflow(desc: WorkflowDescription, options: FakeWorkflowOptions = {}): Workflow {
  const nodes: Record<string, INode> = {};
  for (const n of desc.nodes) nodes[n.name] = toINode(n, options.parameters?.[n.name], options.nodeExtras?.[n.name]);
  const { bySource, byDestination } = connectionMapsOf(desc);
  const descriptions = nodeTypeDescriptions(desc, options.requiredInputsExpression);
  const workflow = {
    id: desc.id ?? desc.name ?? 'wf',
    name: desc.name,
    nodes,
    connectionsBySourceNode: bySource,
    connectionsByDestinationNode: byDestination,
    settings: { executionOrder: options.executionOrder ?? 'v1' },
    nodeTypes: {
      getByNameAndVersion: (type: string) => {
        const description = descriptions.get(type);
        if (description === undefined) throw new Error(`fakeWorkflow: unknown node type '${type}'`);
        return { description };
      },
    },
    expression: {
      // The one expression the adapter evaluates: Merge's requiredInputs. Canned as
      // `$parameter["mode"] === "chooseBranch" ? [0, 1] : 1`.
      getSimpleParameterValue: (node: INode, value: string) =>
        (typeof value === 'string' && value.startsWith('=') ? (node.parameters.mode === 'chooseBranch' ? [0, 1] : 1) : value),
    },
    getNode: (name: string) => nodes[name] ?? null,
    /** `Workflow.getParentNodes(name)`: see {@link parentNodesOf}. */
    getParentNodes: (name: string) => parentNodesOf(byDestination, name),
    staticData: {},
  };
  return workflow as unknown as Workflow;
}

/** `NodeHelpers` as the adapter uses them; `getNodeOutputs` appends the error output like n8n's. */
export const fakeNodeHelpers: NodeHelpersLike = {
  getNodeInputs: (_w, _n, d) => d.inputs as never,
  getNodeOutputs: (_w, node, d) => {
    const outputs = d.outputs as never[];
    return node.onError === 'continueErrorOutput'
      ? [...outputs, { category: 'error', type: 'main', displayName: 'Error' } as never]
      : outputs;
  },
};
