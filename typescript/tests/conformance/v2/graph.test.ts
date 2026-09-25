/**
 * Stage 1 of the engine v2 input (`tasks/v2-profile-plan.md` decision 10, step 3):
 * `graphToDescription` on hand-written `WorkflowGraph`s in the shapes n8n's converter emits.
 * A graph round-trips — description back to graph gives the same nodes, step types, configs
 * the description keeps, and edges — except `isBackEdge`, which a `MainConnection` does not
 * carry and step 4 derives again. The port counts are pinned per node, and a graph the
 * converter could not have produced is refused by name.
 */
import { analyse } from '../../../src/compiler/index.js';
import type { NodeDescription } from '../../../src/compiler/index.js';
import {
  graphToDescription, MANUAL_TRIGGER_TYPE, SPLIT_IN_BATCHES_TYPE, V2_STEP_NODE_TYPES, V2GraphError,
} from '../../../src/conformance/v2/graph.js';
import type { V2Edge, V2Graph, V2GraphInput, V2Node, V2StepType } from '../../../src/conformance/v2/graph.js';

// ---------------------------------------------------------------------------------------------
// Graph builders, in the converter's config shapes (`toGraphNode`, `toBatchConfig`).

const trigger = (id: string, nodeType = 'n8n-nodes-base.manualTrigger'): V2Node =>
  ({ id, name: id, type: 'trigger', config: { nodeType, typeVersion: 1, parameters: {} } });
const v1 = (id: string, nodeType = 'n8n-nodes-base.noOp', continueOnFail = false, typeVersion = 1): V2Node =>
  ({ id, name: id, type: 'v1-node', config: { nodeType, typeVersion, parameters: {}, continueOnFail } });
const batch = (id: string, batchSize: unknown = 1): V2Node => ({ id, name: id, type: 'batch', config: { batchSize } });
const edge = (from: string, to: string, outputIndex = 0, inputIndex = 0, isBackEdge?: true): V2Edge =>
  ({ from, to, outputIndex, inputIndex, ...(isBackEdge ? { isBackEdge } : {}) });

const chain: V2Graph = {
  nodes: [trigger('T'), v1('A', 'n8n-nodes-base.set', false, 3.4), v1('B')],
  edges: [edge('T', 'A'), edge('A', 'B')],
};

/** An If whose branches meet in a 2-input Merge; one branch continues on failure. */
const diamond: V2Graph = {
  nodes: [
    trigger('T'), v1('If', 'n8n-nodes-base.if', false, 2.2), v1('X', 'n8n-nodes-base.httpRequest', true, 4.2),
    v1('Y'), v1('M', 'n8n-nodes-base.merge', false, 3.2), v1('Z'),
  ],
  edges: [edge('T', 'If'), edge('If', 'X', 0), edge('If', 'Y', 1), edge('X', 'M', 0, 0), edge('Y', 'M', 0, 1), edge('M', 'Z')],
};

/** A Switch with outputs 0 and 3 wired and 1, 2 left open. */
const switchFan: V2Graph = {
  nodes: [trigger('T', 'n8n-nodes-base.webhook'), v1('S', 'n8n-nodes-base.switch', false, 3.2), v1('P'), v1('Q')],
  edges: [edge('T', 'S'), edge('S', 'P', 0), edge('S', 'Q', 3)],
};

/** A batch loop: entry and back edge both on slot 0, loop slot 1 into the body, done slot 0 out. */
const loop: V2Graph = {
  nodes: [trigger('T'), batch('B', 2), v1('Body'), v1('After')],
  edges: [edge('T', 'B'), edge('B', 'Body', 1), edge('Body', 'B', 0, 0, true), edge('B', 'After', 0)],
};

/** Two loops in sequence: B1's exit is B2's entry. */
const twoLoops: V2Graph = {
  nodes: [trigger('T'), batch('B1'), v1('Body1'), batch('B2', 10), v1('Body2')],
  edges: [
    edge('T', 'B1'), edge('B1', 'Body1', 1), edge('Body1', 'B1', 0, 0, true),
    edge('B1', 'B2', 0), edge('B2', 'Body2', 1), edge('Body2', 'B2', 0, 0, true),
  ],
};

