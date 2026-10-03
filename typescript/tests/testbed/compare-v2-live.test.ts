/**
 * The pure parts of `compare-v2-live.ts` (ADR 0014 "Open": webhook `runEnd`, concurrent executions,
 * the live cancel race), on synthetic legs: how a capture finds its execution, what is compared and
 * what is a finding, row 39's attribution, the interleaving count, and where a cancel landed. The live
 * phases are `scripts/testbed/diff-engines-v2.sh`; nothing here starts a server.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENDED_REFUSAL, accountCancels, bodyFollowsEnding, compareLive, endingAccount, endingMoved, freshIsFinished, interleaving, landing, linkShadows,
  observeLive, resolveExecution, roundSchedule, untag,
} from './compare-v2-live.js';
import type { Capture, LiveLeg } from './compare-v2-live.js';
import { executionOf, loadLeg } from './compare-v2.js';
import type { CancelRecord, LedgerRecord, PolicyCall, SettlementRecord, ShadowRecord, SqlExecution, SqlStep } from './compare-v2.js';

const NODES = [{ id: 'h', name: 'Webhook' }, { id: 'e', name: 'Echo' }, { id: 'a', name: 'Sink A' }, { id: 'b', name: 'Sink B' }];

const step = (nodeId: string, status: string, outputs: unknown = [[{ json: {} }]], iteration = 0): SqlStep => ({
  nodeId, iteration, status, outputs, error: null,
  filledOutputSlots: Array.isArray(outputs) ? outputs.map((o) => o !== null) : [],
});

const exec = (id: string, status: string, steps: SqlStep[]): SqlExecution => ({ id, status, responseKind: 'runEnd', nodes: NODES, steps });

/** A two-sink webhook run whose rows carry `tag`. */
const twoSinks = (id: string, tag: string) => exec(id, 'completed', [
  step('h', 'completed', [[{ json: { body: { tag } } }]]),
  step('e', 'completed', [[{ json: { tag } }]]),
  step('a', 'completed', [[{ json: { tag, sink: 'A' } }]]),
  step('b', 'completed', [[{ json: { tag, sink: 'B' } }]]),
]);

const call = (method: PolicyCall['method'], roundTrips: number, result: PolicyCall['result'] = null, cancelSeen = false): PolicyCall =>
  ({ method, ms: 1, readerCalls: roundTrips, roundTrips, result, cancelSeen });

const settlement = (executionId: string, nodeId: string, policy: PolicyCall[], extra: Partial<SettlementRecord> = {}): SettlementRecord => ({
  kind: 'settlement', executionId, stepId: `${executionId}-${nodeId}`, ms: 5, step: { nodeId, iteration: 0, status: 'completed' },
  executionStatus: 'running', failedFound: false, store: 5, policy, ended: null, threw: null, ...extra,
});

const ended = (nodeId: string, nodeName: string) =>
  ({ status: 'completed', responseKind: 'runEnd', lastStep: { nodeId, nodeName, iteration: 0, status: 'completed' } });

const http = (body: string, status = 200, extra: Record<string, string> = {}) =>
  ({ status, headers: { 'content-type': 'application/json; charset=utf-8', date: 'now', etag: 'x', 'content-length': String(body.length), ...extra }, body, elapsedMs: 5 });

const webhookCapture = (key: string, tag: string, body: string, phase: Capture['phase'] = 'webhook'): Capture =>
  ({ phase, key, workflow: 'V2 Webhook Two Sinks', tag, responseMode: 'lastNode', http: http(body) });

/** A shadowed `isFinished` report: `reused` names the side that answered from its snapshot. */
const shadowIsFinished = (executionId: string, verdict: ShadowRecord['report']['verdict'], reused: 'primary' | 'candidate', primary: boolean, candidate: boolean): ShadowRecord =>
  ({ kind: 'shadow', report: { method: 'isFinished', executionId, verdict, reused, primary, candidate, race: null, skew: false, primaryMs: 1, candidateMs: 1, primaryReads: reused === 'primary' ? 0 : 1, candidateReads: reused === 'candidate' ? 0 : 1 } });

const liveLeg = (label: string, captures: Capture[], executions: SqlExecution[], ledger: LedgerRecord[]): LiveLeg =>
  ({ label, captures, executions: new Map(executions.map((e) => [e.id, e])), ledger, sequential: [] });

