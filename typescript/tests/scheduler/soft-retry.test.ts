/**
 * The soft-failure re-run under an `onFailure` chain (ADR 0009), driven through `FakeHost`.
 *
 * A soft failure — an error item on output 0 (`stack-scheduler.ts:98-100`) — takes the chain's
 * retry step with `softRetry` set, so the next attempt is n8n's inner `while` loop: a bare
 * `runNode` with none of the per-entry preamble. It is still an attempt of the chain, with the
 * chain's deadline: one that overruns it is abandoned (IO-013), and its late completion must
 * write nothing to n8n.
 */
import { callsOf, dataOf, execute, items, ranNodes, sleep, transitionsStarted } from './support.js';
import { conn, node, workflow } from '../fixtures/workflows.js';
import type { ExecutionPolicy, WorkflowDescription } from '../../src/compiler/index.js';

const START = items({ n: 1 });
/** A soft failure: the run succeeds, with an error item first on output 0. */
const SOFT = { data: [[{ json: { error: 'soft' } }]] };

/** Trigger → A(if) → Ok | Fallback, with the policy on `A`. */
function chained(policy: ExecutionPolicy): WorkflowDescription {
  return workflow('soft-chained', [
    node('Trigger', 'trigger', [0, 0]),
    node('A', 'if', [200, 0], { executionPolicy: policy }),
    node('Ok', 'set', [400, 0]),
    node('Fallback', 'set', [400, 100]),
  ], [
    conn('Trigger', 0, 'A', 0), conn('A', 0, 'Ok', 0), conn('A', 1, 'Fallback', 0),
  ], 'Trigger');
}

const count = (calls: readonly string[], call: string): number => calls.filter((c) => c === call).length;

describe('a soft-failure re-run abandoned at its deadline', () => {
  it('writes nothing to n8n when it resolves after the deadline', async () => {
    let resolvedLate = false;
    const r = await execute(chained({
      timeoutMs: 40,
      onFailure: [{ action: 'retry', waitMs: 0 }, { action: 'stop' }],
    }), {
      A: async ({ call }) => {
        if (call === 0) return SOFT;
        await sleep(300);
        resolvedLate = true;
        return { data: [items({ late: true })] };
      },
    }, { startItems: START });
    // The soft failure took the retry step; the re-run overran and the funnel escalated it.
    expect(transitionsStarted(r.store, (n) => n === 'id:A/timeout_2')).toHaveLength(1);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A']);
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.A![0]!.executionStatus).toBe('error');

    // Let the abandoned re-run resolve, then check it changed nothing.
    await sleep(350);
    expect(resolvedLate).toBe(true);
    const a = callsOf(r.calls, 'A');
    // Its output is never processed, and the one task and the one `nodeExecuteAfter` are the
    // escalated failure's, which the terminal step recorded.
    expect(count(a, 'processNodeOutput(A)')).toBe(0);
    expect(count(a, 'upsertTaskData(A)')).toBe(1);
    expect(count(a, 'hook:nodeExecuteAfter(A)')).toBe(1);
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.A![0]!.executionStatus).toBe('error');
    expect(r.scheduler.diagnostics).toContain(
      "node 'A': attempt 2 finished after its deadline abandoned it; the late result is discarded and nothing is recorded for it");
  });
});

describe('a soft-failure re-run is an attempt of the chain', () => {
  /**
   * The same policy two ways: n8n's `retryOnFail` with three tries, and the all-`retry` chain
   * that ends in `stop`. A chain is a generalisation of the knob, so where the two say the same
   * thing a soft failure must be handled the same by both — the re-run is the chain's next
   * attempt, not a run outside it.
   */
  const asRetryOnFail = workflow('soft-twin-retry', [
    node('Trigger', 'trigger', [0, 0]),
    node('A', 'if', [200, 0], { retryOnFail: true, maxTries: 3, waitBetweenTries: 10 }),
    node('Ok', 'set', [400, 0]),
    node('Fallback', 'set', [400, 100]),
  ], [conn('Trigger', 0, 'A', 0), conn('A', 0, 'Ok', 0), conn('A', 1, 'Fallback', 0)], 'Trigger');
  const asChain = chained({ onFailure: [
    { action: 'retry', waitMs: 10 }, { action: 'retry', waitMs: 10 }, { action: 'stop' },
  ] });

  it('a throw after a soft failure takes the next retry step', async () => {
    const script = ({ call }: { call: number }) => {
      if (call === 0) return SOFT;
      if (call === 1) throw new Error('then it threw');
      return { data: [items({ ok: true })] };
    };
    const twin = await execute(asRetryOnFail, { A: script }, { startItems: START });
    const r = await execute(asChain, { A: script }, { startItems: START });
    // Three attempts and a recorded success; before, the re-run's throw bypassed the chain and
    // went straight to the node's own `onError`, halting after two.
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'A', 'Ok']);
    expect(r.scheduler.outcome).toBe('completed');
    expect(r.runData.A![0]!.executionStatus).toBe('success');
    expect(ranNodes(r.calls)).toEqual(ranNodes(twin.calls));
    expect(dataOf(r.runData)).toEqual(dataOf(twin.runData));
  });

  it('a soft failure on every attempt spends the whole chain', async () => {
    const script = () => SOFT;
    const twin = await execute(asRetryOnFail, { A: script }, { startItems: START });
    const r = await execute(asChain, { A: script }, { startItems: START });
    // Three runs, then the last soft failure is processed as a regular output, as n8n does when
    // it leaves the inner loop with the tries used up; before, the chain stopped after two.
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'A', 'Ok']);
    expect(ranNodes(r.calls)).toEqual(ranNodes(twin.calls));
    expect(dataOf(r.runData)).toEqual(dataOf(twin.runData));
    expect(r.scheduler.outcome).toBe(twin.scheduler.outcome);
  });
});
