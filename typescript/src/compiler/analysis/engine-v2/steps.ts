/**
 * The engine v2 step types that have no executor at the pin `n8n@2.41.3`: `wait` and
 * `subworkflow`. `StepReadyHandler.executorFor` (`@n8n/engine` `execution/step-ready-handler.ts`)
 * runs `v1-node` steps and throws `UnimplementedError` for anything else but `batch`, before the
 * step's `try`, so such a step is never settled: it stays `running`. The compiler owns their node
 * types because the `engineV2` analysis refuses them by these types (`v2-unsupported-step`,
 * `nodes.ts`); the stage-1 graph input (`conformance/v2/graph.ts`) gives the steps these types.
 */
import type { NodeDescription } from '../../types.js';

/**
 * The node type a `wait` or `subworkflow` step compiles under. Neither step carries an n8n node
 * type; the names are chosen so that no n8n node type can collide with them.
 */
export const V2_STEP_NODE_TYPES: Readonly<Record<'wait' | 'subworkflow', string>> = {
  wait: '@n8n/engine.wait',
  subworkflow: '@n8n/engine.subworkflow',
};

/** Whether `node` is a `wait` or `subworkflow` step, which v2 has no executor for. */
export function isV2UnexecutableStep(node: Pick<NodeDescription, 'type'>): boolean {
  return node.type === V2_STEP_NODE_TYPES.wait || node.type === V2_STEP_NODE_TYPES.subworkflow;
}
