/**
 * The differ (`src/conformance/differ.ts`), its reference engine
 * (`src/conformance/stack-reference.ts`) and its command line
 * (`src/conformance/differ-cli.ts`).
 *
 * Three layers:
 * 1. the comparison functions on hand-built runs, so every attribution rule is exercised
 *    including the ones the fixture set never reaches;
 * 2. the reference engine against n8n's own documented behaviour (LIFO stack order, the R6
 *    quiescence fallback, the endless-loop valve);
 * 3. the whole fixture set through both engines at k = 1, 2 and 4, with the divergent set
 *    and the ordering mechanisms the register does not name pinned exactly — a new
 *    divergence, or a new mechanism, fails here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { IRunData, IRunExecutionData } from 'n8n-workflow';
import {
  activationKey, activationsOf, attribute, checkHappensBefore, compareData,
  dependencyEdges, descendantsOf, diffFixture, executionOrder, firstDifference, fixturesOf,
  items, orInputNodesOf, ReferenceHost, renderDiffReport, runDifferCli, runPetri, runReference, strandedNodesOf,
  type AttributionContext, type DifferCliIo, type DifferFixture, type DiffResult, type EngineRun,
  type NodeScript, type TraceEvent,
} from '../../src/conformance/index.js';
import { conn, diamond, multiProducer, node, twoTriggers, userCycle, workflow } from '../fixtures/workflows.js';
import { complicatedMulti, DIFFER_FIXTURES, START, webhookRespond } from './differ-fixtures.js';

// ==================== 1. the comparison functions ====================

/** A run built by hand: `runData`, a trace, and the fields the comparisons read. */
function fakeRun(
  engine: 'n8n' | 'libpetri',
  runData: IRunData,
  trace: readonly TraceEvent[] = [],
  extra: {
    effectiveBudget?: number; diagnostics?: string[]; lastNodeExecuted?: string;
    outcome?: string; executionError?: { name?: string; message?: string };
    executionData?: Partial<NonNullable<IRunExecutionData['executionData']>>;
    destinationNode?: string;
  } = {},
): EngineRun {
  const runExecutionData = {
    ...(extra.destinationNode === undefined ? {} : { startData: { destinationNode: { nodeName: extra.destinationNode } } }),
    resultData: { runData, ...(extra.lastNodeExecuted === undefined ? {} : { lastNodeExecuted: extra.lastNodeExecuted }) },
    ...(extra.executionData === undefined ? {} : {
      executionData: { nodeExecutionStack: [], waitingExecution: {}, waitingExecutionSource: {}, contextData: {}, metadata: {}, ...extra.executionData },
    }),
  } as unknown as IRunExecutionData;
  return {
    engine, runData, runExecutionData, trace, activations: activationsOf(trace),
    effectiveBudget: extra.effectiveBudget ?? 1, budgetRestriction: null,
    diagnostics: extra.diagnostics ?? [], elapsedMs: 0, error: undefined,
    outcome: extra.outcome ?? null,
    contract: { executionError: extra.executionError, closeFunction: false },
    scheduler: null as never, host: null as never,
  };
}

const task = (fields: Record<string, unknown>): never => fields as never;

function trace(...events: Array<[TraceEvent['kind'], string, number]>): TraceEvent[] {
  return events.map(([kind, node, runIndex], seq) => ({ seq, kind, node, runIndex, attempt: 0, at: seq }));
}

describe('firstDifference', () => {
  it('reports the deepest differing path, depth first', () => {
    expect(firstDifference({ a: { b: [1, 2] } }, { a: { b: [1, 3] } }, 'x')).toEqual({
      path: 'x.a.b[1]', n8n: '2', libpetri: '3',
    });
  });

  it('treats an absent key and undefined as the same value', () => {
    expect(firstDifference({ a: 1 }, { a: 1, b: undefined }, 'x')).toBeNull();
  });

  it('reports an array length before its elements', () => {
    expect(firstDifference([1], [1, 2], 'x')?.path).toBe('x.length');
  });

  it('returns null for equal values', () => {
    expect(firstDifference({ json: { a: 1 }, pairedItem: { item: 0 } }, { json: { a: 1 }, pairedItem: { item: 0 } }, 'r')).toBeNull();
  });

  // `Object.keys` of a Date, a Map, a Set or an Error is empty, so a walk that treats every
  // object as a plain one called any two of them equal. n8n node output carries dates
  // routinely (`$now`, the Date & Time node, a Code node), and a fixture's scripts are
  // arbitrary, so a silently-equal comparison there is a hole in the gate itself.
  it('compares a Date by its instant, not by its (empty) key set', () => {
    expect(firstDifference(new Date(1), new Date(2), 'x')).toEqual({ path: 'x', n8n: '1970-01-01T00:00:00.001Z', libpetri: '1970-01-01T00:00:00.002Z' });
    expect(firstDifference(new Date(1), new Date(1), 'x')).toBeNull();
    expect(firstDifference({ json: { when: new Date(1) } }, { json: { when: new Date(2) } }, 'r')?.path).toBe('r.json.when');
  });

  it('reports a Map, a Set or a class instance as different unless it is the same object', () => {
    expect(firstDifference(new Map([['a', 1]]), new Map([['a', 2]]), 'x')).toMatchObject({ path: 'x', n8n: '[Map size 1]' });
    expect(firstDifference(new Set([1]), new Set([2]), 'x')?.path).toBe('x');
    const shared = new Map([['a', 1]]);
    expect(firstDifference(shared, shared, 'x')).toBeNull();
  });

  it('compares an Error by name and message, as the task-data gate does', () => {
    expect(firstDifference(new Error('m1'), new Error('m2'), 'x')?.path).toBe('x.message');
    expect(firstDifference(new Error('m'), new Error('m'), 'x')).toBeNull();
    expect(firstDifference(new Error('m'), new TypeError('m'), 'x')?.path).toBe('x.name');
  });

  it('still walks a Buffer byte by byte (n8n binary data)', () => {
    expect(firstDifference(Buffer.from('AAA'), Buffer.from('AAA'), 'x')).toBeNull();
    expect(firstDifference({ binary: { file: { data: Buffer.from('AAA') } } }, { binary: { file: { data: Buffer.from('BBB') } } }, 'x')?.path)
      .toBe('x.binary.file.data[0]');
  });

  it('treats two NaNs as equal instead of reporting `null` against `null`', () => {
    expect(firstDifference(Number.NaN, Number.NaN, 'x')).toBeNull();
    expect(firstDifference(Number.NaN, 1, 'x')).toEqual({ path: 'x', n8n: 'NaN', libpetri: '1' });
  });
});

