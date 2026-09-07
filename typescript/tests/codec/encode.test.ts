/**
 * `encodeMarking`: the quiescent marking → n8n's `nodeExecutionStack` /
 * `waitingExecution` / `waitingExecutionSource` (ADR 0005, the encode table in
 * `src/codec.ts`). Hand-built markings pin the entry shapes, the positional join slots,
 * the OR round, the stack order, the discards, the undrained-place errors per mode, the
 * stranded mode and the live-node resolution.
 */
import type { INode } from 'n8n-workflow';
import { CodecError, decodeExecutionData, encodeMarking } from '../../src/codec.js';
import { compile } from '../../src/compiler/index.js';
import type { OkPayload, RetryPayload, RunPayload, StoppedPayload, WaitingPayload } from '../../src/scheduler/index.js';
import { chooseBranch, conn, diamond, fanOut, fanOut4, ifBothOutputs, linear, node, twoTriggers, workflow } from '../fixtures/workflows.js';
import { fakeWorkflow, items } from '../scheduler/support.js';
import { edge, edgeData, emptyState, entryFor, entryPayload, gadget, live, named, put, slotsOf, src, stateOf } from './support.js';

const names = (s: { nodeExecutionStack: Array<{ node: { name: string } }> }) => s.nodeExecutionStack.map((e) => e.node.name);

describe('stack entries', () => {
  it('X/waiting is nodeExecutionStack[0] with the node\'s own executionData, ahead of every other pending entry', () => {
    const c = compile(linear);
    const wf = fakeWorkflow(linear);
    const m = c.sharedMarking();
    const w: WaitingPayload = { executionData: entryFor(wf.nodes.A!, [items(1)]) };
    put(m, gadget(c, 'A').waiting, [w]);
    put(m, gadget(c, 'C').in!, [edge(items(2), src('B'))]); // deeper, but the waiting node comes first
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(names(x)).toEqual(['A', 'C']);
    expect(x.nodeExecutionStack[0]).toBe(w.executionData);
  });

  it('a direct-form data token becomes addNodeToBeExecuted\'s entry (live node, main[inputIndex], null below, source at main[0]); an entry payload goes back verbatim', () => {
    const c = compile(linear);
    const wf = fakeWorkflow(linear);
    const m = c.sharedMarking();
    const a = items({ a: 1 });
    const verbatim = entryFor(wf.nodes.B!, [items(9)]);
    put(m, gadget(c, 'A').in!, [edge(a, src('Trigger', 0, 3))]);
    put(m, gadget(c, 'B').in!, [entryPayload(verbatim)]);
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(names(x)).toEqual(['B', 'A']);
    expect(x.nodeExecutionStack[0]).toBe(verbatim);
    expect(x.nodeExecutionStack[1]).toEqual({ node: wf.nodes.A, data: { main: [a] }, source: { main: [src('Trigger', 0, 3)] } });
    expect(x.nodeExecutionStack[1]!.data.main![0]).toBe(a);
    expect(x.nodeExecutionStack[1]!.node).toBe(wf.nodes.A);
  });

  it('order: depth descending, then canvas order, then token FIFO', () => {
    const c = compile(fanOut); // canvas order A, Trigger, B, C; A, B, C all depth 1
    const wf = fakeWorkflow(fanOut);
    const m = c.sharedMarking();
    put(m, gadget(c, 'C').in!, [edge(items(1), src('Trigger'))], 5);
    put(m, gadget(c, 'A').in!, [edge(items(2), src('Trigger'))], 6);
    put(m, gadget(c, 'B').in!, [edge(items(3), src('Trigger')), edge(items(4), src('Trigger'))], 7);
    put(m, gadget(c, 'Trigger').in!, [edge(items(0), null)], 1);
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(names(x)).toEqual(['A', 'B', 'B', 'C', 'Trigger']);
    expect(x.nodeExecutionStack.slice(1, 3).map((e) => e.data.main![0])).toEqual([items(3), items(4)]);
  });

  it('a stopped token with ran: false, a pending retry and (cancelled) a running token are pending activations; ran: true is discarded', () => {
    const c = compile({ ...linear, nodes: linear.nodes.map((n) => (n.name === 'B' ? { ...n, retryOnFail: true } : n)) });
    const wf = fakeWorkflow(linear);
    const m = c.sharedMarking();
    const stopped: StoppedPayload = { executionData: entryFor(wf.nodes.A!, [items(1)]), ran: false };
    const done: StoppedPayload = { executionData: entryFor(wf.nodes.C!, [items(2)]), ran: true };
    const retry: RetryPayload = { executionData: entryFor(wf.nodes.B!, [items(3)]), attempt: 1, taskStartedData: {} as never, reason: { kind: 'error', error: new Error('x') } };
    put(m, gadget(c, 'A').stopped, [stopped]);
    put(m, gadget(c, 'C').stopped, [done]);
    put(m, gadget(c, 'B').retry!, [retry]);
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([retry.executionData, stopped.executionData]);
    const running: RunPayload = { executionData: entryFor(wf.nodes.C!, [items(4)]), attempt: 0 };
    put(m, gadget(c, 'C').running, [running]);
    const y = encodeMarking(c, live(m), emptyState(), { mode: 'cancelled', node: (n) => wf.nodes[n] });
    expect(y.nodeExecutionStack).toEqual([running.executionData, retry.executionData, stopped.executionData]);
  });
});

