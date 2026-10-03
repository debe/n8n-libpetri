/**
 * Shadow mode (`src/settlement/shadow.ts`, `tasks/v2-seam-plan.md` steps 6, 11 and 12): the primary
 * answers, the candidate runs beside it and every call is reported.
 *
 * - A doctored candidate is caught: a key dropped, two keys swapped, queue and skip exchanged, or
 *   `isFinished` flipped is `disagree`, and the handler still gets the primary's answer.
 * - A candidate throw, synchronous or a rejection, is contained: `candidate-threw`, primary's answer.
 * - The named races (decision 8) are `race`, not `disagree`, and only when the answers differ.
 * - The report carries both sides' reads and rows, and `skew` when a row moved between them.
 * - A side whose `isFinished` reused its settlement's snapshot is reported with the rows of its
 *   `decideSuccessors`; its false against a fresh true is `stale`, its true against a fresh false
 *   is `disagree`.
 * - The primary's own throw still reaches the handler, and a report listener's throw does not.
 */
import { describe, expect, it } from 'vitest';
import type { StepRow } from '../../src/codec/v2/step-rows.js';
import type { V2Graph } from '../../src/n8n/v2-graph.js';
import type { V2SettlementPolicy, V2SettlementReader, V2StepKey, V2SuccessorDecisions } from '../../src/n8n/v2-host.js';
import { createSettlementPolicy } from '../../src/settlement/policy.js';
import { createShadowPolicy } from '../../src/settlement/shadow.js';
import type { ShadowReport } from '../../src/settlement/shadow.js';
import { branchDiamond, chain, loop } from '../fixtures/v2-graphs.js';
import { memoryReader } from '../support/settlement-reader.js';

const row = (nodeId: string, iteration: number, status: string, filled: boolean[] = []): StepRow =>
  ({ nodeId, iteration, status, filledOutputSlots: filled });
const done = (nodeId: string, iteration = 0, filled = [true]) => row(nodeId, iteration, 'completed', filled);
const text = (d: { readonly toQueue: readonly V2StepKey[]; readonly toSkip: readonly V2StepKey[] }) => ({
  toQueue: d.toQueue.map((k) => `${k.nodeId}@${k.iteration}`),
  toSkip: d.toSkip.map((k) => `${k.nodeId}@${k.iteration}`),
});

/** `ours`, with its decisions passed through `doctor`. */
function doctored(doctor: (d: V2SuccessorDecisions) => V2SuccessorDecisions, finished?: (f: boolean) => boolean): V2SettlementPolicy {
  const ours = createSettlementPolicy();
  return {
    decideSuccessors: async (graph, settled, reader) => doctor(await ours.decideSuccessors(graph, settled, reader)),
    isFinished: async (graph, reader) => (finished ?? ((f) => f))(await ours.isFinished(graph, reader)),
  };
}

function shadowOf(primary: V2SettlementPolicy, candidate: V2SettlementPolicy) {
  const reports: ShadowReport[] = [];
  return { policy: createShadowPolicy({ primary, candidate, onReport: (r) => reports.push(r) }), reports };
}

// If (both slots filled) -> P and Q both queued, in edge order.
const fanOut = [done('T'), done('If', 0, [true, true])];
// If (slot 0 only) -> P queued, Q skipped.
const split = [done('T'), done('If', 0, [true, false])];

describe('a shadowed call', () => {
  it('agrees with itself, returns the primary\'s answer and reports both sides\' reads', async () => {
    const { policy, reports } = shadowOf(createSettlementPolicy(), createSettlementPolicy());
    const d = await policy.decideSuccessors(branchDiamond, done('If', 0, [true, true]), memoryReader(fanOut, { executionId: 'e' }));
    expect(text(d)).toEqual({ toQueue: ['P@0', 'Q@0'], toSkip: [] });
    expect(await policy.isFinished(branchDiamond, memoryReader(fanOut))).toBe(false);
    expect(reports.map((r) => r.verdict)).toEqual(['agree', 'agree']);
    const [first] = reports;
    expect(first).toMatchObject({
      method: 'decideSuccessors', executionId: 'e', settled: { nodeId: 'If', iteration: 0 }, race: null, error: null,
      primaryReads: 1, candidateReads: 1, skew: false,
    });
    expect(first!.primaryRows).toHaveLength(2);
    expect(first!.candidateRows).toEqual(first!.primaryRows);
    expect(reports[1]!.settled).toBeNull();
  });
});

