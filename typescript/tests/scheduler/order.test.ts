/**
 * The PetriScheduler drives the host exactly as n8n's loop does, node for node: the
 * linear chain and the IF/Merge diamond produce the same `runData` shape (task data with
 * `source`, items with `pairedItem`) and the same host-call / hook order as
 * `stack-scheduler.ts` — the expected per-node sequence is `expectedSuccessSequence` in
 * `support.ts`, read off that file line by line. The stack machinery the net replaces
 * (`isExecutionStackNotEmpty`, `popExecutionStack`, `addNodeToBeExecuted`) is the only
 * difference: the entries are popped once up front, and `addNodeToBeExecuted` is never
 * called (routing is `X_route`, next cycle).
 */
import type { INodeExecutionData, ITaskDataConnections } from 'n8n-workflow';
import { conn, diamond, fanOut, linear, node, workflow } from '../fixtures/workflows.js';
import type { EdgePayload } from '../../src/scheduler/index.js';
import {
  execute, expectedSuccessSequence, items, ranNodes, transitionsFailed, withoutStackMachinery,
  type NodeScript,
} from './support.js';

const START = items({ n: 1 });

describe('linear: Trigger → A → B → C', () => {
  it('runs every node once in order with n8n\'s host-call and hook sequence per node', async () => {
    const r = await execute(linear, {}, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B', 'C']);
    // n8n: `while (isExecutionStackNotEmpty()) { … popExecutionStack() … }`. The net pops the
    // one entry up front; nothing else touches the stack.
    expect(r.calls.filter((c) => c === 'popExecutionStack')).toHaveLength(1);
    expect(r.calls.some((c) => c.startsWith('addNodeToBeExecuted'))).toBe(false);
    expect(withoutStackMachinery(r.calls)).toEqual([
      ...expectedSuccessSequence('Trigger'),
      ...expectedSuccessSequence('A'),
      ...expectedSuccessSequence('B'),
      ...expectedSuccessSequence('C'),
    ]);
    expect(r.scheduler.outcome).toBe('completed');
    expect(r.scheduler.executionError).toBeUndefined();
  });

  it('records task data as n8n does: one run per node, source pointing at the producer, executionIndex in run order', async () => {
    const r = await execute(linear, {}, { startItems: START });
    expect(Object.keys(r.runData)).toEqual(['Trigger', 'A', 'B', 'C']);
    for (const name of ['Trigger', 'A', 'B', 'C']) expect(r.runData[name], name).toHaveLength(1);
    expect(r.runData.Trigger![0]!.source).toEqual([]);
    expect(r.runData.A![0]!.source).toEqual([{ previousNode: 'Trigger', previousNodeOutput: 0, previousNodeRun: 0 }]);
    expect(r.runData.B![0]!.source).toEqual([{ previousNode: 'A', previousNodeOutput: 0, previousNodeRun: 0 }]);
    expect(r.runData.C![0]!.source).toEqual([{ previousNode: 'B', previousNodeOutput: 0, previousNodeRun: 0 }]);
    expect(['Trigger', 'A', 'B', 'C'].map((n) => r.runData[n]![0]!.executionIndex)).toEqual([0, 1, 2, 3]);
    expect(['Trigger', 'A', 'B', 'C'].map((n) => r.runData[n]![0]!.executionStatus)).toEqual(['success', 'success', 'success', 'success']);
    expect(r.runExecutionData.resultData.lastNodeExecuted).toBe('C');
    // The stack is empty at the end, as n8n leaves it; nothing is waiting.
    expect(r.runExecutionData.executionData!.nodeExecutionStack).toEqual([]);
    expect(r.runExecutionData.executionData!.waitingExecution).toEqual({});
  });

  it('passes data by reference and stamps pairedItem: the edge token and the task data hold the very array the node returned', async () => {
    const outputs = new Map<string, unknown[]>();
    const r = await execute(linear, {
      A: () => { const out = [items({ a: 1 })]; outputs.set('A', out); return { data: out }; },
    }, { startItems: START });
    // The token routed to B's `in` place holds A's output array itself (n8n hands the same
    // reference to every connection), and so does A's recorded task data.
    const added = r.store.events().find((e) => e.type === 'token-added' && e.placeName === 'id:B/in') as { token: { value: EdgePayload } } | undefined;
    expect(added).toBeDefined();
    expect(added!.token.value.items).toBe(outputs.get('A')![0]);
    expect(r.runData.A![0]!.data!.main![0]).toBe(outputs.get('A')![0]);
    // n8n's addPairedItemLineage rebuilds the input arrays with stamped items before runNode
    // (line 65): B's runNode input carries the lineage, and A's output got pairedItem from
    // assignPairedItems (line 193).
    expect(r.runData.A![0]!.data!.main![0]![0]!.pairedItem).toEqual({ item: 0 });
    const bInput = r.host.runNodeCalls.find((c) => c.node === 'B')!.main[0]!;
    expect(bInput[0]).toEqual({ json: { a: 1 }, pairedItem: { item: 0, input: undefined } });
  });

  it('the compile cache hits on the second execution of the same workflow (same net, same program, same actions)', async () => {
    const first = await execute(linear, {}, { startItems: START });
    const cache = first.scheduler['cache'];
    expect(cache.size).toBe(1);
    expect(cache.misses).toBe(1);
    const second = await execute(linear, {}, { startItems: START, scheduler: { cache } });
    expect(cache.hits).toBe(1);
    expect(cache.size).toBe(1);
    expect(second.scheduler.compiled).toBe(first.scheduler.compiled);
    expect(second.scheduler.compiled!.program).toBe(first.scheduler.compiled!.program);
    expect(ranNodes(second.calls)).toEqual(['Trigger', 'A', 'B', 'C']);
  });
});

describe('diamond: Trigger → IF → A / B → Merge → End', () => {
  const ifRoutes = (yes: unknown[], no: unknown[]) => () => ({ data: [items(...yes), items(...no)] });

  it('runs Trigger, IF, A, B, Merge, End — the order n8n\'s v1 stack produces — with n8n\'s sequence per node', async () => {
    const r = await execute(diamond, { IF: ifRoutes([{ t: 1 }], [{ f: 1 }]) }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    // n8n: IF's successors are sorted top-left first and unshifted, so A (y -100) runs before
    // B (y 100); the Merge waits in waitingExecution until B's arrival completes its slot.
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'IF', 'A', 'B', 'Merge', 'End']);
    expect(withoutStackMachinery(r.calls)).toEqual(
      ['Trigger', 'IF', 'A', 'B', 'Merge', 'End'].flatMap((n) => expectedSuccessSequence(n)));
    expect(r.scheduler.outcome).toBe('completed');
  });

  it('the Merge receives both inputs with their sources, as n8n\'s waitingExecution hands them over', async () => {
    const r = await execute(diamond, { IF: ifRoutes([{ t: 1 }], [{ f: 1 }]) }, { startItems: START });
    const merge = r.host.runNodeCalls.find((c) => c.node === 'Merge')!;
    expect(merge.main).toHaveLength(2);
    expect(merge.main[0]![0]!.json).toEqual({ t: 1 });
    expect(merge.main[1]![0]!.json).toEqual({ f: 1 });
    expect(r.runData.Merge![0]!.source).toEqual([
      { previousNode: 'A', previousNodeOutput: 0, previousNodeRun: 0 },
      { previousNode: 'B', previousNodeOutput: 0, previousNodeRun: 0 },
    ]);
    expect(r.runData.B![0]!.source).toEqual([{ previousNode: 'IF', previousNodeOutput: 1, previousNodeRun: 0 }]);
    expect(r.runData.End![0]!.source).toEqual([{ previousNode: 'Merge', previousNodeOutput: 0, previousNodeRun: 0 }]);
    // Every item of every task carries pairedItem.
    for (const [name, tasks] of Object.entries(r.runData)) {
      for (const out of tasks[0]!.data!.main!) for (const item of out ?? []) expect(item.pairedItem, name).toBeDefined();
    }
  });

  it('IF routing only true: B is skipped (empty token), the Merge still runs once with [] on input 1 — divergence #1: no stuck-join fallback needed', async () => {
    const r = await execute(diamond, { IF: ifRoutes([{ t: 1 }], []) }, { startItems: START });
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'IF', 'A', 'Merge', 'End']);
    expect(r.runData.B).toBeUndefined();
    const merge = r.host.runNodeCalls.find((c) => c.node === 'Merge')!;
    expect(merge.main).toEqual([expect.any(Array), []]);
    expect(r.runData.Merge![0]!.source).toEqual([{ previousNode: 'A', previousNodeOutput: 0, previousNodeRun: 0 }, null]);
    expect(r.scheduler.outcome).toBe('completed');
    expect(r.runExecutionData.executionData!.waitingExecution).toEqual({});
  });
});