describe('compare-v2-live: finding a capture\'s execution', () => {
  it('uses the execution id when there is one, and the tag in the rows otherwise', () => {
    const e1 = twoSinks('x1', 'wh-two-0001');
    const e10 = twoSinks('x10', 'wh-two-0001x');
    const all = new Map([[e1.id, e1], [e10.id, e10]]);
    expect(resolveExecution({ phase: 'cancel', key: 'k', workflow: 'W', executionId: 'x10' }, all)?.id).toBe('x10');
    // The closing quote keeps one tag from matching a longer one it prefixes.
    expect(resolveExecution(webhookCapture('k', 'wh-two-0001', ''), all)?.id).toBe('x1');
    expect(resolveExecution(webhookCapture('k', 'wh-none', ''), all)).toBeNull();
  });

  it('refuses a tag that two executions carry', () => {
    const all = new Map([['x1', twoSinks('x1', 't')], ['x2', twoSinks('x2', 't')]]);
    expect(() => resolveExecution(webhookCapture('k', 't', ''), all)).toThrow(/matches 2 executions/);
  });
});

describe('compare-v2-live: observations', () => {
  it('replaces the tag in outputs and body, and drops the volatile headers', () => {
    const a = observeLive(twoSinks('x1', 'wh-two-0001'), [], webhookCapture('k1', 'wh-two-0001', '{"tag":"wh-two-0001","sink":"B"}'));
    const b = observeLive(twoSinks('x2', 'wh-two-0002'), [], { tag: 'wh-two-0002', http: { ...http('{"tag":"wh-two-0002","sink":"B"}'), headers: { 'content-type': 'application/json; charset=utf-8', date: 'later', etag: 'y' } } });
    expect(a.outputs).toEqual(b.outputs);
    expect(a.httpBody).toBe('{"tag":"<tag>","sink":"B"}');
    expect(a.httpHeaders).toBe(b.httpHeaders);
    expect(a.httpHeaders).not.toContain('date');
    expect(untag('a-t-b-t', 't')).toBe('a-<tag>-b-<tag>');
    expect(observeLive(twoSinks('x3', 't'), [], {}).httpStatus).toBe('none');
  });
});

describe('compare-v2-live: row 39, attributed', () => {
  const e = twoSinks('x1', 't');
  const reusedFalseAtA = settlement('x1', 'a', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, false)], { t0: 10, t1: 12 });
  const endsAtB = settlement('x1', 'b', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, true)], { t0: 20, t1: 22, ended: ended('b', 'Sink B') });

  it('names a moved ending: A\'s settlement reused its snapshot, said false, and B\'s ended the run', () => {
    expect(endingMoved(e, [reusedFalseAtA, endsAtB], 'completed Sink A@0 completed')).toBe(true);
  });

  it('does not when A\'s isFinished read afresh, said true, or A ended the run itself', () => {
    const fresh = { ...reusedFalseAtA, policy: [call('isFinished', 2, false)] };
    expect(endingMoved(e, [fresh, endsAtB], 'completed Sink A@0 completed')).toBe(false);
    const saidTrue = { ...reusedFalseAtA, policy: [call('isFinished', 0, true)] };
    expect(endingMoved(e, [saidTrue, endsAtB], 'completed Sink A@0 completed')).toBe(false);
    expect(endingMoved(e, [{ ...reusedFalseAtA, ended: ended('a', 'Sink A') }], 'completed Sink A@0 completed')).toBe(false);
  });
});

describe('compare-v2-live: shadow reports, linked to their settlement', () => {
  it('links a report to the next settlement record of its execution, and leaves the rest unlinked', () => {
    const s1 = settlement('x1', 'a', [call('isFinished', 0, false)]);
    const s2 = settlement('x2', 'a', [call('isFinished', 0, false)]);
    const r1 = shadowIsFinished('x1', 'stale', 'primary', false, true);
    const stray = shadowIsFinished('x9', 'agree', 'primary', false, false);
    const late = shadowIsFinished('x2', 'agree', 'primary', false, false);
    const links = linkShadows([r1, stray, s1, s2, late]);
    expect(links.bySettlement.get(s1)).toEqual([r1]);
    expect(links.bySettlement.has(s2)).toBe(false);
    expect(links.unlinked).toEqual([stray, late]);
    // The fresh side is the one that did not reuse.
    expect(freshIsFinished(links, s1)).toBe(true);
    expect(freshIsFinished(linkShadows([shadowIsFinished('x2', 'stale', 'candidate', true, false), s2]), s2)).toBe(true);
    expect(freshIsFinished(links, s2)).toBeUndefined();
  });
});

