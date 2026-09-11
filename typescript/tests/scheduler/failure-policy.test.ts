/**
 * An `onFailure` chain driven through `FakeHost`, the mirror of `WorkflowExecute` at n8n
 * `441970b` (ADR 0009).
 *
 * The retry suite beside this one is the baseline: `retryOnFail` is the all-`retry` chain, and
 * the first case here is deliberately its twin so the two can be read together. What the chain
 * adds is a *chosen* terminal, a delay per attempt, a deadline — and an allowance that is per
 * activation, which `X/tries` is not.
 */
import type { ITaskData } from 'n8n-workflow';
import {
  callsOf, execute, items, ranNodes, sleep, transitionsStarted,
} from './support.js';
import { comparableTask } from '../../src/conformance/differ.js';
import { conn, continueErrorOutput, multiProducer, node, workflow } from '../fixtures/workflows.js';
import type { ExecutionPolicy, WorkflowDescription } from '../../src/compiler/index.js';

const START = items({ n: 1 });

/** Trigger → A(if) → Ok | Fallback, with the policy on `A`. */
function chained(policy: ExecutionPolicy): WorkflowDescription {
  return workflow('chained', [
    node('Trigger', 'trigger', [0, 0]),
    node('A', 'if', [200, 0], { executionPolicy: policy }),
    node('Ok', 'set', [400, 0]),
    node('Fallback', 'set', [400, 100]),
  ], [
    conn('Trigger', 0, 'A', 0), conn('A', 0, 'Ok', 0), conn('A', 1, 'Fallback', 0),
  ], 'Trigger');
}

const RETRY_TWICE_THEN: ExecutionPolicy['onFailure'] = [
  { action: 'retry', waitMs: 0 },
  { action: 'retry', waitMs: 0 },
];

describe('the chain runs the node once per attempt', () => {
  it('failing twice then succeeding: three runNode calls, one task recorded as success', async () => {
    // The twin of `retryOnFail`'s first case, and it must read the same: one
    // `nodeExecuteBefore`, one `createTaskStartedData` (the executionIndex is assigned once),
    // two reported errors, one `nodeExecuteAfter`, one recorded run.
    const r = await execute(chained({ onFailure: [...RETRY_TWICE_THEN, { action: 'stop' }] }), {
      A: ({ call }) => { if (call < 2) throw new Error(`boom ${call}`); return { data: [items({ ok: true })] }; },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'A', 'Ok']);
    const a = callsOf(r.calls, 'A');
    expect(a.filter((c) => c === 'hook:nodeExecuteBefore(A)')).toHaveLength(1);
    expect(a.filter((c) => c === 'createTaskStartedData(A)')).toHaveLength(1);
    expect(a.filter((c) => c === 'reportNodeExecutionError(A)')).toHaveLength(2);
    expect(a.filter((c) => c === 'hook:nodeExecuteAfter(A)')).toHaveLength(1);
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.A![0]!.executionStatus).toBe('success');
    expect(r.scheduler.executionError).toBeUndefined();
    // Attempt 1 is `X_run`; attempts 2 and 3 are their own transitions.
    expect(transitionsStarted(r.store, (n) => n === 'id:A/run')).toHaveLength(1);
    expect(transitionsStarted(r.store, (n) => n === 'id:A/run_2')).toHaveLength(1);
    expect(transitionsStarted(r.store, (n) => n === 'id:A/run_3')).toHaveLength(1);
  });

  it('honours a different delay per attempt', async () => {
    const stamps: number[] = [];
    const r = await execute(chained({
      onFailure: [{ action: 'retry', waitMs: 0 }, { action: 'retry', waitMs: 120 }, { action: 'stop' }],
    }), {
      A: ({ call }) => { stamps.push(performance.now()); if (call < 2) throw new Error('again'); return { data: [items(1)] }; },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(stamps).toHaveLength(3);
    // The first escalation is immediate, the second waits — which one uniform `waitBetweenTries`
    // cannot express.
    //
    // Both assertions are *lower* bounds or relative, deliberately. `setTimeout` never fires
    // early, so "the 120 ms delay was honoured" is safe to assert directly; "the first was
    // immediate" is not, because an upper bound on elapsed time is an assertion about the
    // machine rather than about the scheduler. The claim the test exists for — the two delays
    // differ — is the comparison, and it holds without bounding either one absolutely.
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(110);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThan(stamps[1]! - stamps[0]!);
  });
});

describe('the terminal step is the node error policy', () => {
  it("'stop' halts the execution and sets executionError", async () => {
    const r = await execute(chained({ onFailure: [...RETRY_TWICE_THEN, { action: 'stop' }] }), {
      A: ({ call }) => { throw new Error(`always ${call}`); },
    }, { startItems: START });
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'A']);
    expect(r.scheduler.executionError?.message).toBe('always 2');
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.runData.Ok).toBeUndefined();
    expect(r.runData.Fallback).toBeUndefined();
  });

  it("'route' sends the failure down the named output and the execution continues", async () => {
    const r = await execute(chained({
      onFailure: [{ action: 'retry', waitMs: 0 }, { action: 'route', output: 'false' }],
    }), {
      A: () => { throw new Error('down'); },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    // Two attempts, then the fallback branch — and `Ok` is never reached.
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'Fallback']);
    expect(r.runData.Fallback).toHaveLength(1);
    expect(r.runData.Ok).toBeUndefined();
    expect(r.scheduler.outcome).toBe('completed');
  });

  it("'continue' carries on down output 0", async () => {
    const r = await execute(chained({
      onFailure: [{ action: 'retry', waitMs: 0 }, { action: 'continue' }],
    }), {
      A: () => { throw new Error('down'); },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'Ok']);
    expect(r.runData.Ok).toHaveLength(1);
    expect(r.runData.Fallback).toBeUndefined();
  });
});

