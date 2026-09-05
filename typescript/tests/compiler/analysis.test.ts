/**
 * The structural analysis: validation of the description, canvas order, SCC decomposition,
 * reachability, depth in the condensation and diagnostics.
 */
import { analyse, compile, isAllRequired, joinFormOf, requiredInputsOf, retryParamsOf } from '../../src/compiler/index.js';
import { conn, diamond, linear, loopOverItems, node, twoTriggers, userCycle, workflow, SHAPES } from '../fixtures/workflows.js';

describe('analyse: validation', () => {
  it('rejects an empty workflow, duplicate names or ids, ids containing "/", and an unknown start node', () => {
    expect(() => compile(workflow('empty', [], [], 'X'))).toThrow(/no nodes/);
    expect(() => compile(workflow('dup', [node('A', 'trigger', [0, 0]), node('A', 'set', [1, 1])], [], 'A'))).toThrow(/duplicate node name 'A'/);
    expect(() => compile(workflow('dup-id', [{ ...node('A', 'trigger', [0, 0]), id: 'x' }, { ...node('B', 'set', [1, 1]), id: 'x' }], [], 'A'))).toThrow(/duplicate node id 'x'/);
    expect(() => compile(workflow('slash', [{ ...node('A', 'trigger', [0, 0]), id: 'a/b' }], [], 'A'))).toThrow(/MOD-010/);
    expect(() => compile(workflow('start', [node('A', 'trigger', [0, 0])], [], 'Nope'))).toThrow(/start node 'Nope'/);
  });

  it('rejects connections to unknown nodes or out-of-range ports; the error output is in range only under continueErrorOutput', () => {
    const t = node('T', 'trigger', [0, 0]);
    const a = node('A', 'set', [100, 0]);
    expect(() => compile(workflow('w', [t, a], [conn('T', 0, 'Z', 0)], 'T'))).toThrow(/unknown node 'Z'/);
    expect(() => compile(workflow('w', [t, a], [conn('T', 1, 'A', 0)], 'T'))).toThrow(/output index out of range/);
    expect(() => compile(workflow('w', [t, a], [conn('T', 0, 'A', 1)], 'T'))).toThrow(/input index out of range/);
    expect(() => compile(workflow('w', [t, a, node('E', 'set', [100, 100])], [conn('T', 0, 'A', 0), conn('A', 1, 'E', 0)], 'T'))).toThrow(/output index out of range/);
    const ok = compile(workflow('w', [t, { ...a, onError: 'continueErrorOutput' }, node('E', 'set', [100, 100])],
      [conn('T', 0, 'A', 0), conn('A', 1, 'E', 0)], 'T'));
    expect(ok.netMap.node('A').outputs.map((o) => o.index)).toEqual([1]);
  });

  it('deduplicates repeated connections and ignores unknown or self expression references, with diagnostics', () => {
    const wf = workflow('diag', [node('T', 'trigger', [0, 0]), node('A', 'set', [100, 0])],
      [conn('T', 0, 'A', 0), conn('T', 0, 'A', 0)], 'T', { references: { A: ['A', 'Ghost', 'T', 'T'] } });
    const c = compile(wf);
    expect(c.analysis.edges).toHaveLength(1);
    expect(c.netMap.node('A').references).toEqual(['T']);
    expect(c.netMap.node('A').unguardedReferences).toEqual(['A']);
    expect(c.diagnostics).toEqual([
      "node 'A' references unknown node 'Ghost'; ignored",
      'duplicate connection T.0 -> A.0; ignored',
      "node 'A' references itself; the expression fails inside the action as in n8n",
    ]);
  });

  it('reads retry settings as n8n getRetryParams does: || defaults, [2, 5] and [0, 5000] clamps, nothing rejected', () => {
    expect(retryParamsOf({})).toEqual({ maxTries: 3, waitBetweenTries: 1000 });
    expect(retryParamsOf({ maxTries: 0, waitBetweenTries: 0 })).toEqual({ maxTries: 3, waitBetweenTries: 1000 });
    expect(retryParamsOf({ maxTries: 1, waitBetweenTries: -1 })).toEqual({ maxTries: 2, waitBetweenTries: 0 });
    expect(retryParamsOf({ maxTries: 10, waitBetweenTries: 10000 })).toEqual({ maxTries: 5, waitBetweenTries: 5000 });
    expect(retryParamsOf({ maxTries: 4, waitBetweenTries: 250 })).toEqual({ maxTries: 4, waitBetweenTries: 250 });
    const g = (extra: object) => compile(workflow('r', [node('T', 'trigger', [0, 0], { retryOnFail: true, ...extra })], [], 'T')).netMap.node('T');
    expect([g({}).maxTries, g({}).waitBetweenTries]).toEqual([3, 1000]);
    expect([g({ maxTries: 0 }).maxTries, g({ waitBetweenTries: -1 }).waitBetweenTries]).toEqual([3, 0]);
    expect(g({ maxTries: 10 }).maxTries).toBe(5);
    expect(compile(workflow('r', [node('T', 'trigger', [0, 0], { retryOnFail: true, maxTries: 10 })], [], 'T')).structuralHash)
      .toBe(compile(workflow('r', [node('T', 'trigger', [0, 0], { retryOnFail: true, maxTries: 5 })], [], 'T')).structuralHash);
    const notRetrying = compile(workflow('r', [node('T', 'trigger', [0, 0], { maxTries: 10 })], [], 'T')).netMap.node('T');
    expect([notRetrying.retryOnFail, notRetrying.maxTries, notRetrying.tries]).toEqual([false, null, null]);
  });
});