describe('compare-v2-live: the ending, judged from the ledger', () => {
  const e = twoSinks('x1', 't');
  const head = settlement('x1', 'e', [call('decideSuccessors', 1, { queue: 2, skip: 0 })], { t0: 0, t1: 1 });
  const reusedTrueAtA = settlement('x1', 'a', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, true)], { t0: 10, t1: 12, ended: ended('a', 'Sink A') });
  const afterEnd = settlement('x1', 'b', [], { t0: 20, t1: 21, executionStatus: 'completed' });
  const reusedFalseAtA = settlement('x1', 'a', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, false)], { t0: 10, t1: 12 });
  const freshFalseAtA = { ...reusedFalseAtA, policy: [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 2, false)] };
  const reusedTrueAtB = settlement('x1', 'b', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, true)], { t0: 20, t1: 22, ended: ended('b', 'Sink B') });

  it('accounts an earlier ending on a reused true as one n8n\'s default produces too', () => {
    // The review's reproduction: A's settlement read B already completed, its reused isFinished said true.
    expect(endingAccount(e, [head, reusedTrueAtA, afterEnd])).toMatchObject({ kind: 'n8n ends here too', enderTrue: 'reused', occasions: 0 });
    // A fresh false before the ending is n8n's own count.
    expect(endingAccount(e, [head, freshFalseAtA, reusedTrueAtB]).kind).toBe('n8n ends here too');
  });

  it('names row 39 when an earlier settlement reused and said false, and lets a fresh count decide', () => {
    expect(endingAccount(e, [head, reusedFalseAtA, reusedTrueAtB])).toMatchObject({ kind: 'row 39', occasions: 1, confirmed: 0 });
    const fresh = (answer: boolean) => (r: SettlementRecord) => (r === reusedFalseAtA ? answer : undefined);
    expect(endingAccount(e, [head, reusedFalseAtA, reusedTrueAtB], fresh(true))).toMatchObject({ kind: 'row 39', occasions: 1, confirmed: 1 });
    // A shadow check whose fresh count also said false removes the occasion.
    expect(endingAccount(e, [head, reusedFalseAtA, reusedTrueAtB], fresh(false)).kind).toBe('n8n ends here too');
  });

  it('leaves unaccounted two endings, and a completed ending without an isFinished that said true', () => {
    expect(endingAccount(e, [head, reusedTrueAtA, reusedTrueAtB]).kind).toBe('unaccounted');
    expect(endingAccount(e, [head, { ...reusedFalseAtA, ended: ended('a', 'Sink A') }]).kind).toBe('unaccounted');
    expect(endingAccount(e, [head, { ...reusedFalseAtA, ended: { ...ended('a', 'Sink A'), status: 'failed' } }]).kind).toBe('failure path');
    expect(endingAccount(e, [head]).kind).toBe('no ending');
  });

  it('checks that a runEnd body is the ending step\'s first output item', () => {
    expect(bodyFollowsEnding(e, [head, reusedTrueAtA], http('{"sink":"A","tag":"t"}'))).toBe(true);
    expect(bodyFollowsEnding(e, [head, reusedTrueAtA], http('{"tag":"t","sink":"B"}'))).toBe(false);
    expect(bodyFollowsEnding(e, [head, reusedTrueAtA], http('not json'))).toBe(false);
    expect(bodyFollowsEnding(e, [head, reusedTrueAtA], http('{"message":"Error in workflow"}', 500))).toBeNull();
    expect(bodyFollowsEnding({ ...e, responseKind: 'stepResponse' }, [head, reusedTrueAtA], http('{}'))).toBeNull();
    expect(bodyFollowsEnding(e, [head, reusedTrueAtA], undefined)).toBeNull();
  });
});

