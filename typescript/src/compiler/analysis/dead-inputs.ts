/**
 * Dead required inputs (README "Join gadget"): required inputs with no producer below the highest
 * wired index, which n8n pads and never runs.
 */
import type { EdgeRef } from '../types.js';
import type { RawNode } from './validate.js';

/** Every node's dead required inputs, ascending; diagnosed where there are any. */
export function findDeadInputs(
  raws: readonly RawNode[],
  incoming: ReadonlyMap<string, readonly EdgeRef[]>,
  diagnostics: string[],
): Map<string, number[]> {
  // ---- dead required inputs (README join gadget) ----
  const deadInputsOf = new Map<string, number[]>();
  for (const r of raws) {
    const wired = new Set<number>();
    let maxWired = -1;
    for (const e of incoming.get(r.node.name)!) {
      wired.add(e.inputIndex);
      if (e.inputIndex > maxWired) maxWired = e.inputIndex;
    }
    const dead: number[] = [];
    if (r.requiredInputs !== null && maxWired >= 1) {
      for (const i of r.requiredInputs) if (i < maxWired && !wired.has(i)) dead.push(i);
    }
    if (dead.length > 0) {
      diagnostics.push(
        `node '${r.node.name}' requires input${dead.length > 1 ? 's' : ''} ${dead.join(', ')} ` +
        `but ${dead.length > 1 ? 'they have' : 'it has'} no producer; n8n pads the lower inputs and never runs it, ` +
        'so the join can never complete');
    }
    deadInputsOf.set(r.node.name, dead);
  }
  return deadInputsOf;
}
