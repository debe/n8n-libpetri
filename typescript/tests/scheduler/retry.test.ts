/**
 * retryOnFail on the net: `X_run` emits `X/retry`, the net's `delayed(waitBetweenTries)`
 * `X_retry_wait` replaces n8n's `sleep`, `X_exhausted` resolves the last attempt. Attempt
 * count, wait respected, exhausted path under continueOnFail vs stop, the soft-failure
 * (error item) re-run, and `metadata.resumeError` disabling retries.
 */
import { conn, node, retry as retryFixture, workflow } from '../fixtures/workflows.js';
import { callsOf, execute, items, ranNodes, sleep, transitionsFailed, transitionsStarted, tokensResting,} from './support.js';

const START = items({ n: 1 });

describe('retryOnFail', () => {
  it('a node failing twice then succeeding: three runNode calls, one nodeExecuteBefore, one task recorded as success', async () => {
    const r = await execute(retryFixture, {
      A: ({ call }) => { if (call < 2) throw new Error(`boom ${call}`); return { data: [items({ ok: true })] }; },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'A', 'B']);
    const a = callsOf(r.calls, 'A');
    expect(a.filter((c) => c === 'hook:nodeExecuteBefore(A)')).toHaveLength(1);
    expect(a.filter((c) => c === 'createTaskStartedData(A)')).toHaveLength(1); // executionIndex assigned once
    expect(a.filter((c) => c === 'reportNodeExecutionError(A)')).toHaveLength(2);
    expect(a.filter((c) => c === 'hook:nodeExecuteAfter(A)')).toHaveLength(1);
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.A![0]!.executionStatus).toBe('success');
    expect(r.runData.A![0]!.executionIndex).toBe(1);
    expect(r.runData.B).toHaveLength(1);
    expect(transitionsStarted(r.store, (n) => n === 'id:A/retry_wait')).toHaveLength(2);
    expect(transitionsStarted(r.store, (n) => n === 'id:A/exhausted')).toHaveLength(0);
    expect(r.scheduler.executionError).toBeUndefined();
  });

  it('waitBetweenTries is respected between attempts (delayed transition, TIME-004)', async () => {
    const wf = workflow('retry-wait', [
      node('Trigger', 'trigger', [0, 0]),
      node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 2, waitBetweenTries: 120 }),
    ], [conn('Trigger', 0, 'A', 0)], 'Trigger');
    const stamps: number[] = [];
    const r = await execute(wf, {
      A: ({ call }) => { stamps.push(performance.now()); if (call === 0) throw new Error('once'); return { data: [items(1)] }; },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(stamps).toHaveLength(2);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(110);
  });

  it('exhausted under stopWorkflow: maxTries attempts, then the error halts the execution and sets executionError', async () => {
    const r = await execute(retryFixture, {
      A: ({ call }) => { throw new Error(`always ${call}`); },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'A']); // maxTries 3
    expect(r.scheduler.executionError?.message).toBe('always 2');
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.A![0]!.executionStatus).toBe('error');
    expect(r.runData.B).toBeUndefined();
    // n8n: handleNodeExecutionError upserts, pushes the entry back and runs nodeExecuteAfter.
    expect(callsOf(r.calls, 'A').slice(-4)).toEqual(['handleNodeExecutionError(A)', 'upsertTaskData(A)', 'pushExecutionStack(A)', 'hook:nodeExecuteAfter(A)']);
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['A']);
    expect(transitionsStarted(r.store, (n) => n === 'id:A/exhausted')).toHaveLength(1);
    expect(tokensResting(r.store, '_halt')).toBe(1);
  });

  it('exhausted under continueRegularOutput: the input passes through as output and the successor runs', async () => {
    const wf = workflow('retry-continue', [
      node('Trigger', 'trigger', [0, 0]),
      node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 2, waitBetweenTries: 1, onError: 'continueRegularOutput' }),
      node('B', 'set', [400, 0]),
    ], [conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0)], 'Trigger');
    const r = await execute(wf, { A: () => { throw new Error('nope'); } }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'B']);
    expect(r.runData.A![0]!.executionStatus).toBe('error');
    expect(r.runData.A![0]!.error?.message).toBe('nope');
    // handleNodeExecutionError → nodeSuccessData = [input main[0]]: B receives A's input.
    const bInput = r.host.runNodeCalls.find((c) => c.node === 'B')!.main[0]!;
    expect(bInput[0]!.json).toEqual({ n: 1 });
    expect(r.scheduler.executionError).toBeUndefined(); // reset by B's attempt (line 56), as in n8n
    expect(r.scheduler.outcome).toBe('completed');
  });

  it('a soft failure (error item on output 0) is re-run like n8n\'s inner while loop, then processed as a regular output', async () => {
    const wf = workflow('retry-soft', [
      node('Trigger', 'trigger', [0, 0]),
      node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 2, waitBetweenTries: 1 }),
      node('B', 'set', [400, 0]),
    ], [conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0)], 'Trigger');
    const r = await execute(wf, { A: () => ({ data: [[{ json: { error: 'soft' } }]] }) }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A', 'B']);
    expect(r.runData.A![0]!.executionStatus).toBe('success');
    expect(r.runData.A![0]!.data!.main![0]![0]!.json).toEqual({ error: 'soft' });
    expect(callsOf(r.calls, 'A').filter((c) => c === 'processNodeOutput(A)')).toHaveLength(1);
    expect(transitionsStarted(r.store, (n) => n === 'id:A/exhausted')).toHaveLength(1);
  });

  it('a cancellation between two attempts does not leak the transient error into executionError', async () => {
    // n8n clears `this.executionError` at the top of the next try (line 107) and always
    // reaches it, so a transient failure is never observable outside the retry loop. Here the
    // net can stop between attempts: `executor.close()` means `X_retry_wait` never fires. A
    // leftover error would make `processRunExecutionData` (`workflow-execute.ts:2240`) report
    // the execution as failed instead of canceled.
    const wf = workflow('retry-cancel', [
      node('Trigger', 'trigger', [0, 0]),
      node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 3, waitBetweenTries: 200 }),
      node('B', 'set', [400, 0]),
    ], [conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0)], 'Trigger');
    const r = await execute(wf, { A: () => { throw new Error('transient boom'); } }, {
      startItems: START, during: async (host) => { await sleep(60); host.cancel(); },
    });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('cancelled');
    expect(r.scheduler.executionError).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A']); // the second attempt never started
    expect(r.runData.A).toBeUndefined();
    // The retry token is a pending activation: the attempt re-runs from scratch on resume.
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['A']);
  });

  it('a stop arriving during an attempt does not discard the node: the tries finish, as n8n polls only once per entry', async () => {
    // `shouldStopExecuting()` is line 49, before the try loop; nothing inside the loop
    // re-checks it. Polling per attempt would return the entry unrun after A had already
    // executed once — a side effect done, nothing recorded, and a resume running it again.
    const r = await execute(retryFixture, {
      A: ({ call, host }) => {
        if (call === 0) { host.status = 'canceled'; throw new Error('boom'); }
        return { data: [items({ ok: true })] };
      },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'A']);
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.A![0]!.executionStatus).toBe('success');
    // B's own iteration then returns at line 49 with its entry back on the stack.
    expect(r.calls.filter((c) => c === 'shouldStopExecuting')).toHaveLength(3); // Trigger, A, B
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['B']);
    expect(r.scheduler.outcome).toBe('cancelled');
  });

  it('the soft-failure re-run is n8n\'s inner while loop: runNode alone, without the per-entry preamble', async () => {
    const wf = workflow('retry-soft-calls', [
      node('Trigger', 'trigger', [0, 0]),
      node('A', 'set', [200, 0], { retryOnFail: true, maxTries: 2, waitBetweenTries: 1 }),
    ], [conn('Trigger', 0, 'A', 0)], 'Trigger');
    const r = await execute(wf, { A: () => ({ data: [[{ json: { error: 'soft' } }]] }) }, { startItems: START });
    expect(r.error).toBeUndefined();
    // n8n (lines 143–160): `sleep` (here the delayed X_retry_wait) then `runNode`, with no
    // getRetryParams / getPinnedOutput / collectSubNodeResults around it. `computeRunIndex`
    // is ours: a token never carries a run index, and the node has recorded nothing yet, so
    // it returns the same index n8n kept in its local variable.
    expect(callsOf(r.calls, 'A')).toEqual([
      'resetDynamicCredentialsUsage(A)', 'createTaskStartedData(A)', 'addPairedItemLineage(A)', 'computeRunIndex(A)',
      'isNodeFilteredOut(A)', 'ensureInputData(A)', 'hook:nodeExecuteBefore(A)', 'getRetryParams(A)',
      'getPinnedOutput(A)', 'collectSubNodeResults(A)', 'runNode(A)',
      'computeRunIndex(A)', 'runNode(A)',
      'computeRunIndex(A)', 'processNodeOutput(A)', 'assignPairedItems(A)', 'ensureAlwaysOutputData(A)',
      'createTaskData(A)', 'rewireOutputLog(A)', 'upsertTaskData(A)', 'hook:nodeExecuteAfter(A)',
    ]);
    // The re-run gets n8n's seven arguments: no EngineResponse (`nodeType.execute` sees undefined).
    expect(r.host.runNodeCalls.map((c) => c.engineResponse)).toEqual([true, true, false]);
    expect(r.runData.A![0]!.executionStatus).toBe('success');
  });

  it('metadata.resumeError disables the retry (getRetryParams → [1, 0]): one attempt, then the error path', async () => {
    const wf = workflow('retry-resume', [
      node('A', 'trigger', [0, 0], { retryOnFail: true, maxTries: 3, waitBetweenTries: 1, onError: 'continueRegularOutput' }),
    ], [], 'A');
    const plain = await execute(wf, { A: () => { throw new Error('resumed'); } }, { startItems: START });
    expect(ranNodes(plain.calls)).toEqual(['A', 'A', 'A']);
    const resumed = await execute(wf, { A: () => { throw new Error('resumed'); } }, {
      startItems: START,
      stackMetadata: { resumeError: { message: 'child failed' } } as never,
    });
    expect(ranNodes(resumed.calls)).toEqual(['A']);
    expect(resumed.runData.A![0]!.executionStatus).toBe('error');
    expect(transitionsStarted(resumed.store, (n) => n.startsWith('id:A/retry_wait'))).toHaveLength(0);
    expect(resumed.scheduler.outcome).toBe('completed');
  });
});
