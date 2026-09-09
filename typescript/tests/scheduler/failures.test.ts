/**
 * Failures the scheduler raises itself: an unmet `$('Y')` reference fails before `runNode`
 * with n8n's own "node is unexecuted" error under the node's `onError` policy, an
 * an `EngineRequest` the compiled net has no dispatch branch for fails the node by name, a fatal
 * error (one n8n's loop would have thrown out of `run()`) rejects `run()` after the net
 * quiesced, and a stranded join arrival is written to `waitingExecution` (divergence #2).
 */
import { PetriScheduler, UNMET_REFERENCE_MESSAGE_TEMPLATE } from '../../src/scheduler/index.js';
import { agentOneTool, conn, expressionRef, fanOut, linear, node, workflow } from '../fixtures/workflows.js';
import {
  FakeHost, callsOf, execute, fakeHooks, fakeNodeHelpers, fakeWorkflow, items, newRunExecutionData, ranNodes,
  transitionsFailed, transitionsStarted, tokensResting,
} from './support.js';

const START = items({ n: 1 });

describe('unmet expression reference', () => {
  it("B references $('A'); IF routes to B only: B fails with n8n's unexecuted-node error, without calling runNode", async () => {
    const r = await execute(expressionRef, {
      IF: () => ({ data: [[], items({ f: 1 })] }),
    }, { startItems: START, parameters: { B: { value: "={{ $('A').first().json.x }}" } } });
    expect(r.error).toBeUndefined();
    expect(transitionsStarted(r.store, (n) => n === 'id:B/start_unmet_0')).toHaveLength(1);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'IF']);
    expect(callsOf(r.calls, 'B')).toContain('getPinnedOutput(B)');
    expect(callsOf(r.calls, 'B')).not.toContain('runNode(B)');
    expect(r.scheduler.executionError?.message).toBe("Node 'A' hasn't been executed");
    expect((r.scheduler.executionError as unknown as { description: string }).description)
      .toBe(UNMET_REFERENCE_MESSAGE_TEMPLATE.replace('{{nodeName}}', 'A'));
    expect((r.scheduler.executionError as unknown as { context: { messageTemplate: string } }).context.messageTemplate)
      .toContain('An expression references this node, but the node is unexecuted');
    expect(r.scheduler.executionError?.name).toBe('ExpressionError');
    expect(r.runData.B![0]!.executionStatus).toBe('error');
    expect(r.scheduler.outcome).toBe('halted');
  });

  it('the same under continueRegularOutput: the node continues with its input as output', async () => {
    const wf = workflow('unmet-continue', [
      node('Trigger', 'trigger', [0, 0]), node('IF', 'if', [200, 0]), node('A', 'set', [400, -100]),
      node('B', 'set', [400, 100], { onError: 'continueRegularOutput' }), node('C', 'set', [600, 100]),
    ], [conn('Trigger', 0, 'IF', 0), conn('IF', 0, 'A', 0), conn('IF', 1, 'B', 0), conn('B', 0, 'C', 0)], 'Trigger', { references: { B: ['A'] } });
    const r = await execute(wf, { IF: () => ({ data: [[], items({ f: 1 })] }) }, {
      startItems: START, parameters: { B: { value: '={{ $node["A"].json.x }}' } },
    });
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'IF', 'C']);
    expect(r.runData.B![0]!.executionStatus).toBe('error');
    expect(r.runData.B![0]!.error?.message).toBe("Node 'A' hasn't been executed");
    expect(r.runData.C).toHaveLength(1);
    expect(r.scheduler.outcome).toBe('completed');
  });

  it('IF routes to A only: B waits for A/done and runs normally through X_start', async () => {
    const r = await execute(expressionRef, {
      IF: () => ({ data: [items({ t: 1 }), []] }),
    }, { startItems: START, parameters: { B: { value: "={{ $('A').item.json.x }}" } } });
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'IF', 'A']);
    expect(r.runData.B).toBeUndefined(); // B was skipped: IF sent it nothing
    expect(r.scheduler.outcome).toBe('completed');
  });
});

