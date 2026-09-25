/**
 * Engine v2's batch loops, derived from the structure (`tasks/v2-profile-plan.md` decision 6).
 *
 * A description carries no `isBackEdge` (stage 1 drops it, `conformance/v2/graph.ts`), so which
 * edge closes a loop is derived again here, by the rule n8n marks it with, and then read the way
 * n8n reads a marked graph:
 * - {@link markV2BackEdges} is `V1WorkflowConverter.markBackEdges`
 *   (`node-engine-compatibility` `v1-workflow-converter.ts`), with `resolveSingleBatchEntry`;
 * - {@link deriveV2Loops} is `deriveLoops` (`@n8n/engine` `graph/loops.ts`);
 * - {@link classifyV2Edge} is `classifyEdge` (`@n8n/engine` `execution/iteration-mapping.ts`).
 *
 * Nothing here refuses: a cycle `markBackEdges` would throw on comes back as a
 * {@link BackEdgeMarking} naming the defect, and `shape.ts` turns it into the `CompileError`,
 * beside the `validateLoops` rules that need the derived loops first. With several defective
 * components, the one named is the first in {@link componentsOf}'s order, which may not be the
 * one n8n throws on; the verdict is the same either way (`shape.ts`).
 */
import type { EdgeRef, V2EdgeClass, V2Loop } from '../../types.js';
import { tarjan } from '../scc.js';

/**
 * What {@link markV2BackEdges} found:
 * - `marked`: every cycle has a single batch entry; `back` holds the ids of the return edges;
 * - `unbatched-cycle`: a cycle with no batch node (`UnsupportedCycleError`);
 * - `ambiguous-entry`: a cycle entered other than through exactly one batch node
 *   (`UnsupportedLoopEntryError`); `entries` are the candidate entries `resolveSingleBatchEntry`
 *   saw.
 */
export type BackEdgeMarking =
  | { readonly kind: 'marked'; readonly back: ReadonlySet<number> }
  | { readonly kind: 'unbatched-cycle'; readonly members: readonly string[] }
  | { readonly kind: 'ambiguous-entry'; readonly members: readonly string[]; readonly entries: readonly string[] };

/** Successor lists of `nodes` over `edges`, one entry per edge. */
function successors(nodes: readonly string[], edges: readonly EdgeRef[]): Map<string, string[]> {
  const succ = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of edges) succ.get(e.from)?.push(e.to);
  return succ;
}

/** The strongly connected components of `nodes` over `edges` (Tarjan, `scc.ts`). */
export function componentsOf(nodes: readonly string[], edges: readonly EdgeRef[]): readonly (readonly string[])[] {
  return tarjan(nodes, successors(nodes, edges)).sccs;
}

/**
 * `isCyclic` (`graph/loops.ts`): a component is a cycle when it has more than one member, or
 * its one member has an edge to itself.
 */
export function isCyclicComponent(members: readonly string[], edges: readonly EdgeRef[]): boolean {
  if (members.length > 1) return true;
  const only = members[0];
  return edges.some((e) => e.from === only && e.to === only);
}

/**
 * `markBackEdges`: peels loops from the outside in. Each round takes the cyclic components of
 * the edges not yet marked, resolves each one's single batch entry, marks the component's edges
 * into that entry as return edges and cuts them; a nested loop then surfaces as its own
 * component in the next round. Only set membership decides, so the marks do not depend on node
 * or edge order — which is what lets them be compared with n8n's `isBackEdge` edge for edge.
 */
export function markV2BackEdges(
  nodes: readonly string[],
  edges: readonly EdgeRef[],
  batchNodes: ReadonlySet<string>,
): BackEdgeMarking {
  const back = new Set<number>();
  let remaining = edges;
  while (remaining.length > 0) {
    const cyclic = componentsOf(nodes, remaining).filter((members) => isCyclicComponent(members, remaining));
    if (cyclic.length === 0) break;
    for (const members of cyclic) {
      const memberSet = new Set(members);
      // `resolveSingleBatchEntry`: exactly one way in from outside, and it is a batch node. A
      // component nothing points into has no outside entry, so its batch node stands in,
      // provided it has exactly one.
      const batchMembers = members.filter((n) => batchNodes.has(n));
      if (batchMembers.length === 0) return { kind: 'unbatched-cycle', members };
      const external = new Set<string>();
      for (const e of remaining) if (memberSet.has(e.to) && !memberSet.has(e.from)) external.add(e.to);
      const entries = external.size > 0 ? [...external] : batchMembers;
      const entry = entries[0];
      if (entries.length !== 1 || entry === undefined || !batchNodes.has(entry)) {
        return { kind: 'ambiguous-entry', members, entries };
      }
      for (const e of remaining) if (e.to === entry && memberSet.has(e.from)) back.add(e.id);
    }
    remaining = remaining.filter((e) => !back.has(e.id));
  }
  return { kind: 'marked', back };
}

/**
 * `deriveLoops`: one loop per back-edge target, its members the target's component over every
 * edge, back edges included. Loops come in `nodes` order of their batch node (n8n lists them in
 * edge order of the first return edge; the set is the same).
 */
export function deriveV2Loops(
  nodes: readonly string[],
  edges: readonly EdgeRef[],
  back: ReadonlySet<number>,
): V2Loop[] {
  const targets = new Set(edges.filter((e) => back.has(e.id)).map((e) => e.to));
  if (targets.size === 0) return [];
  const memberOf = new Map<string, ReadonlySet<string>>();
  for (const component of componentsOf(nodes, edges)) {
    const members = new Set(component);
    for (const n of component) memberOf.set(n, members);
  }
  return nodes.filter((n) => targets.has(n)).map((batchNode): V2Loop => {
    const members = memberOf.get(batchNode) ?? new Set([batchNode]);
    return {
      batchNode,
      members,
      backEdges: edges.filter((e) => back.has(e.id) && e.to === batchNode),
      entryEdges: edges.filter((e) => !back.has(e.id) && e.to === batchNode && !members.has(e.from)),
      exitEdges: edges.filter((e) => !back.has(e.id) && members.has(e.from) && !members.has(e.to)),
    };
  });
}

/**
 * `classifyEdge`: which rows an edge connects (see {@link V2EdgeClass}). An edge leaving one
 * loop into another is `exit`: its source row is the first loop's terminal row, and the target
 * row is at iteration 0 either way.
 */
export function classifyV2Edge(edge: EdgeRef, isBack: boolean, loops: readonly V2Loop[]): V2EdgeClass {
  if (isBack) return 'back';
  const sourceLoop = loops.find((loop) => loop.members.has(edge.from));
  const targetLoop = loops.find((loop) => loop.members.has(edge.to));
  if (sourceLoop !== undefined && sourceLoop === targetLoop) return 'intra';
  if (sourceLoop !== undefined) return 'exit';
  if (targetLoop !== undefined) return 'entry';
  return 'plain';
}
