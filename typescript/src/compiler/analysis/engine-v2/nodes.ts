/**
 * The node-level refusals of the `engineV2` profile: what n8n refuses a node for, as opposed to
 * a shape of the graph (`shape.ts`). Each is checked on the nodes the trigger reaches, since
 * `rootAt` (`v1-workflow-converter.ts`) drops the rest before the converter looks at a node.
 *
 * | code | why |
 * |---|---|
 * | `v2-continue-error-output` | `toGraphNode`: `onError: 'continueErrorOutput'` (`UnsupportedWorkflowError`) |
 * | `v2-merge-mode` | `assertSupportedMergeMode`: a Merge in mode `chooseBranch` (`UnsupportedWorkflowError`) |
 * | `v2-disabled-node` | ours: `spliceOutDisabledNodes` is not ported yet (stage 2, plan step 13) |
 * | `v2-unsupported-step` | `StepReadyHandler.executorFor`: no executor for a `wait` / `subworkflow` step |
 *
 * `analyseEngineV2` calls them in the order n8n reaches the defect: the converter's own checks
 * (`toGraphNode`, over the live nodes) come first, then the disabled nodes (their splicing comes
 * next in `convert`, and every edge check after it reads the spliced graph, which we cannot
 * build yet), then `shape.ts`, and `v2-unsupported-step` last, because n8n accepts such a graph
 * and only fails to settle the step at run time.
 *
 * `assertSupportedMergeMode`'s second case, a mode written as an expression at typeVersion ≥ 2,
 * needs the Merge's `mode` parameter, which a description does not carry until step 13 adds
 * `NodeDescription.mergeMode`. Until then chooseBranch is read from what a description does
 * carry: the evaluated `requiredInputs` (see {@link isChooseBranchMerge}).
 */
import { CompileError } from '../../errors.js';
import type { EdgeRef, NodeDescription, NodeTypeShape } from '../../types.js';
import { requiredInputsOf } from '../inputs.js';
import { isV2UnexecutableStep, V2_STEP_NODE_TYPES } from './steps.js';

/** `MERGE_TYPE` (`node-engine-compatibility` `constants.ts`). */
export const MERGE_TYPE = 'n8n-nodes-base.merge';

/** One node the checks read: its description and its evaluated shape. */
export interface V2NodeInput {
  readonly node: NodeDescription;
  readonly shape: NodeTypeShape;
}

/**
 * Whether `node` is a Merge in mode `chooseBranch`, read from its evaluated `requiredInputs`.
 * n8n's Merge v2 and v3 declare `requiredInputs: mode === "chooseBranch" ? [0, 1] : 1`
 * (`Merge/v3/actions/versionDescription.ts`, `Merge/v2/MergeV2.node.ts`), so on `MERGE_TYPE`
 * a non-null `requiredInputsOf` is that mode exactly. A node of another type counts when its
 * `requiredInputs` make it v1's `choose-branch` join (inputs on two or more slots, some
 * required): that is how a description without the Merge type says chooseBranch (the compiler
 * fixtures `mergeChoose`, `merge3Choose`). No other n8n type is caught: CompareDatasets
 * declares `requiredInputs: 1` over two inputs, which names none, and ModelSelector's one main
 * input can never make a join.
 */
export function isChooseBranchMerge({ node, shape }: V2NodeInput, incoming: readonly EdgeRef[]): boolean {
  if (requiredInputsOf(shape) === null) return false;
  return node.type === MERGE_TYPE || new Set(incoming.map((e) => e.inputIndex)).size > 1;
}

/**
 * `toGraphNode`'s refusals, over the live nodes the trigger reaches in canvas order: the trigger
 * is exempt (`toGraphNode` makes it a trigger step before either check), and so is a disabled
 * node, which the converter never converts.
 */
export function checkV2ConvertedNodes(
  nodes: readonly V2NodeInput[],
  reachable: ReadonlySet<string>,
  trigger: string,
  incoming: ReadonlyMap<string, readonly EdgeRef[]>,
): void {
  for (const n of nodes) {
    const name = n.node.name;
    if (!reachable.has(name) || name === trigger || n.node.disabled === true) continue;
    if (n.node.onError === 'continueErrorOutput') {
      throw new CompileError('v2-continue-error-output',
        `compile: node '${name}' uses onError=continueErrorOutput, which engine v2 does not support ` +
        '(UnsupportedWorkflowError, toGraphNode, v1-workflow-converter.ts)', name);
    }
    if (isChooseBranchMerge(n, incoming.get(name) ?? [])) {
      throw new CompileError('v2-merge-mode',
        `compile: node '${name}' is a Merge in mode chooseBranch, which engine v2 does not support: it waits for ` +
        'data on every input, and v2 runs a node once any input is live (UnsupportedWorkflowError, ' +
        'assertSupportedMergeMode, v1-workflow-converter.ts)', name);
    }
  }
}

/**
 * A disabled node the trigger reaches. n8n splices it out (`spliceOutDisabledNodes`: every edge
 * into its slot 0 joined to every edge out of it), which is stage 2's port (plan step 13);
 * until then the graph n8n would check is not the one this description draws, so the node is
 * refused rather than compiled as if it ran.
 */
export function checkV2DisabledNodes(nodes: readonly V2NodeInput[], reachable: ReadonlySet<string>): void {
  for (const { node } of nodes) {
    if (node.disabled === true && reachable.has(node.name)) {
      throw new CompileError('v2-disabled-node',
        `compile: node '${node.name}' is disabled; engine v2 splices a disabled node out of the graph ` +
        '(spliceOutDisabledNodes, v1-workflow-converter.ts), which the engineV2 profile does not port yet', node.name);
    }
  }
}

/**
 * A `wait` or `subworkflow` step the trigger reaches. `StepReadyHandler.executorFor`
 * (`@n8n/engine` `execution/step-ready-handler.ts`) throws `UnimplementedError` for both, and it
 * is called before the step's `try`: no row is written `failed`, the step stays `running`, its
 * siblings go on settling and the execution never finishes. No settlement fate models that —
 * a halt would stop the siblings, a completion would decide successors v2 never decides — so
 * the step is refused.
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