describe('fan-out', () => {
  it('siblings run in canvas order (top-left first), each fed the trigger\'s output array by reference', async () => {
    const r = await execute(fanOut, {}, { startItems: START });
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'A', 'B', 'C']);
    const trig = r.runData.Trigger![0]!.data!.main![0];
    for (const n of ['A', 'B', 'C']) {
      const g = r.scheduler.compiled!.netMap.node(n);
      const added = r.store.events().find((e) => e.type === 'token-added' && e.placeName === g.in!.name) as { token: { value: EdgePayload } };
      expect(added.token.value.items, n).toBe(trig);
      expect(added.token.value.source, n).toEqual({ previousNode: 'Trigger', previousNodeOutput: 0, previousNodeRun: 0 });
    }
  });
});

/**
 * A node wired only on a higher input. n8n never reaches such a node through
 * `addNodeToBeExecuted`'s single-input path — `numberOfInputs` is
 * `connectionsByDestinationNode[node].main.length`, which is 2 here, so the arrival goes to
 * `waitingExecution` and the node is run by R6's stuck-join fallback with `[]` substituted
 * for the input that never arrived (`stack-scheduler.ts:467-491`). The compiler puts it in
 * direct form and runs it on arrival with the same data (divergence #9), so the entry must
 * carry that same `[]`: a `null` there is a shape n8n never hands a node, and
 * `getInputItems` throws "Input index was not set" on it
 * (`base-execute-context.ts:315-325`) — which is what n8n's Merge does when it reads
 * input 0 (n8n `workflow-execute.test.ts` "should run complicated multi node workflow where
 * multiple Merge-Node have missing data and complex dependency structure", node Merge7).
 */
