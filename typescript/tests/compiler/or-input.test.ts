/**
 * README "OR-inputs": an input with `n > 1` empty-capable producer edges aggregates a round
 * (one delivery per edge), runs once per data arrival and skips once per all-empty round,
 * so a downstream join is never stranded by a per-edge skip. Structure read off the net,
 * then the three routings of `IF.true → C`, `IF.false → C`, `C → Merge.0`,
 * `Trigger → Merge.1` on both executors.
 */
import { compile, routingActions, type RoutingPolicy } from '../../src/compiler/index.js';
import { ifBothOutputs, multiProducer } from '../fixtures/workflows.js';
import { failed, gadget, inhibitorNames, inputNames, outputNames, readNames, runCompiled, started, transitionOf, type Executor } from './support.js';

const ITEMS = { items: [{ json: { n: 1 } }] };

describe('OR form structure (multiProducer: A and B both feed C.0)', () => {
  const c = compile(multiProducer);

  it('arms: data → and(ready_i, hasdata_i), empty → ready_i, no free slot, halt-inhibited', () => {
    const data = c.netMap.transitionObject('id:C/arm_e0_data');
    expect(inputNames(data)).toEqual(['id:C/in0_e0']);
    expect(outputNames(data)).toEqual(['id:C/hasdata_0', 'id:C/ready_0']);
    const empty = c.netMap.transitionObject('id:C/arm_e0_empty');
    expect(inputNames(empty)).toEqual(['id:C/in0_e0_empty']);
    expect(outputNames(empty)).toEqual(['id:C/ready_0']);
    expect(inhibitorNames(data)).toEqual(['_halt', '_halted']);
    expect(inhibitorNames(empty)).toEqual(['_halt', '_halted']);
  });

  it('X_start: one(hasdata_i) budget idle → running + ran_i, one run per data arrival', () => {
    const start = transitionOf(c, 'C', 'start');
    expect(inputNames(start)).toEqual(['_budget', 'id:C/hasdata_0', 'id:C/idle']);
    expect(outputNames(start)).toEqual(['id:C/ran_0', 'id:C/running']);
  });

  it('X_skip: exactly(n, ready_i) inhibitor(hasdata_i) inhibitor(ran_i) read(idle) → empties + skipped', () => {
    const skip = transitionOf(c, 'C', 'skip');
    expect(skip.inputSpecs).toEqual([{ type: 'exactly', count: 2, place: gadget(c, 'C').inputs[0]!.ready }]);
    expect(inhibitorNames(skip)).toEqual(['_halt', '_halted', 'id:C/hasdata_0', 'id:C/ran_0']);
    expect(readNames(skip)).toEqual(['id:C/idle']);
    expect(outputNames(skip)).toEqual(['id:C/skipped']); // C has no outgoing edges in this fixture
  });

  it('X_clear: exactly(n, ready_i) all(ran_i) inhibitor(hasdata_i) read(idle), a genuine sink (CORE-043 AC4)', () => {
    const g = gadget(c, 'C');
    expect(g.transitions.clear).toEqual(['id:C/clear_0']);
    const clear = c.netMap.transitionObject('id:C/clear_0');
    expect(clear.inputSpecs.map((s) => [s.type, s.place.name, 'count' in s ? s.count : null])).toEqual([
      ['exactly', 'id:C/ready_0', 2], ['all', 'id:C/ran_0', null],
    ]);
    expect(inhibitorNames(clear)).toEqual(['id:C/hasdata_0']);
    expect(readNames(clear)).toEqual(['id:C/idle']);
    expect(clear.outputSpec).toBeNull();
    expect(c.netMap.transition('id:C/clear_0')).toMatchObject({ role: 'clear', node: 'C', port: 0 });
    expect(c.joinReadyPlaces.find((j) => j.node === 'C')!.places.map((p) => p.name)).toEqual(['id:C/ready_0']);
  });

  it('a cycle-edge producer into an OR input delivers hasdata_i only and does not count towards n', () => {
    // IF.true -> L, IF.false -> L (tree), Body -> L (cycle); L.loop -> Body.
    const wf = {
      ...ifBothOutputs,
      nodes: [
        { id: 'id:T', name: 'T', type: 'trigger', typeVersion: 1, position: [0, 0] as const },
        { id: 'id:IF', name: 'IF', type: 'if', typeVersion: 1, position: [100, 0] as const },
        { id: 'id:L', name: 'L', type: 'loop', typeVersion: 1, position: [200, 0] as const },
        { id: 'id:Body', name: 'Body', type: 'set', typeVersion: 1, position: [300, 100] as const },
        { id: 'id:After', name: 'After', type: 'set', typeVersion: 1, position: [300, -100] as const },
      ],
      connections: [
        { from: 'T', outputIndex: 0, to: 'IF', inputIndex: 0 },
        { from: 'IF', outputIndex: 0, to: 'L', inputIndex: 0 }, { from: 'IF', outputIndex: 1, to: 'L', inputIndex: 0 },
        { from: 'L', outputIndex: 0, to: 'Body', inputIndex: 0 }, { from: 'Body', outputIndex: 0, to: 'L', inputIndex: 0 },
        { from: 'L', outputIndex: 1, to: 'After', inputIndex: 0 },
      ],
      startNode: 'T',
    };
    const cl = compile(wf);
    const l = gadget(cl, 'L');
    expect(l.form).toBe('or');
    expect(l.inputs[0]!.round).toBe(2);
    expect(l.inputs[0]!.edges.map((e) => `${e.edge.from}:${e.edge.kind}`)).toEqual(['IF:tree', 'IF:tree', 'Body:cycle']);
    const bodyArm = cl.netMap.transitionsOf('L').find((t) => t.role === 'arm' && t.edge!.from === 'Body')!;
    expect(outputNames(cl.netMap.transitionObject(bodyArm.name))).toEqual(['id:L/hasdata_0']);
  });
});