describe('a doctored candidate is caught', () => {
  const doctors: Record<string, (d: V2SuccessorDecisions) => V2SuccessorDecisions> = {
    'a key dropped': (d) => ({ toQueue: d.toQueue.slice(1), toSkip: d.toSkip }),
    'two keys swapped': (d) => ({ toQueue: [...d.toQueue].reverse(), toSkip: d.toSkip }),
    'queue and skip exchanged': (d) => ({ toQueue: d.toSkip, toSkip: d.toQueue }),
    'a key added': (d) => ({ toQueue: [...d.toQueue, { nodeId: 'M', iteration: 0 }], toSkip: d.toSkip }),
    'an iteration moved': (d) => ({ toQueue: d.toQueue.map((k, i) => (i === 0 ? { ...k, iteration: k.iteration + 1 } : k)), toSkip: d.toSkip }),
  };

  it.each(Object.entries(doctors))('%s: disagree, and the handler gets the primary\'s answer', async (_name, doctor) => {
    const { policy, reports } = shadowOf(createSettlementPolicy(), doctored(doctor));
    const d = await policy.decideSuccessors(branchDiamond, done('If', 0, [true, true]), memoryReader(fanOut));
    expect(text(d)).toEqual({ toQueue: ['P@0', 'Q@0'], toSkip: [] });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ verdict: 'disagree', race: null });
    expect(text(reports[0]!.candidate as V2SuccessorDecisions)).not.toEqual(text(d));
  });

  it('a flipped isFinished: disagree', async () => {
    const { policy, reports } = shadowOf(createSettlementPolicy(), doctored((d) => d, (f) => !f));
    expect(await policy.isFinished(chain, memoryReader([done('T'), done('A'), done('B')]))).toBe(true);
    expect(reports[0]).toMatchObject({ method: 'isFinished', verdict: 'disagree', primary: true, candidate: false });
  });

  it('in the other direction too: the net answering, a doctored n8n stand-in shadowing', async () => {
    const { policy, reports } = shadowOf(createSettlementPolicy(), doctored((d) => ({ toQueue: d.toSkip, toSkip: d.toQueue })));
    const d = await policy.decideSuccessors(branchDiamond, done('If', 0, [true, false]), memoryReader(split));
    expect(text(d)).toEqual({ toQueue: ['P@0'], toSkip: ['Q@0'] });
    expect(reports[0]!.verdict).toBe('disagree');
  });
});

describe('a candidate throw is contained', () => {
  it.each([
    ['a rejection', async () => { throw new Error('candidate broke'); }],
    ['a synchronous throw', () => { throw new Error('candidate broke'); }],
  ] as const)('%s: candidate-threw, and the primary\'s answer', async (_name, broken) => {
    const candidate = { decideSuccessors: broken, isFinished: broken } as unknown as V2SettlementPolicy;
    const { policy, reports } = shadowOf(createSettlementPolicy(), candidate);
    const d = await policy.decideSuccessors(branchDiamond, done('If', 0, [true, false]), memoryReader(split));
    expect(text(d)).toEqual({ toQueue: ['P@0'], toSkip: ['Q@0'] });
    expect(await policy.isFinished(branchDiamond, memoryReader(split))).toBe(false);
    expect(reports.map((r) => [r.verdict, r.candidate, r.error])).toEqual([
      ['candidate-threw', null, 'candidate broke'], ['candidate-threw', null, 'candidate broke'],
    ]);
  });

  it('a candidate CodecError on rows n8n accepts is reported, not thrown', async () => {
    // n8n's default stand-in answers on any rows; the net refuses B completed with no row for A,
    // B's only input.
    const lenient: V2SettlementPolicy = { decideSuccessors: async () => ({ toQueue: [], toSkip: [] }), isFinished: async () => false };
    const { policy, reports } = shadowOf(lenient, createSettlementPolicy());
    expect(await policy.isFinished(chain, memoryReader([done('T'), done('B')]))).toBe(false);
    expect(reports[0]).toMatchObject({ verdict: 'candidate-threw' });
    expect(reports[0]!.error).toMatch(/never found the start or skip of \(B, 0\)/);
  });

  it('but the primary\'s throw reaches the handler, and the candidate is not asked', async () => {
    let asked = 0;
    const candidate: V2SettlementPolicy = {
      decideSuccessors: async () => { asked++; return { toQueue: [], toSkip: [] }; },
      isFinished: async () => { asked++; return false; },
    };
    const { policy, reports } = shadowOf(createSettlementPolicy(), candidate);
    await expect(policy.isFinished(chain, memoryReader([done('T'), row('A', 0, 'paused')]))).rejects.toThrow(/not an engine v2 step status/);
    expect(asked).toBe(0);
    expect(reports).toEqual([]);
  });

  it('and a report listener that throws changes nothing', async () => {
    const policy = createShadowPolicy({ primary: createSettlementPolicy(), candidate: createSettlementPolicy(), onReport: () => { throw new Error('listener'); } });
    expect(await policy.isFinished(chain, memoryReader([done('T'), done('A'), done('B')]))).toBe(true);
  });
});

