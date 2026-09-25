/**
 * The structure of an `engineV2` net (`tasks/v2-profile-plan.md` step 5, decisions 2–4 and 7–9):
 * every transition carries a real `Out` spec at priority 0, there is no `_budget`, `_pause` or
 * `idle`, the `NetMap` covers every place and transition through the settlement gadgets, the
 * trigger cannot fail or be skipped, every other run can halt, and a node routes per output above
 * `SPLIT_ROUTING_ABOVE` connected outputs — or when two fillings of its slots would write the same
 * places. What the net does with that structure is `settlement.test.ts`.
 */
import { enumerateBranches } from 'libpetri';
import type { Transition } from 'libpetri';
import { compile, CompileError, InternalCompilerError, SPLIT_ROUTING_ABOVE } from '../../../src/compiler/index.js';
import type { CompiledWorkflow, SettlementGadget } from '../../../src/compiler/index.js';
import { graphToDescription } from '../../../src/conformance/v2/graph.js';
import type { V2Graph } from '../../../src/conformance/v2/graph.js';
import {
  SETTLEMENT_SHAPES, branchDiamond, edge, ifIntoMerge, switchFanOut, trigger, v1,
} from '../../fixtures/v2-graphs.js';
import { ALL } from '../../fixtures/workflows.js';

const compileV2 = (graph: V2Graph): CompiledWorkflow =>
  compile(graphToDescription(graph).description, { profile: 'engineV2' });

/** The `ALL` fixtures the engineV2 analysis refuses (`refusals.test.ts` pins their codes). */
const V2_REFUSED: ReadonlySet<string> = new Set([
  'multiProducer', 'loopOverItems', 'userCycle', 'twoTriggers', 'ifBothOutputs',
  'chooseBranch', 'partialRequired', 'continueErrorOutput',
]);

/** Every net this step compiles: the hand-written v2 graphs and the v1 fixtures v2 accepts. */
const SUBJECTS: readonly (readonly [string, () => CompiledWorkflow])[] = [
  ...Object.entries(SETTLEMENT_SHAPES).map(([name, g]) => [`graph ${name}`, () => compileV2(g)] as const),
  ...Object.entries(ALL).filter(([name]) => !V2_REFUSED.has(name))
    .map(([name, wf]) => [`fixture ${name}`, () => compile(wf, { profile: 'engineV2' })] as const),
];

const transitionOf = (c: CompiledWorkflow, name: string): Transition => c.netMap.transitionObject(name);

/** The flat branches of a transition's `Out` spec (IO-016), each a sorted list of place names. */
function branchesOf(t: Transition): string[][] {
  return enumerateBranches(t.outputSpec!).map((b) => [...b].map((p) => p.name).sort()).sort();
}

const gadgetOf = (c: CompiledWorkflow, node: string): SettlementGadget => c.netMap.settlement(node);
const names = (t: Transition, arcs: 'inputs' | 'inhibitors'): string[] =>
  (arcs === 'inputs' ? t.inputSpecs.map((s) => `${s.type}(${s.place.name})`) : t.inhibitors.map((a) => a.place.name)).sort();