describe('compareData', () => {
  const one = (json: unknown): unknown => ({ main: [[{ json }]] });

  it('is equal when every task matches', () => {
    const runData = { A: [task({ data: one({ i: 1 }), source: [], executionStatus: 'success' })] } as unknown as IRunData;
    const other = { A: [task({ data: one({ i: 1 }), source: [], executionStatus: 'success' })] } as unknown as IRunData;
    const result = compareData(fakeRun('n8n', runData), fakeRun('libpetri', other));
    expect(result.equal).toBe(true);
    expect(result.unattributed).toBe(0);
  });

  it('leaves an unexplained difference unattributed', () => {
    const left = { A: [task({ data: one({ i: 1 }), source: [] })] } as unknown as IRunData;
    const right = { A: [task({ data: one({ i: 2 }), source: [] })] } as unknown as IRunData;
    const result = compareData(fakeRun('n8n', left), fakeRun('libpetri', right));
    expect(result.unattributed).toBe(1);
    expect(result.differences[0]!.path).toBe('runData.A[0].data.main[0][0].json.i');
  });

  it('attributes a permutation of a node\'s runs to divergence #11', () => {
    const left = { A: [task({ data: one(1) }), task({ data: one(2) })] } as unknown as IRunData;
    const right = { A: [task({ data: one(2) }), task({ data: one(1) })] } as unknown as IRunData;
    const result = compareData(fakeRun('n8n', left), fakeRun('libpetri', right));
    expect(result.permutedNodes).toEqual(['A']);
    expect(result.unattributed).toBe(0);
    expect(result.differences.every((d) => d.attribution.kind === 'divergence' && d.attribution.row === 11)).toBe(true);
  });

  it('attributes a stranded join and everything downstream of it to divergence #2', () => {
    const left = { M: [task({ data: one(1) }), task({ data: one(2) })], E: [task({ data: one(1) }), task({ data: one(2) })] } as unknown as IRunData;
    const right = { M: [task({ data: one(1) })], E: [task({ data: one(1) })] } as unknown as IRunData;
    const descendants = new Map([['M', new Set(['E'])]]);
    const result = compareData(
      fakeRun('n8n', left),
      fakeRun('libpetri', right, [], { diagnostics: ["node 'M': stranded token on 'id:M/ready_0' input 0 (divergence #2)"] }),
      descendants,
    );
    expect(result.strandedNodes).toEqual(['E', 'M']);
    expect(result.unattributed).toBe(0);
    expect(result.differences.map((d) => d.attribution)).toEqual([
      expect.objectContaining({ row: 2 }), expect.objectContaining({ row: 2 }),
    ]);
  });

  it('does not compare startTime, executionTime, executionIndex or hints', () => {
    const left = { A: [task({ data: one(1), startTime: 1, executionTime: 2, executionIndex: 3, hints: ['x'] })] } as unknown as IRunData;
    const right = { A: [task({ data: one(1), startTime: 9, executionTime: 9, executionIndex: 9, hints: [] })] } as unknown as IRunData;
    expect(compareData(fakeRun('n8n', left), fakeRun('libpetri', right)).equal).toBe(true);
  });

  // Divergence #2 is about a stranded join and its descendants running *fewer times*, and
  // about the arrival the codec wrote back instead. It says nothing about what a run of
  // those nodes produced, so a payload difference there is a wrong result — the project's
  // hard rule is that a data difference is never a divergence.
  it('does not let a stranded join excuse a payload difference in its descendants', () => {
    const left = { M: [task({ data: one(1) })], End: [task({ data: one('correct') })] } as unknown as IRunData;
    const right = { M: [task({ data: one(1) })], End: [task({ data: one('WRONG') })] } as unknown as IRunData;
    const result = compareData(
      fakeRun('n8n', left),
      fakeRun('libpetri', right, [], { diagnostics: ["node 'M': stranded token on 'id:M/ready_0' input 0"] }),
      { descendants: new Map([['M', new Set(['End'])]]) },
    );
    expect(result.differences.map((d) => d.path)).toEqual(['runData.End[0].data.main[0][0].json']);
    expect(result.unattributed).toBe(1);
  });

  it('compares the WorkflowScheduler contract values, which no IRunExecutionData field carries', () => {
    const runData = { A: [task({ data: one(1) })] } as unknown as IRunData;
    const result = compareData(
      fakeRun('n8n', runData, [], { executionError: { name: 'NodeOperationError', message: 'A failed' } }),
      fakeRun('libpetri', runData),
    );
    expect(result.differences.map((d) => d.path)).toEqual(['scheduler.executionError']);
    expect(result.unattributed).toBe(1);
  });

  it('compares the resumable state: two runs that leave a different nodeExecutionStack are not equal', () => {
    const runData = { A: [task({ data: one(1) })] } as unknown as IRunData;
    const entry = (name: string): unknown => ({ node: { name }, data: { main: [[]] }, source: null });
    const result = compareData(
      fakeRun('n8n', runData, [], { executionData: { nodeExecutionStack: [entry('B')] as never } }),
      fakeRun('libpetri', runData, [], { executionData: { nodeExecutionStack: [] as never } }),
    );
    expect(result.differences.map((d) => d.path)).toEqual(['executionData.nodeExecutionStack.length']);
    expect(result.unattributed).toBe(1);
  });

  it('attributes a waiting slot n8n left behind and never ran to divergence #1', () => {
    const left = { M: [] } as unknown as IRunData;
    const right = { M: [task({ data: one(1) })] } as unknown as IRunData;
    const result = compareData(
      fakeRun('n8n', left, [], { executionData: { waitingExecution: { M: { 0: { main: [[], null] } } } as never } }),
      fakeRun('libpetri', right, [], { executionData: { waitingExecution: {} as never } }),
    );
    expect(result.starvedNodes).toEqual(['M']);
    expect(result.unattributed).toBe(0);
    expect(result.differences.every((d) => d.attribution.kind === 'divergence' && d.attribution.row === 1)).toBe(true);
  });

  it('attributes an activation the net ran after a halt to #17, and one n8n ran after a destination stop to #13', () => {
    const none = {} as unknown as IRunData;
    const one17 = { B: [task({ data: one(1) })] } as unknown as IRunData;
    const halt = compareData(fakeRun('n8n', none), fakeRun('libpetri', one17, [], { outcome: 'halted' }));
    expect(halt.differences[0]!.attribution).toMatchObject({ kind: 'divergence', row: 17 });
    const stop = compareData(
      fakeRun('n8n', one17, [], { destinationNode: 'B' }),
      fakeRun('libpetri', none, [], { outcome: 'paused', destinationNode: 'B' }),
    );
    expect(stop.differences[0]!.attribution).toMatchObject({ kind: 'divergence', row: 13 });
  });
});