describe('analyse: graph facts', () => {
  it('canvas order is (y, x) ascending with the name as the final tiebreak', () => {
    const wf = workflow('order', [
      node('D', 'set', [0, 10]), node('B', 'set', [10, 0]), node('A', 'trigger', [0, 0]), node('C', 'set', [10, 0]),
    ], [], 'A');
    expect(analyse(wf).nodes.map((n) => n.node.name)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('SCCs, cyclic set, edge kinds and depths for Loop Over Items and a user cycle', () => {
    const loop = analyse(loopOverItems);
    expect(loop.sccs.filter((s) => s.length > 1).map((s) => [...s].sort())).toEqual([['Body', 'Loop']]);
    expect(loop.hasCycle).toBe(true);
    expect(Object.fromEntries(loop.depth)).toEqual({ Trigger: 0, Loop: 1, Body: 1, After: 2 });
    expect(loop.maxDepth).toBe(2);
    const cycle = analyse(userCycle);
    expect([...cycle.cyclic].sort()).toEqual(['A', 'B']);
    expect(cycle.edges.map((e) => `${e.from}->${e.to}:${e.kind}`)).toEqual(['Trigger->A:tree', 'A->B:cycle', 'B->A:cycle', 'B->Exit:tree']);
  });

  it('depth is the longest path in the condensation, not the shortest', () => {
    // T -> A -> B -> M.1 and T -> M.0: M is at depth 3 via A, B.
    const wf = workflow('longest', [
      node('T', 'trigger', [0, 0]), node('A', 'set', [100, 0]), node('B', 'set', [200, 0]), node('M', 'merge', [300, 0]),
    ], [conn('T', 0, 'A', 0), conn('A', 0, 'B', 0), conn('B', 0, 'M', 1), conn('T', 0, 'M', 0)], 'T');
    expect(Object.fromEntries(analyse(wf).depth)).toEqual({ T: 0, A: 1, B: 2, M: 3 });
  });

  it('reachability from the start node; unreachable nodes get depth 0', () => {
    const a = analyse(twoTriggers);
    expect([...a.reachable].sort()).toEqual(['End', 'Merge', 'TrigA']);
    expect(a.depth.get('TrigB')).toBe(0);
  });

  it('acyclic fixtures have no cyclic nodes and only tree edges', () => {
    for (const wf of [linear, diamond]) {
      const a = analyse(wf);
      expect(a.hasCycle).toBe(false);
      expect(a.edges.every((e) => e.kind === 'tree')).toBe(true);
      expect(a.sccs.every((s) => s.length === 1)).toBe(true);
    }
  });

  it('join form selection: direct for at most one producer on one input, or for several empty-capable ones, otherwise join / choose-branch', () => {
    const a = analyse(diamond);
    expect(joinFormOf(a.byName.get('A')!, a.incoming.get('A')!)).toBe('direct');
    expect(joinFormOf(a.byName.get('Merge')!, a.incoming.get('Merge')!)).toBe('join');
    expect(joinFormOf(a.byName.get('Trigger')!, [])).toBe('direct');
    expect(isAllRequired(SHAPES.mergeChoose)).toBe(true);
    expect(isAllRequired({ inputCount: 2, outputCount: 1, requiredInputs: 2 })).toBe(true);
    expect(isAllRequired({ inputCount: 2, outputCount: 1, requiredInputs: 1 })).toBe(false);
    expect(isAllRequired({ inputCount: 2, outputCount: 1, requiredInputs: [0] })).toBe(false);
    expect(requiredInputsOf({ inputCount: 2, outputCount: 1, requiredInputs: 2 })).toEqual([0, 1]);
    expect(requiredInputsOf({ inputCount: 3, outputCount: 1, requiredInputs: [1, 0] })).toEqual([0, 1]);
    expect(requiredInputsOf({ inputCount: 3, outputCount: 1, requiredInputs: 2 })).toBeNull();
    expect(requiredInputsOf({ inputCount: 3, outputCount: 1, requiredInputs: [] })).toBeNull();
    expect(requiredInputsOf({ inputCount: 3, outputCount: 1 })).toBeNull();
  });

  it('an all-required node wired only on a higher input is a dead join with a diagnostic (n8n pads the lower input and never runs it)', () => {
    const wf = workflow('half', [node('T', 'trigger', [0, 0]), node('M', 'mergeChoose', [100, 0]), node('E', 'set', [200, 0])],
      [conn('T', 0, 'M', 1), conn('M', 0, 'E', 0)], 'T');
    const half = analyse(wf);
    expect(half.byName.get('M')!.deadInputs).toEqual([0]);
    expect(joinFormOf(half.byName.get('M')!, half.incoming.get('M')!)).toBe('choose-branch');
    const c = compile(wf);
    const m = c.netMap.node('M');
    expect(m.form).toBe('choose-branch');
    expect(m.inputs.map((i) => [i.index, i.wired, i.required, i.readyData!.name])).toEqual([
      [0, false, true, 'id:M/ready_0_data'], [1, true, true, 'id:M/ready_1_data'],
    ]);
    // Nothing writes ready_0_data: X_start can never enable.
    const writers = [...c.net.transitions].filter((t) => t.outputSpec !== null && [...t.outputPlaces()].some((p) => p.name === 'id:M/ready_0_data'));
    expect(writers).toEqual([]);
    expect(c.diagnostics).toEqual([
      "node 'M' requires input 0 but it has no producer; n8n pads the lower inputs and never runs it, so the join can never complete",
    ]);
  });

  it('a partial requiredInputs array with an unwired listed input below the highest wired one is dead too; an unwired unlisted input is simply absent', () => {
    const dead = compile(workflow('dead-listed', [node('T', 'trigger', [0, 0]), node('M', 'merge3Choose', [100, 0])],
      [conn('T', 0, 'M', 0), conn('T', 0, 'M', 2)], 'T'));
    expect(dead.netMap.node('M').inputs.map((i) => [i.index, i.wired, i.required])).toEqual([[0, true, true], [1, false, true], [2, true, false]]);
    expect(dead.diagnostics).toHaveLength(1);
    // Wired 0 and 1 only: input 2 is unlisted and unwired -> not modelled, no diagnostic (n8n's main.length is 2).
    const fine = compile(workflow('two-of-three', [node('T', 'trigger', [0, 0]), node('M', 'merge3Choose', [100, 0])],
      [conn('T', 0, 'M', 0), conn('T', 0, 'M', 1)], 'T'));
    expect(fine.netMap.node('M').inputs.map((i) => i.index)).toEqual([0, 1]);
    expect(fine.diagnostics).toEqual([]);
    // Only input 0 wired on an all-required node: main.length is 1 in n8n, the node runs directly.
    const single = compile(workflow('single', [node('T', 'trigger', [0, 0]), node('M', 'mergeChoose', [100, 0])], [conn('T', 0, 'M', 0)], 'T'));
    expect(single.netMap.node('M').form).toBe('direct');
    expect(single.diagnostics).toEqual([]);
  });

  it('a non-all-required node wired only on a higher input stays direct (divergence 9: same data, only the timing differs)', () => {
    const c = compile(workflow('half-merge', [node('T', 'trigger', [0, 0]), node('M', 'merge', [100, 0])], [conn('T', 0, 'M', 1)], 'T'));
    expect(c.netMap.node('M').form).toBe('direct');
    expect(c.netMap.node('M').in!.name).toBe('id:M/in');
    expect(c.diagnostics).toEqual([]);
  });
});
