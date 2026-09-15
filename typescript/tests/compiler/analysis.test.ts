/**
 * The structural analysis: validation of the description, canvas order, SCC decomposition,
 * reachability, depth in the condensation and diagnostics.
 */
import {
  analyse, compile, CompileError, InternalCompilerError, isAllRequired, joinFormOf, NetMap, PolicyError, reachableFrom,
  requiredInputsOf, retryParamsOf, structuralHash,
} from '../../src/compiler/index.js';
import {
  ALL, agentTwoTools, conn, diamond, linear, loopOverItems, node, twoTriggers, userCycle, workflow, SHAPES,
} from '../fixtures/workflows.js';
import { inOf, readyDataOf, retryOf } from './support.js';
import type { NodeDescription, NodeTypeShape } from '../../src/compiler/index.js';

describe('analyse: validation', () => {
  it('rejects an empty workflow, duplicate names or ids, ids containing "/", and an unknown start node', () => {
    expect(() => compile(workflow('empty', [], [], 'X'))).toThrow(/no nodes/);
    expect(() => compile(workflow('dup', [node('A', 'trigger', [0, 0]), node('A', 'set', [1, 1])], [], 'A'))).toThrow(/duplicate node name 'A'/);
    expect(() => compile(workflow('dup-id', [{ ...node('A', 'trigger', [0, 0]), id: 'x' }, { ...node('B', 'set', [1, 1]), id: 'x' }], [], 'A'))).toThrow(/duplicate node id 'x'/);
    expect(() => compile(workflow('slash', [{ ...node('A', 'trigger', [0, 0]), id: 'a/b' }], [], 'A'))).toThrow(/MOD-010/);
    expect(() => compile(workflow('start', [node('A', 'trigger', [0, 0])], [], 'Nope'))).toThrow(/start node 'Nope'/);
  });

  it('refuses with a CompileError that carries a code and the node the refusal is about, message unchanged', () => {
    const refusal = (f: () => unknown): CompileError => {
      try {
        f();
      } catch (e) {
        if (e instanceof CompileError) return e;
        throw e;
      }
      throw new Error('expected a CompileError, nothing was thrown');
    };
    const dupId = refusal(() => compile(workflow('dup-id',
      [{ ...node('A', 'trigger', [0, 0]), id: 'x' }, { ...node('B', 'set', [1, 1]), id: 'x' }], [], 'A')));
    expect(dupId).toBeInstanceOf(Error);
    expect(dupId.name).toBe('CompileError');
    expect(dupId.code).toBe('duplicate-node-id');
    expect(dupId.node).toBe('B');
    expect(dupId.message).toBe("compile: duplicate node id 'x'");

    const missingStart = refusal(() => compile(workflow('start', [node('A', 'trigger', [0, 0])], [], 'Nope')));
    expect(missingStart.code).toBe('unknown-start-node');
    expect(missingStart.node).toBe('Nope');
    expect(missingStart.message).toBe("compile: start node 'Nope' is not in the workflow");

    const noStart = refusal(() => compile({ ...workflow('none', [node('A', 'trigger', [0, 0])], [], 'A'), startNode: undefined }));
    expect(noStart.code).toBe('no-start-node');
    expect(noStart.node).toBeUndefined();

    const t = node('T', 'trigger', [0, 0]);
    const a = node('A', 'set', [100, 0]);
    expect(refusal(() => compile(workflow('dup', [t, { ...a, name: 'T' }], [], 'T'))))
      .toMatchObject({ code: 'duplicate-node-name', node: 'T' });
    expect(refusal(() => compile(workflow('w', [t, a], [conn('T', 0, 'Z', 0)], 'T'))))
      .toMatchObject({ code: 'unknown-connection-node', node: 'Z' });
    expect(refusal(() => compile(workflow('w', [t, a], [conn('T', 1, 'A', 0)], 'T'))))
      .toMatchObject({ code: 'output-index-out-of-range', node: 'T' });
    expect(refusal(() => compile(workflow('w', [t, a], [conn('T', 0, 'A', 1)], 'T'))))
      .toMatchObject({ code: 'input-index-out-of-range', node: 'A' });
    expect(refusal(() => compile(workflow('w', [t, a], [], 'T', { shapes: { A: { inputCount: -1, outputCount: 1 } } }))))
      .toMatchObject({ code: 'invalid-count', node: 'A', message: "node 'A' inputCount must be a non-negative integer, got -1" });
    expect(refusal(() => compile(linear, { budget: 0 })))
      .toMatchObject({ code: 'invalid-budget', message: 'compile: budget must be a positive integer, got 0' });
    expect(refusal(() => compile(linear).netMap.node('Nope')))
      .toMatchObject({ code: 'unknown-node', node: 'Nope', message: "NetMap: unknown node 'Nope'" });
  });

  it('a broken compiler invariant is an InternalCompilerError, and a malformed policy stays a PolicyError', () => {
    const c = compile(linear);
    const [first] = c.netMap.transitions;
    const duplicated = (): NetMap =>
      new NetMap(c.net, c.netMap.shared, c.netMap.nodes, [...c.netMap.transitions, first!], c.netMap.places);
    expect(duplicated).toThrow(InternalCompilerError);
    expect(duplicated).toThrow(`NetMap: duplicate transition '${first!.name}'`);
    expect(duplicated).not.toThrow(CompileError);
    const timeoutOnly = workflow('w', [node('T', 'trigger', [0, 0]), { ...node('A', 'set', [100, 0]), executionPolicy: { timeoutMs: 5 } }],
      [conn('T', 0, 'A', 0)], 'T');
    expect(() => compile(timeoutOnly)).toThrow(PolicyError);
    expect(() => compile(timeoutOnly)).not.toThrow(CompileError);
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
    const g = (extra: object) => retryOf(compile(workflow('r', [node('T', 'trigger', [0, 0], { retryOnFail: true, ...extra })], [], 'T')).netMap.node('T'));
    expect([g({}).maxTries, g({}).waitBetweenTries]).toEqual([3, 1000]);
    expect([g({ maxTries: 0 }).maxTries, g({ waitBetweenTries: -1 }).waitBetweenTries]).toEqual([3, 0]);
    expect(g({ maxTries: 10 }).maxTries).toBe(5);
    expect(compile(workflow('r', [node('T', 'trigger', [0, 0], { retryOnFail: true, maxTries: 10 })], [], 'T')).structuralHash)
      .toBe(compile(workflow('r', [node('T', 'trigger', [0, 0], { retryOnFail: true, maxTries: 5 })], [], 'T')).structuralHash);
    const notRetrying = compile(workflow('r', [node('T', 'trigger', [0, 0], { maxTries: 10 })], [], 'T'));
    expect([notRetrying.netMap.node('T').retry, notRetrying.netMap.placeFor('T', 'tries')]).toEqual([null, undefined]);
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
    expect(m.inputs.map((i) => [i.index, i.wired, i.required, readyDataOf(i).name])).toEqual([
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
    expect(inOf(c.netMap.node('M')).name).toBe('id:M/in');
    expect(c.diagnostics).toEqual([]);
  });
});

describe('analyse: facts computed once', () => {
  it('each node carries its join form, the one joinFormOf chooses and the one the compiled gadget has', () => {
    for (const wf of [...Object.values(ALL), agentTwoTools]) {
      const a = analyse(wf);
      const c = compile(wf);
      for (const n of a.nodes) {
        expect(n.form).toBe(joinFormOf(n, a.incoming.get(n.node.name)!));
        expect(c.netMap.node(n.node.name).form).toBe(n.form);
      }
    }
    expect(analyse(agentTwoTools).nodes.filter((n) => n.form === 'tool').map((n) => n.node.name).sort())
      .toEqual([...analyse(agentTwoTools).agentsOf.keys()].sort());
  });

  it('startNodeSet is startNodes as a set, and every gadget reads its start flag from it', () => {
    const a = analyse({ ...twoTriggers, startNode: undefined, startNodes: ['Merge', 'TrigB', 'TrigA'] });
    expect([...a.startNodeSet].sort()).toEqual([...a.startNodes].sort());
    const c = compile({ ...twoTriggers, startNode: undefined, startNodes: ['Merge', 'TrigB', 'TrigA'] });
    for (const g of c.netMap.nodes) expect(g.isStartNode).toBe(a.startNodeSet.has(g.node));
  });

  it('reachableFrom walks the main edges from any start set, the starts included', () => {
    const a = analyse(diamond);
    expect([...reachableFrom(a, a.startNodes)].sort()).toEqual([...a.reachable].sort());
    expect([...reachableFrom(a, ['A'])].sort()).toEqual(['A', 'End', 'Merge']);
    expect([...reachableFrom(a, ['B', 'A'])].sort()).toEqual(['A', 'B', 'End', 'Merge']);
    expect([...reachableFrom(a, ['End'])]).toEqual(['End']);
    // A name the analysis does not know is its own only member: it has no out-edges.
    expect([...reachableFrom(a, ['Nope'])]).toEqual(['Nope']);
    expect(reachableFrom(a, []).size).toBe(0);
  });
});

describe('compile over a precomputed analysis', () => {
  it('uses the analysis it is given as the compiled workflow\'s own, and hashes it only when no hash is given', () => {
    const a = analyse(diamond);
    const c = compile(diamond, { analysis: a });
    expect(c.analysis).toBe(a);
    expect(c.structuralHash).toBe(structuralHash(a));
    expect(c.structuralHash).toBe(compile(diamond).structuralHash);
    expect(compile(diamond, { analysis: a, structuralHash: 'given' }).structuralHash).toBe('given');
  });

  it('compiles the same net as analysing inside compile', () => {
    for (const wf of [...Object.values(ALL), agentTwoTools]) {
      const inside = compile(wf, { budget: 2 });
      const given = compile(wf, { budget: 2, analysis: analyse(wf) });
      expect([...given.net.places].map((p) => p.name)).toEqual([...inside.net.places].map((p) => p.name));
      expect([...given.net.transitions].map((t) => t.name)).toEqual([...inside.net.transitions].map((t) => t.name));
      expect(given.structuralHash).toBe(inside.structuralHash);
      expect(given.diagnostics).toEqual(inside.diagnostics);
    }
  });

  it('refuses agent budgets beside an analysis that already resolved them, and a hash without its analysis', () => {
    const a = analyse(agentTwoTools);
    expect(() => compile(agentTwoTools, { analysis: a, maxAgentRounds: 3 })).toThrow(/pass them to analyse\(\)/);
    expect(() => compile(agentTwoTools, { analysis: a, maxAgentToolCalls: 3 })).toThrow(/pass them to analyse\(\)/);
    expect(() => compile(agentTwoTools, { structuralHash: 'x' })).toThrow(/without the analysis it hashes/);
  });
});

describe('a required count', () => {
  it('refuses a missing or non-finite count, printing the value as written', () => {
    const refusal = (f: () => unknown): string => {
      try { f(); } catch (e) { if (e instanceof CompileError) return `${e.code}: ${e.message}`; throw e; }
      return 'nothing thrown';
    };
    expect(refusal(() => compile(linear, { maxAgentRounds: Number.NaN })))
      .toBe('invalid-count: maxAgentRounds must be a positive integer, got NaN');
    expect(refusal(() => compile(linear, { maxAgentToolCalls: Number.POSITIVE_INFINITY })))
      .toBe('invalid-count: maxAgentToolCalls must be a positive integer, got Infinity');
    const missing = {
      ...linear,
      nodeTypes: (n: NodeDescription) => (n.name === 'A' ? ({ outputCount: 1 } as unknown as NodeTypeShape) : linear.nodeTypes(n)),
    };
    expect(refusal(() => compile(missing)))
      .toBe("invalid-count: node 'A' inputCount must be a non-negative integer, got undefined");
  });
});
