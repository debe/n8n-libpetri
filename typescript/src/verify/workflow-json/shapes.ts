/**
 * A node's type shape when all the export has is the node: resolution order 1–4 of
 * `verify/workflow-json.ts`'s module doc — the `--node-types` file by name, then by type, then
 * {@link BUILT_IN_SHAPES}, then the connection heuristic, which is the only step that guesses.
 */
import type { MainConnection, NodeDescription, NodeTypeShape } from '../../compiler/index.js';
import { LOOP_NODE_TYPES } from '../../n8n/adapter/shape.js';
import type { NodeTypesFile } from './node-types-file.js';
import { looksLikeTrigger } from './start-node.js';

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

/**
 * `loopNode` is a property of the *type*, not of the ports, and a supplied shape has no
 * reason to restate it — so it is applied on every path of {@link shapeOf} rather than only on
 * the two that used to have it. A shape that sets it explicitly still wins, in either direction.
 */
function withLoopNode(type: string, shape: NodeTypeShape): NodeTypeShape {
  return shape.loopNode !== undefined || !LOOP_NODE_TYPES.has(type) ? shape : { ...shape, loopNode: true };
}

/**
 * A supplied shape is authoritative for the *counts* — it is n8n's own number and it is
 * per-version, where a built-in is one hand-written guess for every version. But n8n's
 * generated type file lists a port as the bare string `"main"`, so it carries no names at
 * all, and a catalogue built from it would silently erase the `outputNames` that let a
 * `route` step say `'true'` instead of `1`. So the built-in fills what the supplied shape
 * leaves out, and only while the two agree on how many ports there are.
 */
function withBuiltInNames(type: string, parameters: Record<string, unknown>, shape: NodeTypeShape): NodeTypeShape {
  const builtInFor = BUILT_IN_SHAPES[type];
  if (builtInFor === undefined) return shape;
  const known = builtInFor(parameters);
  if (known.inputCount !== shape.inputCount || known.outputCount !== shape.outputCount) return shape;
  return {
    ...shape,
    ...(shape.outputNames === undefined && known.outputNames !== undefined
      ? { outputNames: known.outputNames } : {}),
    ...(shape.requiredInputs === undefined && known.requiredInputs !== undefined
      ? { requiredInputs: known.requiredInputs } : {}),
  };
}

/** Steps 1–2: the `--node-types` entry for `node` by name, then by `type@typeVersion`, then by `type`. */
function suppliedShapeOf(node: NodeDescription, types: NodeTypesFile): NodeTypeShape | undefined {
  const byName = types.nodes?.[node.name];
  if (byName !== undefined) return byName;
  return types.types?.[`${node.type}@${node.typeVersion}`] ?? types.types?.[node.type];
}

interface PortUse {
  readonly maxInput: number;
  readonly maxOutput: number;
}

function portUse(node: string, connections: readonly MainConnection[]): PortUse {
  let maxInput = -1;
  let maxOutput = -1;
  for (const c of connections) {
    if (c.to === node && c.inputIndex > maxInput) maxInput = c.inputIndex;
    if (c.from === node && c.outputIndex > maxOutput) maxOutput = c.outputIndex;
  }
  return { maxInput, maxOutput };
}

/** Step 4, the connection heuristic of the module doc. Pushes the warning that says so. */
function guessedShapeOf(
  node: NodeDescription, connections: readonly MainConnection[], warnings: string[],
): NodeTypeShape {
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
  return { inputCount, outputCount };
}

/** Resolution order 1–4 of the module doc. Pushes a warning whenever it reaches step 4. */
export function shapeOf(
  node: NodeDescription,
  parameters: Record<string, unknown>,
  connections: readonly MainConnection[],
  types: NodeTypesFile,
  warnings: string[],
): NodeTypeShape {
  const supplied = suppliedShapeOf(node, types);
  if (supplied !== undefined) return withLoopNode(node.type, withBuiltInNames(node.type, parameters, supplied));
  const builtIn = BUILT_IN_SHAPES[node.type];
  if (builtIn !== undefined) return withLoopNode(node.type, builtIn(parameters));
  return withLoopNode(node.type, guessedShapeOf(node, connections, warnings));
}
