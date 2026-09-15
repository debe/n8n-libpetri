/**
 * Four defects of the differ, each pinned on a hand-built input so the failing shape is
 * exact and does not depend on either engine:
 *
 * 1. `reachableOf` memoised a set *before* its recursion had filled it, so a walk that
 *    re-entered a node already on the stack read a partial closure — and the concurrency
 *    rule then called two dependent activations independent.
 * 2. the permutation check in `compareData` stringified a task unguarded, so a payload
 *    `JSON.stringify` rejects (a `BigInt`) threw out of the data gate instead of being
 *    compared.
 * 3. `renderDiffReport` wrote node names, paths and rendered values into table cells
 *    unescaped, and closed a four-column table with a three-cell truncation row.
 * 4. `checkHappensBefore` reported a producer that never finished as an *inversion*
 *    ("finish(…)=Infinity is not before start(…)"), which is a different finding.
 */
import { describe, expect, it } from 'vitest';
import type { IRunData, IRunExecutionData } from 'n8n-workflow';
import {
  activationsOf, checkHappensBefore, compareData, compareOrdering, dependencyEdges, reachableOf, renderDiffReport,
  runReference,
  type DiffResult, type EngineRun, type TraceEvent,
} from '../../src/conformance/index.js';

const task = (fields: Record<string, unknown>): never => fields as never;

function fakeRun(
  engine: 'n8n' | 'libpetri',
  runData: IRunData,
  trace: readonly TraceEvent[] = [],
  effectiveBudget = 1,
): EngineRun {
  const runExecutionData = { resultData: { runData } } as unknown as IRunExecutionData;
  return {
    engine, runData, runExecutionData, trace, activations: activationsOf(trace), edges: dependencyEdges(runData),
    effectiveBudget, budgetRestriction: null, diagnostics: [], elapsedMs: 0, error: undefined, outcome: null,
    contract: { executionError: undefined, closeFunction: false },
    scheduler: null as never, host: null as never,
  };
}

function trace(...events: Array<[TraceEvent['kind'], string, number]>): TraceEvent[] {
  return events.map(([kind, node, runIndex], seq) => ({ seq, kind, node, runIndex, attempt: 0, at: seq }));
}

describe('reachableOf (defect 1)', () => {
  // The chain b → c → d plus the back edge d → b a re-run of the cycle realises, and a tail
  // c → e outside it. The edges are ordered so the walk *enters at b*: the recursive version
  // memoised `b`'s set while it held only `c`, `d` (reached through c) then read that partial
  // set as final and closed as `{b, c}` — without `d`, and without `e`, which is not even on
  // the cycle. A source node was never affected (nothing re-enters it), so the defect only
  // shows on an activation inside a cycle looking past it.
  const edges = [
    { from: 'b', to: 'c', inputIndex: 0 },
    { from: 'c', to: 'd', inputIndex: 0 },
    { from: 'c', to: 'e', inputIndex: 0 },
    { from: 'd', to: 'b', inputIndex: 0 },
  ];

  it('is a transitive closure whatever order the edges arrive in', () => {
    const reachable = reachableOf(edges);
    expect([...reachable.get('d')!].sort()).toEqual(['b', 'c', 'd', 'e']);
    expect([...reachable.get('b')!].sort()).toEqual(['b', 'c', 'd', 'e']);
    expect([...reachable.get('c')!].sort()).toEqual(['b', 'c', 'd', 'e']);
    expect(reachable.get('e')).toBeUndefined();
  });

  it('closes a long chain end to end', () => {
    // A closure over a chain is quadratic in size by definition, so this is a sanity bound
    // on the walk (iterative, one pass per producer), not a stress test.
    const chain = Array.from({ length: 2_000 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, inputIndex: 0 }));
    const reachable = reachableOf(chain);
    expect(reachable.get('n0')!.size).toBe(2_000);
    expect([...reachable.get('n1999')!]).toEqual(['n2000']);
  });

  it('never calls two dependent activations concurrent because the closure was read half-built', () => {
    // Realised edges in the order above: `c`'s source is `b`, `d`'s and `e`'s are `c`, `b`'s is `d`.
    const sources = {
      c: [{ previousNode: 'b', previousNodeRun: 0 }],
      d: [{ previousNode: 'c', previousNodeRun: 0 }],
      e: [{ previousNode: 'c', previousNodeRun: 0 }],
      b: [{ previousNode: 'd', previousNodeRun: 0 }],
    };
    const ordered = (order: readonly string[]): IRunData => Object.fromEntries(
      Object.entries(sources).map(([node, source]) => [node, [task({ source, executionIndex: order.indexOf(node) })]]),
    ) as unknown as IRunData;
    const reference = fakeRun('n8n', ordered(['b', 'c', 'd', 'e']));
    const candidate = fakeRun('libpetri', ordered(['b', 'c', 'e', 'd']), [], 2);
    const data = compareData(reference, candidate);
    expect(data.equal).toBe(true);
    const ordering = compareOrdering(reference, candidate, data);
    // `d` and `e` swapped, and `e` is reachable from `d` (d → b → c → e): not independent.
    expect(ordering.differences.map((d) => `${d.activation}: ${d.attribution.kind}`))
      .toEqual(['d#0: divergence', 'e#0: divergence']);
  });
});