/** IF routes `mode`; every other node forwards its input as data. */
function ifPolicy(mode: 'true-only' | 'none' | 'both'): RoutingPolicy {
  return (g, out) => {
    if (g.node !== 'IF') return 'data';
    if (mode === 'both') return 'data';
    if (mode === 'none') return 'no-data';
    return out.index === 0 ? 'data' : 'no-data';
  };
}

describe.each<Executor>(['precompiled', 'bitmap'])('OR input end to end on %s (IF both outputs → C → Merge.0, Trigger → Merge.1)', (executor) => {
  const count = (c: ReturnType<typeof compile>, m: Awaited<ReturnType<typeof runCompiled>>['marking'], name: string) => m.tokenCount(c.netMap.place(name)!.place);

  it('IF routes data to one output: C runs once, Merge fires once with data, nothing stranded', async () => {
    const c = compile(ifBothOutputs).withActions(routingActions(ifPolicy('true-only')));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(count(c, marking, 'id:C/done')).toBe(1);
    expect(count(c, marking, 'id:C/skipped')).toBe(0);
    expect(count(c, marking, 'id:Merge/done')).toBe(1);
    expect(count(c, marking, 'id:Merge/skipped')).toBe(0);
    expect(count(c, marking, 'id:End/done')).toBe(1);
    for (const p of ['id:C/ready_0', 'id:C/hasdata_0', 'id:C/ran_0', 'id:Merge/ready_0', 'id:Merge/ready_1', 'id:Merge/hasdata']) {
      expect(count(c, marking, p), p).toBe(0);
    }
    expect(count(c, marking, 'id:Merge/free_0')).toBe(1);
    expect(count(c, marking, 'id:Merge/free_1')).toBe(1);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
    expect(started(store, (n) => n.startsWith('id:C/'))).toEqual([
      'id:C/arm_e2_data', 'id:C/arm_e3_empty', 'id:C/start', 'id:C/run', 'id:C/route', 'id:C/clear_0',
    ]);
  });

  it('IF routes empty on both outputs: one skip, Merge still fires (Trigger data on input 1)', async () => {
    const c = compile(ifBothOutputs).withActions(routingActions(ifPolicy('none')));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(count(c, marking, 'id:C/done')).toBe(0);
    expect(count(c, marking, 'id:C/skipped')).toBe(1);
    expect(count(c, marking, 'id:Merge/done')).toBe(1);
    expect(count(c, marking, 'id:End/done')).toBe(1);
    expect(count(c, marking, 'id:C/ready_0')).toBe(0);
    expect(count(c, marking, 'id:Merge/ready_0')).toBe(0);
    expect(started(store, (n) => n === 'id:C/skip')).toHaveLength(1);
    expect(started(store, (n) => n === 'id:C/clear_0')).toHaveLength(0);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
  });

  it('IF routes data on both outputs: two runs of C, one round cleared, Merge fires once and the second slot strands (divergence 2)', async () => {
    const c = compile(ifBothOutputs).withActions(routingActions(ifPolicy('both')));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(count(c, marking, 'id:C/done')).toBe(2);
    expect(count(c, marking, 'id:C/skipped')).toBe(0);
    expect(count(c, marking, 'id:C/ready_0')).toBe(0);
    expect(count(c, marking, 'id:C/ran_0')).toBe(0);
    expect(started(store, (n) => n === 'id:C/clear_0')).toHaveLength(1);
    expect(count(c, marking, 'id:Merge/done')).toBe(1);
    expect(count(c, marking, 'id:End/done')).toBe(1);
    // The arrival-count mismatch n8n's R6 would partial-fire: the net reports it instead.
    expect(count(c, marking, 'id:Merge/ready_0')).toBe(1);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
  });
});
