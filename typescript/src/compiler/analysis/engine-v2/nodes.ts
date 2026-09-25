/**
 * The node-level refusals of the `engineV2` profile: what n8n refuses a node for, as opposed to
 * a shape of the graph (`shape.ts`). The converter's run on the nodes `rootAt` keeps
 * (`root.ts`) calls the first two, in the order `V1WorkflowConverter.convert` reaches them:
 *
 * | code | n8n (`V2_REFUSALS`, `refusals.ts`) |
 * |---|---|
 * | `v2-continue-error-output` | `toGraphNode`: `onError: 'continueErrorOutput'` |
 * | `v2-merge-mode` | `assertSupportedMergeMode`: mode `chooseBranch`; an expression mode at typeVersion ≥ 2 |
 * | `v2-batch-config` | `toBatchConfig`: a Split In Batches it cannot turn into a batch step |
 * | `v2-connection-type` | `validateSupportedConnectionType`: a connection other than `main` |
 * | `v2-unsupported-step` | `StepReadyHandler.executorFor`: no executor for a `wait` / `subworkflow` step |
 *
 * `toGraphNode` checks each live node but the fired trigger, which it makes the trigger step
 * before any check; `toEdgesForSource` then checks every connection type of every node kept,
 * disabled ones included. `v2-unsupported-step` is last and not the converter's: n8n accepts
 * such a graph and only fails to settle the step at run time.
 */
import { CompileError } from '../../errors.js';
import type { NodeDescription, NodeTypeShape } from '../../types.js';
import { requiredInputsOf } from '../inputs.js';
import { SPLIT_IN_BATCHES_TYPE, SPLIT_IN_BATCHES_TYPE_VERSION } from './batch.js';
import { refuseV2 } from './refusals.js';
import { isV2UnexecutableStep, V2_STEP_NODE_TYPES } from './steps.js';

/** `MERGE_TYPE` (`node-engine-compatibility` `constants.ts`). */
export const MERGE_TYPE = 'n8n-nodes-base.merge';

/**
 * `DEFAULT_BATCH_SIZE` (`node-engine-compatibility` `constants.ts`): SplitInBatchesV3's own
 * default, for a node that never set the parameter.
 */
export const DEFAULT_BATCH_SIZE = 1;

/** One node the checks read: its description and its evaluated shape. */
export interface V2NodeInput {
  readonly node: NodeDescription;
  readonly shape: NodeTypeShape;
}

/**
 * Whether `node` is a Merge in mode `chooseBranch` by its evaluated `requiredInputs`: the
 * reading for a description that does not carry {@link NodeDescription.mergeMode}, such as one
 * written by hand. n8n's Merge v2 and v3 declare `requiredInputs: mode === "chooseBranch" ?
 * [0, 1] : 1` (`Merge/v3/actions/versionDescription.ts`, `Merge/v2/MergeV2.node.ts`), so on
 * `MERGE_TYPE` a non-null `requiredInputsOf` is that mode exactly. A node of any other type is
 * never one: `assertSupportedMergeMode` runs on `MERGE_TYPE` only, whatever a node requires.
 */
export function isChooseBranchMerge({ node, shape }: V2NodeInput): boolean {
  return node.type === MERGE_TYPE && requiredInputsOf(shape) !== null;
}

/**
 * `toGraphNode`'s checks on one live node that is not the fired trigger, in its order:
 * `onError`, then `assertSupportedMergeMode` on a Merge, then `toBatchConfig` on a Split In
 * Batches. `shape` is asked only for a Merge whose description carries no `mergeMode`.
 */
export function checkV2ConvertedNode(node: NodeDescription, shape: () => NodeTypeShape): void {
  const name = node.name;
  if (node.onError === 'continueErrorOutput') {
    refuseV2('continueErrorOutput',
      `node '${name}' uses onError=continueErrorOutput, which engine v2 does not support ` +
      '(UnsupportedWorkflowError, toGraphNode, v1-workflow-converter.ts)', name);
  }
  if (node.type === MERGE_TYPE) checkMergeMode(node, shape);
  if (node.type === SPLIT_IN_BATCHES_TYPE) checkBatchConfig(node);
}

/**
 * `assertSupportedMergeMode` on a node of `MERGE_TYPE`: literally on `mergeMode` and the
 * version n8n compares; by `requiredInputs` when the description does not carry the mode.
 */
