/**
 * The k-safety check (README "Concurrency budget and its safety condition") and the
 * structural hash that keys the `PrecompiledNet` cache (CONC-020).
 */
import type { TransitionAction } from 'libpetri';
import { compile, kSafety, analyse } from '../../src/compiler/index.js';
import { ALL, conn, diamond, linear, loopOverItems, multiProducer, node, userCycle, workflow } from '../fixtures/workflows.js';
import { failed, runCompiled, started } from './support.js';

describe('effectiveBudget', () => {
  it('keeps the requested budget on an acyclic workflow where every input index has one producer', () => {
    for (const name of ['linear', 'fanOut', 'diamond', 'switch20', 'chooseBranch', 'twoTriggers', 'expressionRef', 'retry', 'continueErrorOutput', 'ifHalf', 'fanOut4', 'partialRequired'] as const) {
      const c = compile(ALL[name], { budget: 4 });
      expect(c.requestedBudget, name).toBe(4);
      expect(c.effectiveBudget, name).toBe(4);
      expect(c.budgetRestriction, name).toBeNull();
    }
  });

  it('forces 1 with reason "cyclic" for Loop Over Items and a user cycle', () => {
    for (const wf of [loopOverItems, userCycle]) {
      const c = compile(wf, { budget: 4 });
      expect(c.requestedBudget).toBe(4);
      expect(c.effectiveBudget).toBe(1);
      expect(c.budgetRestriction!.reason).toBe('cyclic');
    }
    const c = compile(loopOverItems, { budget: 2 });
    expect(c.budgetRestriction!.detail).toBe('nodes in a cycle: Body, Loop');
    expect(c.initialMarking(null).get(c.netMap.shared.budget)).toHaveLength(1);
  });

  it('forces 1 with reason "multi-producer-input" when an input index has two producers', () => {
    const c = compile(multiProducer, { budget: 3 });
    expect(c.effectiveBudget).toBe(1);
    expect(c.budgetRestriction).toEqual({ reason: 'multi-producer-input', detail: 'C.0 has 2 producers' });
    expect(compile(ALL.ifBothOutputs, { budget: 2 }).budgetRestriction!.reason).toBe('multi-producer-input');
  });

  it('a self-loop counts as cyclic', () => {
    const wf = workflow('self-loop', [node('T', 'trigger', [0, 0]), node('A', 'set', [100, 0])],
      [conn('T', 0, 'A', 0), conn('A', 0, 'A', 0)], 'T');
    expect(kSafety(analyse(wf))!.reason).toBe('cyclic');
    const c = compile(wf, { budget: 2 });
    expect(c.effectiveBudget).toBe(1);
    expect(c.netMap.node('A').cyclic).toBe(true);
  });

  it('defaults to 1 and rejects a non-positive or fractional budget', () => {
    expect(compile(linear).effectiveBudget).toBe(1);
    expect(() => compile(linear, { budget: 0 })).toThrow(/budget must be a positive integer/);
    expect(() => compile(linear, { budget: 1.5 })).toThrow(/budget must be a positive integer/);
  });
});

describe('structuralHash', () => {
  it('is a 64-hex SHA-256, stable across compiles and independent of the budget', () => {
    const a = compile(diamond).structuralHash;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(compile(diamond).structuralHash).toBe(a);
    expect(compile(diamond, { budget: 3 }).structuralHash).toBe(a);
  });

  it('ignores the order nodes and connections are listed in', () => {
    const shuffled = workflow('diamond', [...diamond.nodes].reverse(), [...diamond.connections].reverse(), diamond.startNode!);
    expect(compile(shuffled).structuralHash).toBe(compile(diamond).structuralHash);
  });

  it('changes with a position, a connection, a node option or an expression reference', () => {
    const base = compile(linear).structuralHash;
    const moved = workflow('linear', linear.nodes.map((n) => (n.name === 'B' ? { ...n, position: [400, 50] as const } : n)), linear.connections, 'Trigger');
    expect(compile(moved).structuralHash).not.toBe(base);
    const rewired = workflow('linear', linear.nodes, linear.connections.slice(0, 2), 'Trigger');
    expect(compile(rewired).structuralHash).not.toBe(base);
    const retried = workflow('linear', linear.nodes.map((n) => (n.name === 'B' ? { ...n, retryOnFail: true } : n)), linear.connections, 'Trigger');
    expect(compile(retried).structuralHash).not.toBe(base);
    const referenced = workflow('linear', linear.nodes, linear.connections, 'Trigger', { references: { C: ['A'] } });
    expect(compile(referenced).structuralHash).not.toBe(base);
  });

  it('distinguishes fixtures', () => {
    const hashes = new Set(Object.values(ALL).map((wf) => compile(wf).structuralHash));
    expect(hashes.size).toBe(Object.keys(ALL).length);
  });
});

describe('the budget semiflow across a halt (README "Retries, halt, cancellation")', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('_budget + Σ(running + routed + retry) = k holds at quiescence when a halt lands while a retry is pending: nothing clears X/retry', async () => {
    // T -> A (retryOnFail, wait 5000 ms) and T -> B at k = 2: A_run takes the retry branch,
    // B_run halts 30 ms later. The pending retry strands (retry_wait and exhausted inhibit on
    // _halt / _halted), still holding its budget unit.
    const wf = workflow('halt-retry', [
      node('T', 'trigger', [0, 0]),
      node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 }),
      node('B', 'set', [200, 100]),
    ], [conn('T', 0, 'A', 0), conn('T', 0, 'B', 0)], 'T');
    const c = compile(wf, { budget: 2 }).withActions((info, map) => {
      if (info.role !== 'run') return null;
      const g = map.node(info.node!);
      if (g.node === 'A') {
        const retry: TransitionAction = async (ctx) => { ctx.output(g.retry!, ctx.input(g.running)); ctx.output(g.idle, null); };
        return retry;
      }
      if (g.node === 'B') {
        const halt: TransitionAction = async (ctx) => {
          await sleep(30);
          ctx.output(map.shared.halt, null);
          ctx.output(map.shared.budget, null);
          ctx.output(g.idle, null);
        };
        return halt;
      }
      // T forwards its input as data on every edge and marks X/routed; X_done refunds the
      // budget one scheduling cycle later (ADR 0004).
      const forward: TransitionAction = async (ctx) => {
        const v = ctx.input(g.running);
        for (const out of g.outputs) for (const e of out.edges) ctx.output(e.data, v);
        ctx.output(g.routed!, null);
        ctx.output(g.idle, null);
      };
      return forward;
    });
    const { marking, store } = await runCompiled(c, c.initialMarking('items'));
    expect(failed(store)).toEqual([]);
    expect(started(store, (n) => n.endsWith('/retry_wait') || n.endsWith('/exhausted'))).toEqual([]);
    const a = c.netMap.node('A');
    const held = c.netMap.nodes.reduce((n, g) =>
      n + marking.tokenCount(g.running) + (g.routed === null ? 0 : marking.tokenCount(g.routed))
      + (g.retry === null ? 0 : marking.tokenCount(g.retry)), 0);
    expect(marking.tokenCount(a.retry!)).toBe(1);
    expect(marking.tokenCount(a.tries!)).toBe(2);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
    expect(marking.tokenCount(c.netMap.shared.budget) + held).toBe(2);
    // `_halt` is the terminal marker and nothing consumes it (`compiler/compile.ts`).
    expect(marking.tokenCount(c.netMap.shared.halt)).toBe(1);
  });
});
