/**
 * Control flow: a stopWorkflow error halts (executionError set, an in-flight sibling
 * finishes and is recorded), cancellation via `host.abortSignal` → `executor.close()`,
 * `waitTill` encodes the marking with the waiting node first on the stack and the net
 * drained, the destination-node stop, v0 delegation to the legacy scheduler, and an empty
 * stack.
 */
import { conn, diamond, fanOut, linear, node, workflow } from '../fixtures/workflows.js';
import type { WorkflowScheduler } from '../../src/n8n/host.js';
import { PetriScheduler } from '../../src/scheduler/index.js';
import {
  FakeHost, callsOf, execute, fakeHooks, fakeNodeHelpers, fakeWorkflow, items, newRunExecutionData, ranNodes, sleep,
  transitionsFailed, transitionsStarted,
} from './support.js';

const START = items({ n: 1 });

describe('stopWorkflow error → halt', () => {
  it('a failing node under stopWorkflow: executionError set, task recorded as error, entry pushed back, successors never run', async () => {
    const r = await execute(linear, { B: () => { throw new Error('B failed'); } }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B']);
    expect(r.scheduler.executionError?.message).toBe('B failed');
    expect(r.scheduler.outcome).toBe('halted');
    expect(r.runData.B![0]!.executionStatus).toBe('error');
    expect(r.runData.C).toBeUndefined();
    expect(r.runExecutionData.resultData.lastNodeExecuted).toBe('B');
    // n8n's after-loop error handling, call for call (lines 210, 217–237), then the loop breaks.
    expect(callsOf(r.calls, 'B').slice(-6)).toEqual([
      'reportNodeExecutionError(B)', 'createTaskData(B)', 'handleNodeExecutionError(B)', 'upsertTaskData(B)',
      'pushExecutionStack(B)', 'hook:nodeExecuteAfter(B)',
    ]);
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['B']);
    expect(transitionsStarted(r.store, (n) => n === '_halt_reap')).toHaveLength(1);
    expect(transitionsStarted(r.store, (n) => n === 'id:C/start')).toHaveLength(0);
  });

  it('the entries n8n never popped stay on the stack: the halt reap clears them, the snapshot puts them back', async () => {
    // Trigger fans out to A, B, C. n8n pops A, fails, `handleNodeExecutionError` pushes it
    // back and the loop `break`s — B and C were never popped and stay on the stack, which is
    // what `ExecutionService.retry()` replays ("Stack will determine what to run next").
    // Here `_halt_reap` clears their `in` tokens, so they come from the marking snapshot
    // taken when the halt branch was written.
    const r = await execute(fanOut, { A: () => { throw new Error('A failed'); } }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('halted');
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A']);
    const stack = r.runExecutionData.executionData!.nodeExecutionStack;
    expect(stack.map((e) => e.node.name)).toEqual(['A', 'B', 'C']);
    // The pending entries are n8n's `addNodeToBeExecuted` shape, data by reference.
    expect(stack[1]!.data.main![0]).toBe(r.runData.Trigger![0]!.data!.main![0]);
    expect(stack[1]!.source).toEqual({ main: [{ previousNode: 'Trigger', previousNodeOutput: 0, previousNodeRun: 0 }] });
    expect(stack[1]!.node).toBe(r.workflow.nodes.B);
    expect(r.scheduler.diagnostics.some((d) => d.startsWith('halted: 2 pending activation(s)') && d.includes('B, C'))).toBe(true);
    expect(r.runData.B).toBeUndefined();
    expect(r.runData.C).toBeUndefined();
  });

  it('at k = 2 a sibling in flight when the halt lands finishes and is recorded; nothing new starts (EXEC-040)', async () => {
    // Trigger → A (fails after 20 ms), Trigger → B (takes 80 ms), B → C.
    const wf = workflow('halt-sibling', [
      node('Trigger', 'trigger', [0, 0]), node('A', 'set', [200, 0]), node('B', 'set', [200, 100]), node('C', 'set', [400, 100]),
    ], [conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0), conn('B', 0, 'C', 0)], 'Trigger');
    const r = await execute(wf, {
      A: async () => { await sleep(20); throw new Error('A failed'); },
      B: async () => { await sleep(80); return { data: [items({ b: 1 })] }; },
    }, { startItems: START, budget: 2 });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(r.scheduler.executionError?.message).toBe('A failed');
    expect(ranNodes(r.calls).sort()).toEqual(['A', 'B', 'Trigger']);
    expect(r.runData.B).toHaveLength(1);
    expect(r.runData.B![0]!.executionStatus).toBe('success');
    expect(r.runData.C).toBeUndefined(); // C's start is halt-inhibited
    expect(r.scheduler.outcome).toBe('halted');
    // The budget semiflow holds: nothing is left in flight.
    expect(transitionsStarted(r.store, (n) => n === 'id:C/start')).toHaveLength(0);
    // B's route is not halt-inhibited, so C's entry lands after the reap and is written back
    // with A's: n8n would have enqueued C too, and never popped it.
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['A', 'C']);
    expect(r.scheduler.diagnostics).toEqual(['halted: 1 pending activation(s) written back to nodeExecutionStack (C)']);
  });
});