function checkMergeMode(node: NodeDescription, shape: () => NodeTypeShape): void {
  const name = node.name;
  const mode = node.mergeMode;
  const chooseBranch = mode === undefined ? isChooseBranchMerge({ node, shape: shape() }) : mode === 'chooseBranch';
  if (chooseBranch) {
    refuseV2('mergeChooseBranch',
      `node '${name}' is a Merge in mode chooseBranch, which engine v2 does not support: it waits for ` +
      'data on every input, and v2 runs a node once any input is live (UnsupportedWorkflowError, ' +
      'assertSupportedMergeMode, v1-workflow-converter.ts)', name);
  }
  // "An expression-valued mode could resolve to chooseBranch at run time", except on Merge v1,
  // which predates chooseBranch. n8n compares the version as written (`mergeVersion`).
  const version = node.mergeVersion ?? node.typeVersion;
  if (version >= 2 && typeof mode === 'string' && mode.startsWith('=')) {
    refuseV2('mergeExpressionMode',
      `node '${name}' sets its Merge mode with an expression, which cannot be checked at conversion time; ` +
      'engine v2 needs a literal mode (UnsupportedWorkflowError, assertSupportedMergeMode, v1-workflow-converter.ts)', name);
  }
}

/** `toBatchConfig`: what makes a Split In Batches a batch step, each refusal in its order. */
function checkBatchConfig(node: NodeDescription): void {
  const name = node.name;
  const at = '(UnsupportedWorkflowError, toBatchConfig, v1-workflow-converter.ts)';
  if (node.typeVersion !== SPLIT_IN_BATCHES_TYPE_VERSION) {
    refuseV2('batchVersion',
      `node '${name}' is a Split In Batches of version ${node.typeVersion}, and engine v2 supports only version ` +
      `${SPLIT_IN_BATCHES_TYPE_VERSION} ${at}`, name);
  }
  if (node.batch?.optionsExpression === true) {
    refuseV2('batchOptionsExpression', `node '${name}' sets its options from an expression, which engine v2 does not support ${at}`, name);
  }
  if (node.batch?.reset === true) {
    refuseV2('batchReset', `node '${name}' uses the reset option, which engine v2 does not support ${at}`, name);
  }
  const size = node.batch?.batchSize ?? DEFAULT_BATCH_SIZE;
  if (size === 'expression') {
    refuseV2('batchSizeExpression', `node '${name}' sets its batch size from an expression, which engine v2 does not support ${at}`, name);
  }
  if (!Number.isInteger(size) || size < 1) {
    refuseV2('batchSizeInvalid',
      `node '${name}' has a batch size of ${String(size)}, and it must be a whole number of at least 1 ${at}`, name);
  }
}

/**
 * `validateSupportedConnectionType`, over the nodes `rootAt` keeps, disabled ones included: a
 * source of any connection other than `main` is refused, whether or not the connection leads
 * anywhere.
 */
export function checkV2ConnectionTypes(nodes: readonly NodeDescription[]): void {
  for (const node of nodes) {
    const [type] = node.aiOutputs ?? [];
    if (type !== undefined) {
      refuseV2('connectionType',
        `node '${node.name}' has a "${type}" connection, which engine v2 does not support: only "main" ` +
        'connections are (UnsupportedConnectionTypeError, toEdgesForSource, v1-workflow-converter.ts)', node.name);
    }
  }
}

/**
 * `validateSupportedConnectionType` on the connections map's keys that name no node
 * (`StrayConnections.sources`): `rootAt` keeps the entry of every name it reaches, node or not,
 * and `toEdgesForSource` checks its types before it drops its edges. With no trigger nothing is
 * rooted and every entry is kept (`rooted` null).
 */
export function checkV2StraySources(
  sources: readonly { readonly name: string; readonly aiOutputs: readonly string[] }[],
  rooted: ReadonlySet<string> | null,
): void {
  for (const source of sources) {
    const [type] = source.aiOutputs;
    if (type !== undefined && (rooted === null || rooted.has(source.name))) {
      refuseV2('connectionType',
        `'${source.name}', a key of the connections map that is no node, has a "${type}" connection, which engine ` +
        'v2 does not support: only "main" connections are (UnsupportedConnectionTypeError, toEdgesForSource, ' +
        'v1-workflow-converter.ts)', source.name);
    }
  }
}

/**
 * A `wait` or `subworkflow` step the trigger reaches. `StepReadyHandler.executorFor`
 * (`@n8n/engine` `execution/step-ready-handler.ts`) throws `UnimplementedError` for both, and it
 * is called before the step's `try`: no row is written `failed`, the step stays `running`, its
 * siblings go on settling and the execution never finishes. No settlement fate models that —
 * a halt would stop the siblings, a completion would decide successors v2 never decides — so
 * the step is refused. It is a run-time site, not the converter's or the validator's, so it has
 * no `V2_REFUSALS` entry.
 */
export function checkV2Steps(nodes: readonly V2NodeInput[], reachable: ReadonlySet<string>): void {
  for (const { node } of nodes) {
    if (isV2UnexecutableStep(node) && reachable.has(node.name)) {
      const step = node.type === V2_STEP_NODE_TYPES.wait ? 'wait' : 'subworkflow';
      throw new CompileError('v2-unsupported-step',
        `compile: node '${node.name}' is a ${step} step, which engine v2 has no executor for: it would stay ` +
        'running and never settle (UnimplementedError, StepReadyHandler.executorFor, step-ready-handler.ts)', node.name);
    }
  }
}
