/**
 * Reachability over a directed graph given as edges: the closure both the static
 * main-connection descendants (the attribution rules) and the realised dependency order
 * (the concurrency rule) are built from.
 */

/** An edge of the graph, by its two vertices. */
export interface Arc {
  readonly from: string;
  readonly to: string;
}

/** The successors of every vertex with an outgoing edge, in edge order. */
export function successorsOf(edges: Iterable<Arc>): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const list = next.get(e.from);
    if (list === undefined) next.set(e.from, [e.to]);
    else list.push(e.to);
  }
  return next;
}

/**
 * Every vertex reachable from `start` over at least one edge (`start` itself only when the
 * edges cycle back to it). One iterative walk, so a long chain cannot overflow the stack.
 */
export function reachableFrom(next: ReadonlyMap<string, readonly string[]>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(next.get(start) ?? [])];
  while (stack.length > 0) {
    const vertex = stack.pop()!;
    if (seen.has(vertex)) continue;
    seen.add(vertex);
    stack.push(...(next.get(vertex) ?? []));
  }
  return seen;
}

/**
 * Transitive reachability over the realised dependency edges: for every producer, every
 * activation downstream of it (itself included when the edges cycle back). One iterative
 * walk per producer — the earlier recursive version memoised a set *before* filling it, so
 * a walk that re-entered an activation still on its stack read a partial closure and the
 * concurrency rule then called two dependent activations independent; and its recursion was
 * unbounded in the chain length.
 */
export function reachableOf(edges: readonly Arc[]): ReadonlyMap<string, ReadonlySet<string>> {
  const next = successorsOf(edges);
  return new Map([...next.keys()].map((from) => [from, reachableFrom(next, from)]));
}
