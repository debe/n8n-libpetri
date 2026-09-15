/**
 * The input-side facts of one node: which inputs `requiredInputs` makes required (the R6 check
 * of `workflow-execute.ts`) and which gadget form its input side takes (README "Join gadget",
 * "OR-inputs").
 */
import type { AnalysedNode, EdgeRef, JoinForm, NodeTypeShape } from '../types.js';

/** Whether `requiredInputs` names every input (n8n `workflow-execute.ts`, the R6 check). */
export function isAllRequired(shape: NodeTypeShape): boolean {
  const r = shape.requiredInputs;
  if (r === undefined) return false;
  if (typeof r === 'number') return r === shape.inputCount;
  return r.length === shape.inputCount;
}

/** The inputs that must carry data (see `AnalysedNode.requiredInputs`). */
export function requiredInputsOf(shape: NodeTypeShape): readonly number[] | null {
  if (isAllRequired(shape)) return Array.from({ length: shape.inputCount }, (_, i) => i);
  const r = shape.requiredInputs;
  if (r === undefined || typeof r === 'number' || r.length === 0) return null;
  return [...new Set(r)].filter((i) => Number.isInteger(i) && i >= 0 && i < shape.inputCount).sort((x, y) => x - y);
}

/**
 * Chooses the input-side gadget. `direct` for at most one producer on one input (dead
 * inputs count as inputs); `or` for one input with several empty-capable (tree) producer
 * edges (README "OR-inputs"; producers inside a cycle carry `nil`, never `empty`, and do
 * not count); otherwise the join gadget, `choose-branch` when some inputs are required.
 */
export function joinFormOf(
  a: Pick<AnalysedNode, 'isTool' | 'deadInputs' | 'requiredInputs'>,
  incoming: readonly EdgeRef[],
): JoinForm {
  // A tool node has no `main` producer by construction (`analyse` only sets `isTool` when
  // `incoming` is empty), so its input side is the agent's dispatch place and nothing else.
  if (a.isTool) return 'tool';
  const indexes = new Set<number>(a.deadInputs);
  for (const e of incoming) indexes.add(e.inputIndex);
  if (indexes.size <= 1) {
    const treeEdges = incoming.filter((e) => e.kind === 'tree').length;
    if (treeEdges > 1) return 'or';
    if (incoming.length <= 1) return 'direct';
    return 'join';
  }
  return a.requiredInputs === null ? 'join' : 'choose-branch';
}
