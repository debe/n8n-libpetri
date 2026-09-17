/**
 * Which nodes must hear of an upstream skip (ADR 0002, "A skip stops where nothing observes
 * it").
 *
 * An `empty` token asserts that an edge carries nothing for this activation of its producer,
 * and a skipped node forwards that assertion on its outgoing tree edges. The assertion has a
 * reader only where a node decides by it: a join or OR-input slot (the `or`, `join` and
 * `choose-branch` forms), a `$('X')` reference that reads `X/skipped`, and a cycle or Loop Over
 * Items, whose exits the emission rule already treats apart. Past the last such reader a chain
 * of skips changes no run data — n8n never runs a skipped node — and costs only interleavings:
 * the state-class graph explores every order of the chain against the branch that did run, and
 * a halt or a pause freezes it at every position it has reached.
 *
 * A node must hear of a skip when it reads one or feeds a node that does, and a skipped node
 * forwards its empties only when one of its successors must (`gadget/facts.ts`). The closure
 * follows every main edge backwards. Cycle edges carry no skip, but every node on one is an
 * observer already, so following them only keeps the set conservative.
 */
import type { AnalysedNode, EdgeRef } from '../types.js';

/** Whether `a` reads a skip itself: its form decides by empty slots, or it is referenced, cyclic or a loop. */
function observes(a: AnalysedNode, cyclic: ReadonlySet<string>, referenced: ReadonlySet<string>): boolean {
  const name = a.node.name;
  return (a.form !== 'direct' && a.form !== 'tool')
    || referenced.has(name) || cyclic.has(name) || a.shape.loopNode === true;
}

/** Every node that must hear of an upstream skip: the observers and every node that feeds one. */
export function skipObservableNodes(
  analysed: readonly AnalysedNode[],
  incoming: ReadonlyMap<string, readonly EdgeRef[]>,
  cyclic: ReadonlySet<string>,
  referenced: ReadonlySet<string>,
): ReadonlySet<string> {
  const observable = new Set<string>();
  const queue: string[] = [];
  for (const a of analysed) {
    if (!observes(a, cyclic, referenced)) continue;
    observable.add(a.node.name);
    queue.push(a.node.name);
  }
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    for (const e of incoming.get(name) ?? []) {
      if (observable.has(e.from)) continue;
      observable.add(e.from);
      queue.push(e.from);
    }
  }
  return observable;
}
