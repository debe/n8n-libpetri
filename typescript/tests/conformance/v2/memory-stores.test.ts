/**
 * The in-memory stores of leg (d) (`src/conformance/v2/memory-stores.ts`, `tasks/v2-seam-plan.md`
 * step 8) on their own, with no `.n8n`. The semantics are ours, written to follow the TypeORM
 * stores at the pin; these cases pin each one the module doc states, so the handler leg's result
 * rests on stated behaviour and not on whatever the stores happened to do.
 */
import { describe, expect, it } from 'vitest';
import { MemoryExecutionStore, MemoryStepStore } from '../../../src/conformance/v2/memory-stores.js';

const X = 'execution-1';

async function seeded(): Promise<{ steps: MemoryStepStore; t: string }> {
  const steps = new MemoryStepStore();
  const [t] = await steps.createSteps(X, [{ nodeId: 'T', iteration: 0, status: 'completed', outputs: [[{ a: 1 }], null] }]);
  return { steps, t: t!.id };
}

describe('MemoryStepStore: createSteps', () => {
  it('inserts a key once: an existing key and a repeat in the same batch are skipped and not returned', async () => {
    const { steps } = await seeded();
    const created = await steps.createSteps(X, [
      { nodeId: 'A', iteration: 0, status: 'queued' },
      { nodeId: 'T', iteration: 0, status: 'skipped' },
      { nodeId: 'B', iteration: 0, status: 'skipped' },
      { nodeId: 'A', iteration: 0, status: 'skipped' },
      { nodeId: 'A', iteration: 1, status: 'queued' },
    ]);
    expect(created.map((c) => `${c.nodeId}@${c.iteration}`)).toEqual(['A@0', 'B@0', 'A@1']);
    const rows = steps.snapshot(X);
    expect(rows.map((r) => `${r.nodeId}@${r.iteration}=${r.status}`)).toEqual(['T@0=completed', 'A@0=queued', 'B@0=skipped', 'A@1=queued']);
  });

  it('keys are per execution', async () => {
    const { steps } = await seeded();
    expect(await steps.createSteps('execution-2', [{ nodeId: 'T', iteration: 0, status: 'queued' }])).toHaveLength(1);
  });

  it('creates nothing once a row of the execution has failed, and still creates for another execution', async () => {
    const { steps } = await seeded();
    const [a] = await steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'queued' }]);
    expect(await steps.claimStep(a!.id)).not.toBeNull();
    expect(await steps.failStep(a!.id, { name: 'Error', message: 'boom' })).toBe(true);
    expect(await steps.createSteps(X, [{ nodeId: 'B', iteration: 0, status: 'queued' }])).toEqual([]);
    expect(steps.snapshot(X)).toHaveLength(2);
    expect(await steps.createSteps('execution-2', [{ nodeId: 'B', iteration: 0, status: 'queued' }])).toHaveLength(1);
  });

  it('refuses a creation status it does not allow, and a completed row without a slot list', async () => {
    const steps = new MemoryStepStore();
    await expect(steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'failed' as never }])).rejects.toThrow();
    await expect(steps.createSteps(X, [{ nodeId: 'A', iteration: -1, status: 'queued' }])).rejects.toThrow();
    await expect(steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'completed' }])).rejects.toThrow();
    expect(steps.snapshot(X)).toEqual([]);
  });
});

describe('MemoryStepStore: compare-and-set transitions', () => {
  it('claims a queued row once, and completes, fails, suspends or cancels only a running one', async () => {
    const { steps } = await seeded();
    const [a, b, c, d] = await steps.createSteps(X, ['A', 'B', 'C', 'D'].map((nodeId) => ({ nodeId, iteration: 0, status: 'queued' as const })));
    expect(await steps.completeStep(a!.id, [[1]])).toBe(false); // not claimed
    const claimed = await steps.claimStep(a!.id);
    expect(claimed).toMatchObject({ nodeId: 'A', iteration: 0, status: 'running', outputs: null });
    expect(await steps.claimStep(a!.id)).toBeNull(); // a duplicate claim
    expect(await steps.completeStep(a!.id, [[1], null])).toBe(true);
    expect(await steps.completeStep(a!.id, [[2]])).toBe(false); // settled
    expect(await steps.failStep(a!.id, { name: 'E', message: 'm' })).toBe(false);

    await steps.claimStep(b!.id);
    expect(await steps.suspendStep(b!.id, { acceptsResumeRequest: true })).toBe(true);
    expect(await steps.resumeStep(b!.id, { kind: 'request', outputs: [] })).toBe(true);
    expect(await steps.resumeStep(b!.id, { kind: 'request', outputs: [] })).toBe(false); // a doubled resume
    expect((await steps.loadStep(b!.id)).status).toBe('queued');

    await steps.claimStep(c!.id);
    expect(await steps.cancelStep(c!.id)).toBe(true);
    expect(await steps.cancelStep(d!.id)).toBe(false); // queued, not running
  });

  it('refuses every claim once a row of the execution has failed', async () => {
    const { steps } = await seeded();
    const [a, b] = await steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'queued' }, { nodeId: 'B', iteration: 0, status: 'queued' }]);
    await steps.claimStep(a!.id);
    await steps.failStep(a!.id, { name: 'E', message: 'm' });
    expect(await steps.claimStep(b!.id)).toBeNull();
    expect((await steps.loadStep(b!.id)).status).toBe('queued');
  });

  it('cancelPendingSteps cancels queued and waiting rows and leaves running and settled ones', async () => {
    const { steps } = await seeded();
    const [q, w, r] = await steps.createSteps(X, ['Q', 'W', 'R'].map((nodeId) => ({ nodeId, iteration: 0, status: 'queued' as const })));
    await steps.claimStep(w!.id);
    await steps.suspendStep(w!.id, { acceptsResumeRequest: true });
    await steps.claimStep(r!.id);
    await steps.cancelPendingSteps(X);
    const status = Object.fromEntries(steps.snapshot(X).map((s) => [s.nodeId, s.status]));
    expect(status).toEqual({ T: 'completed', Q: 'cancelled', W: 'cancelled', R: 'running' });
    expect(q).toBeDefined();
  });

  it('loadStep throws the given error for an unknown id', async () => {
    class StepNotFound extends Error {}
    const steps = new MemoryStepStore({ stepNotFound: (id) => new StepNotFound(id) });
    await expect(steps.loadStep('nope')).rejects.toBeInstanceOf(StepNotFound);
  });
});

