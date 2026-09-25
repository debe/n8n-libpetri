/**
 * Hand-written engine v2 `WorkflowGraph`s for the `engineV2` analysis suites, built in the
 * shapes `V1WorkflowConverter` emits (`toGraphNode`, `toBatchConfig`), with node ids equal to
 * names so a description's names read back as the graph's ids.
 *
 * `isBackEdge` is set by hand, on the edges `markBackEdges` (`node-engine-compatibility`
 * `v1-workflow-converter.ts`) marks: the edges from a loop's members into its single batch
 * entry. It is what the derived marks are compared against.
 */
import { analyse } from '../../src/compiler/index.js';
import type { AnalysisOptions, WorkflowAnalysis } from '../../src/compiler/index.js';
import { graphToDescription } from '../../src/conformance/v2/graph.js';
import type { V2Edge, V2Graph, V2Node } from '../../src/conformance/v2/graph.js';

export const trigger = (id: string): V2Node =>
  ({ id, name: id, type: 'trigger', config: { nodeType: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} } });
export const v1 = (id: string, nodeType = 'n8n-nodes-base.noOp'): V2Node =>
  ({ id, name: id, type: 'v1-node', config: { nodeType, typeVersion: 1, parameters: {}, continueOnFail: false } });
export const batch = (id: string, batchSize = 1): V2Node => ({ id, name: id, type: 'batch', config: { batchSize } });
export const edge = (from: string, to: string, outputIndex = 0, inputIndex = 0): V2Edge =>
  ({ from, to, outputIndex, inputIndex });
/** An edge n8n marks `isBackEdge`. */
export const backEdge = (from: string, to: string, outputIndex = 0): V2Edge =>
  ({ from, to, outputIndex, inputIndex: 0, isBackEdge: true });

/** `from.out -> to.in`, the key an edge is compared under. */
export const keyOf = (e: { from: string; outputIndex: number; to: string; inputIndex: number }): string =>
  `${e.from}.${e.outputIndex} -> ${e.to}.${e.inputIndex}`;

/** The `engineV2` analysis of a graph, through the stage-1 input. */
export function analyseV2(graph: V2Graph, options: AnalysisOptions = {}): WorkflowAnalysis {
  return analyse(graphToDescription(graph).description, { ...options, profile: 'engineV2' });
}

// ---- Graphs engine v2 accepts ----

/** No loop at all. */
export const chain: V2Graph = {
  nodes: [trigger('T'), v1('A'), v1('B')],
  edges: [edge('T', 'A'), edge('A', 'B')],
};

/** The smallest loop: entry and return on slot 0, loop slot 1 into the body, done slot 0 out. */
export const loop: V2Graph = {
  nodes: [trigger('T'), batch('B', 2), v1('Body'), v1('After')],
  edges: [edge('T', 'B'), edge('B', 'Body', 1), backEdge('Body', 'B'), edge('B', 'After', 0)],
};

/** A body with an If and a Merge inside it: every body edge is `intra`, one return. */
export const diamondBody: V2Graph = {
  nodes: [trigger('T'), batch('B'), v1('If', 'n8n-nodes-base.if'), v1('P'), v1('Q'), v1('M', 'n8n-nodes-base.merge'), v1('After')],
  edges: [
    edge('T', 'B'), edge('B', 'If', 1), edge('If', 'P', 0), edge('If', 'Q', 1),
    edge('P', 'M', 0, 0), edge('Q', 'M', 0, 1), backEdge('M', 'B'), edge('B', 'After', 0),
  ],
};

/** The batch node returns to itself: its loop slot is its own back edge. */
export const selfLoop: V2Graph = {
  nodes: [trigger('T'), batch('B'), v1('After')],
  edges: [edge('T', 'B'), backEdge('B', 'B', 1), edge('B', 'After', 0)],
};

/** Two loops in sequence: B1's done slot is B2's entry, an `exit` by `classifyEdge`. */
export const twoLoops: V2Graph = {
  nodes: [trigger('T'), batch('B1'), v1('Body1'), batch('B2'), v1('Body2'), v1('End')],
  edges: [
    edge('T', 'B1'), edge('B1', 'Body1', 1), backEdge('Body1', 'B1'), edge('B1', 'B2', 0),
    edge('B2', 'Body2', 1), backEdge('Body2', 'B2'), edge('B2', 'End', 0),
  ],
};