describe('the per-attempt deadline', () => {
  it('abandons an overrunning attempt, escalates, and records nothing for the late result', async () => {
    // The node keeps working — IO-013 does not cancel it — so the assertion that matters is
    // that its late completion writes nothing: `runData.A` holds the escalated failure, not a
    // success the net had already moved past.
    let resolvedLate = false;
    const r = await execute(chained({
      timeoutMs: 40,
      onFailure: [{ action: 'retry', waitMs: 0 }, { action: 'stop' }],
    }), {
      A: async ({ call }) => {
        if (call === 0) { await sleep(300); resolvedLate = true; return { data: [items({ late: true })] }; }
        throw new Error('second attempt failed too');
      },
    }, { startItems: START });
    expect(transitionsStarted(r.store, (n) => n === 'id:A/timeout_1')).toHaveLength(1);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A']);
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.A![0]!.executionStatus).toBe('error');
    // Let the abandoned action finish and confirm it changed nothing.
    await sleep(350);
    expect(resolvedLate).toBe(true);
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.A![0]!.executionStatus).toBe('error');
  });

  it('a deadline that is not reached costs nothing', async () => {
    const r = await execute(chained({ timeoutMs: 500, onFailure: [{ action: 'stop' }] }), {
      A: () => ({ data: [items({ ok: true })] }),
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(transitionsStarted(r.store, (n) => n === 'id:A/timeout_1')).toHaveLength(0);
    expect(r.runData.A![0]!.executionStatus).toBe('success');
    expect(r.runData.Ok).toHaveLength(1);
  });
});

describe('the error output catches a thrown failure as well as a per-item one', () => {
  /** `continueErrorOutput` fixture: Trigger -> A; A.0 -> B, A.1 (the appended error output) -> Err. */
  const throws = () => { throw new Error('blew up'); };

  it('n8n sends a thrown failure down output 0, which is the baseline to compare against', async () => {
    // n8n's error output is for *per-item* errors: `handleNodeErrorOutput` sorts them out of an
    // otherwise successful run, so a node that throws outright is continued down output 0 with
    // its input passed through, and the error branch does not fire.
    const r = await execute(continueErrorOutput, { A: throws }, { startItems: START });
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B']);
    expect(r.runData.Err).toBeUndefined();
  });

  it('a chain routes the same failure to the error output, with the error as data', async () => {
    // `onError` declares the port — `NodeHelpers.getNodeOutputs` appends it on that field alone,
    // which is what makes the editor draw the arc — and `onFailure` decides when a failure takes
    // it. Same workflow, same wiring, one added policy.
    const wf = {
      ...continueErrorOutput,
      nodes: continueErrorOutput.nodes.map((n) => n.name === 'A'
        ? { ...n, executionPolicy: { onFailure: [
            { action: 'retry' as const, waitMs: 0 },
            { action: 'route' as const, output: 'error' },
          ] } }
        : n),
    };
    const r = await execute(wf, { A: throws }, { startItems: START });
    expect(r.error).toBeUndefined();
    // Two attempts, then the error branch — and `B`, the success branch, never runs.
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'Err']);
    expect(r.runData.B).toBeUndefined();
    expect(r.runData.Err).toHaveLength(1);
    expect(r.runData.Err![0]!.data!.main![0]![0]!.json['error']).toBe('blew up');
    expect(r.scheduler.outcome).toBe('completed');
  });

  it('a deadline reaches the error output too', async () => {
    const wf = {
      ...continueErrorOutput,
      nodes: continueErrorOutput.nodes.map((n) => n.name === 'A'
        ? { ...n, executionPolicy: { timeoutMs: 40, onFailure: [
            { action: 'route' as const, output: 'error' },
          ] } }
        : n),
    };
    const r = await execute(wf, { A: async () => { await sleep(300); return { data: [items(1)] }; } },
      { startItems: START });
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'Err']);
    expect(r.runData.Err![0]!.data!.main![0]![0]!.json['error']).toBe('did not finish within 40 ms');
  });
});

