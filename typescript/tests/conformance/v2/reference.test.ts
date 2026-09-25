/**
 * The reference module (`src/conformance/v2/reference.ts`, `tasks/v2-profile-plan.md` step 9) on
 * its own, with no `.n8n`: the seeded behaviour, the event loop's bookkeeping (states reported,
 * `running` between claim and settle, cancellation after a failure, termination guard) and R(S).
 *
 * n8n's settlement code is injected, and here it is a **stub**: rules 2–4 of `settlement.ts` for
 * graphs without a loop (`tests/fixtures/v2-stub-reference.ts`). It stands in for n8n only so the loop can run; no
 * claim about n8n's answers rests on it. The claim that R(S) is n8n's answer is the `tasks/`
 * scripts', which inject the pinned `dist` (`tasks/spike-v2-settlement.mts`).
 */
import { describe, expect, it } from 'vitest';
import { decodeStepRows } from '../../../src/codec/v2/step-rows.js';
import { planFromMarking } from '../../../src/codec/v2/plan.js';
import { compile } from '../../../src/compiler/index.js';
import type { V2Graph } from '../../../src/conformance/v2/graph.js';
import { graphToDescription } from '../../../src/conformance/v2/graph.js';
import {
  hash, latestTerminal, MAX_EVENTS, outcome, referenceAnswer, rng, simulate, terminalIterations,
  type Behaviour, type ReferencePlan, type ReferenceRow, type SettlementReference,
} from '../../../src/conformance/v2/reference.js';
import { batch, branchDiamond, chain, edge, loop, SETTLEMENT_SHAPES, trigger, v1 } from '../../fixtures/v2-graphs.js';
import { stub, stubKeyId } from '../../fixtures/v2-stub-reference.js';

const id = stubKeyId;

const row = (nodeId: string, iteration: number, status: ReferenceRow['status'], filledOutputSlots: boolean[] = []): ReferenceRow =>
  ({ nodeId, iteration, id: `${nodeId}:${iteration}`, status, filledOutputSlots });
const keys = (plan: ReferencePlan): { toQueue: string[]; toSkip: string[] } =>
  ({ toQueue: plan.toQueue.map(id).sort(), toSkip: plan.toSkip.map(id).sort() });
const calm = (seed: number, pFail = 0): Behaviour => ({ seed, pFail, emptyTerminal: 0 });

// ---- seeded behaviour ----

