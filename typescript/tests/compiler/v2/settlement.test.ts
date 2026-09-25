/**
 * What an `engineV2` net decides (`tasks/v2-profile-plan.md` step 5): run on libpetri's executors
 * under every combination of filled output slots, each shape outside a loop reaches the fates
 * `packages/@n8n/engine/src/execution/settlement.ts` rules 2–4 give, and quiesces with nothing
 * pending. Then failure (decision 8): `_halt` stops every decision not yet taken and lets a run in
 * flight settle.
 *
 * The expected fates are written here from the rules, not taken from n8n's code (the differential
 * against n8n's own `decideSuccessors` is step 10):
 * - rule 2: an edge is live iff its source completed and filled the edge's output slot;
 * - rule 3: a node is decidable once every source of its incoming edges has settled — queued (and,
 *   with no failure, completed) with one live incoming edge or more, skipped with none;
 * - rule 4: a skip settles like a run, so it decides the next hop.
 */
import type { Marking, Place, Token } from 'libpetri';
import { compile, settlementActions } from '../../../src/compiler/index.js';
import type { CompiledWorkflow, PlaceRole, SettlementPolicy } from '../../../src/compiler/index.js';
import { graphToDescription } from '../../../src/conformance/v2/graph.js';
import type { V2Graph } from '../../../src/conformance/v2/graph.js';
import { unit } from '../../../src/internal/tokens.js';
import {
  branchDiamond, chain, ifIntoMerge, longChain, switchFanOut, threeInputMerge,
} from '../../fixtures/v2-graphs.js';
import { runCompiled, type Executor } from '../support.js';

type Fate = 'completed' | 'skipped' | 'failed' | 'undecided';

const compileV2 = (graph: V2Graph): CompiledWorkflow =>
  compile(graphToDescription(graph).description, { profile: 'engineV2' });

/** `node.output`: one output slot. */
const slotKey = (node: string, output: number): string => `${node}.${output}`;

/** Every connected output slot of the graph, in edge order. */
function slotsOf(graph: V2Graph): string[] {
  return [...new Set(graph.edges.map((e) => slotKey(e.from, e.outputIndex)))];
}

/** Every subset of `slots`: each is one run's set of filled slots, across all nodes at once. */
function fillingsOf(slots: readonly string[]): ReadonlySet<string>[] {
  return Array.from({ length: 2 ** slots.length }, (_, mask) =>
    new Set(slots.filter((_s, k) => (mask & (1 << k)) !== 0)));
}

/**
 * Rules 2–4 on an acyclic graph with no failure: settle whatever is decidable until nothing is.
 * The trigger is completed at birth (`ExecutionStartHandler`).
 */
function ruleFates(graph: V2Graph, filled: ReadonlySet<string>): Map<string, Fate> {
  const fate = new Map<string, Fate>();
  for (const n of graph.nodes) if (n.type === 'trigger') fate.set(n.id, 'completed');
  for (let progress = true; progress;) {
    progress = false;
    for (const n of graph.nodes) {
      if (fate.has(n.id)) continue;
      const incoming = graph.edges.filter((e) => e.to === n.id);
      if (!incoming.every((e) => fate.has(e.from))) continue; // rule 3: not decidable yet
      const live = incoming.some((e) => fate.get(e.from) === 'completed' && filled.has(slotKey(e.from, e.outputIndex)));
      fate.set(n.id, live ? 'completed' : 'skipped');
      progress = true;
    }
  }
  return fate;
}

/** The policy that fills exactly `filled`, and fails the nodes in `failing`. */
function policyOf(filled: ReadonlySet<string>, failing: ReadonlySet<string> = new Set()): SettlementPolicy {
  return { filled: (g, o) => filled.has(slotKey(g.node, o)), fails: (g) => failing.has(g.node) };
}