describe('strandedNodesOf / descendantsOf', () => {
  it('reads the node name out of the engine\'s stranded-token diagnostic', () => {
    expect(strandedNodesOf([
      "node 'Merge2': stranded token on 'id:Merge2/ready_0' input 0 (divergence #2); written to waitingExecution",
      'compiler: deduplicated connection A -> B',
    ])).toEqual(['Merge2']);
  });

  it('closes over the main connections', () => {
    const map = descendantsOf(diamond);
    expect([...map.get('IF')!].sort()).toEqual(['A', 'B', 'End', 'Merge']);
    expect([...map.get('End')!]).toEqual([]);
  });
});

describe('dependencyEdges / executionOrder', () => {
  it('reads the realised dependencies off each task\'s source', () => {
    const runData = {
      B: [task({ source: [{ previousNode: 'A', previousNodeRun: 1 }, null] })],
    } as unknown as IRunData;
    expect(dependencyEdges(runData)).toEqual([{ from: 'A#1', to: 'B#0', inputIndex: 0 }]);
  });

  it('orders activations by executionIndex', () => {
    const runData = {
      A: [task({ executionIndex: 2 })], B: [task({ executionIndex: 0 }), task({ executionIndex: 1 })],
    } as unknown as IRunData;
    expect(executionOrder(runData)).toEqual(['B#0', 'B#1', 'A#0']);
  });
});