describe.each(SUBJECTS)('%s', (_name, build) => {
  const c = build();

  it('gives every transition a real Out spec and priority 0', () => {
    expect(c.net.transitions.size).toBeGreaterThan(0);
    for (const t of c.net.transitions) {
      expect(t.outputSpec, t.name).not.toBeNull();
      expect(t.priority, t.name).toBe(0);
    }
  });

  it('has no _budget, _pause or idle; _halt is its one shared place', () => {
    const placeNames = [...c.net.places].map((p) => p.name);
    expect(placeNames).not.toContain('_budget');
    expect(placeNames).not.toContain('_pause');
    expect(placeNames.filter((n) => n.endsWith('/idle'))).toEqual([]);
    expect(c.netMap.places.filter((p) => p.node === null).map((p) => [p.name, p.role])).toEqual([['_halt', 'halt']]);
    expect(c.netMap.halt.name).toBe('_halt');
  });

  it('maps every place and transition once, each owned by one settlement gadget of a compiled node', () => {
    expect(c.netMap.places.map((p) => p.name).sort()).toEqual([...c.net.places].map((p) => p.name).sort());
    expect(new Set(c.netMap.places.map((p) => p.role))).toSatisfy((roles: Set<string>) =>
      [...roles].every((r) => ['arrived', 'live', 'running', 'done', 'skipped', 'ok', 'halt'].includes(r)));
    expect(c.netMap.settlements.map((g) => g.node).sort()).toEqual([...c.analysis.reachable].sort());
    const owned: string[] = [];
    for (const g of c.netMap.settlements) {
      const own = [g.transitions.start, ...(g.transitions.skip === null ? [] : [g.transitions.skip]), g.transitions.run,
        ...g.transitions.routes];
      expect(c.netMap.transitionsOf(g.node).map((t) => t.name).sort(), g.node).toEqual([...own].sort());
      owned.push(...own);
    }
    expect(owned.sort()).toEqual([...c.net.transitions].map((t) => t.name).sort());
    expect(new Set(c.netMap.transitions.map((t) => t.role))).toSatisfy((roles: Set<string>) =>
      [...roles].every((r) => ['start', 'skip', 'run', 'route'].includes(r)));
  });

  it('decides every node but the trigger on all its arrivals: start takes all(live), skip is inhibited by it', () => {
    for (const g of c.netMap.settlements) {
      if (g.isTrigger) continue;
      const arrived = g.incoming.map((e) => `one(${e.arrived.name})`);
      expect(g.incoming.length, g.node).toBeGreaterThan(0);
      expect(names(transitionOf(c, g.transitions.start), 'inputs'), g.node).toEqual([...arrived, `all(${g.live!.name})`].sort());
      expect(names(transitionOf(c, g.transitions.start), 'inhibitors'), g.node).toEqual(['_halt']);
      expect(names(transitionOf(c, g.transitions.skip!), 'inputs'), g.node).toEqual([...arrived].sort());
      expect(names(transitionOf(c, g.transitions.skip!), 'inhibitors'), g.node).toEqual([g.live!.name, '_halt'].sort());
      // A skip announces itself: every out-edge arrives, dead, beside the node's own marker.
      const outArrivals = g.outputs.flatMap((o) => o.edges.map((e) => e.arrived.name));
      expect(branchesOf(transitionOf(c, g.transitions.skip!)), g.node).toEqual([[...outArrivals, g.skipped!.name].sort()]);
    }
  });

  it('lets a run in flight settle whatever _halt says: no run or route is inhibited', () => {
    for (const g of c.netMap.settlements) {
      for (const name of [g.transitions.run, ...g.transitions.routes]) expect(transitionOf(c, name).inhibitors, name).toEqual([]);
    }
  });
});

describe('the trigger (decision 7)', () => {
  const c = compileV2(branchDiamond);
  const t = gadgetOf(c, 'T');

  it('is started from its seeded synthetic arrival and has no skip', () => {
    expect([t.isTrigger, t.failure, t.live, t.skipped, t.transitions.skip]).toEqual([true, 'never', null, null, null]);
    expect(names(transitionOf(c, t.transitions.start), 'inputs')).toEqual([`one(${t.in!.name})`]);
    expect(c.netMap.place(t.in!.name)).toMatchObject({ role: 'arrived', node: 'T', port: null });
    expect(c.netMap.place(t.in!.name)?.edge).toBeUndefined();
  });

  it('has a success-only run whose slot still routes live or dead', () => {
    const [e] = t.outputs[0]!.edges;
    expect(branchesOf(transitionOf(c, t.transitions.run))).toEqual([
      [e!.arrived.name, t.done!.name].sort(),
      [e!.arrived.name, e!.live.name, t.done!.name].sort(),
    ].sort());
  });

  it('is the whole initial marking; nothing is seeded before it', () => {
    expect([...c.initialMarking({ ignored: true })].map(([p, tokens]) => [p.name, tokens.length])).toEqual([[t.in!.name, 1]]);
    expect(c.sharedMarking().size).toBe(0);
  });
});

describe('failure (decision 8)', () => {
  it('gives every other run a halt branch that writes _halt and the done marker, and nothing else', () => {
    const c = compileV2(branchDiamond);
    for (const g of c.netMap.settlements.filter((s) => !s.isTrigger)) {
      expect(g.failure, g.node).toBe('possible');
      expect(branchesOf(transitionOf(c, g.transitions.run)), g.node).toContainEqual(['_halt', g.done!.name].sort());
    }
  });
});