describe('a uniform chain is n8n retryOnFail, expressed twice', () => {
  /** Trigger -> A -> B, with `A` retrying twice on the same delay and then giving up. */
  const asRetryOnFail = workflow('twin-retry', [
    node('Trigger', 'trigger', [0, 0]),
    node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 3, waitBetweenTries: 10 }),
    node('B', 'set', [400, 0]),
  ], [conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0)], 'Trigger');

  const asChain = workflow('twin-chain', [
    node('Trigger', 'trigger', [0, 0]),
    node('A', 'set', [200, 0], { executionPolicy: { onFailure: [
      { action: 'retry', waitMs: 10 }, { action: 'retry', waitMs: 10 }, { action: 'stop' },
    ] } }),
    node('B', 'set', [400, 0]),
  ], [conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0)], 'Trigger');

  /** `runData` minus the clocks and the ordering index — the differ's own projection. */
  const dataOf = (runData: Record<string, ITaskData[] | undefined>): unknown =>
    Object.fromEntries(Object.entries(runData).map(([name, tasks]) =>
      [name, (tasks ?? []).map(comparableTask)]));

  it.each([
    ['recovering on the third attempt', ({ call }: { call: number }) => {
      if (call < 2) throw new Error('twin boom');
      return { data: [items({ ok: true })] };
    }],
    ['never recovering', () => { throw new Error('twin boom'); }],
  ])('produces the same run data as retryOnFail: %s', async (_what, script) => {
    // The claim the chain has to earn: it is a *generalisation* of n8n's knob, so where the two
    // express the same policy they must be indistinguishable in what they record — not merely
    // in how many times the node ran.
    const a = await execute(asRetryOnFail, { A: script }, { startItems: START });
    const b = await execute(asChain, { A: script }, { startItems: START });
    expect(ranNodes(b.calls)).toEqual(ranNodes(a.calls));
    expect(dataOf(b.runData)).toEqual(dataOf(a.runData));
    expect(b.scheduler.outcome).toBe(a.scheduler.outcome);
    expect(b.scheduler.executionError?.message).toBe(a.scheduler.executionError?.message);
  });
});

describe('the allowance is per activation, where retryOnFail spends it per execution', () => {
  /**
   * `C` runs twice (both `A` and `B` feed it). Each activation fails twice and succeeds on its
   * third attempt, so a per-activation allowance of three spends exactly six calls.
   */
  const failTwicePerActivation = () => {
    let call = 0;
    return () => {
      const within = call++ % 3;
      if (within < 2) throw new Error(`failure ${within + 1} of this activation`);
      return { data: [items({ ok: true })] };
    };
  };

  it('retryOnFail: the second activation inherits what the first left (the finding)', async () => {
    // `X/tries` is seeded once per execution and refunded by nothing, so the first activation's
    // two failures leave one try for the second — where n8n re-reads `getRetryParams` per
    // activation and would give it three. Recorded so the chain's behaviour below reads as a
    // fix rather than as a preference.
    const wf = {
      ...multiProducer,
      nodes: multiProducer.nodes.map((n) => n.name === 'C'
        ? { ...n, retryOnFail: true, maxTries: 3, waitBetweenTries: 0 }
        : n),
    };
    const r = await execute(wf, { C: failTwicePerActivation() }, { startItems: START });
    // Four, not six: the first activation spends both retry tokens and succeeds on its third
    // call; the second has none left, exhausts on its first failure, and halts the execution.
    expect(ranNodes(r.calls).filter((n) => n === 'C')).toHaveLength(4);
    expect(r.scheduler.outcome).toBe('halted');
  });

  it('onFailure: each activation gets the whole chain', async () => {
    const wf = {
      ...multiProducer,
      nodes: multiProducer.nodes.map((n) => n.name === 'C'
        ? { ...n, executionPolicy: { onFailure: [...RETRY_TWICE_THEN, { action: 'stop' } as const] } }
        : n),
    };
    const r = await execute(wf, { C: failTwicePerActivation() }, { startItems: START });
    expect(r.error).toBeUndefined();
    // Three attempts for each of the two activations, both succeeding on their third.
    expect(ranNodes(r.calls).filter((n) => n === 'C')).toHaveLength(6);
    expect(r.runData.C).toHaveLength(2);
    expect(r.runData.C!.every((t) => t.executionStatus === 'success')).toBe(true);
    expect(r.scheduler.outcome).toBe('completed');
  });
});