describe('checkHappensBefore', () => {
  const runData = { A: [task({ source: [] })], B: [task({ source: [{ previousNode: 'A', previousNodeRun: 0 }] })] } as unknown as IRunData;

  it('accepts a run where the producer finishes before the consumer starts', () => {
    const good = trace(['start', 'A', 0], ['finish', 'A', 0], ['start', 'B', 0], ['finish', 'B', 0]);
    const result = checkHappensBefore(fakeRun('n8n', runData, good), fakeRun('libpetri', runData, good));
    expect(result.respected).toBe(true);
    expect(result.checkedEdges).toBe(2);
    expect(result.unmatchedEdges).toBe(0);
  });

  it('reports an inversion inside one engine', () => {
    const good = trace(['start', 'A', 0], ['finish', 'A', 0], ['start', 'B', 0], ['finish', 'B', 0]);
    const bad = trace(['start', 'B', 0], ['start', 'A', 0], ['finish', 'A', 0], ['finish', 'B', 0]);
    const result = checkHappensBefore(fakeRun('n8n', runData, good), fakeRun('libpetri', runData, bad));
    expect(result.respected).toBe(false);
    expect(result.violations.map((v) => v.engine)).toEqual(['libpetri', 'weakening']);
  });

  it('reports an edge whose activation left no runNode observation instead of skipping it', () => {
    // `ordered()` returns 'absent' when an activation is in `runData` but not in the trace
    // (a pinned output short-circuits `runNode`). It used to be counted as checked and then
    // dropped, so the edge silently left the gate.
    const traced = trace(['start', 'A', 0], ['finish', 'A', 0], ['start', 'B', 0], ['finish', 'B', 0]);
    const result = checkHappensBefore(fakeRun('n8n', runData, traced), fakeRun('libpetri', runData, []));
    expect(result.absentEdges).toBe(1);
    expect(result.respected).toBe(false);
    expect(result.violations[0]!.detail).toContain('no runNode observation');
  });

  it('skips an n8n dependency the net never realised instead of calling it an inversion', () => {
    const netRunData = { A: [task({ source: [] })], B: [task({ source: [{ previousNode: 'A', previousNodeRun: 3 }] })] } as unknown as IRunData;
    const t = trace(['start', 'A', 0], ['finish', 'A', 0], ['start', 'B', 0], ['finish', 'B', 0]);
    const result = checkHappensBefore(fakeRun('n8n', runData, t), fakeRun('libpetri', netRunData, t));
    expect(result.unmatchedEdges).toBe(1);
    expect(result.violations.filter((v) => v.engine === 'weakening')).toEqual([]);
  });
});

describe('attribute', () => {
  const base: AttributionContext = {
    effectiveBudget: 1, permutedNodes: [], strandedNodes: [], joinActivations: new Set(), reachable: new Map(),
  };

  it('calls an independent move at k > 1 concurrency', () => {
    const a = attribute('A2#0', ['B1#0'], { ...base, effectiveBudget: 2 });
    expect(a.kind).toBe('concurrency');
  });

  it('does not call a dependent move concurrency, even at k > 1', () => {
    const reachable = new Map([['A#0', new Set(['B#0'])]]);
    const a = attribute('A#0', ['B#0'], { ...base, effectiveBudget: 4, reachable });
    expect(a.kind).toBe('divergence');
  });

  it('names divergence #11 for a permuted node', () => {
    expect(attribute('C#1', ['B#0'], { ...base, permutedNodes: ['C'] })).toMatchObject({ row: 11, mechanism: 'or-input-lifo', novel: false });
  });

  it('names divergence #12 for a multi-input join', () => {
    expect(attribute('M#0', ['B#0'], { ...base, joinActivations: new Set(['M#0']) })).toMatchObject({ row: 12, mechanism: 'join-unshift' });
  });

  it('falls back to row #5 and flags the mechanism as novel', () => {
    expect(attribute('C#0', ['B#0'], base)).toMatchObject({ kind: 'divergence', row: 5, mechanism: 'unnamed', novel: true });
  });

  it('never calls a one-sided activation concurrency: it did not move, it exists once', () => {
    const oneSided = new Map<'n8n' | 'libpetri', never>() as unknown as ReadonlyMap<string, 'n8n' | 'libpetri'>;
    const ctx = { ...base, effectiveBudget: 2, oneSided: new Map([['B#0', 'libpetri' as const]]) };
    expect(attribute('B#0', [], ctx)).toMatchObject({ kind: 'unattributed' });
    expect(attribute('B#0', [], { ...ctx, candidateOutcome: 'halted' })).toMatchObject({ row: 17, mechanism: 'halt-window' });
    expect(attribute('B#0', [], { ...ctx, oneSided: new Map([['B#0', 'n8n' as const]]), destinationNode: 'D' }))
      .toMatchObject({ row: 13, mechanism: 'destination-stop' });
    expect(attribute('M#0', [], { ...ctx, oneSided: new Map([['M#0', 'libpetri' as const]]), starvedNodes: ['M'] }))
      .toMatchObject({ row: 1, mechanism: 'starved-join' });
    expect(oneSided).toBeDefined();
  });

  it('names the OR-input arm latency (row #20) instead of leaving the mechanism unnamed', () => {
    expect(attribute('C#0', ['B#0'], { ...base, orInputNodes: new Set(['C']) }))
      .toMatchObject({ row: 20, mechanism: 'or-input-arm', novel: false });
  });
});

describe('orInputNodesOf', () => {
  it('finds the inputs with more than one producer edge', () => {
    expect([...orInputNodesOf(multiProducer)]).toEqual(['C']);
    expect([...orInputNodesOf(diamond)]).toEqual([]);
  });
});

