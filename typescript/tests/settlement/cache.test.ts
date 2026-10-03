/**
 * The settlement policy's compile memo (`src/settlement/compile-cache.ts`, `tasks/v2-seam-plan.md`
 * decision 10): a pure memo of the graph, keyed by the sha256 of its canonical JSON, a bounded
 * LRU, a refusal cached as a refusal, and no per-execution state.
 */
import { describe, expect, it } from 'vitest';
import type { CompiledWorkflow } from '../../src/compiler/index.js';
import type { V2Graph } from '../../src/n8n/v2-graph.js';
import {
  canonicalJson, compileGraph, createCompileCache, graphKey, SettlementCompileRefusal,
} from '../../src/settlement/compile-cache.js';
import { createSettlementPolicy } from '../../src/settlement/policy.js';
import { batch, branchDiamond, chain, diamondBody, edge, loop, trigger, twoLoops, v1 } from '../fixtures/v2-graphs.js';
import { memoryReader } from '../support/settlement-reader.js';

/** `graph` with every object's keys written in reverse order. */
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)])) as T;
}

describe('the cache key', () => {
  it('is the sha256 of the canonical JSON: key order inside objects does not matter', () => {
    expect(graphKey(reversedKeys(loop))).toBe(graphKey(loop));
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: undefined } })).toBe('{"a":{"d":[2,{"x":0,"y":1}]},"b":1}');
    expect(graphKey(loop)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps edge order and node order, which are meaning', () => {
    const edgesReversed: V2Graph = { ...branchDiamond, edges: [...branchDiamond.edges].reverse() };
    const nodesReversed: V2Graph = { ...branchDiamond, nodes: [...branchDiamond.nodes].reverse() };
    expect(graphKey(edgesReversed)).not.toBe(graphKey(branchDiamond));
    expect(graphKey(nodesReversed)).not.toBe(graphKey(branchDiamond));
  });

  it('covers the node config: a batch size or a node type moves it', () => {
    const resized: V2Graph = { ...loop, nodes: loop.nodes.map((n) => (n.id === 'B' ? batch('B', 3) : n)) };
    const retyped: V2Graph = { ...chain, nodes: chain.nodes.map((n) => (n.id === 'A' ? v1('A', 'n8n-nodes-base.set') : n)) };
    expect(graphKey(resized)).not.toBe(graphKey(loop));
    expect(graphKey(retyped)).not.toBe(graphKey(chain));
  });
});

describe('the memo', () => {
  it('compiles a graph once, and returns the first graph object for every graph equal to it', () => {
    let compiles = 0;
    const cache = createCompileCache({ compileGraph: (g) => { compiles++; return compileGraph(g); } });
    const first = cache.get(loop);
    const copy: V2Graph = JSON.parse(JSON.stringify(loop));
    const again = cache.get(copy);
    expect(again).toBe(first);
    expect(again.graph).toBe(loop);
    expect(compiles).toBe(1);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, refusals: 0, evictions: 0, size: 1 });
  });

  it('holds nothing per execution: an entry is the key, the graph, the net and the replay rank', async () => {
    const cache = createCompileCache();
    const policy = createSettlementPolicy({ cache });
    const rows = [
      { nodeId: 'T', iteration: 0, status: 'completed', filledOutputSlots: [true] },
      { nodeId: 'B', iteration: 0, status: 'completed', filledOutputSlots: [false, true] },
    ];
    await policy.isFinished(loop, memoryReader(rows, { executionId: 'a' }));
    await policy.isFinished(loop, memoryReader(rows, { executionId: 'b' }));
    const entry = cache.get(loop);
    expect(Object.keys(entry).sort()).toEqual(['compiled', 'graph', 'key', 'rank']);
    expect(cache.stats().size).toBe(1);
  });

  it('ranks nodes topologically without the back edges, ties in graph order', () => {
    expect([...createCompileCache().get(diamondBody).rank.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id))
      .toEqual(['T', 'B', 'If', 'P', 'Q', 'M', 'After']); // the earliest ready node in graph order each time
    expect([...createCompileCache().get(twoLoops).rank.keys()].length).toBe(twoLoops.nodes.length);
  });

  it('caches a refusal as a refusal: compiled once, refused each time with the first error as cause', () => {
    let compiles = 0;
    const first = new Error('first');
    const cache = createCompileCache({ compileGraph: () => { compiles++; throw first; } });
    const refusals: SettlementCompileRefusal[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        cache.get(chain);
      } catch (e) {
        refusals.push(e as SettlementCompileRefusal);
      }
    }
    expect(compiles).toBe(1);
    expect(refusals).toHaveLength(3);
    for (const r of refusals) {
      expect(r).toBeInstanceOf(SettlementCompileRefusal);
      expect(r.cause).toBe(first);
      expect(r.message).toMatch(/does not compile under the engineV2 profile: first/);
    }
    expect(new Set(refusals).size).toBe(3);
    expect(cache.stats()).toMatchObject({ misses: 1, hits: 2, refusals: 3 });
  });

  it('refuses through stage 1 and the compiler as they refuse', () => {
    const cache = createCompileCache();
    const noTrigger: V2Graph = { nodes: [v1('A')], edges: [] };
    expect(() => cache.get(noTrigger)).toThrow(/0 trigger nodes/);
    const waitStep: V2Graph = { nodes: [trigger('T'), { id: 'W', name: 'W', type: 'wait' }], edges: [edge('T', 'W')] };
    expect(() => cache.get(waitStep)).toThrow(SettlementCompileRefusal);
  });

  it('is a bounded LRU: the least recently used goes first', () => {
    const compiled = new Map<string, number>();
    const cache = createCompileCache({
      maxEntries: 2,
      compileGraph: (g) => {
        const k = g.nodes.map((n) => n.id).join();
        compiled.set(k, (compiled.get(k) ?? 0) + 1);
        return {} as CompiledWorkflow;
      },
    });
    const a = chain;
    const b = branchDiamond;
    const c = loop;
    cache.get(a);
    cache.get(b);
    cache.get(a); // a is now the most recent
    cache.get(c); // evicts b
    cache.get(a); // hit
    cache.get(b); // miss again, evicts c
    expect([...compiled.values()]).toEqual([1, 2, 1]);
    expect(cache.stats()).toEqual({ hits: 2, misses: 4, refusals: 0, evictions: 2, size: 2 });
    cache.clear();
    expect(cache.stats().size).toBe(0);
    expect(() => createCompileCache({ maxEntries: 0 })).toThrow(RangeError);
  });

  it('gives the same compiled net to a warm call as a cold one compiled itself', () => {
    const cold = createCompileCache().get(diamondBody).compiled;
    const cache = createCompileCache();
    cache.get(diamondBody);
    const warm = cache.get(diamondBody).compiled;
    expect(warm.net.transitions.size).toBe(cold.net.transitions.size);
    expect([...warm.net.transitions].map((t) => t.name)).toEqual([...cold.net.transitions].map((t) => t.name));
    expect([...warm.net.places].map((p) => p.name)).toEqual([...cold.net.places].map((p) => p.name));
  });
});