/** Tokens on the places of `roles`, by place name, leaving out the empty ones. */
function tokensOn(c: CompiledWorkflow, m: Marking, roles: readonly PlaceRole[]): Record<string, number> {
  const held: Record<string, number> = {};
  for (const p of c.netMap.places) if (roles.includes(p.role) && m.tokenCount(p.place) > 0) held[p.name] = m.tokenCount(p.place);
  return held;
}

/**
 * Each compiled node's fate in a quiescent marking, read off its markers. A run's done marker does
 * not say how it ended, so a run is failed when the node could fail and the policy failed it.
 */
function netFates(c: CompiledWorkflow, m: Marking, failing: ReadonlySet<string> = new Set()): Map<string, Fate> {
  return new Map(c.netMap.settlements.map((g): [string, Fate] => {
    const ran = m.tokenCount(g.done!) > 0;
    const skipped = g.skipped !== null && m.tokenCount(g.skipped) > 0;
    const failed = g.failure === 'possible' && failing.has(g.node);
    const fate: Fate = ran ? (failed ? 'failed' : 'completed') : skipped ? 'skipped' : 'undecided';
    return [g.node, fate];
  }));
}

/** Tokens on `p`. */
const m1 = (m: Marking, p: Place<unknown>): number => m.tokenCount(p);

const EXECUTORS: readonly Executor[] = ['precompiled', 'bitmap'];

const SHAPES: readonly (readonly [string, V2Graph])[] = [
  ['diamond', branchDiamond],
  ['3-input Merge', threeInputMerge],
  ['switch fan-out (split routing)', switchFanOut],
  ['chain', longChain],
  ['If into one Merge (split routing)', ifIntoMerge],
];

describe.each(SHAPES)('%s, under every filling of its slots', (_name, graph) => {
  const c = compileV2(graph);
  const fillings = fillingsOf(slotsOf(graph));

  it.each(EXECUTORS)('reaches the fates of rules 2-4 on the %s executor, and quiesces with nothing pending', async (executor) => {
    for (const filled of fillings) {
      const label = [...filled].join(' ') || '(none filled)';
      const { marking } = await runCompiled(c.withActions(settlementActions(policyOf(filled))), c.initialMarking(null), executor);
      expect(Object.fromEntries(netFates(c, marking)), label).toEqual(Object.fromEntries(ruleFates(graph, filled)));
      // Every node decided exactly once, and no arrival, live mark, run or split route left over.
      for (const g of c.netMap.settlements) {
        expect(m1(marking, g.done!) + (g.skipped === null ? 0 : m1(marking, g.skipped)), `${label}: ${g.node}`).toBe(1);
      }
      expect(tokensOn(c, marking, ['arrived', 'live', 'running', 'ok', 'halt']), label).toEqual({});
    }
  });
});

describe('the diamond, as a table written from the rules', () => {
  // Every slot but If's two is filled; If's filling alone decides the branches and their meeting.
  const others = ['T.0', 'P.0', 'Q.0', 'M.0'];
  const TABLE: readonly (readonly [string, Record<string, Fate>])[] = [
    ['If.0 If.1', { T: 'completed', If: 'completed', P: 'completed', Q: 'completed', M: 'completed', End: 'completed' }],
    ['If.0', { T: 'completed', If: 'completed', P: 'completed', Q: 'skipped', M: 'completed', End: 'completed' }],
    ['If.1', { T: 'completed', If: 'completed', P: 'skipped', Q: 'completed', M: 'completed', End: 'completed' }],
    // Both branches skipped: the Merge has settled inputs and none live, so it is skipped too.
    ['', { T: 'completed', If: 'completed', P: 'skipped', Q: 'skipped', M: 'skipped', End: 'skipped' }],
  ];
  const c = compileV2(branchDiamond);

  it.each(TABLE)('If filling {%s}', async (ifSlots, want) => {
    const filled = new Set([...others, ...ifSlots.split(' ').filter((s) => s !== '')]);
    const { marking } = await runCompiled(c.withActions(settlementActions(policyOf(filled))), c.initialMarking(null));
    expect(Object.fromEntries(netFates(c, marking))).toEqual(want);
    expect(Object.fromEntries(ruleFates(branchDiamond, filled))).toEqual(want);
  });

  it('queues the Merge on one live input beside a dead one', async () => {
    // P filled nothing, Q filled its slot: M has one dead and one live input, so it runs.
    const filled = new Set(['T.0', 'If.0', 'If.1', 'Q.0', 'M.0']);
    const { marking } = await runCompiled(c.withActions(settlementActions(policyOf(filled))), c.initialMarking(null));
    expect(netFates(c, marking).get('M')).toBe('completed');
  });
});