describe('renderDiffReport', () => {
  it('leads with the tally, names the mechanism and states what happens-before could not check', async () => {
    // `ifBothOutputs`, not `multiProducer`: since the budget refund moved to `X_done`
    // (SPLIT_ROUTING_ABOVE = 0) `multiProducer` reproduces n8n's order exactly and its
    // report names no mechanism at all — which is what row #20 being fixed means.
    const result = await diffFixture(DIFFER_FIXTURES.find((f) => f.name === 'ifBothOutputs')!, 1);
    const report = renderDiffReport([result], 'T');
    expect(report).toContain('# T');
    expect(report).toContain('## ifBothOutputs @ k=1');
    expect(report).toContain('divergence #2 (stranded-join)');
    expect(report).not.toContain('not in the register');
    // Never silent about an edge it did not compare.
    expect(report).toContain('n8n edge(s) the net never realised (not comparable)');
    expect(report).toContain('with no runNode observation');
  });

  it('marks a mechanism the register does not name', () => {
    const result = {
      fixture: 'x', requestedBudget: 1, effectiveBudget: 1, budgetRestriction: null,
      data: { equal: true, differences: [], unattributed: 0, permutedNodes: [], strandedNodes: [], starvedNodes: [] },
      happensBefore: { respected: true, violations: [], checkedEdges: 0, unmatchedEdges: 0, absentEdges: 0 },
      ordering: {
        n8n: ['A#0'], libpetri: ['A#0'], equal: false, unattributed: 0, novelMechanisms: ['unnamed'],
        lastNodeExecuted: { n8n: undefined, libpetri: undefined, equal: true, attribution: null },
        differences: [{ activation: 'A#0', n8nRank: 0, libpetriRank: 1, attribution: { kind: 'divergence', row: 5, mechanism: 'unnamed', novel: true, why: 'w' } }],
      },
      verdict: 'divergent', novelMechanisms: ['unnamed'],
      elapsed: { n8n: 0, libpetri: 0 }, errors: { n8n: null, libpetri: null }, diagnostics: [],
    } as unknown as DiffResult;
    expect(renderDiffReport([result], 'T')).toContain('Ordering mechanisms with no row in `docs/divergences.md`');
  });
});

// ==================== 2. the reference engine ====================

describe('StackReferenceScheduler', () => {
  const fixture = (name: string) => DIFFER_FIXTURES.find((f) => f.name === name)!;

  it('reproduces n8n\'s LIFO stack order: the consumer of the first producer runs before the second producer', async () => {
    const run = await runReference(fixture('multiProducer'));
    expect(executionOrder(run.runData)).toEqual(['Trigger#0', 'A#0', 'C#0', 'B#0', 'C#1']);
  });

  it('runs a join only once both inputs arrived, after both branches', async () => {
    const run = await runReference(fixture('diamond'));
    expect(executionOrder(run.runData)).toEqual(['Trigger#0', 'IF#0', 'A#0', 'B#0', 'Merge#0', 'End#0']);
  });

  it('applies the R6 quiescence fallback: an input that never arrived becomes []', async () => {
    const run = await runReference(fixture('twoTriggers'));
    expect(run.runData.TrigB).toBeUndefined();
    // `Merge` input 1 is fed only by the trigger that is not the start node, so it never
    // arrives; the fallback substitutes `[]` for it rather than leaving the slot `null`.
    const input = run.host.runNodeCalls.find((c) => c.node === 'Merge')!.main!;
    expect(input.map((slot) => slot?.length)).toEqual([2, 0]);
    expect(input[1]).toEqual([]);
  });

  it('delivers a backlog of arrivals most-recent-first, as the stack does', async () => {
    const run = await runReference(fixture('userCycle'));
    // B ran three times; Exit's two activations come off the stack in reverse arrival order.
    expect(run.runData.Exit!.map((t) => t.source![0]!.previousNodeRun)).toEqual([1, 0]);
  });

  it('refuses a non-v1 workflow instead of guessing', async () => {
    const run = await runReference({ ...fixture('linear'), options: { startItems: START, executionOrder: 'v0' } });
    expect(String(run.error)).toContain('v1 only');
  });

  // 10 000 activations through the reference host: fast (~100 ms) but not instant, and the
  // default 5 s timeout is not enough for it on a loaded machine.
  it('stops a non-terminating workflow at the safety valve', { timeout: 20_000 }, async () => {
    // `A` never stops producing, so n8n's own loop would spin here as well.
    const run = await runReference({
      ...fixture('userCycle'),
      scripts: { ...fixture('userCycle').scripts, B: ({ executionData }) => ({ data: [executionData.data.main?.[0] ?? []] }) },
    });
    expect(String(run.error)).toContain('activations');
  });

  it('never lets the PetriScheduler reach n8n\'s enqueue path', () => {
    // `runPetri` builds a host whose `addNodeToBeExecuted` is still fatal; every fixture
    // passing the sweep below is the proof, and this pins the guard itself.
    const host = new ReferenceHost({} as never, {} as never, {});
    expect(() => host.addNodeToBeExecuted({} as never, { node: 'X' } as never, 0, 'P', [], 0))
      .toThrow('must never be called');
  });
});