describe('compare-v2-live: interleaving', () => {
  it('counts executions in flight at once and switches between them', () => {
    const r = (id: string, t0: number, t1: number) => settlement(id, 'e', [], { t0, t1 });
    expect(interleaving([r('1', 0, 1), r('2', 2, 3), r('1', 4, 5), r('2', 6, 7), r('3', 10, 11)])).toEqual({ executions: 3, maxInFlight: 2, settlements: 5, switches: 4 });
  });

  it('describes a round\'s schedule: start spread, the window every execution is in flight, and the blocks', () => {
    const r = (id: string, t0: number, t1: number) => settlement(id, 'e', [], { t0, t1 });
    const records = [r('1', 0, 1), r('1', 1, 2), r('2', 3, 4), r('1', 5, 6), r('2', 7, 8), r('3', 2.5, 2.8), r('other', 4.5, 4.6)];
    const members = [{ executionId: '1', workflow: 'W', startedAtMs: 0 }, { executionId: '2', workflow: 'W', startedAtMs: 4 }, { executionId: '3', workflow: 'V', startedAtMs: 1 }];
    expect(roundSchedule(1, records, members)).toEqual({
      round: 1, executions: 3, startSpreadMs: 4,
      // Every execution in flight: from 3 (execution 2's first) to 2.8 (execution 3's last): none.
      commonOverlapMs: 2.8 - 3,
      blocks: 5, sequence: 'W > V > W > W > W', blocksPerExecution: { W: [2, 2], V: [1] },
    });
  });
});

describe('compare-v2-live: where a cancel landed', () => {
  const s = settlement('x', 'e', [call('decideSuccessors', 1)], { t0: 10, tLoaded: 12, tRead: 14, tCreate: 16, t1: 18 });
  it('places the compare-and-set against the settlement then in flight', () => {
    expect(landing(5, [s]).landing).toBe('no settlement in flight');
    expect(landing(11, [s]).landing).toBe('before the liveness read');
    expect(landing(13, [s]).landing).toBe('between the liveness read and the policy read');
    expect(landing(15, [s]).landing).toBe('between the policy read and createSteps');
    expect(landing(17, [s]).landing).toBe('after createSteps');
    expect(landing(15, [{ ...s, tCreate: null }]).landing).toBe('after the policy read, no createSteps');
    // A handler that planned nothing and read nothing (it found a failure, say).
    expect(landing(15, [{ ...s, tRead: null, tCreate: null }]).landing).toBe('between the liveness read and the policy read');
  });
});

