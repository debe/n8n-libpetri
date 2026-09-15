/**
 * SCC decomposition of the main-connection graph (Tarjan) and the edge classification the
 * emission rule reads (ADR 0002): an edge inside one SCC is a `cycle` edge, any other a `tree`
 * edge.
 */
import type { EdgeRef } from '../types.js';
import type { RawEdge } from './connections.js';
import type { RawNode } from './validate.js';

/** The main graph's successors, SCCs, cyclic nodes and classified edges. */
export interface Decomposition {
  readonly succ: ReadonlyMap<string, readonly string[]>;
  /** Node name to SCC index (Tarjan emission order: reverse topological). */
  readonly sccOf: ReadonlyMap<string, number>;
  readonly sccs: readonly (readonly string[])[];
  readonly cyclic: ReadonlySet<string>;
  readonly edges: readonly EdgeRef[];
  readonly incoming: ReadonlyMap<string, readonly EdgeRef[]>;
  readonly outgoing: ReadonlyMap<string, readonly EdgeRef[]>;
}

/** Decomposes the main graph into SCCs and classifies every edge as `tree` or `cycle`. */
export function decompose(raws: readonly RawNode[], mainEdges: readonly RawEdge[]): Decomposition {
  // ---- SCC decomposition (Tarjan) ----
  const succ = new Map<string, string[]>();
  for (const r of raws) succ.set(r.node.name, []);
  for (const e of mainEdges) succ.get(e.from)!.push(e.to);
  const { sccOf, sccs } = tarjan(raws.map((r) => r.node.name), succ);
  const cyclic = new Set<string>();
  for (const scc of sccs) if (scc.length > 1) for (const n of scc) cyclic.add(n);
  for (const e of mainEdges) if (e.from === e.to) cyclic.add(e.from);

  const edges: EdgeRef[] = mainEdges.map(({ from, outputIndex, to, inputIndex }, id) => ({
    from, outputIndex, to, inputIndex, id, kind: sccOf.get(from) === sccOf.get(to) ? 'cycle' : 'tree',
  }));
  const incoming = new Map<string, EdgeRef[]>();
  const outgoing = new Map<string, EdgeRef[]>();
  for (const r of raws) {
    incoming.set(r.node.name, []);
    outgoing.set(r.node.name, []);
  }
  for (const e of edges) {
    incoming.get(e.to)!.push(e);
    outgoing.get(e.from)!.push(e);
  }
  return { succ, sccOf, sccs, cyclic, edges, incoming, outgoing };
}

/** One frame of the depth-first walk: the node and how far along its successors it is. */
interface TarjanFrame {
  readonly v: string;
  readonly next: readonly string[];
  pos: number;
}

/**
 * Tarjan's SCC algorithm; SCCs are emitted in reverse topological order. Iterative, with the
 * recursion made an explicit frame stack, so a long chain of nodes cannot overflow the call
 * stack; the visit order — and so every SCC id — is exactly the recursive one's.
 */
function tarjan(
  names: readonly string[],
  succ: ReadonlyMap<string, readonly string[]>,
): { sccOf: Map<string, number>; sccs: string[][] } {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccOf = new Map<string, number>();
  const sccs: string[][] = [];
  let counter = 0;

  const enter = (v: string, frames: TarjanFrame[]): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    frames.push({ v, next: succ.get(v) ?? [], pos: 0 });
  };
  /** Every successor of `v` visited: pop its SCC if `v` is the root of one. */
  const leave = (v: string): void => {
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      scc.push(w);
      sccOf.set(w, sccs.length);
    } while (w !== v);
    sccs.push(scc);
  };

  for (const root of names) {
    if (index.has(root)) continue;
    const frames: TarjanFrame[] = [];
    enter(root, frames);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const w = frame.next[frame.pos];
      if (w !== undefined) {
        frame.pos++;
        if (!index.has(w)) enter(w, frames);
        else if (onStack.has(w)) low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        continue;
      }
      frames.pop();
      leave(frame.v);
      // The return from the recursive call: the caller's low-link takes the callee's.
      const caller = frames[frames.length - 1];
      if (caller !== undefined) low.set(caller.v, Math.min(low.get(caller.v)!, low.get(frame.v)!));
    }
  }
  return { sccOf, sccs };
}