/** A loop behind a branch whose exit meets a plain edge in a Merge. */
export const exitIntoMerge: V2Graph = {
  nodes: [
    trigger('T'), v1('If', 'n8n-nodes-base.if'), batch('B'), v1('Body'), v1('Other'),
    v1('M', 'n8n-nodes-base.merge'),
  ],
  edges: [
    edge('T', 'If'), edge('If', 'B', 0), edge('If', 'Other', 1), edge('B', 'Body', 1), backEdge('Body', 'B'),
    edge('B', 'M', 0, 0), edge('Other', 'M', 0, 1),
  ],
};

/** Only the loop slot wired: a loop with no way out, which `validateLoops` allows. */
export const noExit: V2Graph = {
  nodes: [trigger('T'), batch('B'), v1('Body')],
  edges: [edge('T', 'B'), edge('B', 'Body', 1), backEdge('Body', 'B')],
};

export const ACCEPTED: Readonly<Record<string, V2Graph>> = {
  chain, loop, diamondBody, selfLoop, twoLoops, exitIntoMerge, noExit,
};

// ---- Shapes outside any loop, for the settlement gadget (step 5) ----

/** If → P / Q → Merge → End: two branches that meet again. */
export const branchDiamond: V2Graph = {
  nodes: [trigger('T'), v1('If', 'n8n-nodes-base.if'), v1('P'), v1('Q'), v1('M', 'n8n-nodes-base.merge'), v1('End')],
  edges: [
    edge('T', 'If'), edge('If', 'P', 0), edge('If', 'Q', 1), edge('P', 'M', 0, 0), edge('Q', 'M', 0, 1), edge('M', 'End'),
  ],
};

/** One trigger slot into three nodes, and those three into the three slots of one Merge. */
export const threeInputMerge: V2Graph = {
  nodes: [trigger('T'), v1('A'), v1('B'), v1('C'), v1('M', 'n8n-nodes-base.merge'), v1('End')],
  edges: [
    edge('T', 'A'), edge('T', 'B'), edge('T', 'C'),
    edge('A', 'M', 0, 0), edge('B', 'M', 0, 1), edge('C', 'M', 0, 2), edge('M', 'End'),
  ],
};

/** A Switch with five connected outputs, one node on each: more than `SPLIT_ROUTING_ABOVE`. */
export const switchFanOut: V2Graph = {
  nodes: [trigger('T'), v1('Sw', 'n8n-nodes-base.switch'), v1('N0'), v1('N1'), v1('N2'), v1('N3'), v1('N4')],
  edges: [
    edge('T', 'Sw'), edge('Sw', 'N0', 0), edge('Sw', 'N1', 1), edge('Sw', 'N2', 2), edge('Sw', 'N3', 3), edge('Sw', 'N4', 4),
  ],
};

/** T → A → B → C: a dead slot is skipped onward one hop per settlement. */
export const longChain: V2Graph = {
  nodes: [trigger('T'), v1('A'), v1('B'), v1('C')],
  edges: [edge('T', 'A'), edge('A', 'B'), edge('B', 'C')],
};

/** An If whose two outputs enter one Merge: filling one slot or both makes the Merge live alike. */
export const ifIntoMerge: V2Graph = {
  nodes: [trigger('T'), v1('If', 'n8n-nodes-base.if'), v1('M', 'n8n-nodes-base.merge'), v1('End')],
  edges: [edge('T', 'If'), edge('If', 'M', 0, 0), edge('If', 'M', 1, 1), edge('M', 'End')],
};

/** Every accepted shape without a batch node. */
export const SETTLEMENT_SHAPES: Readonly<Record<string, V2Graph>> = {
  chain, branchDiamond, threeInputMerge, switchFanOut, longChain, ifIntoMerge,
};

// ---- Graphs engine v2 accepts and never finishes ----

/**
 * A `wait` step beside a chain: `T.0 -> W`, `T.1 -> A -> B -> C`. v2 has no executor for `W`
 * (`executorFor` throws before the step's `try`), so `W` stays `running` while `A`, `B` and
 * `C` complete, and the execution never finishes. The `engineV2` analysis refuses it.
 */
export const waitStep: V2Graph = {
  nodes: [trigger('T'), { id: 'W', name: 'W', type: 'wait' }, v1('A'), v1('B'), v1('C')],
  edges: [edge('T', 'W', 0), edge('T', 'A', 1), edge('A', 'B'), edge('B', 'C')],
};