describe('compare-v2-live: cancel accounting', () => {
  const cancelRec = (executionId: string, tCas: number, tPending: number | null, won = true): CancelRecord =>
    ({ kind: 'cancel', executionId, t0: tCas - 1, t1: tPending ?? tCas + 1, tCas, won, tPending, status: won ? 'cancelled' : 'completed', threw: null });

  it('counts the window, the rows planned after the cancel, and those cancelled at claim', () => {
    const e = exec('c1', 'cancelled', [step('h', 'completed'), step('e', 'completed'), step('a', 'cancelled', null), step('b', 'cancelled', null)]);
    const ledger: LedgerRecord[] = [
      settlement('c1', 'h', [call('decideSuccessors', 1, { queue: 1, skip: 0 })], { t0: 0, tLoaded: 1, tRead: 2, tCreate: 3, t1: 4, created: [{ nodeId: 'e', iteration: 0, status: 'queued' }] }),
      // The cancel lands between Echo's liveness read and its policy read; its cancelPendingSteps
      // answers after the read, so the policy plans both sinks, which are cancelled at claim.
      settlement('c1', 'e', [call('decideSuccessors', 1, { queue: 2, skip: 0 }), call('isFinished', 1, true)], { t0: 10, tLoaded: 11, tRead: 13, tCreate: 15, t1: 16, created: [{ nodeId: 'a', iteration: 0, status: 'queued' }, { nodeId: 'b', iteration: 0, status: 'queued' }] }),
      cancelRec('c1', 12, 14),
    ];
    const a = accountCancels([{ phase: 'cancel', key: 'k', workflow: 'W', executionId: 'c1', stop: { status: 200, ok: true, body: {} } }], new Map([['c1', e]]), ledger);
    expect(a).toMatchObject({
      runs: 1, accepted: 1, endedFirst: 0, inWindow: 1, pendingBeforeRead: 0,
      createdAfterCancel: { queued: 2, skipped: 0 }, cancelledAtClaim: 2, finishedLostToCancel: 1, broken: [],
    });
    expect(a.byLanding['between the liveness read and the policy read']).toBe(1);
  });

  it('counts the calls that read a cancelled row set and what they answered, and the race diagnostics', () => {
    const e = exec('c2', 'cancelled', [step('h', 'completed'), step('a', 'cancelled', null)]);
    const ledger: LedgerRecord[] = [
      settlement('c2', 'h', [call('decideSuccessors', 1, { queue: 0, skip: 0 }, true), call('isFinished', 0, false, true)], { t0: 0, tLoaded: 1, tRead: 3, t1: 4 }),
      cancelRec('c2', 2, 2.5),
      { kind: 'race', executionId: 'c2', race: 'cancel', method: 'decideSuccessors' },
    ];
    const a = accountCancels([{ phase: 'cancel', key: 'k', workflow: 'W', executionId: 'c2', stop: { status: 200, ok: true, body: {} } }], new Map([['c2', e]]), ledger);
    expect(a.cancelSeen).toEqual({ decide: 1, decidePlanned: 0, isFinished: 1, isFinishedTrue: 0 });
    expect(a.pendingBeforeRead).toBe(1);
    expect(a.raceDiagnostics).toBe(1);
  });

  it('names a stale verdict at a settlement the cancel landed inside as the fresh count counting cancelled rows', () => {
    const e = exec('c7', 'cancelled', [step('h', 'completed'), step('a', 'cancelled', null)]);
    const stale: LedgerRecord = { kind: 'shadow', report: { method: 'isFinished', executionId: 'c7', verdict: 'stale', reused: 'primary', race: null, skew: false, primaryMs: 1, candidateMs: 1, primaryReads: 0, candidateReads: 2 } };
    const inside = settlement('c7', 'h', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, false)], { t0: 0, tLoaded: 1, tRead: 2, t1: 10 });
    const cap: Capture = { phase: 'cancel', key: 'k', workflow: 'W', executionId: 'c7', stop: { status: 200, ok: true, body: {} } };
    // The shadow policy reports inside the call, so the verdict precedes its settlement's record.
    expect(accountCancels([cap], new Map([['c7', e]]), [stale, inside, cancelRec('c7', 5, 6)])).toMatchObject({ staleDuringCancel: 1, staleOther: 0 });
    // In a shadow leg the call's round trips include the other side's; the policy's own event decides.
    const shadowed = { ...inside, policy: [call('isFinished', 2, false)], snapshots: [{ method: 'decideSuccessors' as const, event: 'stored' as const, token: 1 }, { method: 'isFinished' as const, event: 'reused' as const, token: 1 }] };
    expect(accountCancels([cap], new Map([['c7', e]]), [stale, shadowed, cancelRec('c7', 5, 6)]).staleDuringCancel).toBe(1);
    // The same verdict with the cancel landing after the settlement is not this case.
    expect(accountCancels([cap], new Map([['c7', e]]), [stale, inside, cancelRec('c7', 12, 13)])).toMatchObject({ staleDuringCancel: 0, staleOther: 1 });
    // Nor is it when no cancelled row was there for the fresh count to have counted.
    const noCancelledRow = exec('c7', 'cancelled', [step('h', 'completed'), step('a', 'completed')]);
    expect(accountCancels([cap], new Map([['c7', noCancelledRow]]), [stale, inside, cancelRec('c7', 5, 6)])).toMatchObject({ staleDuringCancel: 0, staleOther: 1 });
  });

  it('links each stale verdict to its own settlement, not to whichever settlement the cancel landed in', () => {
    // The review's case: a stale verdict at an earlier settlement, and a cancel that lands later in
    // another settlement that also reused isFinished.
    const e = exec('c8', 'cancelled', [step('h', 'completed'), step('e', 'completed'), step('a', 'cancelled', null)]);
    const stale: LedgerRecord = shadowIsFinished('c8', 'stale', 'primary', false, true);
    const early = settlement('c8', 'h', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, false)], { t0: 0, tLoaded: 1, tRead: 2, t1: 3 });
    const later = settlement('c8', 'e', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, false)], { t0: 10, tLoaded: 11, tRead: 12, t1: 20 });
    const cap: Capture = { phase: 'cancel', key: 'k', workflow: 'W', executionId: 'c8', stop: { status: 200, ok: true, body: {} } };
    expect(accountCancels([cap], new Map([['c8', e]]), [stale, early, later, cancelRec('c8', 15, 16)])).toMatchObject({ staleDuringCancel: 0, staleOther: 1 });
  });

  it('tells a row cancelled at claim from the bulk update only where the ledger can', () => {
    const e = exec('c9', 'cancelled', [step('h', 'completed'), step('e', 'completed'), step('a', 'cancelled', null), step('b', 'cancelled', null)]);
    const cap: Capture = { phase: 'cancel', key: 'k', workflow: 'W', executionId: 'c9', stop: { status: 200, ok: true, body: {} } };
    // A's createSteps is called before cancelPendingSteps answers (at 14), B's after.
    const settleE = settlement('c9', 'e', [call('decideSuccessors', 1, { queue: 1, skip: 0 })], { t0: 10, tLoaded: 11, tRead: 12, tCreate: 13, t1: 13.5, created: [{ nodeId: 'a', iteration: 0, status: 'queued', id: 'row-a' }] });
    const settleH = settlement('c9', 'h', [call('decideSuccessors', 1, { queue: 1, skip: 0 })], { t0: 14.5, tLoaded: 14.6, tRead: 14.7, tCreate: 15, t1: 16, created: [{ nodeId: 'b', iteration: 0, status: 'queued', id: 'row-b' }] });
    const cancel = cancelRec('c9', 12.5, 14);
    // Without cancel-step records: B only at claim, A either way.
    expect(accountCancels([cap], new Map([['c9', e]]), [settleE, settleH, cancel])).toMatchObject({ createdAfterCancel: { queued: 2, skipped: 0 }, cancelledAtClaim: 1, cancelledByBulk: 0, cancelledEitherPath: 1 });
    // With them, the record decides: A was cancelled by the bulk update, B at claim.
    const claimB: LedgerRecord = { kind: 'cancel-step', executionId: 'c9', stepId: 'row-b', t: 17, won: true };
    expect(accountCancels([cap], new Map([['c9', e]]), [settleE, settleH, cancel, claimB])).toMatchObject({ cancelledAtClaim: 1, cancelledByBulk: 1, cancelledEitherPath: 0 });
  });

  it('breaks on rows left pending, on an accepted stop that did not cancel, and on a refusal that is not n8n\'s for an ended run', () => {
    const left = exec('c3', 'cancelled', [step('h', 'completed'), step('a', 'running', null)]);
    const notCancelled = exec('c4', 'completed', [step('h', 'completed')]);
    const refused = exec('c5', 'cancelled', [step('h', 'completed')]);
    const lost = exec('c6', 'completed', [step('h', 'completed')]);
    const other = exec('c10', 'completed', [step('h', 'completed')]);
    const ended = `${ENDED_REFUSAL} and c6 is currently success`;
    const caps: Capture[] = [
      { phase: 'cancel', key: 'left', workflow: 'W', executionId: 'c3', stop: { status: 200, ok: true, body: {} } },
      { phase: 'cancel', key: 'notCancelled', workflow: 'W', executionId: 'c4', stop: { status: 200, ok: true, body: {} } },
      { phase: 'cancel', key: 'refused', workflow: 'W', executionId: 'c5', stop: { status: 500, ok: false, body: ended } },
      { phase: 'cancel', key: 'lost', workflow: 'W', executionId: 'c6', stop: { status: 500, ok: false, body: ended } },
      // A 500 for any other reason, on a run that then completes, is not "ended first".
      { phase: 'cancel', key: 'other', workflow: 'W', executionId: 'c10', stop: { status: 500, ok: false, body: { message: 'Internal Server Error' } } },
    ];
    const a = accountCancels(caps, new Map([left, notCancelled, refused, lost, other].map((e) => [e.id, e])), []);
    expect(a.accepted).toBe(2);
    expect(a.endedFirst).toBe(1);
    expect(a.broken.map((b) => b.split(':')[0])).toEqual(['left', 'notCancelled', 'refused', 'other']);
  });
});

