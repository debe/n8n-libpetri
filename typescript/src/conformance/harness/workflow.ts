/**
 * The fake n8n `Workflow` built from a compiler `WorkflowDescription`, with the members the
 * adapter and both schedulers read, and the `NodeHelpers` the adapter calls.
 */
import type { IConnection, INode, INodeParameters, Workflow } from 'n8n-workflow';
import type { NodeDescription, WorkflowDescription } from '../../compiler/index.js';
import { POLICY_SCHEMA_VERSION } from '../../compiler/index.js';
import type { NodeHelpersLike } from '../../n8n/host.js';

export interface FakeWorkflowOptions {
  readonly executionOrder?: 'v0' | 'v1';
  /** Node parameters (scanned for `$('X')` references by the adapter). */
  readonly parameters?: Readonly<Record<string, INodeParameters>>;
  /** Extra `INode` fields per node (e.g. `alwaysOutputData`, `continueOnFail`). */
  readonly nodeExtras?: Readonly<Record<string, Partial<INode>>>;
  /** A string `requiredInputs` (expression) per node type name, for the adapter test. */
  readonly requiredInputsExpression?: Readonly<Record<string, string>>;
}

function toINode(n: NodeDescription, options: FakeWorkflowOptions = {}): INode {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    typeVersion: n.typeVersion,
    position: [n.position[0], n.position[1]],
    // An agent's round budget lives where n8n keeps it — `options.maxIterations` in the node's
    // parameters — so a fixture's `maxRounds` survives the round-trip back through
    // `describeWorkflow`, which is the only path the scheduler ever reads it by.
    parameters: {
      ...(n.maxRounds === undefined && n.maxToolCalls === undefined ? {} : {
        options: {
          ...(n.maxRounds === undefined ? {} : { maxIterations: n.maxRounds }),
          ...(n.maxToolCalls === undefined ? {} : { maxToolCalls: n.maxToolCalls }),
        },
      }),
      ...(options.parameters?.[n.name] ?? {}),
    },
    ...(n.disabled === undefined ? {} : { disabled: n.disabled }),
    ...(n.onError === undefined ? {} : { onError: n.onError }),
    ...(n.retryOnFail === undefined ? {} : { retryOnFail: n.retryOnFail }),
    ...(n.maxTries === undefined ? {} : { maxTries: n.maxTries }),
    ...(n.waitBetweenTries === undefined ? {} : { waitBetweenTries: n.waitBetweenTries }),
    // The fixture holds the *resolved* policy (layer 2); n8n carries the *declared* one
    // (layer 1), which is what `describeWorkflow` parses. Writing the schema version back is
    // what makes a fixture's `executionPolicy` survive the same round trip `maxRounds` does —
    // and it exercises the real carrier rather than a shortcut past it (ADR 0009 §2).
    ...(n.executionPolicy === undefined
      ? {}
      : { executionPolicy: { v: POLICY_SCHEMA_VERSION, ...n.executionPolicy } }),
    ...(options.nodeExtras?.[n.name] ?? {}),
  };
}

/** A minimal `Workflow` with the members the adapter and the scheduler read. */
export function fakeWorkflow(desc: WorkflowDescription, options: FakeWorkflowOptions = {}): Workflow {
  const nodes: Record<string, INode> = {};
  for (const n of desc.nodes) nodes[n.name] = toINode(n, options);
  type ConnectionMap = { main: Array<IConnection[] | null>; ai_tool?: Array<IConnection[] | null> };
  const bySource: Record<string, ConnectionMap> = {};
  const byDestination: Record<string, ConnectionMap> = {};
  for (const c of desc.connections) {
    const s = (bySource[c.from] ??= { main: [] });
    while (s.main.length <= c.outputIndex) s.main.push([]);
    s.main[c.outputIndex]!.push({ node: c.to, type: 'main', index: c.inputIndex });
    const d = (byDestination[c.to] ??= { main: [] });
    while (d.main.length <= c.inputIndex) d.main.push([]);
    d.main[c.inputIndex]!.push({ node: c.from, type: 'main', index: c.outputIndex });
  }
  // `ai_tool` sits on the same maps as `main`, keyed from the tool into the agent, which is how
  // n8n stores it — and why `mainConnectionsOf` has to filter by type rather than by key.
  for (const c of desc.toolConnections ?? []) {
    const s = (bySource[c.tool] ??= { main: [] });
    (s.ai_tool ??= [[]])[0]!.push({ node: c.agent, type: 'ai_tool', index: 0 });
    const d = (byDestination[c.agent] ??= { main: [] });
    (d.ai_tool ??= [[]])[0]!.push({ node: c.tool, type: 'ai_tool', index: 0 });
  }
  const descriptions = new Map<string, unknown>();
  for (const n of desc.nodes) {
    const shape = desc.nodeTypes(n);
    const expr = options.requiredInputsExpression?.[n.type];
    descriptions.set(n.type, {
      displayName: n.type,
      name: n.type,
      version: n.typeVersion,
      inputs: Array.from({ length: shape.inputCount }, () => 'main'),
      outputs: Array.from({ length: shape.outputCount }, () => 'main'),
      ...(expr !== undefined ? { requiredInputs: expr } : shape.requiredInputs === undefined ? {} : { requiredInputs: shape.requiredInputs }),
      ...(shape.outputNames === undefined ? {} : { outputNames: [...shape.outputNames] }),
      properties: [],
    });
  }
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
    /**
     * `Workflow.getParentNodes(name)` (n8n-workflow `common/get-connected-nodes.ts`):
     * every transitive ancestor over main connections. n8n's own implementation also
     * fixes an order the reference loop never reads — its single caller, the R6
     * quiescence fallback (`stack-scheduler.ts:404`), only asks `parentNodes.some(...)`
     * — so this returns the same set, sorted, and not n8n's unshift order.
     */
    getParentNodes: (name: string) => {
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
    },
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
