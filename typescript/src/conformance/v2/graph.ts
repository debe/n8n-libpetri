/**
 * Stage 1 of the engine v2 input (`tasks/v2-profile-plan.md` decision 10): n8n's own converted
 * `WorkflowGraph` → a compiler {@link WorkflowDescription}. The graph has already been through
 * `V1WorkflowConverter.convert` (`@n8n/node-engine-compatibility` `v1-workflow-converter.ts`):
 * rooted at the fired trigger, disabled nodes spliced out, edges deduplicated, back edges
 * marked. So this is a renaming, not a port — it is exact on every graph the converter accepts,
 * and the port of those steps (stage 2, step 13) is measured against it rather than trusted.
 *
 * The graph types are local mirrors of `@n8n/engine` `graph/workflow-graph.ts` (`GraphNode`,
 * `GraphEdge`, `WorkflowGraph`) at the pin `n8n@2.41.3`: `src/` never imports `.n8n`
 * (decision 15), and a structural mirror lets a `tasks/` script pass n8n's own graph straight in.
 *
 * What the description keeps and what it drops:
 * - node ids and names as they are, and the graph's edge order as the connection order;
 * - the trigger as the one start node;
 * - a `batch` step as Split In Batches v3 with outputs `['done', 'loop']` (n8n's `DONE_SLOT = 0`,
 *   `LOOP_SLOT = 1`, `execution/loop-ledger.ts`) and its literal `batchSize` (decision 5);
 * - every other node's port counts from its edges: output count = highest `outputIndex` + 1,
 *   input count = highest `inputIndex` + 1. v2 routes on filled slots only, and a slot no edge
 *   reads is never decided by anything, so an unwired slot has no place to occupy;
 * - `continueOnFail` as `onError: 'continueRegularOutput'`: the converter already folded both
 *   into that one flag, and v2 treats a caught failure as an ordinary completion (decision 8);
 * - **not** `isBackEdge`: `MainConnection` has no such field. Which edge closes a loop is derived
 *   again from the structure (step 4, `deriveV2Loops`), and that derivation is tested against
 *   n8n's mark;
 * - **not** parameters, credentials or positions. The planner reads only a step's settled
 *   flags, never its data (decision 3). Positions are synthesised in graph order: v2 reads none,
 *   and the v1 declaration order they feed is not part of an engineV2 net.
 *
 * A graph the converter could not have produced is refused with a {@link V2GraphError} rather
 * than given a meaning. The shapes n8n's own validator refuses (`validateExecutableGraph`,
 * `validateLoops`) are **not** checked here beyond what building a description needs: they are
 * step 4's `CompileError`s, so the stage-1 and stage-2 inputs meet one refusal surface.
 */
import {
  BATCH_OUTPUT_NAMES, SPLIT_IN_BATCHES_TYPE, SPLIT_IN_BATCHES_TYPE_VERSION, V2_STEP_NODE_TYPES,
} from '../../compiler/index.js';
import type { NodeDescription, NodeTypeShape, WorkflowDescription } from '../../compiler/index.js';

// The batch step's names are the compiler's (`analysis/engine-v2/batch.ts`), which decides by
// them which node is a batch node, and so are the `wait` / `subworkflow` node types
// (`analysis/engine-v2/steps.ts`), which the engineV2 analysis refuses; re-exported so this
// input's callers keep one import.
export { BATCH_OUTPUT_NAMES, SPLIT_IN_BATCHES_TYPE, SPLIT_IN_BATCHES_TYPE_VERSION, V2_STEP_NODE_TYPES };

/** `StepType` (`graph/workflow-graph.ts`). The converter emits only `trigger`, `v1-node` and `batch`. */
export type V2StepType = 'trigger' | 'v1-node' | 'wait' | 'subworkflow' | 'batch';

/** `GraphNode` (`graph/workflow-graph.ts`). `config` is `unknown` there too: it is read by guard. */
export interface V2Node {
  readonly id: string;
  readonly name: string;
  readonly type: V2StepType;
  readonly config?: unknown;
}

