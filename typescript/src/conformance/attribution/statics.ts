/**
 * What the attribution rules read off the workflow's *static* shape, and off the net's
 * diagnostics: the divergence #2 closure, the divergence #20 gadget's nodes and the nodes the
 * net reported a stranded token for.
 */
import type { WorkflowDescription } from '../../compiler/index.js';
import { reachableFrom, successorsOf } from '../gates/reach.js';

/** The static main-connection descendants of every node, for the divergence #2 rule. */
export function descendantsOf(workflow: WorkflowDescription): Map<string, Set<string>> {
  const next = successorsOf(workflow.connections);
  return new Map(workflow.nodes.map((node) => [node.name, reachableFrom(next, node.name)]));
}

/**
 * Nodes an input of which has more than one producer edge — the OR-input gadget (README
 * "OR-inputs"), whose `arm` transition is what divergence #20 is about.
 */
export function orInputNodesOf(workflow: WorkflowDescription): Set<string> {
  // Node → input index → producer count: nested, so no composite key can collide with an
  // activation key (a node name may contain `#`).
  const producers = new Map<string, Map<number, number>>();
  for (const c of workflow.connections) {
    let inputs = producers.get(c.to);
    if (inputs === undefined) { inputs = new Map(); producers.set(c.to, inputs); }
    inputs.set(c.inputIndex, (inputs.get(c.inputIndex) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [node, inputs] of producers) {
    for (const count of inputs.values()) if (count > 1) out.add(node);
  }
  return out;
}

/**
 * What the attribution rules read off the workflow's *static* shape, independent of the
 * budget: computed once per fixture and shared by every budget it runs at.
 */
export interface FixtureStatics {
  /** {@link descendantsOf}: the divergence #2 closure. */
  readonly descendants: ReadonlyMap<string, ReadonlySet<string>>;
  /** {@link orInputNodesOf}: the divergence #20 gadget's nodes. */
  readonly orInputNodes: ReadonlySet<string>;
}

export function fixtureStatics(workflow: WorkflowDescription): FixtureStatics {
  return { descendants: descendantsOf(workflow), orInputNodes: orInputNodesOf(workflow) };
}

/** `node 'X': stranded token on …` — the runtime half of divergence #2. */
export function strandedNodesOf(diagnostics: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of diagnostics) {
    if (!d.includes('stranded')) continue;
    const match = /node '([^']+)'/.exec(d);
    if (match !== null) out.push(match[1]!);
  }
  return out;
}