describe('compare-v2-live: the report', () => {
  const body = (tag: string, sink: string) => `{"tag":"${tag}","sink":"${sink}"}`;
  const runAt = (leg: string, i: number, sink: 'A' | 'B', reusedFalseAtA = false) => {
    const id = `${leg}-${i}`;
    const tag = `wh-two-000${i}`;
    const e = twoSinks(id, tag);
    const head = ['h', 'e'].map((n, k) => settlement(id, n, [call('decideSuccessors', 1, { queue: n === 'h' ? 1 : 2, skip: 0 })], { t0: k, t1: k + 0.5 }));
    const records: SettlementRecord[] = [...head, ...(sink === 'A'
      ? [settlement(id, 'a', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 2, true)], { t0: 10, t1: 11, ended: ended('a', 'Sink A') }),
         settlement(id, 'b', [], { t0: 20, t1: 21, executionStatus: 'completed' })]
      : [settlement(id, 'a', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', reusedFalseAtA ? 0 : 2, false)], { t0: 10, t1: 11 }),
         settlement(id, 'b', [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, true)], { t0: 20, t1: 21, ended: ended('b', 'Sink B') })])];
    return { capture: webhookCapture(`two.${i}`, tag, body(tag, sink)), e, records };
  };
  const leg = (label: string, runs: ReturnType<typeof runAt>[], extra: LedgerRecord[] = []) =>
    liveLeg(label, runs.map((r) => r.capture), runs.map((r) => r.e), [...runs.flatMap((r) => r.records), ...extra]);

  it('attributes a moved ending to row 39 against a constant pool, as a note and not a finding', () => {
    const off = leg('off', [runAt('o', 1, 'A'), runAt('o', 2, 'A')]);
    const primary = leg('primary', [runAt('p', 1, 'B', true), runAt('p', 2, 'A')]);
    const { summary } = compareLive([off, primary]);
    expect(summary.findings).toEqual([]);
    expect(summary.notes.filter((n) => n.includes('row 39')).length).toBe(2); // lastStep and the HTTP body
    expect(summary.phases[0]!.legs['primary']!.row39).toBe(1);
  });

  it('notes an earlier ending on a reused true against a constant pool, as n8n\'s ending on that interleaving', () => {
    // The review's reproduction: off constant at sink B; a primary run ends at sink A, whose settlement
    // read B already completed and whose reused isFinished said true.
    const off = leg('off', [runAt('o', 1, 'B'), runAt('o', 2, 'B')]);
    const p = runAt('p', 1, 'A');
    const reusedAtA = { ...p, records: p.records.map((r) => (r.step?.nodeId === 'a' ? { ...r, policy: [call('decideSuccessors', 1, { queue: 0, skip: 0 }), call('isFinished', 0, true)] } : r)) };
    const { summary } = compareLive([off, leg('primary', [reusedAtA, runAt('p', 2, 'B')])]);
    expect(summary.findings).toEqual([]);
    expect(summary.notes.filter((n) => n.includes("n8n's default ends this interleaving here too")).length).toBe(2);
    expect(summary.phases[0]!.legs['primary']!.endings).toMatchObject({ 'n8n ends here too': 2, 'row 39': 0, unaccounted: 0, reusedTrue: 2 });
  });

  it('finds the difference when the ending is unaccounted, and a body that is not the ending step\'s', () => {
    const off = leg('off', [runAt('o', 1, 'A'), runAt('o', 2, 'A')]);
    const p = runAt('p', 1, 'B', false);
    // Sink B's settlement ends the run without an isFinished that said true.
    const unaccounted = { ...p, records: p.records.map((r) => (r.step?.nodeId === 'b' ? { ...r, policy: [call('decideSuccessors', 1, { queue: 0, skip: 0 })] } : r)) };
    const findings = compareLive([off, leg('primary', [unaccounted])]).summary.findings;
    expect(findings.map((f) => f.split(': ')[1]!.split(' ')[0])).toEqual(['ending', 'lastStep', 'httpBody']);
    const q = runAt('p', 2, 'A');
    const wrongBody = { ...q, capture: { ...q.capture, http: http('{"tag":"wh-two-0002","sink":"B"}') } };
    const bodyFindings = compareLive([off, leg('primary', [wrongBody])]).summary.findings;
    expect(bodyFindings.some((f) => f.includes("not the ending step's first output item"))).toBe(true);
    expect(bodyFindings.some((f) => f.includes('httpBody differs'))).toBe(true);
  });

  it('notes an ending off the pool in a leg where n8n\'s default answers, as its own variation', () => {
    const off = leg('off', [runAt('o', 1, 'A'), runAt('o', 2, 'A')]);
    const shadow = leg('shadow', [runAt('s', 1, 'B', false)]);
    const { summary } = compareLive([off, shadow]);
    expect(summary.findings).toEqual([]);
    expect(summary.notes.filter((n) => n.includes('its own interleaving')).length).toBe(2);
  });

  it('reports a field the pool varies on as a distribution, not a finding', () => {
    const off = leg('off', [runAt('o', 1, 'A'), runAt('o', 2, 'B')]);
    const primary = leg('primary', [runAt('p', 1, 'B', false), runAt('p', 2, 'B', false)]);
    const { summary } = compareLive([off, primary]);
    expect(summary.findings).toEqual([]);
    const d = summary.phases[0]!.distributions.find((x) => x.field === 'lastStep');
    expect(d?.byLeg['primary']).toEqual({ '"completed Sink B@0 completed"': 2 });
  });

  it('finds a disagreement, a policy error, a crossed snapshot and an execution left running', () => {
    const off = leg('off', [runAt('o', 1, 'A')]);
    const r = runAt('p', 1, 'A');
    const running = { ...r, e: { ...r.e, status: 'running' } };
    const crossed = settlement('p-1', 'e', [call('decideSuccessors', 1), call('isFinished', 0)], { snapshots: [{ method: 'decideSuccessors', event: 'stored', token: 2 }, { method: 'isFinished', event: 'reused', token: 1 }], step: { nodeId: 'e', iteration: 0, status: 'completed' } });
    const extra: LedgerRecord[] = [
      crossed,
      { kind: 'shadow', report: { method: 'decideSuccessors', executionId: 'p-1', verdict: 'disagree', race: null, skew: false, primaryMs: 1, candidateMs: 1, primaryReads: 1, candidateReads: 1 } },
      { kind: 'error', executionId: 'p-1', name: 'CodecError', error: 'x', method: 'decideSuccessors' },
    ];
    const findings = compareLive([off, leg('primary', [running], extra)]).summary.findings.join('\n');
    expect(findings).toContain('shadow disagreements (F2)');
    expect(findings).toContain('CodecError: x (F6 reading)');
    expect(findings).toContain('crossed from another handler (binding B)');
    expect(findings).toContain('F3: webhook / primary');
  });
});