describe('cancellation', () => {
  it('host.abortSignal → executor.close(): the in-flight node finishes, nothing else starts, pending entries go back on the stack', async () => {
    const r = await execute(linear, {
      A: async ({ host }) => { await sleep(30); host.cancel(); await sleep(10); return { data: [items({ a: 1 })] }; },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A']);
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.B).toBeUndefined();
    expect(r.scheduler.outcome).toBe('cancelled');
    expect(r.scheduler.executionError).toBeUndefined();
    // A's completion is processed after close() (its output lands on X/ok) and nothing fires
    // afterwards, so the encoder routes the ok token itself: B is on the stack, exactly where
    // n8n's addNodeToBeExecuted had put it before the next iteration's cancellation check.
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['B']);
    expect(r.runExecutionData.executionData!.nodeExecutionStack[0]!.source).toEqual({ main: [{ previousNode: 'A', previousNodeOutput: 0, previousNodeRun: 0 }] });
    expect(transitionsStarted(r.store, (n) => n === 'id:B/run')).toHaveLength(0);
  });

  it('cancelled before the first node ran: nothing runs and the start entry stays on the stack, as n8n leaves it', async () => {
    // `during` runs at the executor's first yield: Trigger's start has fired (instantaneous),
    // X_run has not. close() then stops the net; the running token is a pending activation.
    const r = await execute(linear, {}, { startItems: START, during: (host) => { host.cancel(); } });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual([]);
    expect(r.runData).toEqual({});
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['Trigger']);
    expect(r.runExecutionData.executionData!.nodeExecutionStack[0]!.data.main![0]).toBe(START);
    expect(r.scheduler.outcome).toBe('cancelled');
  });

  it('a signal already aborted before run(): the executor is closed before it starts, nothing fires, the entry stays on the stack unrun', async () => {
    const workflow = fakeWorkflow(linear);
    const red = newRunExecutionData(workflow.nodes.Trigger!, { startItems: START });
    const host = new FakeHost(workflow, red, {});
    host.cancel();
    const scheduler = new PetriScheduler({ nodeHelpers: fakeNodeHelpers, legacy: () => { throw new Error('no'); } });
    await scheduler.run(host, workflow, red, fakeHooks(host.calls));
    expect(ranNodes(host.calls)).toEqual([]);
    expect(host.calls).not.toContain('shouldStopExecuting'); // no X_run ever fired
    expect(red.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['Trigger']);
    expect(red.executionData!.nodeExecutionStack[0]!.data.main![0]).toBe(START);
    expect(scheduler.outcome).toBe('cancelled');
  });

  it('shouldStopExecuting() true without an abort (n8n\'s timeout poll, line 49): X_run takes the stopped branch, the entry goes back on the stack unrun, the net drains', async () => {
    // A flips the host to canceled without aborting the signal, as `hasExecutionTimedOut`
    // does inside `shouldStopExecuting`. n8n: A completes and is recorded, B is enqueued,
    // the next iteration `return`s at line 49 with B still on the stack.
    const r = await execute(linear, {
      A: ({ host }) => { host.status = 'canceled'; return { data: [items({ a: 1 })] }; },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A']);
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.B).toBeUndefined();
    // B's X_run fired (its start had already consumed the routed token), saw the stop and
    // put the entry back: line 49 is the first thing the iteration does.
    expect(callsOf(r.calls, 'B')).toEqual([]);
    expect(r.calls.filter((c) => c === 'shouldStopExecuting')).toHaveLength(3); // Trigger, A, B's aborted iteration
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['B']);
    expect(r.runExecutionData.executionData!.nodeExecutionStack[0]!.source).toEqual({ main: [{ previousNode: 'A', previousNodeOutput: 0, previousNodeRun: 0 }] });
    expect(r.scheduler.outcome).toBe('cancelled');
    expect(r.scheduler.executionError).toBeUndefined();
    expect(transitionsStarted(r.store, (n) => n === 'id:C/start')).toHaveLength(0);
  });
});

