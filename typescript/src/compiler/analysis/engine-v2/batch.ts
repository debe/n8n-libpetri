/**
 * What makes a node engine v2's `batch` step, and the slots such a step has
 * (`tasks/v2-profile-plan.md` decision 5). The compiler owns these names because the analysis
 * (loops, shape refusals) and the settlement gadget both read them; the stage-1 graph input
 * (`conformance/v2/graph.ts`) builds its batch nodes from the same constants.
 */
import type { NodeDescription } from '../../types.js';

/** `SPLIT_IN_BATCHES_TYPE` (`node-engine-compatibility` `constants.ts`). */
export const SPLIT_IN_BATCHES_TYPE = 'n8n-nodes-base.splitInBatches';

/**
 * `SPLIT_IN_BATCHES_TYPE_VERSION`: the only version `toBatchConfig`
 * (`v1-workflow-converter.ts`) accepts, and the one `toV1BatchNode` rebuilds a batch node at.
 */
export const SPLIT_IN_BATCHES_TYPE_VERSION = 3;

/** The done slot, `DONE_SLOT` (`@n8n/engine` `execution/loop-ledger.ts`): the loop's only way out. */
export const DONE_SLOT = 0;

/** The loop slot, `LOOP_SLOT` (`execution/loop-ledger.ts`): one pass's slice, into the body. */
export const LOOP_SLOT = 1;

/** A batch node's outputs, by slot: {@link DONE_SLOT} then {@link LOOP_SLOT}. */
export const BATCH_OUTPUT_NAMES: readonly ['done', 'loop'] = ['done', 'loop'];

/**
 * `MAX_SLOT_INDEX` (`@n8n/engine` `graph/validate-executable-graph.ts`): the highest input or
 * output slot an edge may use.
 */
export const MAX_SLOT_INDEX = 100;

/**
 * Whether `node` is v2's `batch` step: a Split In Batches at version 3, which is what
 * `toGraphNode` makes a `batch` step and `toBatchConfig` accepts. `NodeTypeShape.loopNode`
 * does not decide it: v1's Loop Over Items flag is informational, and a Split In Batches at
 * another version is refused by the converter rather than looped.
 */
export function isV2BatchNode(node: Pick<NodeDescription, 'type' | 'typeVersion'>): boolean {
  return node.type === SPLIT_IN_BATCHES_TYPE && node.typeVersion === SPLIT_IN_BATCHES_TYPE_VERSION;
}
