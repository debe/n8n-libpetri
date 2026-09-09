/**
 * Root cause C — `StateClassGraph` counts one marking as several classes when the clock
 * order differs.
 *
 * `classKey` (`state-class-graph.ts`) is `marking.toString() + firingDomain.toString()`;
 * `DBM.toString()` walks `clockNames` in stored order; a successor's order is
 * `[...persistent, ...newlyEnabled]`; `DBM.equals` compares `clockNames[i]` positionally. So
 * the order in which transitions *became* enabled is part of a class's identity. On an untimed
 * net every domain is `[0, ∞)` per clock, and the order is the only difference.
 */
import { StateClassGraph } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { markingStateOf } from '../../src/verify/verify.js';
import { linear, diamond, agentTwoTools } from '../fixtures/workflows.js';

for (const [label, wf] of [['linear', linear], ['diamond', diamond], ['agentTwoTools (maxToolCalls 6)', { ...agentTwoTools, nodes: agentTwoTools.nodes.map((n) => (n.name === 'Agent' ? { ...n, maxToolCalls: 6 } : n)) }]] as const) {
  const c = compile(wf);
  const g = StateClassGraph.build(c.net, markingStateOf(c.initialMarking(null)), 400_000);
  const places = [...c.net.places];
  const byMarking = new Map<string, number>();
  for (const sc of g.stateClasses()) {
    const k = places.map((p) => sc.marking.tokens(p)).join(',');
    byMarking.set(k, (byMarking.get(k) ?? 0) + 1);
  }
  const most = Math.max(...byMarking.values());
  console.log(`${label.padEnd(30)} classes=${String(g.size()).padStart(6)} distinct markings=${String(byMarking.size).padStart(6)}  overhead=${(g.size() / byMarking.size).toFixed(2)}x  max classes on one marking=${most}`);
}
