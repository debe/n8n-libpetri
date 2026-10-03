/**
 * The pure parts of `compare-v2.ts` (plan step 12), on synthetic legs: what counts as a difference,
 * how a settlement without a policy call is attributed, and when F3 and F4 fire. The live legs are
 * `scripts/testbed/diff-engines-v2.sh`; nothing here starts a server.
 */
import { describe, expect, it } from 'vitest';
import {
  accountCalls, binding, byQuarter, compare, differences, latency, normalisedOutput, observe, percentile,
} from './compare-v2.js';
import type { Leg, PolicyCall, SettlementRecord, SqlExecution, SqlStep } from './compare-v2.js';

const step = (nodeId: string, iteration: number, status: string, outputs: unknown = [[{ json: {} }]], error: SqlStep['error'] = null): SqlStep => ({
  nodeId, iteration, status, outputs, error,
  filledOutputSlots: Array.isArray(outputs) ? outputs.map((o) => o !== null) : [],
});

const execution = (id: string, status: string, steps: SqlStep[]): SqlExecution => ({
  id, status, responseKind: 'none',
  nodes: [{ id: 't', name: 'Trigger' }, { id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  steps,
});

const call = (method: PolicyCall['method'], roundTrips: number, ms = 1): PolicyCall => ({ method, ms, readerCalls: roundTrips, roundTrips });

const settlement = (executionId: string, nodeId: string, status: string, policy: PolicyCall[], extra: Partial<SettlementRecord> = {}): SettlementRecord => ({
  kind: 'settlement', executionId, stepId: `${executionId}-${nodeId}`, ms: 5,
  step: { nodeId, iteration: 0, status }, executionStatus: 'running', failedFound: false,
  store: 7, policy, ended: null, threw: null, ...extra,
});

const leg = (label: string, runs: { workflow: string; e: SqlExecution }[], ledger: Leg['ledger']): Leg => ({
  label,
  runs: runs.map(({ workflow, e }) => ({ workflow, executionId: e.id, elapsedMs: 1, restStatus: e.status })),
  executions: new Map(runs.map(({ e }) => [e.id, e])),
  ledger,
  serverVersion: '18.4',
});

describe('compare-v2: observations', () => {
  it('reduces an error to its name and message, and keeps outputs as they are', () => {
    const a = step('a', 0, 'failed', null, { name: 'E', message: 'm', stack: 'at /x' } as SqlStep['error']);
    const b = step('a', 0, 'failed', null, { name: 'E', message: 'm', stack: 'at /y' } as SqlStep['error']);
    expect(normalisedOutput(a)).toBe(normalisedOutput(b));
    expect(normalisedOutput(step('a', 0, 'completed', [[{ json: { n: 1 } }]]))).not.toBe(normalisedOutput(step('a', 0, 'completed', [[{ json: { n: 2 } }]])));
  });

  it('is independent of row order and names the fields that differ', () => {
    const e1 = execution('1', 'completed', [step('t', 0, 'completed'), step('a', 0, 'completed')]);
    const e2 = execution('2', 'completed', [step('a', 0, 'completed'), step('t', 0, 'completed')]);
    expect(differences(observe(e1, []), observe(e2, []))).toEqual([]);
    const e3 = execution('3', 'completed', [step('t', 0, 'completed'), step('a', 0, 'skipped', [])]);
    expect(differences(observe(e1, []), observe(e3, [])).map((d) => d.field)).toEqual(['fates', 'slots', 'outputs']);
  });

  it('reads lastStep from the settlement whose handler announced the end', () => {
    const e = execution('1', 'completed', [step('t', 0, 'completed')]);
    const ended = settlement('1', 't', 'completed', [], { ended: { status: 'completed', responseKind: 'none', lastStep: { nodeId: 't', nodeName: 'Trigger', iteration: 0, status: 'completed' } } });
    expect(observe(e, [ended]).lastStep).toBe('completed Trigger@0 completed');
    expect(observe(e, []).lastStep).toBe('none');
  });
});

describe('compare-v2: policy calls against settled rows', () => {
  it('attributes a settlement without a call to the ended execution or the failure found first', () => {
    const e = execution('1', 'failed', [step('t', 0, 'completed'), step('a', 0, 'failed', null), step('b', 0, 'completed')]);
    const records = [
      settlement('1', 't', 'completed', [call('decideSuccessors', 1)]),
      settlement('1', 'a', 'failed', []),
      settlement('1', 'b', 'completed', [], { failedFound: true }),
    ];
    expect(accountCalls(e, records)).toMatchObject({ settledNonFailed: 2, settlementsNonFailed: 2, decideCalls: 1, failureFirst: 1, endedFirst: 0, unexplained: 0 });
    const late = [records[0]!, records[1]!, settlement('1', 'b', 'completed', [], { executionStatus: 'failed' })];
    expect(accountCalls(e, late)).toMatchObject({ endedFirst: 1, failureFirst: 0, unexplained: 0 });
  });

  it('counts a live settlement that skipped the policy for no named reason as unexplained', () => {
    const e = execution('1', 'completed', [step('t', 0, 'completed')]);
    expect(accountCalls(e, [settlement('1', 't', 'completed', [])])).toMatchObject({ unexplained: 1 });
  });
});

describe('compare-v2: latency', () => {
  it('uses nearest-rank percentiles', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(Number.isNaN(percentile([], 95))).toBe(true);
  });

  it('sums the policy calls of one settlement and lists those over 3 round trips', () => {
    const l = latency([
      settlement('1', 'a', 'completed', [call('decideSuccessors', 2, 3), call('isFinished', 2, 4)]),
      settlement('1', 'b', 'completed', [call('decideSuccessors', 2, 1)]),
      settlement('1', 't', 'failed', []),
    ], new Map([['a', 'A'], ['b', 'B']]));
    expect(l.roundTrips.max).toBe(4);
    expect(l.policyMs.max).toBe(7);
    expect(l.handlerMs.n).toBe(3);
    expect(l.over3).toEqual(['A@0 completed: decideSuccessors 2 + isFinished 2']);
  });
});

describe('compare-v2: the report', () => {
  const loop = (id: string, status = 'completed') => execution(id, status, [step('t', 0, 'completed'), step('a', 0, 'completed')]);
  const records = (id: string, trips: number[], handlerMs: number, policyMs: number) =>
    trips.map((t, i) => settlement(id, i === 0 ? 't' : 'a', 'completed', [call('decideSuccessors', t, policyMs)], { ms: handlerMs }));

  it('finds nothing when the legs agree and F4 holds', () => {
    const off = leg('off', [{ workflow: 'V2 Loop Over Items', e: loop('o1') }], records('o1', [1, 2], 10, 2));
    const primary = leg('primary', [{ workflow: 'V2 Loop Over Items', e: loop('p1') }], records('p1', [1, 2], 12, 4));
    const { summary } = compare([off, primary]);
    expect(summary.findings).toEqual([]);
    expect(summary.f3).toBe(false);
    expect(summary.f4).toMatchObject({ fires: false, maxRoundTrips: 2 });
  });

  it('fires F4 on a settlement past 3 round trips, and on a p95 past twice the off handler', () => {
    const off = leg('off', [{ workflow: 'V2 Loop Over Items', e: loop('o1') }], records('o1', [1, 2], 10, 2));
    const trips = leg('primary', [{ workflow: 'V2 Loop Over Items', e: loop('p1') }], records('p1', [1, 4], 12, 4));
    expect(compare([off, trips]).summary.f4).toMatchObject({ fires: true, maxRoundTrips: 4 });
    const slow = leg('primary', [{ workflow: 'V2 Loop Over Items', e: loop('p1') }], records('p1', [1, 2], 12, 25));
    expect(compare([off, slow]).summary.f4).toMatchObject({ fires: true, ratio: 2.5 });
  });

  it('fires F3 when an execution stays running where off ended', () => {
    const off = leg('off', [{ workflow: 'W', e: loop('o1') }], records('o1', [1, 1], 1, 1));
    const primary = leg('primary', [{ workflow: 'W', e: loop('p1', 'running') }], records('p1', [1, 1], 1, 1));
    const { summary } = compare([off, primary]);
    expect(summary.f3).toBe(true);
    expect(summary.findings.some((f) => f.startsWith('F3:'))).toBe(true);
  });

  it('counts a shadow race and finds a disagreement', () => {
    const shadow = (verdict: 'agree' | 'disagree' | 'race', race: 'failure' | null = null) => ({
      kind: 'shadow' as const,
      report: { method: 'decideSuccessors', executionId: 's1', verdict, race, skew: false, primaryMs: 1, candidateMs: 1, primaryReads: 1, candidateReads: 1 },
    });
    const off = leg('off', [{ workflow: 'W', e: loop('o1') }], records('o1', [1, 1], 1, 1));
    const raced = leg('shadow', [{ workflow: 'W', e: loop('s1') }], [...records('s1', [1, 1], 1, 1), shadow('agree'), shadow('race', 'failure')]);
    expect(compare([off, raced]).summary.findings).toEqual([]);
    const disagreed = leg('shadow', [{ workflow: 'W', e: loop('s1') }], [...records('s1', [1, 1], 1, 1), shadow('disagree')]);
    expect(compare([off, disagreed]).summary.findings).toEqual(['shadow: 1 shadow disagreements (F2)']);
  });

  it('reports a difference that off shows between its own runs as variation, not as a finding', () => {
    const a = execution('o1', 'failed', [step('t', 0, 'completed'), step('a', 0, 'cancelled', null)]);
    const b = execution('o2', 'failed', [step('t', 0, 'completed'), step('a', 0, 'completed')]);
    const c = execution('p1', 'failed', [step('t', 0, 'completed'), step('a', 0, 'completed')]);
    const off = leg('off', [{ workflow: 'W', e: a }, { workflow: 'W', e: b }], []);
    const primary = leg('primary', [{ workflow: 'W', e: c }], []);
    const { summary } = compare([off, primary]);
    expect(summary.findings).toEqual([]);
    expect(summary.notes.some((n) => n.includes('varies here too'))).toBe(true);
    expect(summary.notes.some((n) => n.includes('not run with --timing'))).toBe(true);
  });
});

describe('compare-v2: snapshot reuse (step 12 rerun)', () => {
  const ev = (method: 'decideSuccessors' | 'isFinished', event: 'stored' | 'reused' | 'overrun', token: number) => ({ method, event, token });
  // One settled row per execution, so one decideSuccessors call accounts for it.
  const loop = (id: string) => execution(id, 'completed', [step('t', 0, 'completed')]);

  it('pairs a reused snapshot with its stored one in the same handler, and finds one that crossed', () => {
    const paired = settlement('1', 'a', 'completed', [call('decideSuccessors', 2), call('isFinished', 0)], { snapshots: [ev('decideSuccessors', 'stored', 4), ev('isFinished', 'reused', 4)] });
    const crossed = settlement('1', 'b', 'completed', [call('decideSuccessors', 2), call('isFinished', 0)], { snapshots: [ev('decideSuccessors', 'stored', 6), ev('isFinished', 'reused', 5)] });
    const fresh = settlement('1', 't', 'cancelled', [call('isFinished', 2)], { snapshots: [ev('isFinished', 'overrun', 0)] });
    expect(binding([paired, fresh])).toEqual({ stored: 1, reused: 1, crossed: 0, overruns: 1, isFinishedFresh: 1, isFinishedNoRead: 1 });
    expect(binding([crossed]).crossed).toBe(1);
    const off = leg('off', [{ workflow: 'W', e: loop('o1') }], [settlement('o1', 't', 'completed', [call('decideSuccessors', 1)])]);
    expect(compare([off, leg('primary', [{ workflow: 'W', e: loop('p1') }], [{ ...crossed, executionId: 'p1', step: { nodeId: 't', iteration: 0, status: 'completed' } }])]).summary.findings)
      .toEqual(['primary: 1 reused snapshots crossed from another handler (binding B)']);
  });

  it('counts a stale shadow verdict without finding it', () => {
    const stale = { kind: 'shadow' as const, report: { method: 'isFinished', executionId: 's1', verdict: 'stale' as const, reused: 'candidate' as const, race: null, skew: false, primaryMs: 1, candidateMs: 1, primaryReads: 1, candidateReads: 0 } };
    const off = leg('off', [{ workflow: 'W', e: loop('o1') }], [settlement('o1', 't', 'completed', [call('decideSuccessors', 1)])]);
    const shadow = leg('shadow', [{ workflow: 'W', e: loop('s1') }], [settlement('s1', 't', 'completed', [call('decideSuccessors', 1)]), stale]);
    const { summary, markdown } = compare([off, shadow]);
    expect(summary.findings).toEqual([]);
    expect(summary.notes.some((n) => n.includes('1 shadow `stale` verdicts'))).toBe(true);
    expect(markdown).toContain('| shadow | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |');
  });

  it('splits the loop\'s settlements into four quarters of the passes', () => {
    const at = (iteration: number, policyMs: number, trips: number) =>
      settlement('1', 'b', 'completed', [call('decideSuccessors', trips, policyMs)], { step: { nodeId: 'b', iteration, status: 'completed' }, ms: 10 * policyMs });
    const qs = byQuarter([at(0, 1, 2), at(3, 2, 2), at(4, 3, 2), at(7, 4, 3)]);
    expect(qs.map((q) => [q.from, q.to, q.policyMs.p50, q.handlerMs.p50, q.maxRoundTrips])).toEqual([
      [0, 1, 1, 10, 2], [2, 3, 2, 20, 2], [4, 5, 3, 30, 2], [6, 7, 4, 40, 3],
    ]);
  });
});