describe('MemoryStepStore: planning reads', () => {
  it('summaries carry filled slots (not JSON null), [] for a row without outputs; absent keys are left out', async () => {
    const { steps } = await seeded();
    await steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'skipped' }]);
    const got = await steps.loadStepSummariesByKeys(X, [{ nodeId: 'T', iteration: 0 }, { nodeId: 'A', iteration: 0 }, { nodeId: 'Z', iteration: 0 }]);
    expect(Object.keys(got).sort()).toEqual(['A@0', 'T@0']);
    expect(got['T@0']!.filledOutputSlots).toEqual([true, false]);
    expect(got['A@0']!.filledOutputSlots).toEqual([]);
    const full = await steps.loadStepsByKeys(X, [{ nodeId: 'T', iteration: 0 }]);
    expect(full['T@0']!.outputs).toEqual([[{ a: 1 }], null]);
  });

  it('loadLatestStepSummaries gives each asked node its highest iteration, keyed by node id', async () => {
    const { steps } = await seeded();
    await steps.createSteps(X, [
      { nodeId: 'L', iteration: 0, status: 'completed', outputs: [null, [1]] },
      { nodeId: 'L', iteration: 2, status: 'completed', outputs: [[1], null] },
      { nodeId: 'L', iteration: 1, status: 'completed', outputs: [null, [1]] },
      { nodeId: 'M', iteration: 0, status: 'queued' },
    ]);
    const got = await steps.loadLatestStepSummaries(X, ['L', 'Q']);
    expect(Object.keys(got)).toEqual(['L']);
    expect(got['L']).toMatchObject({ iteration: 2, filledOutputSlots: [true, false] });
  });

  it('counts completed, failed, skipped and cancelled as settled, and reports a failure', async () => {
    const { steps } = await seeded();
    const [a, b] = await steps.createSteps(X, [
      { nodeId: 'A', iteration: 0, status: 'queued' }, { nodeId: 'B', iteration: 0, status: 'queued' }, { nodeId: 'C', iteration: 0, status: 'skipped' },
    ]);
    expect(await steps.countSettledSteps(X)).toBe(2);
    expect(await steps.hasFailedSteps(X)).toBe(false);
    await steps.claimStep(a!.id);
    await steps.failStep(a!.id, { name: 'E', message: 'm' });
    await steps.cancelPendingSteps(X);
    expect(steps.snapshot(X).find((r) => r.id === b!.id)!.status).toBe('cancelled');
    expect(await steps.countSettledSteps(X)).toBe(4);
    expect(await steps.hasFailedSteps(X)).toBe(true);
  });

  it('the record order of a keyed load follows the seed, and the content does not', async () => {
    const { steps: plain } = await seeded();
    const keys = ['A', 'B', 'C', 'D', 'E', 'F'].map((nodeId) => ({ nodeId, iteration: 0 }));
    await plain.createSteps(X, keys.map((k) => ({ ...k, status: 'skipped' as const })));
    const shuffled = MemoryStepStore.frozen(plain.snapshot(X), { order: 7 });
    const a = await plain.loadStepSummariesByKeys(X, keys);
    const b = await shuffled.loadStepSummariesByKeys(X, keys);
    expect(Object.keys(a)).not.toEqual(Object.keys(b));
    expect(Object.fromEntries(Object.entries(b).sort())).toEqual(Object.fromEntries(Object.entries(a).sort()));
  });
});