describe('failure (decision 8)', () => {
  it('decides nothing after a failed run: the successors stay undecided and _halt is the only residue', async () => {
    const c = compileV2(longChain);
    const failing = new Set(['A']);
    const { marking } = await runCompiled(
      c.withActions(settlementActions(policyOf(new Set(['T.0', 'A.0', 'B.0']), failing))), c.initialMarking(null));
    expect(Object.fromEntries(netFates(c, marking, failing))).toEqual({ T: 'completed', A: 'failed', B: 'undecided', C: 'undecided' });
    expect(tokensOn(c, marking, ['arrived', 'live', 'running', 'halt'])).toEqual({ _halt: 1 });
  });

  it('never fails the trigger, whatever the policy says', async () => {
    const c = compileV2(chain);
    const failing = new Set(['T', 'A', 'B']);
    const { marking } = await runCompiled(
      c.withActions(settlementActions(policyOf(new Set(['T.0', 'A.0']), failing))), c.initialMarking(null));
    expect(Object.fromEntries(netFates(c, marking, failing))).toEqual({ T: 'completed', A: 'failed', B: 'undecided' });
    // A ran, so the trigger routed its slot live; `_halt` holds A's failure alone.
    expect(m1(marking, c.netMap.halt)).toBe(1);
  });

  /** A marking of the diamond's places by name, one unit each. */
  const markingOf = (c: CompiledWorkflow, places: readonly string[]): Map<Place<unknown>, Token<unknown>[]> =>
    new Map(places.map((name) => [c.netMap.place(name)!.place, [unit()]]));

  it('lets a run in flight settle after _halt, and decides nothing from what it delivers', async () => {
    const c = compileV2(branchDiamond);
    const q = c.netMap.settlement('Q');
    const m = c.netMap.settlement('M');
    const [pm, qm] = m.incoming;
    // P failed while Q was running: `_halt` is marked, and P's edge into M never arrives.
    const all = new Set(['T.0', 'If.0', 'If.1', 'P.0', 'Q.0', 'M.0']);
    const { marking } = await runCompiled(
      c.withActions(settlementActions(policyOf(all))), markingOf(c, ['_halt', q.running.name]));
    expect(m1(marking, q.done!)).toBe(1);
    expect([m1(marking, qm!.arrived), m1(marking, m.live!), m1(marking, pm!.arrived)]).toEqual([1, 1, 0]);
    expect([m1(marking, m.running), m1(marking, m.skipped!)]).toEqual([0, 0]);
  });

  it('stops a start and a skip that are enabled but for _halt', async () => {
    const c = compileV2(branchDiamond);
    const m = c.netMap.settlement('M');
    const arrivals = m.incoming.map((e) => e.arrived.name);
    for (const places of [[...arrivals, m.live!.name], arrivals]) {
      const { marking } = await runCompiled(
        c.withActions(settlementActions(policyOf(new Set()))), markingOf(c, ['_halt', ...places]));
      expect(tokensOn(c, marking, ['arrived', 'live', 'running', 'done', 'skipped', 'halt']))
        .toEqual(Object.fromEntries(['_halt', ...places].map((n) => [n, 1])));
    }
  });
});