describe('waitTill', () => {
  it('at k = 2 a sibling finishing after another node set waitTill is recorded, not re-queued as waiting', async () => {
    // Trigger → A (waits immediately), Trigger → B (30 ms, succeeds), B → C. `waitTill` is
    // one execution-global field; only A may claim it. Before this, B took the waiting
    // branch too, went back on the stack and would have run a second time on resume, and
    // C never received the output B had already produced.
    const wf = workflow('wait-sibling', [
      node('Trigger', 'trigger', [0, 0]), node('A', 'set', [200, 0]), node('B', 'set', [200, 100]), node('C', 'set', [400, 100]),
    ], [conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0), conn('B', 0, 'C', 0)], 'Trigger');
    const r = await execute(wf, {
      A: ({ runExecutionData }) => { runExecutionData.waitTill = new Date(Date.now() + 60_000); return { data: [items({ a: 1 })] }; },
      B: async () => { await sleep(30); return { data: [items({ b: 1 })] }; },
    }, { startItems: START, budget: 2 });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(r.scheduler.outcome).toBe('paused');
    expect(r.runData.B).toHaveLength(1);
    const stack = r.runExecutionData.executionData!.nodeExecutionStack;
    expect(stack.map((e) => e.node.name)).toEqual(['A', 'C']);
    expect(stack[1]!.source).toEqual({ main: [{ previousNode: 'B', previousNodeOutput: 0, previousNodeRun: 0 }] });
    expect(r.scheduler.diagnostics.some((d) => d.includes("node 'B'") && d.includes("by 'A'"))).toBe(true);
  });


  it('a node putting the execution to wait: run() returns with the waiting node as nodeExecutionStack[0] and the net drained', async () => {
    const r = await execute(linear, {
      B: ({ runExecutionData }) => { runExecutionData.waitTill = new Date(Date.now() + 60_000); return { data: [items({ b: 1 })] }; },
    }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B']);
    expect(r.scheduler.outcome).toBe('paused');
    // n8n (lines 252–258): task recorded as 'waiting', nodeExecuteAfter, pushExecutionStack, break.
    expect(r.runData.B![0]!.executionStatus).toBe('waiting');
    expect(callsOf(r.calls, 'B').slice(-3)).toEqual(['rewireOutputLog(B)', 'upsertTaskData(B)', 'hook:nodeExecuteAfter(B)']);
    const stack = r.runExecutionData.executionData!.nodeExecutionStack;
    expect(stack.map((e) => e.node.name)).toEqual(['B']);
    expect(stack[0]!.node).toBe(r.workflow.nodes.B); // the live INode, as handleWaitingState expects
    expect(stack[0]!.data.main![0]![0]!.json).toEqual({ n: 1 }); // B's input executionData, lineage stamped
    expect(stack[0]!.source).toEqual({ main: [{ previousNode: 'A', previousNodeOutput: 0, previousNodeRun: 0 }] });
    expect(r.runData.C).toBeUndefined();
    // Drained: no running / ok tokens, C never started, _pause holds.
    const c = r.scheduler.compiled!;
    expect(transitionsStarted(r.store, (n) => n === 'id:C/start')).toHaveLength(0);
    expect(transitionsStarted(r.store, (n) => n === 'id:B/route')).toHaveLength(0);
    const snapshot = r.store.events().filter((e) => e.type === 'marking-snapshot').at(-1)!;
    const tokens = (snapshot as unknown as { marking: ReadonlyMap<string, readonly unknown[]> }).marking;
    const count = (name: string) => tokens.get(name)?.length ?? 0;
    expect(count('_pause')).toBe(1);
    expect(count('id:B/waiting')).toBe(1);
    expect(count('id:B/running')).toBe(0);
    expect(count('id:B/ok')).toBe(0);
    expect(count('_budget')).toBe(c.effectiveBudget);
  });
});

