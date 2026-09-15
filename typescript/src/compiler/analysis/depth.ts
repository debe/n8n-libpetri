/**
 * Depth: the longest path over the SCC condensation from any start node, the `X_start` priority
 * under EXEC-002, with each tool placed one step below the agent that dispatches it.
 */
import type { EdgeRef, ToolConnection } from '../types.js';
import type { RawNode } from './validate.js';

/** Each node's depth and the deepest of them. */
export interface Depths {
  readonly depth: ReadonlyMap<string, number>;
  readonly maxDepth: number;
}

/** Computes every node's depth over the condensation, then over the tool dispatch relation. */
export function depthOf(
  raws: readonly RawNode[],
  startNodes: readonly string[],
  sccs: readonly (readonly string[])[],
  sccOf: ReadonlyMap<string, number>,
  outgoing: ReadonlyMap<string, readonly EdgeRef[]>,
  toolConnections: readonly ToolConnection[],
  diagnostics: string[],
): Depths {
  // ---- depth: longest path over the condensation from any start node, in topological order ----
  // Tarjan emits SCCs in reverse topological order, so walking them backwards visits every
  // SCC after all of its predecessors.
  const sccDepth = new Array<number>(sccs.length).fill(-1);
  for (const s of startNodes) sccDepth[sccOf.get(s)!] = 0;
  for (let s = sccs.length - 1; s >= 0; s--) {
    const d = sccDepth[s]!;
    if (d < 0) continue;
    for (const n of sccs[s]!) {
      for (const e of outgoing.get(n)!) {
        if (e.kind === 'tree') {
          const t = sccOf.get(e.to)!;
          if (sccDepth[t]! < d + 1) sccDepth[t] = d + 1;
        }
      }
    }
  }
  const depth = new Map<string, number>();
  for (const r of raws) depth.set(r.node.name, Math.max(0, sccDepth[sccOf.get(r.node.name)!]!));
  // A tool is not on the main graph, so the condensation gave it 0. It runs one step below the
  // agent that dispatches it, and `X_start` priority is depth, so it must sort below its agent
  // and above nothing else. Iterated for the agent-as-tool case; `toolConnections.length` passes
  // is enough for any acyclic dispatch graph, and a cyclic one (an agent reachable from its own
  // tool) is diagnosed and left at the depth it reached.
  for (let pass = 0; pass <= toolConnections.length; pass++) {
    let changed = false;
    for (const c of toolConnections) {
      const want = depth.get(c.agent)! + 1;
      if (depth.get(c.tool)! < want) {
        depth.set(c.tool, want);
        changed = true;
      }
    }
    if (!changed) break;
    if (pass === toolConnections.length) {
      diagnostics.push('ai_tool dispatch has a cycle (an agent is reachable from its own tool); depths are truncated');
    }
  }
  let maxDepth = 0;
  for (const d of depth.values()) if (d > maxDepth) maxDepth = d;
  return { depth, maxDepth };
}