describe('compare-v2: the sequential report keeps to its own executions', () => {
  it('drops ledger records about executions outside sql.json, and keeps process-wide ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compare-v2-'));
    try {
      mkdirSync(join(dir, 'runs'));
      writeFileSync(join(dir, 'sql.json'), JSON.stringify({ executions: [exec('mine', 'completed', [step('h', 'completed')])] }));
      writeFileSync(join(dir, 'runs', 'w.1.json'), JSON.stringify({ workflow: 'W', executionId: 'mine', elapsedMs: 1, execution: { status: 'success' } }));
      const lines: LedgerRecord[] = [
        { kind: 'registered', mode: 'primary' },
        settlement('mine', 'h', [call('decideSuccessors', 1)]),
        settlement('theirs', 'h', [call('decideSuccessors', 1)]),
        { kind: 'race', executionId: 'theirs', race: 'cancel', method: 'decideSuccessors' },
        { kind: 'shadow', report: { method: 'isFinished', executionId: 'theirs', verdict: 'agree', race: null, skew: false, primaryMs: 1, candidateMs: 1, primaryReads: 1, candidateReads: 1 } },
      ];
      writeFileSync(join(dir, 'settlement.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
      const kept = loadLeg(dir, 'primary').ledger;
      expect(kept.map((r) => `${r.kind}:${executionOf(r) ?? '-'}`)).toEqual(['registered:-', 'settlement:mine']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