describe('compareData with a payload JSON.stringify rejects (defect 2)', () => {
  const one = (json: unknown): unknown => ({ main: [[{ json }]] });

  it('compares a BigInt payload instead of throwing out of the gate', () => {
    const left = { A: [task({ data: one({ big: 1n }) }), task({ data: one({ big: 2n }) })] } as unknown as IRunData;
    const right = { A: [task({ data: one({ big: 2n }) }), task({ data: one({ big: 1n }) })] } as unknown as IRunData;
    const result = compareData(fakeRun('n8n', left), fakeRun('libpetri', right));
    expect(result.permutedNodes).toEqual(['A']);
    expect(result.unattributed).toBe(0);
  });
});

describe('renderDiffReport (defect 3)', () => {
  /** The cells of a table row, splitting on the pipes that are not escaped. */
  const cells = (line: string): string[] => line.split(/(?<!\\)\|/).slice(1, -1);

  function result(differences: number): DiffResult {
    const d = (i: number) => ({
      path: `runData.A|B[${i}].data`, n8n: `{"a|b":${i}}`, libpetri: '<missing>',
      attribution: { kind: 'unattributed' as const, why: 'w' },
    });
    return {
      fixture: 'x|y', requestedBudget: 1, effectiveBudget: 1, budgetRestriction: null,
      data: {
        equal: false, differences: Array.from({ length: differences }, (_, i) => d(i)),
        unattributed: differences, permutedNodes: ['A|B'], strandedNodes: [], starvedNodes: [],
      },
      happensBefore: { respected: true, violations: [], checkedEdges: 0, unmatchedEdges: 0, absentEdges: 0 },
      ordering: {
        n8n: ['A|B#0'], libpetri: ['A|B#0'], equal: false, unattributed: 0, novelMechanisms: [],
        lastNodeExecuted: { n8n: undefined, libpetri: undefined, equal: true, attribution: null },
        differences: [{
          activation: 'A|B#0', n8nRank: 0, libpetriRank: 1,
          attribution: { kind: 'divergence', row: 11, mechanism: 'or-input-lifo', novel: false, why: "'A|B' moved" },
        }],
      },
      verdict: 'fail',
      elapsed: { n8n: 0, libpetri: 0 }, errors: { n8n: null, libpetri: null }, diagnostics: [],
    };
  }

  it('escapes a node name containing | in every cell, so the table stays well-formed', () => {
    const lines = renderDiffReport([result(1)]).split('\n');
    const header = lines.findIndex((l) => l.startsWith('| path |'));
    expect(header).toBeGreaterThan(0);
    for (const line of lines.slice(header, header + 3)) expect(`${line} -> ${cells(line).length}`).toBe(`${line} -> 4`);
    const orderHeader = lines.findIndex((l) => l.startsWith('| activation |'));
    for (const line of lines.slice(orderHeader, orderHeader + 3)) expect(`${line} -> ${cells(line).length}`).toBe(`${line} -> 4`);
    const summary = lines.find((l) => l.startsWith('| x'))!;
    expect(cells(summary)).toHaveLength(8);
  });

  it('closes the truncated table with a row of the same width', () => {
    const lines = renderDiffReport([result(25)]).split('\n');
    const more = lines.find((l) => l.includes('5 more'))!;
    expect(more).toBeDefined();
    expect(cells(more)).toHaveLength(4);
  });
});

describe('checkHappensBefore with a producer that never finished (defect 4)', () => {
  it('reports the activation as non-terminating, not as an inversion at Infinity', () => {
    const runData = { A: [task({ source: [] })], B: [task({ source: [{ previousNode: 'A', previousNodeRun: 0 }] })] } as unknown as IRunData;
    const good = trace(['start', 'A', 0], ['finish', 'A', 0], ['start', 'B', 0], ['finish', 'B', 0]);
    const open = trace(['start', 'A', 0], ['start', 'B', 0], ['finish', 'B', 0]);
    const result = checkHappensBefore(fakeRun('n8n', runData, good), fakeRun('libpetri', runData, open));
    expect(result.respected).toBe(false);
    const details = result.violations.map((v) => `${v.engine}: ${v.detail}`);
    expect(details.join('\n')).not.toContain('Infinity');
    expect(details).toEqual([expect.stringMatching(/^libpetri: A#0 never finished/)]);
  });
});

describe('a fixture that names no start node', () => {
  it('is refused with a clear error instead of running against undefined', async () => {
    const fixture = {
      name: 'nameless',
      workflow: { name: 'nameless', nodes: [], connections: [], nodeTypes: () => ({ inputCount: 1, outputCount: 1 }) },
    };
    await expect(runReference(fixture)).rejects.toThrow(/'nameless' names no start node/);
  });
});