describe('destination node', () => {
  it('a cancellation racing the destination stop encodes the pause in mode cancelled instead of throwing', async () => {
    // k = 2: A is the destination and stops the run while B is still in flight; the abort
    // then closes the executor (ENV-013), so B's completion lands on `id:B/ok` with no
    // `X_route` left to drain it. Mode `pause` rejects that token as undrained (a
    // `CodecError` out of `run()`, with the whole pending state lost); mode `cancelled`
    // routes it as `X_route` would have, which is where n8n's stack has it.
    const wf = workflow('pause-cancel', [
      node('Trigger', 'trigger', [0, 0]), node('A', 'set', [200, 0]), node('B', 'set', [200, 100]), node('C', 'set', [400, 100]),
    ], [conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'B', 0), conn('B', 0, 'C', 0)], 'Trigger');
    const r = await execute(wf, {
      B: async () => { await sleep(60); return { data: [items({ b: 1 })] }; },
    }, {
      startItems: START, budget: 2, destinationNode: 'A',
      during: async (host) => { await sleep(25); host.cancel(); },
    });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.outcome).toBe('cancelled');
    expect(r.runData.A).toHaveLength(1);
    expect(r.runData.B).toHaveLength(1);
    const stack = r.runExecutionData.executionData!.nodeExecutionStack;
    expect(stack.map((e) => e.node.name)).toEqual(['C']);
    expect(stack[0]!.source).toEqual({ main: [{ previousNode: 'B', previousNodeOutput: 0, previousNodeRun: 0 }] });
  });


  it('the destination node runs, its task is recorded, nodeExecuteAfter runs, its successors are not enqueued', async () => {
    const r = await execute(linear, {}, { startItems: START, destinationNode: 'B', runNodeFilter: ['Trigger', 'A', 'B'] });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B']);
    expect(callsOf(r.calls, 'B').slice(-2)).toEqual(['upsertTaskData(B)', 'hook:nodeExecuteAfter(B)']);
    expect(r.runData.B).toHaveLength(1);
    expect(r.runData.C).toBeUndefined();
    expect(transitionsStarted(r.store, (n) => n === 'id:B/route')).toHaveLength(0);
    expect(r.scheduler.outcome).toBe('paused');
    // Nothing pending: the stopped token is discarded, the stack stays empty.
    expect(r.runExecutionData.executionData!.nodeExecutionStack).toEqual([]);
  });

  it('a sibling outside the run filter after the destination stop: never runs, no task data, dropped from the stack as n8n drops it', async () => {
    const r = await execute(diamond, { IF: () => ({ data: [items(1), items(2)] }) }, {
      startItems: START, destinationNode: 'A', runNodeFilter: ['Trigger', 'IF', 'A'],
    });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'IF', 'A']);
    // n8n pops B next, runs its per-pop preamble (lines 60–72) and drops it at
    // isNodeFilteredOut (74–76). Here the destination stop pauses the net (`_pause`), B's
    // start never fires and the scheduler drops B's pending entry through the same
    // predicate after encoding: the filter call is B's only host interaction, and nothing
    // of the preamble (no createTaskStartedData, so no executionIndex is consumed).
    expect(callsOf(r.calls, 'B'), 'B is only ever asked about through the run filter').toEqual(['isNodeFilteredOut(B)']);
    expect(r.runData.B).toBeUndefined();
    expect(r.runExecutionData.executionData!.nodeExecutionStack).toEqual([]);
    expect(r.scheduler.outcome).toBe('paused');
  });

  it('a node outside the run filter reached before the destination is skipped entirely (no run, no task data, no hooks) and its successors receive empties', async () => {
    // Trigger → IF → A → Merge.0, IF → B → Merge.1, Merge → End; destination End, filter without B.
    const r = await execute(diamond, { IF: () => ({ data: [items(1), items(2)] }) }, {
      startItems: START, destinationNode: 'End', runNodeFilter: ['Trigger', 'IF', 'A', 'Merge', 'End'],
    });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'IF', 'A', 'Merge', 'End']);
    expect(callsOf(r.calls, 'B')).toEqual(['resetDynamicCredentialsUsage(B)', 'createTaskStartedData(B)', 'addPairedItemLineage(B)', 'computeRunIndex(B)', 'isNodeFilteredOut(B)']);
    expect(r.runData.B).toBeUndefined();
    const merge = r.host.runNodeCalls.find((c) => c.node === 'Merge')!;
    expect(merge.main[1]).toEqual([]);
  });
});