describe('an engine request the compiled net has no round for', () => {
  it('a node with no ai_tool connections fails by name instead of opening a round', async () => {
    const wf = workflow('agent', [node('Trigger', 'trigger', [0, 0]), node('Agent', 'set', [200, 0])], [conn('Trigger', 0, 'Agent', 0)], 'Trigger');
    const r = await execute(wf, { Agent: () => ({ actions: [], metadata: {} }) }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(r.scheduler.executionError?.name).toBe('NodeOperationError');
    expect(r.scheduler.executionError?.message).toContain('no ai_tool connections');
    // The round is the net's, never the host's: nothing was enqueued on n8n's stack.
    expect(r.calls).not.toContain('handleEngineRequest(Agent)');
    expect(r.runData.Agent![0]!.executionStatus).toBe('error');
    expect(r.scheduler.outcome).toBe('halted');
  });

  it('an action naming a node that is not one of the agent\'s tools fails by name', async () => {
    const r = await execute(agentOneTool, {
      Agent: () => ({
        actions: [{ actionType: 'ExecutionNodeAction' as const, nodeName: 'End', input: {}, type: 'ai_tool' as const, id: 'a1', metadata: {} }],
        metadata: {},
      }),
    }, { startItems: START });
    expect(r.scheduler.executionError?.message).toContain('"End" is not connected to it');
    expect(r.runData.Calculator).toBeUndefined();
  });
});

describe('fatal errors: what n8n\'s loop would have thrown out of run()', () => {
  it('a nodeExecuteBefore hook rejecting: run() rejects with that error after the net quiesced via the halt branch; executionError set; nothing else recorded', async () => {
    const boom = new Error('hook boom');
    const r = await execute(linear, {}, { startItems: START, hookFailures: { nodeExecuteBefore: (n) => (n === 'B' ? boom : undefined) } });
    // n8n: `await hooks.runHook('nodeExecuteBefore', …)` (line 96) sits outside the node's
    // try, so the rejection leaves the loop and `processRunExecutionData`'s `.catch` records it.
    expect(r.error).toBe(boom);
    expect(r.scheduler.outcome).toBe('fatal');
    expect(r.scheduler.executionError?.message).toBe('hook boom');
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A']);
    expect(r.runData.B).toBeUndefined();
    expect(r.runData.C).toBeUndefined();
    // The action never throws (EXEC-030): the halt branch was taken, `_halt` rests, C never started.
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(tokensResting(r.store, '_halt')).toBe(1);
    expect(transitionsStarted(r.store, (n) => n === 'id:C/start')).toHaveLength(0);
    expect(r.scheduler.diagnostics.some((d) => d.includes("node 'B': fatal error"))).toBe(true);
  });

  it('on a node whose onError policy gives X_run no halt alternative the stopped branch stands in, and run() still rejects', async () => {
    const wf = workflow('fatal-continue', [
      node('Trigger', 'trigger', [0, 0]), node('A', 'set', [200, 0], { onError: 'continueRegularOutput' }), node('B', 'set', [400, 0]),
    ], [conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0)], 'Trigger');
    const boom = new Error('after boom');
    const r = await execute(wf, {}, { startItems: START, hookFailures: { nodeExecuteAfter: (n) => (n === 'A' ? boom : undefined) } });
    expect(r.error).toBe(boom);
    expect(r.scheduler.outcome).toBe('fatal');
    expect(transitionsFailed(r.store)).toEqual([]);
    // A's task data was already upserted (line 250) before the hook (line 368) rejected.
    expect(r.runData.A).toHaveLength(1);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A']);
    expect(r.runData.B).toBeUndefined();
    expect(transitionsStarted(r.store, (n) => n === 'id:B/start')).toHaveLength(0);
  });
});

