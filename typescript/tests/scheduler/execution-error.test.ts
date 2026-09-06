/**
 * The `WorkflowScheduler` contract value `executionError` (patch 0001: "the error of the node
 * that stopped the execution"), which `processRunExecutionData` reads after `run()` resolves
 * (`workflow-execute.ts:2250-2255`) to decide whether the execution is persisted as a success
 * or as a failure.
 *
 * n8n keeps it in one field (`stack-scheduler.ts:29`) that is cleared at the top of every
 * loop iteration (line 56) and at the top of every retry (line 107), which is safe only
 * because exactly one node is in flight and the loop `break`s on the halting one. Above
 * k = 1 both of those clears belong to *another* activation, so the scheduler keeps two
 * values instead:
 *
 * - `haltError` — written once, by the activation whose failure ended the execution;
 * - `leftoverError` — what n8n's per-iteration field still held when the last activation to
 *   *complete* finished (an error it continued past), overwritten by every completion.
 *
 * `executionError` is `haltError ?? leftoverError`. At k = 1 completion order is n8n's
 * iteration order, so the value is byte-identical; above k = 1 the halt can no longer be
 * lost to a sibling, and the leftover follows completion order (divergence #19).
 */
import { conn, node, workflow } from '../fixtures/workflows.js';
import { dataOf, execute, items, ranNodes, sleep, type NodeScript } from './support.js';

const START = items({ n: 1 });

/** `Trigger` → `A` (fails fatally at 10 ms) and → `R` (retries; its first try throws at 30 ms). */
const haltVsRetry = workflow('halt-vs-retry', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0]),
  node('R', 'set', [200, 100], { retryOnFail: true, maxTries: 3, waitBetweenTries: 1 }),
], [conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'R', 0)], 'Trigger');

const haltVsRetryScripts: Record<string, NodeScript> = {
  A: async () => { await sleep(10); throw new Error('A failed'); },
  R: async () => { await sleep(30); throw new Error('R failed'); },
};

/** `Trigger` → `A` (continues past its own error at 2 ms) and → `B` (succeeds at 20 ms). */
const continueVsSuccess = workflow('continue-vs-success', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0], { onError: 'continueRegularOutput' }),
  node('B', 'set', [200, 100]),
], [conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0)], 'Trigger');

const continueVsSuccessScripts: Record<string, NodeScript> = {
  A: async () => { await sleep(2); throw new Error('A boom'); },
  B: async () => { await sleep(20); return { data: [items({ b: 1 })] }; },
};

describe('the halt error is never lost to a sibling activation', () => {
  it('k = 1: the failing node halts and its error is the contract value', async () => {
    const r = await execute(haltVsRetry, haltVsRetryScripts, { startItems: START, budget: 1 });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.scheduler.executionError?.message).toBe('A failed');
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A']); // R never started: the halt got there first
  });

  for (const budget of [2, 4]) {
    it(`k = ${budget}: a sibling that fails and retries after the halt does not clear it`, async () => {
      // Pre-fix this returned `undefined`: `R`'s catch and `retryOutcome` wrote the shared
      // slot at 30 ms, after `A`'s halt at 10 ms, so `processSuccessExecution` would have
      // persisted a halted execution as `finished: true`, `status: 'success'`.
      const r = await execute(haltVsRetry, haltVsRetryScripts, { startItems: START, budget });
      expect(r.error).toBeUndefined();
      expect(r.scheduler.outcome).toBe('halted');
      expect(r.scheduler.executionError?.message).toBe('A failed');
      expect(r.runData.A![0]!.executionStatus).toBe('error');
    });
  }
});

describe('the leftover error follows completion order, as n8n\'s per-iteration clear does', () => {
  it('k = 1: a node that continued past its own error, then a node that succeeded — no error left', async () => {
    const r = await execute(continueVsSuccess, continueVsSuccessScripts, { startItems: START, budget: 1 });
    expect(r.scheduler.outcome).toBe('completed');
    expect(r.runData.A![0]!.executionStatus).toBe('error');
    expect(r.scheduler.executionError).toBeUndefined();
  });

  for (const budget of [2, 4]) {
    it(`k = ${budget}: the same, with both nodes in flight at once`, async () => {
      // Pre-fix this returned `A boom`: `B`'s `attempt` cleared the slot at 0 ms, before `A`
      // wrote it at 2 ms, so a fully successful execution was reported as failed.
      const r = await execute(continueVsSuccess, continueVsSuccessScripts, { startItems: START, budget });
      expect(r.scheduler.outcome).toBe('completed');
      expect(r.scheduler.executionError).toBeUndefined();
      expect(dataOf(r.runData))
        .toEqual(dataOf((await execute(continueVsSuccess, continueVsSuccessScripts, { startItems: START, budget: 1 })).runData));
    });
  }

  it('a continued error on the last node to complete survives, at k = 1 and above', async () => {
    // n8n's field is only cleared by the *next* iteration, so a node that continues past its
    // error and is the last thing the loop runs leaves the execution reported as failed.
    const wf = workflow('continue-last', [
      node('Trigger', 'trigger', [0, 0]),
      node('B', 'set', [200, 0]),
      node('A', 'set', [400, 0], { onError: 'continueRegularOutput' }),
    ], [conn('Trigger', 0, 'B', 0), conn('B', 0, 'A', 0)], 'Trigger');
    const scripts: Record<string, NodeScript> = { A: () => { throw new Error('A boom'); } };
    for (const budget of [1, 2]) {
      const r = await execute(wf, scripts, { startItems: START, budget });
      expect(`k=${budget}: ${r.scheduler.executionError?.message}`).toBe(`k=${budget}: A boom`);
      expect(r.scheduler.outcome).toBe('completed');
    }
  });
});