describe('delegation and empty stack', () => {
  it('executionOrder v0 delegates to the legacy scheduler and copies its executionError / closeFunction', async () => {
    const seen: unknown[] = [];
    const closeFunction = Promise.resolve();
    const legacy: WorkflowScheduler = {
      executionError: undefined,
      closeFunction: undefined,
      async run(host, workflow, runExecutionData, hooks) {
        seen.push(host, workflow, runExecutionData, hooks);
        (this as { executionError: unknown }).executionError = { message: 'legacy error' };
        (this as { closeFunction: unknown }).closeFunction = closeFunction;
      },
    };
    const r = await execute(linear, {}, { startItems: START, executionOrder: 'v0', legacy: () => legacy });
    expect(r.error).toBeUndefined();
    expect(seen).toEqual([r.host, r.workflow, r.runExecutionData, r.hooks]);
    expect(ranNodes(r.calls)).toEqual([]);
    expect(r.scheduler.executionError).toEqual({ message: 'legacy error' });
    expect(r.scheduler.closeFunction).toBe(closeFunction);
    expect(r.scheduler.outcome).toBe('legacy');
    expect(r.scheduler.compiled).toBeUndefined();
  });

  it('closeFunction of the last node that registered one is kept (line 185)', async () => {
    const closeA = Promise.resolve();
    const r = await execute(linear, {
      A: () => ({ data: [items(1)], closeFunction: async () => closeA }),
    }, { startItems: START });
    expect(r.scheduler.closeFunction).toBeInstanceOf(Promise);
  });

  it('an empty nodeExecutionStack runs nothing (the loop never enters)', async () => {
    const r = await execute(linear, {}, { emptyStack: true });
    expect(r.error).toBeUndefined();
    expect(ranNodes(r.calls)).toEqual([]);
    expect(r.scheduler.outcome).toBe('nothing-to-run');
    expect(r.scheduler.compiled).toBeUndefined();
    expect(r.calls).toEqual(['isExecutionStackNotEmpty']);
  });
});