describe('fatal errors keep the pending stack', () => {
  it('the siblings n8n never popped are still on the stack when run() rejects', async () => {
    // Trigger fans out to A, B, C; A's `nodeExecuteBefore` rejects. n8n has popped only A,
    // so its `processRunExecutionData().catch` saves an execution whose stack is [B, C].
    const boom = new Error('hook boom');
    const r = await execute(fanOut, {}, { startItems: START, hookFailures: { nodeExecuteBefore: (n) => (n === 'A' ? boom : undefined) } });
    expect(r.error).toBe(boom);
    expect(r.scheduler.outcome).toBe('fatal');
    expect(ranNodes(r.calls)).toEqual(['Trigger']);
    expect(r.runExecutionData.executionData!.nodeExecutionStack.map((e) => e.node.name)).toEqual(['B', 'C']);
  });
});

describe('decode diagnostics', () => {
  it("n8n state the codec had to drop is reported, not skipped silently", async () => {
    // `waitingExecution[C][0].main[1]` for a single-input node: the shape n8n leaves behind
    // when a node's input count shrinks. Decode drops it; the scheduler must say so
    // (CLAUDE.md "No silent skips") instead of reporting a clean completion only.
    const wf = fakeWorkflow(linear);
    const red = newRunExecutionData(wf.nodes.Trigger!, { startItems: START });
    red.executionData!.waitingExecution = { C: { 0: { main: [null, items({ x: 1 })] } } } as never;
    const host = new FakeHost(wf, red, {});
    const scheduler = new PetriScheduler({ nodeHelpers: fakeNodeHelpers, legacy: () => { throw new Error('no'); } });
    await scheduler.run(host, wf, red, fakeHooks(host.calls));
    expect(ranNodes(host.calls)).toEqual(['Trigger', 'A', 'B', 'C']);
    expect(scheduler.diagnostics.some((d) => d.startsWith('decode: ') && d.includes("node 'C'")
      && d.includes('names an input the node does not have'))).toBe(true);
  });
});

describe('stranded tokens (divergence #2)', () => {
  it('a join input that can never complete: the arrival is written to waitingExecution as n8n\'s own stuck slot, with a diagnostic naming node and place', async () => {
    // Trigger → A → B → A (cycle), B → Merge.0, Trigger → Merge.1. B is cyclic, so its tree
    // edge to Merge.0 carries `data | nil`: when B produces nothing, Merge.0 never arrives and
    // the Trigger's delivery to Merge.1 is stranded on `Merge/ready_1`.
    const wf = workflow('stranded', [
      node('Trigger', 'trigger', [0, 0]), node('A', 'set', [200, 0]), node('B', 'set', [400, 0]), node('Merge', 'merge', [600, 100]),
    ], [
      conn('Trigger', 0, 'A', 0), conn('A', 0, 'B', 0), conn('B', 0, 'A', 0), conn('B', 0, 'Merge', 0), conn('Trigger', 0, 'Merge', 1),
    ], 'Trigger');
    const r = await execute(wf, { B: () => ({ data: [[]] }) }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B']);
    expect(r.runData.Merge).toBeUndefined();
    expect(r.scheduler.outcome).toBe('stranded');
    expect(r.scheduler.diagnostics.some((d) => d.includes("node 'Merge'") && d.includes('id:Merge/ready_1') && d.includes('divergence #2'))).toBe(true);
    const exec = r.runExecutionData.executionData!;
    expect(exec.nodeExecutionStack).toEqual([]);
    expect(exec.waitingExecution.Merge![0]!.main).toEqual([null, r.runData.Trigger![0]!.data!.main![0]]);
    expect(exec.waitingExecutionSource!.Merge![0]!.main).toEqual([null, { previousNode: 'Trigger', previousNodeOutput: 0, previousNodeRun: 0 }]);
  });
});