/** The two step types v2 declares but has no executor for. */
const unimplemented: V2Graph = {
  nodes: [trigger('T'), { id: 'W', name: 'W', type: 'wait' }, { id: 'Sub', name: 'Sub', type: 'subworkflow' }],
  edges: [edge('T', 'W'), edge('W', 'Sub')],
};

const GRAPHS: Readonly<Record<string, V2Graph>> = { chain, diamond, switchFan, loop, twoLoops, unimplemented };

// ---------------------------------------------------------------------------------------------
// The inverse: what a description says about the graph it came from.

function stepTypeOf(node: NodeDescription, startNode: string): V2StepType {
  if (node.name === startNode) return 'trigger';
  if (node.batch !== undefined) return 'batch';
  if (node.type === V2_STEP_NODE_TYPES.wait) return 'wait';
  if (node.type === V2_STEP_NODE_TYPES.subworkflow) return 'subworkflow';
  return 'v1-node';
}

/** The graph a description describes, with the configs the builders above write. */
function descriptionToGraph({ description, startNode }: V2GraphInput): V2Graph {
  const idOf = new Map(description.nodes.map((n) => [n.name, n.id]));
  const nodes = description.nodes.map((n): V2Node => {
    const type = stepTypeOf(n, startNode);
    const base = { id: n.id, name: n.name, type };
    switch (type) {
      case 'trigger': return { ...base, config: { nodeType: n.type, typeVersion: n.typeVersion, parameters: {} } };
      case 'batch': return { ...base, config: { batchSize: n.batch!.batchSize } };
      case 'v1-node': return {
        ...base,
        config: { nodeType: n.type, typeVersion: n.typeVersion, parameters: {}, continueOnFail: n.onError === 'continueRegularOutput' },
      };
      default: return base;
    }
  });
  const edges = description.connections.map((c) => edge(idOf.get(c.from)!, idOf.get(c.to)!, c.outputIndex, c.inputIndex));
  return { nodes, edges };
}

const withoutBackEdges = (graph: V2Graph): V2Graph =>
  ({ nodes: graph.nodes, edges: graph.edges.map((e) => edge(e.from, e.to, e.outputIndex, e.inputIndex)) });

/** `name: inputs/outputs` for every node, in graph order. */
function portsOf({ description }: V2GraphInput): string[] {
  return description.nodes.map((n) => {
    const shape = description.nodeTypes(n);
    return `${n.name}: ${shape.inputCount}/${shape.outputCount}`;
  });
}

function refusal(graph: V2Graph): string {
  try {
    graphToDescription(graph);
  } catch (e) {
    if (e instanceof V2GraphError) return e.message;
    throw e;
  }
  return 'nothing thrown';
}

// ---------------------------------------------------------------------------------------------

describe('graphToDescription round-trips', () => {
  it.each(Object.entries(GRAPHS))('%s: back to the same graph, isBackEdge aside', (_name, graph) => {
    expect(descriptionToGraph(graphToDescription(graph))).toEqual(withoutBackEdges(graph));
  });

  it.each(Object.entries(GRAPHS))('%s: the trigger is the one start node, nodes keep graph order', (_name, graph) => {
    const input = graphToDescription(graph);
    expect(input.startNode).toBe('T');
    expect(input.description.startNode).toBe('T');
    expect(input.description.startNodes).toBeUndefined();
    expect(input.description.nodes.map((n) => n.position)).toEqual(graph.nodes.map((_n, i) => [i, 0]));
  });

  it.each(Object.entries(GRAPHS).filter(([name]) => name !== 'unimplemented'))(
    '%s: is a description the compiler analyses under engineV2', (_name, graph) => {
      const { description } = graphToDescription(graph);
      const analysis = analyse(description, { profile: 'engineV2' });
      expect(analysis.profile).toBe('engineV2');
      expect(analysis.startNode).toBe('T');
      expect(analysis.edges).toHaveLength(graph.edges.length);
    });

  it('unimplemented: is a description the engineV2 analysis refuses, since v2 never settles its steps', () => {
    expect(() => analyse(graphToDescription(unimplemented).description, { profile: 'engineV2' }))
      .toThrow(expect.objectContaining({ code: 'v2-unsupported-step', node: 'W' }));
  });
});