// ==================== 3. the fixture sweep ====================

/**
 * The fixtures that do not come out identical, with the register rows that explain them.
 * `parallelBranches` is the only one whose divergence appears at k > 1: it is the fixture
 * built to make the net's concurrency visible in the `executionIndex` order.
 */
const DIVERGENT: Readonly<Record<string, { budgets: readonly number[]; rows: readonly number[]; novel: readonly string[] }>> = {
  // `multiProducer` is deliberately absent: it was the row #20 fixture (the OR-input arm
  // costing a scheduling cycle), and since the budget refund moved onto `X_done` it
  // reproduces n8n's `Trigger, A, C, B, C` exactly, at every budget.
  userCycle: { budgets: [1, 2, 4], rows: [5, 11], novel: [] },
  // Row #12 (join-unshift) and row #11's ordering half are gone with row #20: the join now
  // fires in the same cycle its shallower sibling would have. What is left is the stranded
  // join (#2), the payload order of `C`'s two runs (#11) and which node ran *last* (#5).
  ifBothOutputs: { budgets: [1, 2, 4], rows: [2, 5, 11], novel: [] },
  // `lastNodeExecuted` moves because the branches finish out of n8n's order: row #16.
  parallelBranches: { budgets: [2, 4], rows: [16], novel: [] },
  // The stop surface: only reachable because these four fixtures exist.
  haltInFlight: { budgets: [2, 4], rows: [17], novel: [] },
  // Depth-first restored, so `C` (the destination) now runs before `B` and `_pause` lands
  // first: `B` never runs at all, which is what row #13 says a pending entry does.
  destinationStop: { budgets: [1, 2, 4], rows: [13], novel: [] },
  runFilter: { budgets: [1, 2, 4], rows: [1], novel: [] },
  // The two n8n conformance cases that regress at k > 1 (`docs/conformance-m3.md`).
  // `complicatedMulti` names no row at all: every difference is the concurrency the budget
  // bought, and its data is equal at every budget — which is the whole point of running it.
  complicatedMulti: { budgets: [2, 4], rows: [], novel: [] },
  webhookRespond: { budgets: [2, 4], rows: [17], novel: [] },
};