describe('hash and rng', () => {
  it('are pinned: a behaviour is a pure function of its inputs', () => {
    expect(hash('a')).toBe(0xe40c292c);
    expect(hash('a', 1)).toBe(hash('a\u00001'));
    const a = rng(42);
    const b = rng(42);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('takes seed 0 as 1, which xorshift needs', () => {
    expect(rng(0)()).toBe(rng(1)());
  });
});

describe('outcome', () => {
  const sw: V2Graph = { nodes: [trigger('T'), v1('S'), v1('X'), v1('Y')], edges: [edge('T', 'S'), edge('S', 'X', 0), edge('S', 'Y', 2)] };
  const S = sw.nodes[1]!;
  const B = loop.nodes[1]!;

  it('fills one slot per output the edges use, each drawn once', () => {
    for (let seed = 0; seed < 20; seed++) {
      const o = outcome(sw, S, 0, calm(seed));
      expect(o.status).toBe('completed');
      expect(o.filled).toHaveLength(3);
    }
  });

  it('fails every non-batch step at pFail 1, and never a batch step', () => {
    expect(outcome(sw, S, 0, calm(7, 1))).toEqual({ status: 'failed', filled: [] });
    expect(outcome(loop, B, 0, calm(7, 1)).status).toBe('completed');
  });

  it('runs a batch node 1 + hash % 3 steps: loop slot until the last, done slot at the last', () => {
    for (let seed = 0; seed < 30; seed++) {
      const passes = 1 + (hash(seed, 'B', 'passes') % 3);
      for (let it = 0; it < passes - 1; it++) expect(outcome(loop, B, it, calm(seed)).filled).toEqual([false, true]);
      expect(outcome(loop, B, passes - 1, calm(seed)).filled).toEqual([true, false]);
    }
  });

  it('ends a loop with [null, null] at emptyTerminal 1, and draws the choice apart from every other outcome', () => {
    for (let seed = 0; seed < 30; seed++) {
      const passes = 1 + (hash(seed, 'B', 'passes') % 3);
      const empty = { seed, pFail: 0.2, emptyTerminal: 1 };
      expect(outcome(loop, B, passes - 1, empty).filled).toEqual([false, false]);
      for (let it = 0; it < passes - 1; it++) expect(outcome(loop, B, it, empty).filled).toEqual([false, true]);
      expect(outcome(sw, S, 0, empty)).toEqual(outcome(sw, S, 0, { ...empty, emptyTerminal: 0 }));
    }
  });

  it('ends a quarter of loops empty at emptyTerminal 0.25, per (behaviour, batch node)', () => {
    const graph: V2Graph = { nodes: [trigger('T'), batch('B')], edges: [edge('T', 'B')] };
    let empty = 0;
    for (let seed = 0; seed < 2000; seed++) {
      if (outcome(graph, graph.nodes[1]!, 5, { seed, pFail: 0, emptyTerminal: 0.25 }).filled[0] === false) empty++;
    }
    expect(empty / 2000).toBeGreaterThan(0.2);
    expect(empty / 2000).toBeLessThan(0.3);
  });
});

// ---- the loop ----

describe('simulate', () => {
  it('runs a chain to completion, reporting the birth row first and every change after', () => {
    const states: (readonly ReferenceRow[])[] = [];
    const r = simulate(stub, chain, calm(3), 0, { onState: (rows) => states.push(rows) });
    expect(states[0]).toEqual([row('T', 0, 'completed', [true])].map((x) => ({ ...x, id: '0' })));
    for (let i = 1; i < states.length; i++) expect(states[i]).not.toEqual(states[i - 1]);
    expect(r.end).toBe('completed');
    expect(r.settled).toBe(r.expected);
    expect(r.rows).toEqual(states[states.length - 1]);
  });

  it('shows every step that ran as queued, then running, then settled', () => {
    for (let seed = 0; seed < 20; seed++) {
      const seen = new Map<string, string[]>();
      simulate(stub, branchDiamond, calm(seed), seed, {
        onState: (rows) => {
          for (const r of rows) {
            const trail = seen.get(id(r)) ?? [];
            if (trail[trail.length - 1] !== r.status) trail.push(r.status);
            seen.set(id(r), trail);
          }
        },
      });
      for (const [key, trail] of seen) {
        if (key === 'T:0') expect(trail).toEqual(['completed']);
        else if (trail[0] === 'queued') expect(trail).toEqual(['queued', 'running', 'completed']);
        else expect(trail).toEqual(['skipped']);
      }
    }
  });

  it('hands out snapshots the run does not touch afterwards', () => {
    const states: (readonly ReferenceRow[])[] = [];
    simulate(stub, chain, calm(3), 0, { onState: (rows) => states.push(rows) });
    expect(states[1]!.find((r) => r.nodeId === 'A')!.status).toBe('queued');
  });

  it('is a pure function of (graph, behaviour, order)', () => {
    for (let order = 0; order < 10; order++) {
      expect(simulate(stub, branchDiamond, calm(11, 0.3), order)).toEqual(simulate(stub, branchDiamond, calm(11, 0.3), order));
    }
  });

  it('on a failure, cancels the queued rows and reports that state; running steps are left running', () => {
    // T fans out to A, B and C; any may fail while the others are still queued.
    const fan: V2Graph = { nodes: [trigger('T'), v1('A'), v1('B'), v1('C')], edges: [edge('T', 'A'), edge('T', 'B'), edge('T', 'C')] };
    let cancelledRuns = 0;
    for (let order = 0; order < 50; order++) {
      const states: (readonly ReferenceRow[])[] = [];
      const r = simulate(stub, fan, calm(5, 1), order, { onState: (rows) => states.push(rows) });
      expect(r.end).toBe('failed');
      expect(r.leftQueued).toBe(0);
      const last = states[states.length - 1]!;
      expect(last).toEqual(r.rows);
      if (last.some((x) => x.status === 'cancelled')) {
        cancelledRuns++;
        expect(last.some((x) => x.status === 'failed')).toBe(true);
        expect(states[states.length - 2]!.filter((x) => x.status === 'queued').map(id))
          .toEqual(last.filter((x) => x.status === 'cancelled').map(id));
      }
    }
    expect(cancelledRuns).toBeGreaterThan(0);
  });

  it('throws when the loop does not terminate', () => {
    const endless: SettlementReference = {
      ...stub,
      decideSuccessors: (_g, _l, settled) => ({ toQueue: [], toSkip: [{ nodeId: settled.nodeId, iteration: settled.iteration + 1 }] }),
      countExpectedSettledSteps: () => undefined,
    };
    expect(MAX_EVENTS).toBe(20_000);
    expect(() => simulate(endless, chain, calm(1), 0, { maxEvents: 500 })).toThrow('no termination within 500 events');
  });
});

// ---- R(S) ----

describe('referenceAnswer', () => {
  const S = [row('T', 0, 'completed', [true]), row('If', 0, 'completed', [true, false])];

  it('is the union of decideSuccessors over the completed and skipped rows', () => {
    expect(keys(referenceAnswer(stub, branchDiamond, [], S))).toEqual({ toQueue: ['P:0'], toSkip: ['Q:0'] });
    const later = [...S, row('P', 0, 'running'), row('Q', 0, 'skipped')];
    expect(keys(referenceAnswer(stub, branchDiamond, [], later))).toEqual({ toQueue: [], toSkip: [] });
    const done = [...S, row('P', 0, 'completed', [true]), row('Q', 0, 'skipped')];
    expect(keys(referenceAnswer(stub, branchDiamond, [], done))).toEqual({ toQueue: ['M:0'], toSkip: [] });
  });

  it('is empty once any row failed', () => {
    const failed = [...S, row('P', 0, 'failed'), row('Q', 0, 'skipped')];
    expect(keys(referenceAnswer(stub, branchDiamond, [], failed))).toEqual({ toQueue: [], toSkip: [] });
  });

  it('leaves out keys that already have a row, and keeps a key both lists name', () => {
    const noisy: SettlementReference = {
      ...stub,
      decideSuccessors: (_g, _l, settled) => (settled.nodeId === 'T'
        ? { toQueue: [{ nodeId: 'If', iteration: 0 }, { nodeId: 'P', iteration: 0 }], toSkip: [] }
        : { toQueue: [], toSkip: [{ nodeId: 'P', iteration: 0 }] }),
    };
    expect(keys(referenceAnswer(noisy, branchDiamond, [], S))).toEqual({ toQueue: ['P:0'], toSkip: ['P:0'] });
  });
});

describe('latestTerminal and terminalIterations', () => {
  it('read each asked batch node\'s latest row, and omit a loop that has not ended', () => {
    const rows = [
      row('B', 0, 'completed', [false, true]), row('B', 1, 'completed', [true, false]),
      row('C', 0, 'completed', [false, true]),
      row('D', 0, 'completed', [false, true]), row('D', 1, 'skipped'),
    ];
    expect(latestTerminal(stub, rows, ['B', 'C', 'D'])).toEqual(new Map([['B', 1], ['D', 1]]));
    expect(latestTerminal(stub, rows, ['C'])).toEqual(new Map());
    const loops = [{ batchNodeId: 'B', memberIds: new Set(['B']) }, { batchNodeId: 'C', memberIds: new Set(['C']) }];
    expect(terminalIterations(stub, loops, rows)).toEqual(new Map([['B', 1]]));
  });
});

// ---- the loop's row sets reach the decoder ----

describe('the reference loop\'s row sets, decoded (stub reference, graphs without a loop)', () => {
  it.each(Object.entries(SETTLEMENT_SHAPES))('%s: every state decodes, and the planner agrees with the stub', (_name, graph) => {
    const c = compile(graphToDescription(graph).description, { profile: 'engineV2' });
    let states = 0;
    let running = 0;
    for (let seed = 0; seed < 12; seed++) {
      for (let order = 0; order < 4; order++) {
        simulate(stub, graph, calm(seed, seed % 3 === 2 ? 0.3 : 0), order, {
          onState: (rows) => {
            states++;
            if (rows.some((r) => r.status === 'running')) running++;
            const plan = planFromMarking(c, decodeStepRows(c, rows));
            expect(keys(plan)).toEqual(keys(referenceAnswer(stub, graph, [], rows)));
          },
        });
      }
    }
    expect(states).toBeGreaterThan(48);
    expect(running).toBeGreaterThan(0);
  });
});