describe('port counts', () => {
  it('are the highest slot an edge uses, plus one: 0 where no edge does', () => {
    expect(portsOf(graphToDescription(chain))).toEqual(['T: 0/1', 'A: 1/1', 'B: 1/0']);
    expect(portsOf(graphToDescription(diamond))).toEqual(['T: 0/1', 'If: 1/2', 'X: 1/1', 'Y: 1/1', 'M: 2/1', 'Z: 1/0']);
  });

  it('count an open slot below a wired one: a Switch wired on 0 and 3 has four outputs', () => {
    expect(portsOf(graphToDescription(switchFan))).toEqual(['T: 0/1', 'S: 1/4', 'P: 1/0', 'Q: 1/0']);
  });

  it('give wait and subworkflow steps their edges\' ports under a type no n8n node has', () => {
    const { description } = graphToDescription(unimplemented);
    expect(portsOf({ description, startNode: 'T' })).toEqual(['T: 0/1', 'W: 1/1', 'Sub: 1/0']);
    expect(description.nodes.map((n) => `${n.type}@${n.typeVersion}`))
      .toEqual(['n8n-nodes-base.manualTrigger@1', '@n8n/engine.wait@1', '@n8n/engine.subworkflow@1']);
  });
});

describe('a batch node', () => {
  it('is Split In Batches v3 with outputs done, loop and its literal batch size', () => {
    const { description } = graphToDescription(loop);
    const b = description.nodes.find((n) => n.name === 'B')!;
    expect(b).toMatchObject({ type: SPLIT_IN_BATCHES_TYPE, typeVersion: 3, batch: { batchSize: 2 } });
    expect(description.nodeTypes(b)).toEqual({ inputCount: 1, outputCount: 2, loopNode: true, outputNames: ['done', 'loop'] });
  });

  it('has both outputs whichever is wired, and the entry and back edge share slot 0', () => {
    const onlyLoop: V2Graph = {
      nodes: [trigger('T'), batch('B'), v1('Body')],
      edges: [edge('T', 'B'), edge('B', 'Body', 1), edge('Body', 'B', 0, 0, true)],
    };
    const { description } = graphToDescription(onlyLoop);
    expect(portsOf({ description, startNode: 'T' })).toEqual(['T: 0/1', 'B: 1/2', 'Body: 1/1']);
    expect(description.connections).toContainEqual({ from: 'Body', outputIndex: 0, to: 'B', inputIndex: 0 });
  });

  it('is the only node carrying batch: every other node leaves it unset', () => {
    const { description } = graphToDescription(twoLoops);
    expect(description.nodes.filter((n) => n.batch !== undefined).map((n) => [n.name, n.batch!.batchSize]))
      .toEqual([['B1', 1], ['B2', 10]]);
  });
});