describe('the fixture set through both engines', () => {
  const budgets = [1, 2, 4] as const;
  let results: DiffResult[];

  beforeAll(async () => {
    results = [];
    for (const fixture of DIFFER_FIXTURES) {
      for (const budget of budgets) results.push(await diffFixture(fixture, budget));
    }
  });

  it('covers every fixture at every budget', () => {
    expect(results).toHaveLength(DIFFER_FIXTURES.length * budgets.length);
    expect(new Set(results.map((r) => r.fixture)).size).toBe(DIFFER_FIXTURES.length);
  });

  it('never fails: every difference is attributed to a registered divergence row', () => {
    const failures = results.filter((r) => r.verdict === 'fail').map((r) => ({
      fixture: `${r.fixture}@k=${r.requestedBudget}`,
      data: r.data.differences.filter((d) => d.attribution.kind === 'unattributed'),
      order: r.ordering.differences.filter((d) => d.attribution.kind === 'unattributed'),
      happensBefore: r.happensBefore.violations,
    }));
    expect(failures).toEqual([]);
  });

  it('respects happens-before in both engines and weakens n8n\'s order rather than reordering it', () => {
    for (const r of results) {
      expect(`${r.fixture}@k=${r.requestedBudget}: ${JSON.stringify(r.happensBefore.violations)}`)
        .toBe(`${r.fixture}@k=${r.requestedBudget}: []`);
    }
  });

  it('is data-equal everywhere the register does not say otherwise', () => {
    const unequal = results.filter((r) => !r.data.equal).map((r) => r.fixture);
    expect([...new Set(unequal)].sort())
      .toEqual(['destinationStop', 'haltInFlight', 'ifBothOutputs', 'runFilter', 'userCycle', 'webhookRespond']);
  });

  it('never skips an edge it cannot observe: every dependency has a runNode trace at both ends', () => {
    for (const r of results) {
      expect(`${r.fixture}@k=${r.requestedBudget}: ${r.happensBefore.absentEdges} absent`)
        .toBe(`${r.fixture}@k=${r.requestedBudget}: 0 absent`);
    }
  });

  it('exercises the stop surface — halt, wait, destination stop, run filter — at every budget', () => {
    // Without these the sweep never reaches rows #1, #13 or #17, and "nothing fails at any
    // budget" would be a property of the fixture set rather than of the engine.
    for (const name of ['haltInFlight', 'waitTill', 'destinationStop', 'runFilter']) {
      expect(results.filter((r) => r.fixture === name)).toHaveLength(budgets.length);
    }
    const halt = results.find((r) => r.fixture === 'haltInFlight' && r.requestedBudget === 2)!;
    // n8n `break`s and never runs B; the net cannot un-start it (row #17).
    expect(halt.data.differences.map((d) => d.path)).toContain('runData.B');
    expect(halt.data.unattributed).toBe(0);
    const filtered = results.find((r) => r.fixture === 'runFilter' && r.requestedBudget === 1)!;
    // n8n drops the filtered entry with `continue`, which skips its R6 block, so the loop
    // exits with `Merge` still in `waitingExecution`; the net's empty token completes it.
    expect(filtered.data.differences.map((d) => d.path)).toContain('runData.Merge');
    expect(filtered.data.differences.every((d) => d.attribution.kind === 'divergence' && d.attribution.row === 1)).toBe(true);
  });

  it('produces exactly the pinned set of divergent runs', () => {
    const seen: Record<string, number[]> = {};
    for (const r of results.filter((x) => x.verdict === 'divergent')) {
      (seen[r.fixture] ??= []).push(r.requestedBudget);
    }
    expect(seen).toEqual(Object.fromEntries(
      Object.entries(DIVERGENT).map(([name, d]) => [name, [...d.budgets]]),
    ));
  });

  it('attributes each divergent run to exactly the pinned register rows', () => {
    for (const r of results.filter((x) => x.verdict === 'divergent')) {
      const rows = new Set<number>();
      for (const d of [...r.ordering.differences, ...r.data.differences]) {
        if (d.attribution.kind === 'divergence') rows.add(d.attribution.row);
      }
      expect(`${r.fixture}: ${[...rows].sort((a, b) => a - b)}`)
        .toBe(`${r.fixture}: ${[...DIVERGENT[r.fixture]!.rows].sort((a, b) => a - b)}`);
    }
  });

  it('reports exactly the ordering mechanisms the register does not name', () => {
    for (const r of results) {
      const expected = r.verdict === 'divergent' ? DIVERGENT[r.fixture]!.novel : [];
      expect(`${r.fixture}@k=${r.requestedBudget}: ${r.novelMechanisms}`)
        .toBe(`${r.fixture}@k=${r.requestedBudget}: ${expected}`);
    }
  });

  it('honours the compiler\'s k-safety check: a cyclic or multi-producer workflow stays at k = 1', () => {
    const restricted = results.filter((r) => r.requestedBudget > 1 && r.effectiveBudget === 1);
    expect([...new Set(restricted.map((r) => r.fixture))].sort())
      .toEqual(['destinationStop', 'ifBothOutputs', 'loopOverItems', 'multiProducer', 'userCycle']);
    for (const r of restricted) expect(r.budgetRestriction).not.toBeNull();
  });

  it('runs the concurrency fixture out of n8n\'s depth-first order at k >= 2, and says why', () => {
    const at = (k: number): DiffResult => results.find((r) => r.fixture === 'parallelBranches' && r.requestedBudget === k)!;
    expect(at(1).ordering.libpetri).toEqual(['Trigger#0', 'A1#0', 'A2#0', 'B1#0', 'B2#0']);
    expect(at(2).ordering.n8n).toEqual(['Trigger#0', 'A1#0', 'A2#0', 'B1#0', 'B2#0']);
    expect(at(2).ordering.libpetri).toEqual(['Trigger#0', 'A1#0', 'B1#0', 'B2#0', 'A2#0']);
    expect(at(2).data.equal).toBe(true);
    expect(at(2).ordering.differences.filter((d) => d.attribution.kind === 'concurrency')).toHaveLength(3);
  });
});

// ==================== the command line ====================

describe('runDifferCli', () => {
  const io = (): DifferCliIo & { written: Record<string, string>; out: string[]; err: string[] } => {
    const written: Record<string, string> = {};
    const out: string[] = [];
    const err: string[] = [];
    return {
      written, out, err,
      load: async (specifier) => await import(specifier),
      writeFile: (p, c) => { written[p] = c; },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    };
  };

  it('writes the report and exits 0 when nothing fails', async () => {
    const i = io();
    const code = await runDifferCli(['./differ-fixtures.js', '--budget', '1', '--fixture', 'linear', '--out', 'r.md'], {
      ...i, load: async () => await import('./differ-fixtures.js'),
    });
    expect(code).toBe(0);
    expect(i.written['r.md']).toContain('| linear | 1 |');
    expect(i.err.join('')).toContain('1 pass');
  });

  it('exits 1 on an ordering mechanism no docs/divergences.md row names', async () => {
    // A novel mechanism is not a `fail` verdict — data and happens-before are intact — but
    // the register says nothing is skipped silently, so a CI leg must not go green on one.
    // Every shipped fixture is explained today, so the run itself is substituted here.
    const divergentWithNovel = {
      fixture: 'linear', requestedBudget: 1, effectiveBudget: 1, budgetRestriction: null,
      data: { equal: true, differences: [], unattributed: 0, permutedNodes: [], strandedNodes: [], starvedNodes: [] },
      happensBefore: { respected: true, violations: [], checkedEdges: 0, unmatchedEdges: 0, absentEdges: 0 },
      ordering: {
        n8n: [], libpetri: [], equal: false, differences: [], unattributed: 0, novelMechanisms: ['unnamed'],
        lastNodeExecuted: { n8n: undefined, libpetri: undefined, equal: true, attribution: null },
      },
      verdict: 'divergent', novelMechanisms: ['unnamed'],
      elapsed: { n8n: 0, libpetri: 0 }, errors: { n8n: null, libpetri: null }, diagnostics: [],
    } as unknown as DiffResult;
    const i = io();
    const code = await runDifferCli(['./differ-fixtures.js', '--budget', '1', '--fixture', 'linear'], {
      ...i,
      load: async () => await import('./differ-fixtures.js'),
      diff: async () => await Promise.resolve(divergentWithNovel),
    });
    expect(code).toBe(1);
    expect(i.err.join('')).toContain('no row in docs/divergences.md');
  });

  it('rejects a bad budget and an unknown option', async () => {
    const i = io();
    expect(await runDifferCli(['m', '--budget', '0'], i)).toBe(2);
    expect(await runDifferCli(['m', '--nope'], i)).toBe(2);
    expect(await runDifferCli([], i)).toBe(2);
  });

  it('rejects a fixtures module that exports no fixture array', async () => {
    const i = io();
    await expect(runDifferCli(['m'], { ...i, load: async () => await Promise.resolve({}) }))
      .rejects.toThrow('array of DifferFixture');
  });

  it('accepts either the default export or DIFFER_FIXTURES', () => {
    expect(fixturesOf({ default: [{ name: 'a' }] })).toHaveLength(1);
    expect(fixturesOf({ DIFFER_FIXTURES: [{ name: 'a' }, { name: 'b' }] })).toHaveLength(2);
  });
});