describe('a node wired only on input 1', () => {
  const onlyHigherInput = workflow('only-higher-input', [
    node('Trigger', 'trigger', [0, 0]),
    node('Merge', 'merge', [200, 0]),
  ], [conn('Trigger', 0, 'Merge', 1)], 'Trigger');

  /** n8n's `getInputItems`, verbatim on the two branches that reject a slot. */
  const getInputItems = (main: ITaskDataConnections['main'], inputIndex: number): INodeExecutionData[] => {
    if (main.length < inputIndex) throw new Error('Could not get input with given index');
    const allItems = main[inputIndex];
    if (allItems === null) throw new Error('Input index was not set');
    return allItems ?? [];
  };

  it('receives [] on input 0, not null, and appends both inputs like n8n\'s Merge', async () => {
    // The Merge script reads BOTH inputs, as MergeV2 does before it appends them.
    const merge: NodeScript = ({ executionData }) => {
      const main = executionData.data.main!;
      return { data: [[...getInputItems(main, 0), ...getInputItems(main, 1)]] };
    };
    const r = await execute(onlyHigherInput, { Merge: merge }, { startItems: START });
    expect(r.error).toBeUndefined();
    expect(transitionsFailed(r.store)).toEqual([]);
    expect(ranNodes(r.calls)).toEqual(['Trigger', 'Merge']);
    expect(r.scheduler.outcome).toBe('completed');
    expect(r.scheduler.executionError).toBeUndefined();
    // The entry the start action built, in the fallback's shape.
    const call = r.host.runNodeCalls.find((c) => c.node === 'Merge')!;
    expect(call.main).toEqual([[], [{ json: { n: 1 }, pairedItem: { item: 0, input: 1 } }]]);
    expect(r.runData.Merge![0]!.source).toEqual([null, { previousNode: 'Trigger', previousNodeOutput: 0, previousNodeRun: 0 }]);
    expect(r.runData.Merge![0]!.data!.main![0]!.map((i) => i.json)).toEqual([{ n: 1 }]);
  });
});