describe('node fields', () => {
  it('fold continueOnFail into onError continueRegularOutput, and leave it unset otherwise', () => {
    const { description } = graphToDescription(diamond);
    expect(description.nodes.filter((n) => n.onError !== undefined).map((n) => [n.name, n.onError]))
      .toEqual([['X', 'continueRegularOutput']]);
  });

  it('stand in a manual trigger v1 for a trigger with no config, as toV1TriggerNode does', () => {
    const graph: V2Graph = { nodes: [{ id: 'T', name: 'Start', type: 'trigger' }, v1('A')], edges: [edge('T', 'A')] };
    const input = graphToDescription(graph);
    expect(input.startNode).toBe('Start');
    expect(input.description.nodes[0]).toMatchObject({ id: 'T', name: 'Start', type: MANUAL_TRIGGER_TYPE, typeVersion: 1 });
  });

  it('keep ids and names apart: connections speak names', () => {
    const graph: V2Graph = {
      nodes: [{ ...trigger('t-1'), name: 'When clicked' }, { ...v1('a-2'), name: 'Do it' }],
      edges: [edge('t-1', 'a-2')],
    };
    const { description } = graphToDescription(graph);
    expect(description.nodes.map((n) => [n.id, n.name])).toEqual([['t-1', 'When clicked'], ['a-2', 'Do it']]);
    expect(description.connections).toEqual([{ from: 'When clicked', outputIndex: 0, to: 'Do it', inputIndex: 0 }]);
  });
});

describe('graphs the converter cannot produce are refused', () => {
  const cases: ReadonlyArray<readonly [string, V2Graph, RegExp]> = [
    ['a repeated id', { nodes: [trigger('T'), v1('A'), { ...v1('A'), name: 'A2' }], edges: [] }, /two nodes have id 'A'/],
    ['a repeated name', { nodes: [trigger('T'), v1('A'), { ...v1('B'), name: 'A' }], edges: [] }, /two nodes are named 'A'/],
    ['no trigger', { nodes: [v1('A')], edges: [] }, /0 trigger nodes; exactly one/],
    ['two triggers', { nodes: [trigger('T'), trigger('U')], edges: [] }, /2 trigger nodes; exactly one/],
    ['an edge to a missing node', { nodes: [trigger('T')], edges: [edge('T', 'Gone')] }, /T -> Gone names a node/],
    ['a negative slot', { nodes: [trigger('T'), v1('A')], edges: [edge('T', 'A', -1)] }, /slot index -1/],
    ['a fractional slot', { nodes: [trigger('T'), v1('A')], edges: [edge('T', 'A', 0, 0.5)] }, /slot index 0.5/],
    ['a batch size of 0', { nodes: [trigger('T'), batch('B', 0)], edges: [] }, /batch node 'B' has no batch size/],
    ['a fractional batch size', { nodes: [trigger('T'), batch('B', 1.5)], edges: [] }, /batch node 'B' has no batch size/],
    ['an expression batch size', { nodes: [trigger('T'), batch('B', '={{ 2 }}')], edges: [] }, /batch node 'B' has no batch size/],
    ['a batch node with no config', { nodes: [trigger('T'), { id: 'B', name: 'B', type: 'batch' }], edges: [] }, /batch node 'B' has no batch size/],
    ['a third batch output', { nodes: [trigger('T'), batch('B'), v1('A')], edges: [edge('B', 'A', 2)] }, /edge from output 2/],
    ['a v1 node with no config', { nodes: [trigger('T'), { id: 'A', name: 'A', type: 'v1-node' }], edges: [] }, /v1 node 'A' has no v1 node config/],
    ['a v1 node without continueOnFail', {
      nodes: [trigger('T'), { id: 'A', name: 'A', type: 'v1-node', config: { nodeType: 'x', typeVersion: 1, parameters: {} } }], edges: [],
    }, /v1 node 'A' has no v1 node config/],
    ['a v1 node that is a Split In Batches', { nodes: [trigger('T'), v1('A', SPLIT_IN_BATCHES_TYPE, false, 3)], edges: [] }, /converter makes that a batch step/],
    ['a step type after the pin', {
      nodes: [trigger('T'), { id: 'A', name: 'A', type: 'approval' as V2StepType }], edges: [],
    }, /step type 'approval'/],
  ];

  it.each(cases)('%s', (_name, graph, message) => {
    expect(refusal(graph)).toMatch(message);
  });

  it('and the resolver refuses a node the graph does not have', () => {
    const { description } = graphToDescription(chain);
    expect(() => description.nodeTypes({ id: 'Q', name: 'Q', type: 'x', typeVersion: 1, position: [0, 0] }))
      .toThrow(V2GraphError);
  });
});