/** `GraphEdge` (`graph/workflow-graph.ts`): one edge `from.outputIndex → to.inputIndex`, by node id. */
export interface V2Edge {
  readonly from: string;
  readonly to: string;
  readonly outputIndex: number;
  readonly inputIndex: number;
  /** Set by the converter's `markBackEdges` on the edges that close a batch loop. */
  readonly isBackEdge?: boolean;
}

/** `WorkflowGraph` (`graph/workflow-graph.ts`). */
export interface V2Graph {
  readonly nodes: readonly V2Node[];
  readonly edges: readonly V2Edge[];
}

/** What {@link graphToDescription} returns: the description and the name of its start node. */
export interface V2GraphInput {
  readonly description: WorkflowDescription;
  /** The trigger's name, which is also `description.startNode`. */
  readonly startNode: string;
}

/** `MANUAL_TRIGGER_TYPE`: what `toV1TriggerNode` stands in for a trigger that carries no config. */
export const MANUAL_TRIGGER_TYPE = 'n8n-nodes-base.manualTrigger';

/** A graph {@link graphToDescription} cannot turn into a description: not one the converter emits. */
export class V2GraphError extends Error {
  override readonly name = 'V2GraphError';
}

/** Highest input and output slot an edge uses at a node; `-1` where no edge does. */
interface SlotUse {
  maxIn: number;
  maxOut: number;
}

/**
 * The compiler description of a converted v2 graph, with its trigger as the start node. See the
 * module doc for what is kept and dropped. Throws {@link V2GraphError} on a graph the converter
 * cannot produce.
 */
export function graphToDescription(graph: V2Graph): V2GraphInput {
  const byId = new Map<string, V2Node>();
  const names = new Set<string>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) throw new V2GraphError(`graphToDescription: two nodes have id '${node.id}'`);
    // n8n names are unique per workflow and the description speaks names, so a repeat would
    // merge two nodes' connections.
    if (names.has(node.name)) throw new V2GraphError(`graphToDescription: two nodes are named '${node.name}'`);
    byId.set(node.id, node);
    names.add(node.name);
  }

  // `validateExecutableGraph` refuses zero and several triggers alike; without exactly one
  // there is no start node to name.
  const triggers = graph.nodes.filter((node) => node.type === 'trigger');
  const trigger = triggers[0];
  if (trigger === undefined || triggers.length > 1) {
    throw new V2GraphError(`graphToDescription: the graph has ${triggers.length} trigger nodes; exactly one is required`);
  }

  const use = new Map<string, SlotUse>(graph.nodes.map((node) => [node.id, { maxIn: -1, maxOut: -1 }]));
  const connections = graph.edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) {
      throw new V2GraphError(`graphToDescription: edge ${edge.from} -> ${edge.to} names a node the graph does not have`);
    }
    // `validateExecutableGraph`'s slot rule, the part a port count depends on.
    for (const index of [edge.outputIndex, edge.inputIndex]) {
      if (!Number.isInteger(index) || index < 0) {
        throw new V2GraphError(`graphToDescription: edge ${edge.from} -> ${edge.to} has slot index ${index}; slot indices are non-negative integers`);
      }
    }
    const out = use.get(from.id)!;
    out.maxOut = Math.max(out.maxOut, edge.outputIndex);
    const into = use.get(to.id)!;
    into.maxIn = Math.max(into.maxIn, edge.inputIndex);
    return { from: from.name, outputIndex: edge.outputIndex, to: to.name, inputIndex: edge.inputIndex };
  });

  const shapes = new Map<string, NodeTypeShape>();
  const nodes = graph.nodes.map((node, index): NodeDescription => {
    const slots = use.get(node.id)!;
    const described = describe(node, slots, index);
    shapes.set(node.name, described.shape);
    return described.node;
  });

  const description: WorkflowDescription = {
    nodes,
    connections,
    startNode: trigger.name,
    nodeTypes: (node) => {
      const shape = shapes.get(node.name);
      if (shape === undefined) throw new V2GraphError(`graphToDescription: no shape for '${node.name}', which the graph does not have`);
      return shape;
    },
  };
  return { description, startNode: trigger.name };
}

