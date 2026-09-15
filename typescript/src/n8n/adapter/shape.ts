/**
 * The compiler's view of a live node's type: port counts, output names, `requiredInputs` and
 * `loopNode`, evaluated for the node through `workflow.nodeTypes.getByNameAndVersion` and the
 * injected `NodeHelpers.getNodeInputs` / `getNodeOutputs`. Only `main` ports are counted.
 */
import type {
  INode, INodeInputConfiguration, INodeOutputConfiguration, INodeTypeDescription, NodeConnectionType, Workflow,
  WorkflowExecuteMode,
} from 'n8n-workflow';
import type { NodeTypeShape, WorkflowDescription } from '../../compiler/index.js';
import type { NodeHelpersLike } from '../host.js';

/** Node types compiled as Loop Over Items (informational, carried into `NetMap`). */
export const LOOP_NODE_TYPES: ReadonlySet<string> = new Set(['n8n-nodes-base.splitInBatches']);

export interface AdapterOptions {
  readonly nodeHelpers: NodeHelpersLike;
  /** The mode `requiredInputs` expressions are evaluated under (n8n uses the execution's). Default `'internal'`. */
  readonly mode?: WorkflowExecuteMode;
}

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

/** The shape recorded for `name`, or {@link UnknownNodeError}: no node gets an invented shape. */
export function recordedShapeOf(shapes: ReadonlyMap<string, NodeTypeShape>, name: string): NodeTypeShape {
  const shape = shapes.get(name);
  if (shape === undefined) throw new UnknownNodeError(name);
  return shape;
}

/**
 * A description's two per-node lookups over what was recorded for each scheduled node — the
 * live adapter's and the verify CLI's alike.
 */
export function recordedLookups(
  shapes: ReadonlyMap<string, NodeTypeShape>, references: ReadonlyMap<string, string[]>,
): Pick<WorkflowDescription, 'nodeTypes' | 'expressionReferences'> {
  return {
    nodeTypes: (n) => recordedShapeOf(shapes, n.name),
    expressionReferences: (n) => references.get(n.name) ?? [],
  };
}

const isMain = (c: NodeConnectionType | INodeInputConfiguration | INodeOutputConfiguration): boolean =>
  (typeof c === 'string' ? c : c.type) === 'main';

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

/**
 * `requiredInputs` from the type description; a string form is evaluated with
 * `workflow.expression.getSimpleParameterValue(node, expr, mode, { $version }, undefined, [])`,
 * the call `stack-scheduler.ts`'s stuck-join fallback makes (lines 396–404), and the result is
 * narrowed by {@link normaliseRequiredInputs}.
 */
function requiredInputsOf(
  workflow: Workflow, node: INode, description: INodeTypeDescription, options: AdapterOptions,
): number | number[] | undefined {
  const raw = typeof description.requiredInputs === 'string'
    ? workflow.expression.getSimpleParameterValue(
      node, description.requiredInputs, options.mode ?? 'internal', { $version: node.typeVersion }, undefined, [])
    : description.requiredInputs;
  return normaliseRequiredInputs(raw);
}

/** Labels only (NetMap, and part of the structural hash): a non-string is no name. */
const labelOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The declared outputs' names, `''` for an unnamed one; `undefined` when none is named. */
function outputNamesOf(
  outputs: ReadonlyArray<NodeConnectionType | INodeOutputConfiguration>, declared: readonly string[] | undefined,
): string[] | undefined {
  const names = outputs.map((o, i) =>
    (typeof o === 'string' ? labelOf(declared?.[i]) : labelOf(o.displayName ?? declared?.[i])));
  return names.some((n) => n !== null) ? names.map((n) => n ?? '') : undefined;
}

/**
 * The compiler's view of one node type, evaluated for `node`. `getNodeOutputs` already appends
 * the error output under `onError: 'continueErrorOutput'` (`node-helpers.ts`, the
 * `{ category: 'error' }` entry), and the compiler appends it too, so one is subtracted: the
 * shape's `outputCount` is the declared main outputs without the error output.
 */
export function nodeShapeOf(workflow: Workflow, node: INode, options: AdapterOptions): NodeTypeShape {
  const description = workflow.nodeTypes.getByNameAndVersion(node.type, node.typeVersion).description;
  const inputs = options.nodeHelpers.getNodeInputs(workflow, node, description).filter(isMain);
  const outputs = options.nodeHelpers.getNodeOutputs(workflow, node, description).filter(isMain);
  const errorOutputs = node.onError === 'continueErrorOutput' ? 1 : 0;
  const declaredOutputs = outputs.slice(0, outputs.length - errorOutputs);
  const requiredInputs = requiredInputsOf(workflow, node, description, options);
  const outputNames = outputNamesOf(declaredOutputs, description.outputNames);
  return {
    inputCount: inputs.length,
    outputCount: declaredOutputs.length,
    ...(requiredInputs === undefined ? {} : { requiredInputs }),
    ...(LOOP_NODE_TYPES.has(node.type) ? { loopNode: true } : {}),
    ...(outputNames === undefined ? {} : { outputNames }),
  };
}