describe('the named races', () => {
  /** n8n's `decideSuccessors` with no failure guard: it plans past a failed or cancelled row. */
  const unguarded = (answer: V2SuccessorDecisions, finished: boolean): V2SettlementPolicy => ({
    decideSuccessors: async (_g, _s, reader) => { await reader.loadLatestStepSummaries(['T']); return answer; },
    isFinished: async (_g, reader) => { await reader.countSettledSteps(); return finished; },
  });

  it('a failed row where the answers differ is the race failure, not a disagreement', async () => {
    const rows = [done('T'), done('A'), row('B', 0, 'failed')];
    const { policy, reports } = shadowOf(unguarded({ toQueue: [{ nodeId: 'B', iteration: 0 }], toSkip: [] }, true), createSettlementPolicy());
    await policy.decideSuccessors(chain, done('A'), memoryReader(rows));
    await policy.isFinished(chain, memoryReader(rows));
    expect(reports.map((r) => [r.verdict, r.race])).toEqual([['race', 'failure'], ['race', 'failure']]);
    expect(reports[1]!.primaryReads).toBe(1);
    // Ours took its settlement's snapshot: no read, and the rows of its decideSuccessors.
    expect(reports[1]).toMatchObject({ candidateReads: 0, reused: 'candidate' });
    expect(reports[1]!.candidateRows).toEqual(reports[0]!.candidateRows);
  });

  it('a cancelled row and no failed one is the race cancel', async () => {
    const rows = [done('T'), row('A', 0, 'cancelled')];
    const { policy, reports } = shadowOf(unguarded({ toQueue: [{ nodeId: 'A', iteration: 0 }], toSkip: [] }, false), createSettlementPolicy());
    await policy.decideSuccessors(chain, done('T'), memoryReader(rows));
    expect(reports.map((r) => [r.verdict, r.race])).toEqual([['race', 'cancel']]);
  });

  it('is not claimed where the answers agree', async () => {
    const rows = [done('T'), row('A', 0, 'failed')];
    const { policy, reports } = shadowOf(unguarded({ toQueue: [], toSkip: [] }, false), createSettlementPolicy());
    await policy.decideSuccessors(chain, done('T'), memoryReader(rows));
    await policy.isFinished(chain, memoryReader(rows));
    expect(reports.map((r) => [r.verdict, r.race])).toEqual([['agree', null], ['agree', null]]);
  });
});

describe('skew', () => {
  it('is flagged when a row both sides read moved between their reads', async () => {
    // The body completes between the primary's keyed read and the candidate's.
    const before = [done('T'), done('B', 0, [false, true]), row('Body', 0, 'running')];
    const after = [done('T'), done('B', 0, [false, true]), done('Body', 0)];
    let calls = 0;
    const moving: V2SettlementReader = {
      executionId: 'e',
      loadLatestStepSummaries: (ids) => memoryReader(after).loadLatestStepSummaries(ids),
      loadStepSummariesByKeys: (keys) => memoryReader(calls++ === 0 ? before : after).loadStepSummariesByKeys(keys),
      countSettledSteps: () => memoryReader(after).countSettledSteps(),
    };
    const { policy, reports } = shadowOf(createSettlementPolicy(), createSettlementPolicy());
    const graph: V2Graph = loop;
    expect(text(await policy.decideSuccessors(graph, done('B', 0, [false, true]), moving))).toEqual({ toQueue: [], toSkip: [] });
    expect(reports[0]).toMatchObject({ verdict: 'agree', skew: true });
    calls = 0;
    // Another settlement (its own graph object), so both sides read afresh.
    expect(await policy.isFinished({ ...graph }, moving)).toBe(false);
    expect(reports[1]).toMatchObject({ skew: true, reused: null });
  });
});

describe('a reused snapshot', () => {
  /** n8n's stand-in: reads the count, answers `finished`. */
  const counting = (finished: boolean): V2SettlementPolicy => ({
    decideSuccessors: async (_g, _s, reader) => { await reader.loadStepSummariesByKeys([{ nodeId: 'T', iteration: 0 }]); return { toQueue: [], toSkip: [] }; },
    isFinished: async (_g, reader) => { await reader.countSettledSteps(); return finished; },
  });
  // T -> A -> B, B running when ours reads; it completes before isFinished.
  const settling = [done('T'), done('A'), row('B', 0, 'running')];

  it('false where the fresh side says true is stale, in both directions', async () => {
    for (const [primary, candidate, reusedSide] of [
      [counting(true), createSettlementPolicy(), 'candidate'],
      [createSettlementPolicy(), counting(true), 'primary'],
    ] as const) {
      const { policy, reports } = shadowOf(primary, candidate);
      await policy.decideSuccessors(chain, done('A'), memoryReader(settling));
      await policy.isFinished(chain, memoryReader([done('T'), done('A'), done('B')]));
      expect(reports[1]).toMatchObject({ method: 'isFinished', verdict: 'stale', race: null, reused: reusedSide });
    }
  });

  it('true where the fresh side says false is a disagreement', async () => {
    const { policy, reports } = shadowOf(counting(false), createSettlementPolicy());
    const final = [done('T'), done('A'), done('B')];
    await policy.decideSuccessors(chain, done('B'), memoryReader(final));
    await policy.isFinished(chain, memoryReader(final));
    expect(reports[1]).toMatchObject({ verdict: 'disagree', reused: 'candidate', candidate: true, primary: false });
  });
});