describe('routing (decision 4)', () => {
  it(`splits above ${SPLIT_ROUTING_ABOVE} connected outputs: X_run writes X/ok_o, X_route_o routes it`, () => {
    const c = compileV2(switchFanOut);
    const sw = gadgetOf(c, 'Sw');
    expect(sw.routing).toBe('split');
    expect(sw.outputs.map((o) => o.ok?.name)).toEqual([0, 1, 2, 3, 4].map((o) => `Sw/ok_${o}`));
    expect(branchesOf(transitionOf(c, sw.transitions.run))).toEqual([
      ['Sw/done', 'Sw/ok_0', 'Sw/ok_1', 'Sw/ok_2', 'Sw/ok_3', 'Sw/ok_4'],
      ['Sw/done', '_halt'],
    ]);
    expect(sw.transitions.routes).toEqual([0, 1, 2, 3, 4].map((o) => `Sw/route_${o}`));
    sw.outputs.forEach((o) => {
      const route = transitionOf(c, sw.transitions.routes[o.index]!);
      expect(names(route, 'inputs')).toEqual([`one(Sw/ok_${o.index})`]);
      const [e] = o.edges;
      expect(branchesOf(route)).toEqual([[e!.arrived.name], [e!.arrived.name, e!.live.name].sort()].sort());
    });
  });

  it(`routes inside X_run at ${SPLIT_ROUTING_ABOVE} connected outputs: 2^${SPLIT_ROUTING_ABOVE} success branches and the halt`, () => {
    const c = compileV2({
      nodes: [trigger('T'), v1('Sw', 'n8n-nodes-base.switch'), v1('N0'), v1('N1'), v1('N2')],
      edges: [edge('T', 'Sw'), edge('Sw', 'N0', 0), edge('Sw', 'N1', 1), edge('Sw', 'N2', 2)],
    });
    const sw = gadgetOf(c, 'Sw');
    expect([sw.routing, sw.transitions.routes, sw.outputs.map((o) => o.ok)]).toEqual(['collapsed', [], [null, null, null]]);
    expect(branchesOf(transitionOf(c, sw.transitions.run))).toHaveLength(2 ** SPLIT_ROUTING_ABOVE + 1);
  });

  it('splits two outputs that enter one node, whose fillings would write the same places', () => {
    // Filling If's slot 0, slot 1 or both writes {e/arrived…, M/live} each time: three branches
    // claiming one output, which the executor refuses as ambiguous (`validateOutSpec`).
    expect(gadgetOf(compileV2(ifIntoMerge), 'If').routing).toBe('split');
    expect(gadgetOf(compileV2(branchDiamond), 'If').routing).toBe('collapsed');
  });

  it('makes a node live once for two edges of one slot into it', () => {
    const c = compileV2({
      nodes: [trigger('T'), v1('A'), v1('M', 'n8n-nodes-base.merge')],
      edges: [edge('T', 'A'), edge('A', 'M', 0, 0), edge('A', 'M', 0, 1)],
    });
    const a = gadgetOf(c, 'A');
    expect(a.routing).toBe('collapsed');
    const arrivals = a.outputs[0]!.edges.map((e) => e.arrived.name);
    expect(branchesOf(transitionOf(c, a.transitions.run))).toEqual([
      ['A/done', '_halt'],
      [...arrivals, 'A/done'].sort(),
      [...arrivals, 'A/done', 'M/live'].sort(),
    ].sort());
  });
});

describe('what an engineV2 net does not compile', () => {
  it('leaves out a node the trigger does not reach (decision 9)', () => {
    const c = compileV2({ nodes: [trigger('T'), v1('A'), v1('Y'), v1('W')], edges: [edge('T', 'A'), edge('Y', 'W')] });
    expect(c.netMap.settlements.map((g) => g.node)).toEqual(['T', 'A']);
    expect([...c.net.places].map((p) => p.name).filter((n) => n.startsWith('Y/') || n.startsWith('W/'))).toEqual([]);
  });

  // Every accessor of the profile boundary, and the consumers' entry checks, are `boundary.test.ts`.
  it('has no v1 node gadget or shared places to read', () => {
    const c = compileV2(branchDiamond);
    expect(c.netMap.profile).toBe('engineV2');
    expect(() => c.netMap.nodes).toThrow(InternalCompilerError);
    expect(() => c.netMap.shared).toThrow(InternalCompilerError);
    expect(() => c.netMap.settlement('nope')).toThrow(CompileError);
    expect(() => compile(ALL.diamond!).netMap.settlements).toThrow(InternalCompilerError);
  });
});