describe('MemoryStepStore: what the leg adds', () => {
  it('snapshot and frozen are copies: writes to one store never show in the other', async () => {
    const { steps } = await seeded();
    const [a] = await steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'queued' }]);
    const frozen = MemoryStepStore.frozen(steps.snapshot(X));
    await steps.claimStep(a!.id);
    expect((await frozen.loadStep(a!.id)).status).toBe('queued');
    expect(await frozen.createSteps(X, [{ nodeId: 'B', iteration: 0, status: 'queued' }])).toHaveLength(1);
    expect(steps.snapshot(X).map((r) => r.nodeId)).toEqual(['T', 'A']);
    // a frozen store mints ids after the ones it holds
    expect(frozen.snapshot(X).map((r) => r.id)).toEqual(['s0', 's1', 's2']);
  });

  it('version moves on every write that changed a row, and on nothing else', async () => {
    const { steps } = await seeded();
    const v0 = steps.version;
    await steps.loadStepSummariesByKeys(X, [{ nodeId: 'T', iteration: 0 }]);
    await steps.createSteps(X, [{ nodeId: 'T', iteration: 0, status: 'queued' }]); // deduped
    expect(steps.version).toBe(v0);
    const [a] = await steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'queued' }]);
    await steps.claimStep(a!.id);
    expect(steps.version).toBe(v0 + 2);
  });

  it('onTransition sees every status change with the status before', async () => {
    const { steps } = await seeded();
    const seen: string[] = [];
    steps.onTransition = (row, from) => seen.push(`${row.nodeId}:${from ?? 'new'}->${row.status}`);
    const [a] = await steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'queued' }]);
    await steps.claimStep(a!.id);
    await steps.suspendStep(a!.id, { acceptsResumeRequest: true });
    expect(seen).toEqual(['A:new->queued', 'A:queued->running', 'A:running->waiting']);
  });

  it('yields before each call when asked, so concurrent calls interleave', async () => {
    const steps = new MemoryStepStore({ yieldTicks: () => 2 });
    const order: string[] = [];
    await Promise.all([
      steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'queued' }]).then(() => order.push('create')),
      Promise.resolve().then(() => order.push('sync')),
    ]);
    expect(order).toEqual(['sync', 'create']);
  });
});

describe('MemoryExecutionStore', () => {
  const record = { id: X, status: 'queued' as const, graph: { nodes: [{ id: 'T' }], edges: [] } };

  it('loadExecution hands back a fresh copy every time', async () => {
    const executions = new MemoryExecutionStore(new MemoryStepStore());
    await executions.createExecution(record);
    const a = await executions.loadExecution(X);
    const b = await executions.loadExecution(X);
    expect(a.graph).toEqual(b.graph);
    expect(a.graph).not.toBe(b.graph);
    expect(a.finishedAt).toBeNull();
  });

  it('transitionStatus and finishExecution are compare-and-sets; finish takes only a live execution', async () => {
    const executions = new MemoryExecutionStore(new MemoryStepStore());
    await executions.createExecution(record);
    expect(await executions.finishExecution(X, 'completed')).toBeNull(); // queued is not live
    expect(await executions.transitionStatus(X, 'queued', 'running')).toBe(true);
    expect(await executions.transitionStatus(X, 'queued', 'running')).toBe(false);
    expect(await executions.finishExecution(X, 'failed')).not.toBeNull();
    expect(await executions.finishExecution(X, 'completed')).toBeNull(); // the second writer loses
    expect(executions.statusNow(X)).toBe('failed');
    expect(await executions.cancelExecution(X)).toBeNull();
  });

  it('refreshLiveStatus: running with a queued or running row, waiting with only waiting rows, an ended one untouched', async () => {
    const steps = new MemoryStepStore();
    const executions = new MemoryExecutionStore(steps);
    await executions.createExecution(record);
    await executions.transitionStatus(X, 'queued', 'running');
    const [a] = await steps.createSteps(X, [{ nodeId: 'A', iteration: 0, status: 'queued' }]);
    await steps.claimStep(a!.id);
    await steps.suspendStep(a!.id, { acceptsResumeRequest: true });
    await executions.refreshLiveStatus(X);
    expect(executions.statusNow(X)).toBe('waiting');
    await steps.resumeStep(a!.id, { kind: 'request', outputs: [] });
    await executions.refreshLiveStatus(X);
    expect(executions.statusNow(X)).toBe('running');
    await steps.claimStep(a!.id);
    await steps.completeStep(a!.id, []);
    await executions.refreshLiveStatus(X); // nothing runnable or waiting: left as it is
    expect(executions.statusNow(X)).toBe('running');
    await executions.finishExecution(X, 'completed');
    await steps.createSteps(X, [{ nodeId: 'B', iteration: 0, status: 'queued' }]);
    await executions.refreshLiveStatus(X);
    expect(executions.statusNow(X)).toBe('completed');
  });
});