/** One node's description and type shape. `index` is its position in `graph.nodes`. */
function describe(node: V2Node, slots: SlotUse, index: number): { node: NodeDescription; shape: NodeTypeShape } {
  const common = { id: node.id, name: node.name, position: [index, 0] as const };
  const shape: NodeTypeShape = { inputCount: slots.maxIn + 1, outputCount: slots.maxOut + 1 };
  switch (node.type) {
    case 'trigger': {
      // `toV1TriggerNode` (`v1-adapters.ts`): a trigger without a readable config is a manual
      // trigger at version 1 — "an older graph carries no config".
      const config = isTriggerStepConfig(node.config) ? node.config : undefined;
      return {
        node: { ...common, type: config?.nodeType ?? MANUAL_TRIGGER_TYPE, typeVersion: config?.typeVersion ?? 1 },
        shape,
      };
    }
    case 'batch': {
      // `validateLoops` (`graph/loops.ts`) refuses a batch node whose config is not
      // `isBatchStepConfig`, and `toBatchConfig` never writes one.
      if (!isBatchStepConfig(node.config)) {
        throw new V2GraphError(`graphToDescription: batch node '${node.name}' has no batch size, and it must be a whole number of at least 1`);
      }
      if (slots.maxOut >= BATCH_OUTPUT_NAMES.length) {
        throw new V2GraphError(`graphToDescription: batch node '${node.name}' has an edge from output ${slots.maxOut}; a batch node has only 'done' (0) and 'loop' (1)`);
      }
      return {
        node: {
          ...common,
          type: SPLIT_IN_BATCHES_TYPE,
          typeVersion: SPLIT_IN_BATCHES_TYPE_VERSION,
          batch: { batchSize: node.config.batchSize },
        },
        shape: { ...shape, outputCount: BATCH_OUTPUT_NAMES.length, loopNode: true, outputNames: BATCH_OUTPUT_NAMES },
      };
    }
    case 'v1-node': {
      // `toGraphNode` always writes a `V1NodeStepConfig`; without one there is no node type.
      if (!isV1NodeStepConfig(node.config)) {
        throw new V2GraphError(`graphToDescription: v1 node '${node.name}' has no v1 node config (nodeType, typeVersion, parameters, continueOnFail)`);
      }
      // `toGraphNode` makes every Split In Batches a `batch` step, and decision 5 identifies a
      // batch node by its type, so a v1 node of that type would silently become one.
      if (node.config.nodeType === SPLIT_IN_BATCHES_TYPE) {
        throw new V2GraphError(`graphToDescription: v1 node '${node.name}' is a Split In Batches; the converter makes that a batch step`);
      }
      return {
        node: {
          ...common,
          type: node.config.nodeType,
          typeVersion: node.config.typeVersion,
          ...(node.config.continueOnFail ? { onError: 'continueRegularOutput' as const } : {}),
        },
        shape,
      };
    }
    case 'wait':
    case 'subworkflow':
      return { node: { ...common, type: V2_STEP_NODE_TYPES[node.type], typeVersion: 1 }, shape };
    default: {
      // A step type added after the pin reaches here from a `tasks/` script passing n8n's graph.
      const unknown: never = node.type;
      throw new V2GraphError(`graphToDescription: node '${node.name}' has step type '${String(unknown)}', which n8n@2.41.3 does not have`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `isTriggerStepConfig` (`node-engine-compatibility` `guards.ts`). */
function isTriggerStepConfig(config: unknown): config is { nodeType: string; typeVersion: number } {
  return isRecord(config) && typeof config['nodeType'] === 'string' && config['nodeType'].length > 0
    && typeof config['typeVersion'] === 'number' && isRecord(config['parameters']);
}

/**
 * `isV1NodeStepConfig` (`node-engine-compatibility` `guards.ts`), without its credentials
 * check: credentials are never read here, and a converted graph carries n8n's own.
 */
function isV1NodeStepConfig(config: unknown): config is { nodeType: string; typeVersion: number; continueOnFail: boolean } {
  return isTriggerStepConfig(config) && typeof (config as Record<string, unknown>)['continueOnFail'] === 'boolean';
}

/** `isBatchStepConfig` (`@n8n/engine` `graph/workflow-graph.ts`). */
function isBatchStepConfig(config: unknown): config is { batchSize: number } {
  if (!isRecord(config)) return false;
  const batchSize = config['batchSize'];
  return typeof batchSize === 'number' && Number.isInteger(batchSize) && batchSize >= 1;
}