describe('join slots', () => {
  it('a complete slot is a stack entry with items or [] per input and the sources alongside (n8n\'s allDataFound)', () => {
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    const a = items({ a: 1 });
    m.delete(g.inputs[0]!.free!);
    m.delete(g.inputs[1]!.free!);
    put(m, g.inputs[0]!.ready!, [edge(a, src('A'))]);
    put(m, g.inputs[1]!.ready!, [null]);
    put(m, g.hasdata!, [null]);
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([{ node: wf.nodes.Merge, data: { main: [a, []] }, source: { main: [src('A'), null] } }]);
    expect(x.nodeExecutionStack[0]!.data.main![0]).toBe(a);
    expect(x.waitingExecution).toEqual({});
    expect(x.waitingExecutionSource).toEqual({});
  });

  it('a complete all-empty slot is a skip, not a run: written as a waitingExecution slot of [] (n8n\'s R6 drops it), which decodes back to the skip-ready state', () => {
    // Only `close()` can freeze one (X_skip is not pause-inhibited), so it is a cancelled-mode shape.
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    m.delete(g.inputs[0]!.free!);
    m.delete(g.inputs[1]!.free!);
    put(m, g.inputs[0]!.ready!, [null]);
    put(m, g.inputs[1]!.ready!, [null]);
    const x = encodeMarking(c, live(m), emptyState(), { mode: 'cancelled', node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([]);
    expect(x.waitingExecution).toEqual({ Merge: { 0: { main: [[], []] } } });
    const back = named(decodeExecutionData(c, x));
    expect(back['id:Merge/ready_0']).toBe(1);
    expect(back['id:Merge/ready_1']).toBe(1);
    expect(back['id:Merge/hasdata']).toBeUndefined(); // X_skip, not X_start
    expect(back['id:Merge/free_0']).toBeUndefined();
  });

  it('a partial slot is waitingExecution[node][0] with null for the input that has not arrived, the source mirrored', () => {
    const c = compile(diamond);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    const b = items({ b: 1 });
    m.delete(g.inputs[1]!.free!);
    put(m, g.inputs[1]!.ready!, [edge(b, src('B', 0, 2))]);
    put(m, g.hasdata!, [null]);
    const x = encodeMarking(c, live(m), emptyState());
    expect(x.nodeExecutionStack).toEqual([]);
    expect(x.waitingExecution).toEqual({ Merge: { 0: { main: [null, b] } } });
    expect(x.waitingExecutionSource).toEqual({ Merge: { 0: { main: [null, src('B', 0, 2)] } } });
    expect(x.waitingExecution.Merge![0]!.main![1]).toBe(b);
  });

  it('slots are positional: the heads pair as slot 0, the arrivals queued on the edge places as slot 1, 2, …', () => {
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    const [a1, a2, a3, b1] = [items(1), items(2), items(3), items({ b: 1 })];
    m.delete(g.inputs[0]!.free!);
    m.delete(g.inputs[1]!.free!);
    put(m, g.inputs[0]!.ready!, [edge(a1, src('A'))]);
    put(m, g.inputs[1]!.ready!, [edge(b1, src('B'))]);
    put(m, g.hasdata!, [null, null]);
    put(m, edgeData(c, 'A', 0, 'Merge', 0), [edge(a2, src('A', 0, 1)), edge(a3, src('A', 0, 2))]);
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([{ node: wf.nodes.Merge, data: { main: [a1, b1] }, source: { main: [src('A'), src('B')] } }]);
    expect(slotsOf(x.waitingExecution, 'Merge')).toEqual([{ main: [a2, null] }, { main: [a3, null] }]);
    expect(slotsOf(x.waitingExecutionSource!, 'Merge')).toEqual([{ main: [src('A', 0, 1), null] }, { main: [src('A', 0, 2), null] }]);
  });

  it('an entry-headed slot is the entry verbatim (its unit companions are not slots)', () => {
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    const e = entryFor(wf.nodes.Merge!, [items(1)]);
    m.delete(g.inputs[0]!.free!);
    m.delete(g.inputs[1]!.free!);
    put(m, g.inputs[0]!.ready!, [entryPayload(e)]);
    put(m, g.inputs[1]!.ready!, [null]);
    put(m, g.hasdata!, [null]);
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([e]);
    expect(x.nodeExecutionStack[0]).toBe(e);
    expect(x.waitingExecution).toEqual({});
  });

  it('choose-branch: ready_i_data and ready_i_empty form one slot', () => {
    const c = compile(chooseBranch);
    const wf = fakeWorkflow(chooseBranch);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    const t = items({ t: 1 });
    m.delete(g.inputs[0]!.free!);
    m.delete(g.inputs[1]!.free!);
    put(m, g.inputs[0]!.readyData!, [edge(t, src('IF', 0))]);
    put(m, g.inputs[1]!.readyEmpty!, [null]);
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([{ node: wf.nodes.Merge, data: { main: [t, []] }, source: { main: [src('IF', 0), null] } }]);
  });

  it('two different entries paired in one slot is a CodecError naming the node', () => {
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    put(m, g.inputs[0]!.ready!, [entryPayload(entryFor(wf.nodes.Merge!, [items(1)]))]);
    put(m, g.inputs[1]!.ready!, [entryPayload(entryFor(wf.nodes.Merge!, [items(2)]))]);
    expect(() => encodeMarking(c, live(m), emptyState())).toThrow(/node 'Merge': slot 0 pairs two different stack entries/);
  });
});

describe('OR rounds', () => {
  it('pending arrivals become entries; the round\'s other deliveries become [] slots (n8n\'s R6 discards them, decode counts them)', () => {
    const c = compile(ifBothOutputs);
    const wf = fakeWorkflow(ifBothOutputs);
    const m = c.sharedMarking();
    const g = gadget(c, 'C');
    const t = items({ t: 1 });
    put(m, g.inputs[0]!.hasdata!, [edge(t, src('IF', 0))]);
    put(m, g.inputs[0]!.ready!, [null, null]); // IF delivered data on 0 and empty on 1: two deliveries, one of them the pending arrival
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([{ node: wf.nodes.C, data: { main: [t] }, source: { main: [src('IF', 0)] } }]);
    expect(x.waitingExecution).toEqual({ C: { 0: { main: [[]] } } });
    expect(x.waitingExecutionSource).toEqual({ C: { 0: { main: [null] } } });
  });

  it('the seeded deliveries of unreachable producers are not written (the shared marking re-seeds them)', () => {
    const wf = workflow('or-partial', [
      node('T', 'trigger', [0, 0]), node('Other', 'trigger', [0, 200]), node('IF', 'if', [200, 0]), node('C', 'set', [400, 0]),
    ], [conn('T', 0, 'IF', 0), conn('IF', 0, 'C', 0), conn('IF', 1, 'C', 0), conn('Other', 0, 'C', 0)], 'T');
    const c = compile(wf);
    const g = gadget(c, 'C');
    expect(g.inputs[0]!.unreachableEdges).toBe(1);
    const m = c.sharedMarking(); // ready_0 = 1 (the seed)
    put(m, g.inputs[0]!.ready!, [null]); // one real empty delivered
    const x = encodeMarking(c, live(m), emptyState());
    expect(x.waitingExecution).toEqual({ C: { 0: { main: [[]] } } });
    expect(encodeMarking(c, live(c.sharedMarking()), emptyState()).waitingExecution).toEqual({});
  });

  it('a join slot holding nothing but the seeded empty of an unreachable input is not written either; with an arrival it completes into a stack entry', () => {
    const c = compile(twoTriggers);
    const wf = fakeWorkflow(twoTriggers);
    expect(named(c.sharedMarking())['id:Merge/ready_1']).toBe(1);
    const lone = encodeMarking(c, live(c.sharedMarking()), emptyState(), { node: (n) => wf.nodes[n] });
    expect(lone.nodeExecutionStack).toEqual([]);
    expect(lone.waitingExecution).toEqual({});
    const diags: string[] = [];
    encodeMarking(c, live(c.sharedMarking()), emptyState(), { mode: 'stranded', onDiagnostic: (d) => diags.push(d) });
    expect(diags).toEqual([expect.stringMatching(/node 'Merge': join never completed; only the seeded empty of input 1/)]);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    const a = items({ a: 1 });
    m.delete(g.inputs[0]!.free!);
    put(m, g.inputs[0]!.ready!, [edge(a, src('TrigA'))]);
    put(m, g.hasdata!, [null]);
    const x = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([{ node: wf.nodes.Merge, data: { main: [a, []] }, source: { main: [src('TrigA'), null] } }]);
  });
});

describe('discards and untouched fields', () => {
  it('budget, idle, free, tries, done, skipped, ran, the hasdata counter, nil, routed, pause and a ran: true stop leave nothing behind; contextData and metadata are untouched', () => {
    const c = compile({ ...ifBothOutputs, nodes: ifBothOutputs.nodes.map((n) => (n.name === 'End' ? { ...n, retryOnFail: true } : n)) });
    const wf = fakeWorkflow(ifBothOutputs);
    const m = c.sharedMarking(); // budget, idle, free, tries
    const g = gadget(c, 'C');
    put(m, g.done, [null]);
    put(m, g.skipped!, [null]);
    put(m, g.inputs[0]!.ran!, [null]);
    put(m, gadget(c, 'Merge').hasdata!, [null]);
    put(m, c.netMap.shared.pause, [null]);
    const stopped: StoppedPayload = { executionData: entryFor(wf.nodes.End!, [items(1)]), ran: true };
    put(m, gadget(c, 'End').stopped, [stopped]);
    const s = emptyState();
    const context = { a: { x: 1 } };
    const meta = { A: [] };
    (s as { contextData: unknown }).contextData = context;
    (s as { metadata: unknown }).metadata = meta;
    const x = encodeMarking(c, live(m), s);
    expect(x.nodeExecutionStack).toEqual([]);
    expect(x.waitingExecution).toEqual({});
    expect((x as { contextData: unknown }).contextData).toBe(context);
    expect((x as { metadata: unknown }).metadata).toBe(meta);
  });
});

describe('undrained places', () => {
  it.each([
    ['X/running', (c: ReturnType<typeof compile>, m: Map<never, never>) => put(m, gadget(c, 'A').running, [{ executionData: {} as never, attempt: 0 } satisfies RunPayload]), 'id:A/running'],
    ['X/routed', (c: ReturnType<typeof compile>, m: Map<never, never>) => put(m, gadget(c, 'A').routed!, [null]), 'id:A/routed'],
    ['X/in_empty', (c: ReturnType<typeof compile>, m: Map<never, never>) => put(m, gadget(c, 'A').inEmpty!, [null]), 'id:A/in_empty'],
  ])('%s in pause mode is a CodecError naming the place', (_what, arrange, place) => {
    const c = compile(linear);
    const m = c.sharedMarking();
    arrange(c, m as never);
    expect(() => encodeMarking(c, live(m), emptyState())).toThrow(CodecError);
    expect(() => encodeMarking(c, live(m), emptyState())).toThrow(place);
    expect(() => encodeMarking(c, live(m), emptyState(), { mode: 'stranded' })).toThrow(place);
  });

  it('an OR input\'s edge places are drained by the arms: a token there is undrained in pause and stranded, an arrival in cancelled', () => {
    const c = compile(ifBothOutputs);
    const wf = fakeWorkflow(ifBothOutputs);
    const m = c.sharedMarking();
    const t = items(1);
    put(m, edgeData(c, 'IF', 0, 'C', 0), [edge(t, src('IF', 0))]);
    expect(() => encodeMarking(c, live(m), emptyState())).toThrow(CodecError);
    const x = encodeMarking(c, live(m), emptyState(), { mode: 'cancelled', node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack.map((e) => e.data.main![0])).toEqual([t]);
    expect(x.waitingExecution).toEqual({}); // not armed, so not yet a round delivery
  });

  it('X/retry is a pending activation in pause and cancelled, an undrained place in stranded', () => {
    const c = compile({ ...linear, nodes: linear.nodes.map((n) => (n.name === 'B' ? { ...n, retryOnFail: true } : n)) });
    const wf = fakeWorkflow(linear);
    const m = c.sharedMarking();
    const retry: RetryPayload = { executionData: entryFor(wf.nodes.B!, [items(3)]), attempt: 1, taskStartedData: {} as never, reason: { kind: 'error', error: new Error('x') } };
    put(m, gadget(c, 'B').retry!, [retry]);
    expect(encodeMarking(c, live(m), emptyState()).nodeExecutionStack).toEqual([retry.executionData]);
    expect(encodeMarking(c, live(m), emptyState(), { mode: 'cancelled' }).nodeExecutionStack).toEqual([retry.executionData]);
    expect(() => encodeMarking(c, live(m), emptyState(), { mode: 'stranded' })).toThrow('id:B/retry');
  });

  it('cancelled: a token on X/ok_o is routed by the encoder as X_route_o would have (data edges become entries, empties nothing)', () => {
    // `Q` has four connected outputs, above `SPLIT_ROUTING_ABOVE`, so it is the one shape
    // that still parks its outcome on `X/ok_o` between `X_run` and `X_route_o` — the window
    // `close()` (ENV-013) can catch and only mode `cancelled` can encode.
    const c = compile(fanOut4);
    const wf = fakeWorkflow(fanOut4);
    const m = c.sharedMarking();
    const t = items({ t: 1 });
    const ok: OkPayload = { nodeSuccessData: [t, [], [], []], runIndex: 4 };
    const q = gadget(c, 'Q');
    expect(q.splitRouting).toBe(true);
    expect(q.routed).toBeNull();
    for (const o of q.outputs) put(m, o.ok!, [ok]);
    const x = encodeMarking(c, live(m), emptyState(), { mode: 'cancelled', node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([{ node: wf.nodes.S0, data: { main: [t] }, source: { main: [src('Q', 0, 4)] } }]);
  });

  it('cancelled: a node that routes inside X_run has already deposited its edges, so only X/routed is discarded', () => {
    // The collapsed shape has no window between the run and the routing: `close()` between
    // `X_run` and `X_done` leaves the arrivals on the consumers' own edge places, which the
    // ordinary encode paths read, plus one `X/routed` unit the refund never consumed.
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const m = c.sharedMarking();
    const t = items({ t: 1 });
    expect(gadget(c, 'IF').splitRouting).toBe(false);
    expect(gadget(c, 'IF').outputs.every((o) => o.ok === null)).toBe(true);
    put(m, gadget(c, 'IF').routed!, [null]);
    put(m, gadget(c, 'A').in!, [edge(t, src('IF', 0, 4))]);
    const x = encodeMarking(c, live(m), emptyState(), { mode: 'cancelled', node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([{ node: wf.nodes.A, data: { main: [t] }, source: { main: [src('IF', 0, 4)] } }]);
  });
});

describe('stranded mode (divergence #2)', () => {
  it('every pending token becomes a waitingExecution slot with a diagnostic naming node and place; the stack is emptied', () => {
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    const a = items({ a: 1 });
    const e = items({ e: 1 });
    m.delete(g.inputs[0]!.free!);
    put(m, g.inputs[0]!.ready!, [edge(a, src('A'))]);
    put(m, g.hasdata!, [null]);
    put(m, gadget(c, 'End').in!, [edge(e, src('Merge'))]);
    const diags: string[] = [];
    const s = stateOf([entryFor(wf.nodes.A!, [items(0)])]); // whatever was on the stack goes
    const x = encodeMarking(c, live(m), s, { mode: 'stranded', onDiagnostic: (d) => diags.push(d), node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([]);
    expect(x.waitingExecution).toEqual({ Merge: { 0: { main: [a, null] } }, End: { 0: { main: [e] } } });
    expect(x.waitingExecutionSource).toEqual({ Merge: { 0: { main: [src('A'), null] } }, End: { 0: { main: [src('Merge')] } } });
    expect(diags).toEqual([
      expect.stringMatching(/node 'Merge': stranded token on 'id:Merge\/ready_0' input 0 \(divergence #2\)/),
      expect.stringMatching(/node 'End': stranded token on 'id:End\/in' \(divergence #2\)/),
    ]);
  });

  it('a complete slot that could not start (a read arc never satisfied) is a stuck slot in stranded mode, a stack entry otherwise', () => {
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const m = c.sharedMarking();
    const g = gadget(c, 'Merge');
    m.delete(g.inputs[0]!.free!);
    m.delete(g.inputs[1]!.free!);
    put(m, g.inputs[0]!.ready!, [edge(items(1), src('A'))]);
    put(m, g.inputs[1]!.ready!, [null]);
    put(m, g.hasdata!, [null]);
    const stranded = encodeMarking(c, live(m), emptyState(), { mode: 'stranded', node: (n) => wf.nodes[n] });
    expect(stranded.nodeExecutionStack).toEqual([]);
    expect(slotsOf(stranded.waitingExecution, 'Merge')).toEqual([{ main: [items(1), []] }]);
    const paused = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(paused.nodeExecutionStack).toHaveLength(1);
  });
});

describe('the live INode of an entry', () => {
  it('options.node first, then an entry already on the stack naming the node, then a name-only stub', () => {
    const c = compile(linear);
    const wf = fakeWorkflow(linear);
    const m = c.sharedMarking();
    put(m, gadget(c, 'B').in!, [edge(items(1), src('A'))]);
    const viaOption = encodeMarking(c, live(m), emptyState(), { node: (n) => wf.nodes[n] });
    expect(viaOption.nodeExecutionStack[0]!.node).toBe(wf.nodes.B);
    const onStack: INode = { ...wf.nodes.B!, disabled: true };
    const viaStack = encodeMarking(c, live(m), stateOf([entryFor(onStack, [items(0)])]));
    expect(viaStack.nodeExecutionStack[0]!.node).toBe(onStack);
    const stub = encodeMarking(c, live(m), emptyState());
    expect(stub.nodeExecutionStack[0]!.node).toEqual({ id: 'id:B', name: 'B', type: 'set', typeVersion: 1, position: [0, 0], parameters: {} });
  });
});
