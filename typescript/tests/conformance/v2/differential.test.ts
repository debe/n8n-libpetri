/**
 * The engine v2 differential's parts (`tasks/v2-profile-plan.md` step 10) with no `.n8n`: the
 * binder (`binder.ts`), the net run read back as rows (`net-run.ts`) and the three comparisons
 * (`differential.ts`). The corpus-scale run against n8n's own code is `tasks/v2-differential.mts`.
 *
 * Where a leg needs the reference, n8n is replaced by the stub in `tests/fixtures/v2-stub-reference.ts`
 * (rules 2–4 without loops), so legs (a) and (b) run on the shapes without a loop. Leg (c) needs no
 * reference and runs on every graph, loops included. Each comparison is also shown to *catch* a
 * disagreement: a doctored reference, run or point must not compare equal.
 *
 * Legs (a″) and (a‴) (`tasks/v2-seam-plan.md` decision 13) run the same way on the stub. Leg (a‴)
 * follows decision 7 as amended after F3 fired at step 2: `isFinished` is false on a row set with a
 * failed row, and such a row set is F3's named race, counted (`agree: null`) and not compared.
 */
import { describe, expect, it } from 'vitest';
import { compile, DONE_SLOT, LOOP_SLOT } from '../../../src/compiler/index.js';
import type { CompiledWorkflow } from '../../../src/compiler/index.js';
import { outcomePolicy, v2Actions } from '../../../src/conformance/v2/binder.js';
import {
  compareFinished, compareLockstep, comparePoint, compareScoped, compareState, executorPlan, netPlanAt,
} from '../../../src/conformance/v2/differential.js';
import { graphToDescription } from '../../../src/conformance/v2/graph.js';
import type { V2Graph } from '../../../src/conformance/v2/graph.js';
import { runV2 } from '../../../src/conformance/v2/net-run.js';
import type { NetRun } from '../../../src/conformance/v2/net-run.js';
import { outcome, reachableOf, simulate } from '../../../src/conformance/v2/reference.js';
import type { Behaviour, ReferenceRow, SettlementReference } from '../../../src/conformance/v2/reference.js';
import { ACCEPTED, branchDiamond, chain, loop, SETTLEMENT_SHAPES, switchFanOut, threeInputMerge } from '../../fixtures/v2-graphs.js';
import { stub } from '../../fixtures/v2-stub-reference.js';

const compileV2 = (graph: V2Graph): CompiledWorkflow => compile(graphToDescription(graph).description, { profile: 'engineV2' });
const SEEDS = Array.from({ length: 12 }, (_, i) => i);
/** A third of the behaviours let a step fail; a quarter of loops end empty. */
const behaviourOf = (seed: number): Behaviour => ({ seed, pFail: seed % 3 === 2 ? 0.3 : 0, emptyTerminal: 0.25 });
const ALL_GRAPHS: readonly (readonly [string, V2Graph])[] = Object.entries({ ...SETTLEMENT_SHAPES, ...ACCEPTED });
const NO_LOOP: readonly (readonly [string, V2Graph])[] = Object.entries(SETTLEMENT_SHAPES);

const run = (c: CompiledWorkflow, graph: V2Graph, seed: number): Promise<NetRun> =>
  runV2(c, v2Actions(graph, behaviourOf(seed), seed));

// ---- binder ----

describe('outcomePolicy', () => {
  it('is outcome() on every step but the trigger, which fills slot 0 only', () => {
    const c = compileV2(switchFanOut);
    const policy = outcomePolicy(switchFanOut, behaviourOf(4));
    const T = c.netMap.settlement('T');
    const Sw = c.netMap.settlement('Sw');
    expect([0, 1, 2].map((o) => policy.filled(T, o, 0))).toEqual([true, false, false]);
    const want = outcome(switchFanOut, switchFanOut.nodes[1]!, 0, behaviourOf(4));
    expect([0, 1, 2, 3, 4].map((o) => policy.filled(Sw, o, 0))).toEqual(want.filled);
    expect(policy.fails!(Sw, 0)).toBe(want.status === 'failed');
  });

  it('draws a batch node\'s passes from outcome(), the loop slot until the last', () => {
    const c = compileV2(loop);
    const B = c.netMap.settlement('B');
    for (const seed of SEEDS) {
      const policy = outcomePolicy(loop, behaviourOf(seed));
      for (let it = 0; it < 3; it++) {
        const o = outcome(loop, loop.nodes[1]!, it, behaviourOf(seed));
        expect([policy.filled(B, DONE_SLOT, it), policy.filled(B, LOOP_SLOT, it)]).toEqual([o.filled[0] === true, o.filled[1] === true]);
      }
    }
  });
});