describe('activationsOf', () => {
  it('folds every attempt of one (node, runIndex) into one activation', () => {
    const t = trace(['start', 'A', 0], ['finish', 'A', 0], ['start', 'A', 0], ['finish', 'A', 0]);
    const a = activationsOf(t).get(activationKey('A', 0))!;
    expect(a).toMatchObject({ attempts: 2, start: 0, finish: 3 });
  });

  it('leaves an activation that never finished open', () => {
    const a = activationsOf(trace(['start', 'A', 0])).get('A#0')!;
    expect(a.finish).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('the two legs are isolated from each other', () => {
  /** `A` writes into the item it was handed — the hazard ADR 0006 documents as forbidden. */
  const bump: NodeScript = ({ executionData }) => {
    const first = executionData.data.main![0]![0]!;
    (first.json as { i: number }).i += 100;
    return { data: [executionData.data.main![0]!] };
  };
  const mutatingWorkflow = workflow('mutating', [
    node('Trigger', 'trigger', [0, 0]), node('A', 'set', [200, 0]),
  ], [conn('Trigger', 0, 'A', 0)], 'Trigger');

  it('a node that writes into its input does not change what the other leg already recorded', async () => {
    // The legs run one after the other and are compared afterwards. Sharing the fixture's
    // start items made the second leg mutate the first leg's *recorded* objects, so two runs
    // that produced 100 and 200 compared equal — the one harness that could catch a payload
    // violation was blind to it. And the mutation leaked into every later fixture.
    const start = items({ i: 0 });
    const fixture: DifferFixture = {
      name: 'mutating', workflow: mutatingWorkflow, scripts: { A: bump }, options: { startItems: start },
    };
    const reference = await runReference(fixture);
    const candidate = await runPetri(fixture, 1);
    const value = (run: EngineRun): unknown => run.runData.A![0]!.data!.main![0]![0]!.json;
    expect(value(reference)).toEqual({ i: 100 });
    expect(value(candidate)).toEqual({ i: 100 });
    expect(value(reference)).not.toBe(value(candidate));
    expect(start).toEqual(items({ i: 0 }));
  });
});

describe('the differ fixtures themselves', () => {
  it('start every workflow with the same two items', () => {
    expect(START).toEqual(items({ i: 0 }, { i: 1 }));
    for (const f of DIFFER_FIXTURES) expect(f.options?.startItems).toEqual(START);
  });

  it('cover the compiler fixture set plus the concurrency one', () => {
    expect(DIFFER_FIXTURES.map((f) => f.name)).toContain('parallelBranches');
    for (const name of [multiProducer, userCycle, diamond, twoTriggers].map((w) => w.name)) {
      expect(DIFFER_FIXTURES.some((f) => f.workflow.name === name)).toBe(true);
    }
  });

  it('reproduce both n8n conformance cases that pass at k = 1 and fail at k > 1', () => {
    // `docs/conformance-m3.md` classifies these two from n8n's own suite. n8n asserts a total
    // `nodeExecutionOrder` and stops at the first mismatch, so its junit cannot say whether
    // the data still matches; these fixtures are what makes the classification measurable.
    for (const name of ['complicatedMulti', 'webhookRespond']) {
      expect(DIFFER_FIXTURES.some((f) => f.name === name)).toBe(true);
    }
    // Every input index has exactly one producer and the graph is acyclic, so k-safety leaves
    // the budget alone: if it did not, the k > 1 run would not differ from the k = 1 one and
    // the fixture would prove nothing.
    expect(complicatedMulti.connections.filter((c) => c.to === 'Merge1')).toHaveLength(2);
    expect(new Set(complicatedMulti.connections.map((c) => `${c.to}.${c.inputIndex}`)).size)
      .toBe(complicatedMulti.connections.length);
    expect(webhookRespond.connections.map((c) => c.to)).toEqual(['Agent', 'Respond to Webhook']);
  });
});