// ---- the net run, as rows ----

describe.each(ALL_GRAPHS)('runV2 on %s', (_name, graph) => {
  const c = compileV2(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('ends with every step settled as outcome() decided it, halted exactly when a step failed', async () => {
    for (const seed of SEEDS) {
      const r = await run(c, graph, seed);
      expect(r.rows.filter((x) => x.status === 'running'), `seed ${seed}`).toEqual([]);
      expect(r.halted, `seed ${seed}`).toBe(r.rows.some((x) => x.status === 'failed'));
      for (const row of r.rows) {
        const g = c.netMap.settlements.find((x) => x.id === row.nodeId)!;
        if (row.status === 'skipped' || g.isTrigger) continue;
        const o = outcome(graph, byId.get(row.nodeId)!, row.iteration, behaviourOf(seed));
        expect(row.status, `seed ${seed} ${row.nodeId}@${row.iteration}`).toBe(o.status);
        if (row.status !== 'completed') continue;
        // Read back from the places the firing wrote, on every connected slot.
        for (const out of g.outputs) {
          expect(row.filledOutputSlots[out.index], `seed ${seed} ${row.nodeId}@${row.iteration} slot ${out.index}`).toBe(o.filled[out.index] === true);
        }
      }
    }
  });

  it('records the initial marking first and a row-set point after the last firing', async () => {
    const r = await run(c, graph, 1);
    expect(r.points[0]).toEqual({ firings: 0, rows: [], marking: { [c.netMap.settlement(graph.nodes[0]!.name).in!.name]: 1 } });
    expect(r.points[r.points.length - 1]!.firings).toBe(r.firings);
    expect(r.points[r.points.length - 1]!.marking).toEqual(r.marking);
  });

  // ---- (c) ----

  it('(c) at every row-set point, the rows decode to the executor marking and the planner is libpetri\'s enabled set', async () => {
    let points = 0;
    for (const seed of SEEDS) {
      for (const p of (await run(c, graph, seed)).points) {
        expect(comparePoint(c, p), `seed ${seed} after ${p.firings}`).toEqual({ agree: true });
        points++;
      }
    }
    expect(points).toBeGreaterThan(SEEDS.length * 3);
  });
});

describe('comparePoint catches a disagreement', () => {
  it('in the marking, and in a row set the net cannot have produced', async () => {
    const c = compileV2(branchDiamond);
    const r = await run(c, branchDiamond, 0);
    const p = r.points[r.points.length - 1]!;
    const extra = { ...p, marking: { ...p.marking, [c.netMap.halt.name]: 1 } };
    const v = comparePoint(c, extra);
    expect(v.agree).toBe(false);
    if (!v.agree) {
      expect(v.markingDiff).toEqual([`${c.netMap.halt.name}: 0 ≠ 1`]);
      expect(v.executor).toEqual({ toQueue: [], toSkip: [] });
    }
    const bogus = comparePoint(c, { ...p, rows: [...p.rows, { nodeId: 'nope', iteration: 0, status: 'completed', filledOutputSlots: [] }] });
    expect(bogus.agree === false && bogus.error).toMatch(/not compiled/);
  });

  it('in the planner: libpetri\'s enabled set at the initial marking is the trigger alone', () => {
    const c = compileV2(chain);
    expect(executorPlan(c, { [c.netMap.settlement('T').in!.name]: 1 }, [])).toEqual({ toQueue: ['T@0'], toSkip: [] });
  });
});

// ---- (a) and (b), stub reference ----

describe.each(NO_LOOP)('legs (a) and (b) on %s (stub reference)', (_name, graph) => {
  const c = compileV2(graph);

  it('(a) the planner equals R(S) at every state of the reference loop', () => {
    let states = 0;
    for (const seed of SEEDS) {
      for (let order = 0; order < 4; order++) {
        simulate(stub, graph, behaviourOf(seed), order, {
          onState: (rows) => {
            states++;
            expect(compareState(c, stub, graph, [], rows), `seed ${seed} order ${order}`).toEqual({ agree: true });
          },
        });
      }
    }
    expect(states).toBeGreaterThan(SEEDS.length * 4);
  });

  it('(b) a net run and a reference run under one behaviour end alike', async () => {
    let failed = 0;
    for (const seed of SEEDS) {
      for (let order = 0; order < 3; order++) {
        const ref = simulate(stub, graph, behaviourOf(seed), order);
        const net = await runV2(c, v2Actions(graph, behaviourOf(seed), order));
        const v = compareLockstep(stub, graph, [], c, ref, net);
        expect(v.problems, `seed ${seed} order ${order}`).toEqual([]);
        expect(v.agree).toBe(true);
        if (v.failed) failed++;
        else expect(v.compared).toBe(net.rows.length);
      }
    }
    expect(failed).toBeGreaterThan(0);
  });
});

// ---- (a) and (b) with master's suspend and resume (ADR 0013 (a)), stub reference ----

describe.each(NO_LOOP)('legs (a) and (b) on %s with steps that suspend (stub reference)', (_name, graph) => {
  const c = compileV2(graph);
  const waiting = (seed: number): Behaviour => ({ ...behaviourOf(seed), pWait: 0.5 });

  it('(a) the planner equals R(S) at every state, waiting rows included', () => {
    let withWaiting = 0;
    for (const seed of SEEDS) {
      for (let order = 0; order < 4; order++) {
        simulate(stub, graph, waiting(seed), order, {
          onState: (rows) => {
            if (rows.some((r) => r.status === 'waiting')) withWaiting++;
            expect(compareState(c, stub, graph, [], rows), `seed ${seed} order ${order}`).toEqual({ agree: true });
          },
        });
      }
    }
    expect(withWaiting).toBeGreaterThan(0);
  });

  it('(b) a step that waited is, in the net, a run that settled later: the runs still end alike', async () => {
    for (const seed of SEEDS) {
      for (let order = 0; order < 3; order++) {
        const ref = simulate(stub, graph, waiting(seed), order);
        const net = await runV2(c, v2Actions(graph, waiting(seed), order));
        const v = compareLockstep(stub, graph, [], c, ref, net);
        expect(v.problems, `seed ${seed} order ${order}`).toEqual([]);
      }
    }
  });
});

describe('compareState catches a disagreement', () => {
  const c = compileV2(branchDiamond);
  const row = (nodeId: string, iteration: number, status: ReferenceRow['status'], filledOutputSlots: boolean[] = []): ReferenceRow =>
    ({ nodeId, iteration, id: `${nodeId}:${iteration}`, status, filledOutputSlots });
  const S = [row('T', 0, 'completed', [true]), row('If', 0, 'completed', [true, false])];

  it('when the reference answers otherwise', () => {
    const neverSkips: SettlementReference = {
      ...stub,
      decideSuccessors: (...args) => ({ ...stub.decideSuccessors(...args), toSkip: [] }),
    };
    expect(compareState(c, neverSkips, branchDiamond, [], S)).toEqual({
      agree: false, rows: S, error: null,
      reference: { toQueue: ['P@0'], toSkip: [] },
      net: { toQueue: ['P@0'], toSkip: ['Q@0'] },
    });
  });

  it('when the rows do not decode, and says why', () => {
    const v = compareState(c, stub, branchDiamond, [], [...S, row('P', 0, 'cancelled')]);
    expect(v.agree).toBe(false);
    if (!v.agree) {
      expect(v.net).toBeNull();
      expect(v.error).toMatch(/cancelled but no row failed/);
    }
  });
});

describe('compareLockstep catches a disagreement', () => {
  const c = compileV2(branchDiamond);
  const calm: Behaviour = { seed: 3, pFail: 0, emptyTerminal: 0 };

  it('in a fate, in the settled count and in the ends', async () => {
    const ref = simulate(stub, branchDiamond, calm, 0);
    const net = await runV2(c, v2Actions(branchDiamond, calm, 0));
    expect(compareLockstep(stub, branchDiamond, [], c, ref, net).agree).toBe(true);

    const dropped: NetRun = { ...net, rows: net.rows.slice(0, -1) };
    const v = compareLockstep(stub, branchDiamond, [], c, ref, dropped);
    expect(v.agree).toBe(false);
    expect(v.problems.some((p) => p.startsWith('fates differ'))).toBe(true);
    expect(v.problems.some((p) => p.includes('countExpectedSettledSteps'))).toBe(true);

    const halted = compareLockstep(stub, branchDiamond, [], c, ref, { ...net, halted: true });
    expect(halted.problems[0]).toMatch(/^ends differ/);
  });

  it('in a slot a completed step filled', async () => {
    const ref = simulate(stub, branchDiamond, calm, 0);
    const net = await runV2(c, v2Actions(branchDiamond, calm, 0));
    const i = net.rows.findIndex((r) => r.nodeId === 'If');
    const flipped = net.rows.map((r, j) => (j === i ? { ...r, filledOutputSlots: r.filledOutputSlots.map((x) => !x) } : r));
    const v = compareLockstep(stub, branchDiamond, [], c, ref, { ...net, rows: flipped });
    expect(v.problems.some((p) => p.startsWith('If#0=completed filled slots'))).toBe(true);
  });
});

// ---- (a″) and (a‴), stub reference ----

describe.each(NO_LOOP)('legs (a″) and (a‴) on %s (stub reference)', (_name, graph) => {
  const c = compileV2(graph);
  const reachable = reachableOf(stub, graph);
  const behaviours = (seed: number): Behaviour[] => [behaviourOf(seed), { ...behaviourOf(seed), pWait: 0.5 }];

  it('(a″) at every (S, s) the handler takes, the scoped net plan is its decision, in order', () => {
    let pairs = 0;
    let halted = 0;
    for (const seed of SEEDS) {
      for (const b of behaviours(seed)) {
        for (let order = 0; order < 4; order++) {
          simulate(stub, graph, b, order, {
            onSettled: (rows, settled) => {
              pairs++;
              const v = compareScoped(c, stub, graph, [], rows, settled);
              if (v.halted) halted++;
              expect(v, `seed ${seed} order ${order} settled ${settled.nodeId}`).toMatchObject({ agree: true, error: null });
            },
          });
        }
      }
    }
    expect(pairs).toBeGreaterThan(SEEDS.length * 8);
    expect(halted).toBeGreaterThanOrEqual(0);
  });

  it('(a‴) at every S without a failed row, isFinished is the count test; one with a failed row is the race, not compared', () => {
    let finished = 0;
    for (const seed of SEEDS) {
      for (const b of behaviours(seed)) {
        for (let order = 0; order < 4; order++) {
          simulate(stub, graph, b, order, {
            onState: (rows) => {
              const v = compareFinished(c, stub, [], reachable, rows);
              expect(v.error).toBeNull();
              if (v.reference && !v.failed) finished++;
              if (!v.failed) expect(v.agree, `seed ${seed} order ${order}`).toBe(true);
              else expect(v).toMatchObject({ agree: null, net: false });
            },
          });
        }
      }
    }
    expect(finished).toBeGreaterThan(0);
  });
});

describe('compareScoped', () => {
  const row = (nodeId: string, iteration: number, status: ReferenceRow['status'], filledOutputSlots: boolean[] = []): ReferenceRow =>
    ({ nodeId, iteration, id: `${nodeId}:${iteration}`, status, filledOutputSlots });
  const c = compileV2(threeInputMerge);
  const S = [row('T', 0, 'completed', [true])];
  const T = { nodeId: 'T', iteration: 0 };

  it('compares order: three queued keys in edge order agree, the same keys reversed do not', () => {
    expect(compareScoped(c, stub, threeInputMerge, [], S, T)).toEqual({
      agree: true, halted: false, error: null,
      reference: { toQueue: ['A@0', 'B@0', 'C@0'], toSkip: [] },
      unguarded: { toQueue: ['A@0', 'B@0', 'C@0'], toSkip: [] },
      net: { toQueue: ['A@0', 'B@0', 'C@0'], toSkip: [] },
    });
    const reversed: SettlementReference = {
      ...stub,
      decideSuccessors: (...args) => { const p = stub.decideSuccessors(...args); return { toQueue: [...p.toQueue].reverse(), toSkip: p.toSkip }; },
    };
    const v = compareScoped(c, reversed, threeInputMerge, [], S, T);
    expect(v.agree).toBe(false);
    expect(v.reference.toQueue).toEqual(['C@0', 'B@0', 'A@0']);
    expect(v.net!.toQueue).toEqual(['A@0', 'B@0', 'C@0']);
  });

  it('on a failed S takes the handler\'s answer, ∅, and keeps the unguarded decideSuccessors apart', () => {
    const failed = [...S, row('A', 0, 'completed', [true]), row('B', 0, 'failed'), row('C', 0, 'completed', [true])];
    const v = compareScoped(c, stub, threeInputMerge, [], failed, { nodeId: 'C', iteration: 0 });
    expect(v).toMatchObject({ agree: true, halted: true, reference: { toQueue: [], toSkip: [] }, net: { toQueue: [], toSkip: [] } });
    expect(v.unguarded).toEqual({ toQueue: ['M@0'], toSkip: [] });
  });

  it('reports a row set that does not decode, and uses an R(S) handed in', () => {
    const v = compareScoped(c, stub, threeInputMerge, [], [...S, row('A', 0, 'cancelled')], T);
    expect(v.agree).toBe(false);
    expect(v.net).toBeNull();
    expect(v.error).toMatch(/cancelled but no row failed/);
    const none = compareScoped(c, stub, threeInputMerge, [], S, T, { plan: { toQueue: [], toSkip: [] } });
    expect(none.agree).toBe(false);
    expect(none.net).toEqual({ toQueue: [], toSkip: [] });
  });
});

describe('compareFinished', () => {
  const row = (nodeId: string, iteration: number, status: ReferenceRow['status'], filledOutputSlots: boolean[] = []): ReferenceRow =>
    ({ nodeId, iteration, id: `${nodeId}:${iteration}`, status, filledOutputSlots });
  const c = compileV2(chain);
  const reachable = reachableOf(stub, chain);

  it('agrees on a finished run and on one still in flight', () => {
    const done = [row('T', 0, 'completed', [true]), row('A', 0, 'completed', [false]), row('B', 0, 'skipped')];
    expect(compareFinished(c, stub, [], reachable, done)).toEqual({ agree: true, failed: false, reference: true, settled: 3, expected: 3, net: true, error: null });
    const waiting = [done[0]!, row('A', 0, 'completed', [true]), row('B', 0, 'waiting')];
    expect(compareFinished(c, stub, [], reachable, waiting)).toMatchObject({ agree: true, reference: false, net: false });
  });

  it('counts the smallest failed S, T -> A -> B with A failed, as the race: isFinished false, not compared', () => {
    const early = [row('T', 0, 'completed', [true]), row('A', 0, 'failed')];
    expect(compareFinished(c, stub, [], reachable, early)).toEqual({
      agree: null, failed: true, reference: false, settled: 2, expected: 3, net: false, error: null,
    });
    expect(compareFinished(c, stub, [], reachable, early, netPlanAt(c, early)).agree).toBeNull();
  });

  it('counts a failed S with nothing left owed as the race too, though the count test says finished there', () => {
    const last = [row('T', 0, 'completed', [true]), row('A', 0, 'completed', [true]), row('B', 0, 'failed')];
    expect(compareFinished(c, stub, [], reachable, last)).toMatchObject({ agree: null, failed: true, reference: true, net: false });
  });

  it('reports a disagreement on a failure-free S, and a decoder throw as one whether or not S failed', () => {
    const done = [row('T', 0, 'completed', [true]), row('A', 0, 'completed', [true]), row('B', 0, 'completed', [true])];
    // An R(S) handed in that still plans B: isFinished false, the count test true.
    const v = compareFinished(c, stub, [], reachable, done, { plan: { toQueue: [{ nodeId: 'B', iteration: 0 }], toSkip: [] } });
    expect(v).toMatchObject({ agree: false, failed: false, reference: true, net: false });
    const cancelled = [row('T', 0, 'completed', [true]), row('A', 0, 'cancelled')];
    expect(compareFinished(c, stub, [], reachable, cancelled)).toMatchObject({ agree: false, net: null });
    const threw = compareFinished(c, stub, [], reachable, [row('T', 0, 'completed', [true]), row('A', 0, 'failed')], { error: 'doctored' });
    expect(threw).toMatchObject({ agree: false, failed: true, net: null, error: 'doctored' });
  });
});
