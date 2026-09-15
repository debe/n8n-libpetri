/**
 * `encodeMarking` under `cancelled`: the arrivals a token still on `X/ok_o` would have
 * produced, and what the encoder does when one of them names an edge the consumer's input
 * does not carry. The compiler never builds such a pair — producer and consumer are cut
 * from one analysis — so the mismatch is manufactured here by narrowing the consumer's
 * gadget: the point is that the encoder refuses it, in every input form, instead of
 * parking the arrival on a place the consumer never reads (a structural impossibility is a
 * `CodecError`, `src/codec.ts`).
 */
import type { NodeGadget } from '../../src/compiler/index.js';
import { CodecError, encodeMarking } from '../../src/codec.js';
import { compile, type CompiledWorkflow, type NetMapView } from '../../src/compiler/index.js';
import type { OkPayload } from '../../src/scheduler/index.js';
import { conn, node, workflow } from '../fixtures/workflows.js';
import { fakeWorkflow, items } from '../scheduler/support.js';
import { emptyState, gadget, live, put, src } from './support.js';
import { inOf, inputOf, splitOutputsOf } from '../compiler/support.js';

/** A four-output router (above `SPLIT_ROUTING_ABOVE`) whose last two outputs feed a join. */
const routerIntoJoin = workflow('router-into-join', [
  node('Trigger', 'trigger', [0, 0]),
  node('Q', 'switch4', [200, 0]),
  node('S0', 'set', [400, 0]),
  node('S1', 'set', [400, 100]),
  node('Merge', 'merge', [400, 200]),
], [
  conn('Trigger', 0, 'Q', 0),
  conn('Q', 0, 'S0', 0), conn('Q', 1, 'S1', 0),
  conn('Q', 2, 'Merge', 0), conn('Q', 3, 'Merge', 1),
], 'Trigger');

/** The same router with its last two outputs on one input of `C`: an OR-form consumer. */
const routerIntoOr = workflow('router-into-or', [
  node('Trigger', 'trigger', [0, 0]),
  node('Q', 'switch4', [200, 0]),
  node('S0', 'set', [400, 0]),
  node('S1', 'set', [400, 100]),
  node('C', 'set', [400, 200]),
], [
  conn('Trigger', 0, 'Q', 0),
  conn('Q', 0, 'S0', 0), conn('Q', 1, 'S1', 0),
  conn('Q', 2, 'C', 0), conn('Q', 3, 'C', 0),
], 'Trigger');

/** `c` with `name`'s gadget replaced in `netMap.nodes`; every other lookup stays the original's. */
function withGadget(c: CompiledWorkflow, name: string, g: NodeGadget): CompiledWorkflow {
  const nodes = c.netMap.nodes.map((n) => (n.node === name ? g : n));
  const netMap: NetMapView = Object.create(c.netMap, { nodes: { value: nodes } });
  return Object.create(c, { netMap: { value: netMap } });
}

describe('routed arrivals into a join', () => {
  it('cancelled: a data output on X/ok_o becomes the consumer input\'s arrival', () => {
    const c = compile(routerIntoJoin);
    const wf = fakeWorkflow(routerIntoJoin);
    const m = c.sharedMarking();
    const a = items({ a: 1 });
    const b = items({ b: 1 });
    const ok: OkPayload = { kind: 'ok', nodeSuccessData: [[], [], a, b], runIndex: 2 };
    for (const o of splitOutputsOf(gadget(c, 'Q'))) put(m, o.ok, [ok]);
    const x = encodeMarking(c, live(m), emptyState(), { mode: 'cancelled', node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([
      { node: wf.nodes.Merge, data: { main: [a, b] }, source: { main: [src('Q', 2, 2), src('Q', 3, 2)] } },
    ]);
  });

  it('an arrival over an edge the consumer\'s input does not carry is a CodecError naming node, edge and place', () => {
    const c = compile(routerIntoJoin);
    const wf = fakeWorkflow(routerIntoJoin);
    const merge = gadget(c, 'Merge');
    if (merge.form !== 'join') throw new Error('fixture: Merge is not a join');
    const input0 = inputOf(merge, 0);
    const missing = input0.edges.find((e) => e.edge.from === 'Q' && e.edge.outputIndex === 2);
    if (missing === undefined) throw new Error('fixture: Q.2 -> Merge.0 is not an edge of input 0');
    const narrowed: NodeGadget = {
      ...merge,
      inputs: merge.inputs.map((i) => (i === input0 ? { ...i, edges: i.edges.filter((e) => e !== missing) } : i)),
    };
    const patched = withGadget(c, 'Merge', narrowed);
    const m = c.sharedMarking();
    const ok: OkPayload = { kind: 'ok', nodeSuccessData: [[], [], items({ a: 1 }), items({ b: 1 })], runIndex: 0 };
    for (const o of splitOutputsOf(gadget(c, 'Q'))) put(m, o.ok, [ok]);
    const diagnostics: string[] = [];
    const encode = (): unknown => encodeMarking(patched, live(m), emptyState(), {
      mode: 'cancelled', node: (n) => wf.nodes[n], onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(encode).toThrow(CodecError);
    expect(encode).toThrow(/node 'Merge' input 0/);
    expect(encode).toThrow(new RegExp(`edge #${missing.edge.id} \\(Q\\.2 -> Merge\\.0\\)`));
    expect(encode).toThrow(/'id:Q\/ok_2'/);
    expect(diagnostics).toEqual([]);
  });

  it('an arrival over an input the join does not model is a CodecError, not silently ignored', () => {
    const c = compile(routerIntoJoin);
    const wf = fakeWorkflow(routerIntoJoin);
    const merge = gadget(c, 'Merge');
    if (merge.form !== 'join') throw new Error('fixture: Merge is not a join');
    const narrowed: NodeGadget = { ...merge, inputs: merge.inputs.filter((i) => i.index !== 1) };
    const patched = withGadget(c, 'Merge', narrowed);
    const m = c.sharedMarking();
    const ok: OkPayload = { kind: 'ok', nodeSuccessData: [[], [], items({ a: 1 }), items({ b: 1 })], runIndex: 0 };
    for (const o of splitOutputsOf(gadget(c, 'Q'))) put(m, o.ok, [ok]);
    const encode = (): unknown => encodeMarking(patched, live(m), emptyState(), { mode: 'cancelled', node: (n) => wf.nodes[n] });
    expect(encode).toThrow(CodecError);
    expect(encode).toThrow(/node 'Merge' input 1: an arrival routed from 'id:Q\/ok_3' over edge #\d+ \(Q\.3 -> Merge\.1\)/);
  });
});

describe('routed arrivals into an OR-form or a direct-form consumer', () => {
  it('cancelled: both outputs on X/ok_o become the OR input\'s arrivals', () => {
    const c = compile(routerIntoOr);
    const wf = fakeWorkflow(routerIntoOr);
    expect(gadget(c, 'C').form).toBe('or');
    const m = c.sharedMarking();
    const a = items({ a: 1 });
    const b = items({ b: 1 });
    const ok: OkPayload = { kind: 'ok', nodeSuccessData: [[], [], a, b], runIndex: 1 };
    for (const o of splitOutputsOf(gadget(c, 'Q'))) put(m, o.ok, [ok]);
    const x = encodeMarking(c, live(m), emptyState(), { mode: 'cancelled', node: (n) => wf.nodes[n] });
    expect(x.nodeExecutionStack).toEqual([
      { node: wf.nodes.C, data: { main: [a] }, source: { main: [src('Q', 2, 1)] } },
      { node: wf.nodes.C, data: { main: [b] }, source: { main: [src('Q', 3, 1)] } },
    ]);
  });

  /** `routerIntoOr` with `C`'s input narrowed to lose the edge `Q.2 -> C.0`. */
  function narrowedOr(): { readonly patched: CompiledWorkflow; readonly c: CompiledWorkflow; readonly id: number } {
    const c = compile(routerIntoOr);
    const or = gadget(c, 'C');
    if (or.form !== 'or') throw new Error('fixture: C is not in OR form');
    const [input0] = or.inputs;
    const missing = input0.edges.find((e) => e.edge.from === 'Q' && e.edge.outputIndex === 2);
    if (missing === undefined) throw new Error('fixture: Q.2 -> C.0 is not an edge of input 0');
    const narrowed: NodeGadget = { ...or, inputs: [{ ...input0, edges: input0.edges.filter((e) => e !== missing) }] };
    return { patched: withGadget(c, 'C', narrowed), c, id: missing.edge.id };
  }

  // Before the fix the data output was parked on `C/hasdata_0` and written back as a stack
  // entry of C, and the empty output counted as one more `[]` delivery of C's open round.
  it.each([
    ['a data output', items({ a: 1 })],
    ['an empty output', []],
  ] as const)('%s routed over an edge the OR input does not carry is a CodecError naming node, edge and place', (_what, out2) => {
    const { patched, c, id } = narrowedOr();
    const wf = fakeWorkflow(routerIntoOr);
    const m = c.sharedMarking();
    const ok: OkPayload = { kind: 'ok', nodeSuccessData: [[], [], [...out2], items({ b: 1 })], runIndex: 0 };
    for (const o of splitOutputsOf(gadget(c, 'Q'))) put(m, o.ok, [ok]);
    const diagnostics: string[] = [];
    const encode = (): unknown => encodeMarking(patched, live(m), emptyState(), {
      mode: 'cancelled', node: (n) => wf.nodes[n], onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(encode).toThrow(CodecError);
    expect(encode).toThrow(new RegExp(`node 'C' input 0: an arrival routed from 'id:Q/ok_2' over edge #${id} \\(Q\\.2 -> C\\.0\\)`));
    expect(diagnostics).toEqual([]);
  });

  it('an arrival over an edge the direct input does not carry is a CodecError naming node, edge and place', () => {
    const c = compile(routerIntoOr);
    const wf = fakeWorkflow(routerIntoOr);
    // S0's gadget carries S1's edge place, so the arrival over Q.0 -> S0.0 has no place in it.
    const narrowed: NodeGadget = { ...gadget(c, 'S0'), in: inOf(gadget(c, 'S1')) } as NodeGadget;
    const patched = withGadget(c, 'S0', narrowed);
    const m = c.sharedMarking();
    const ok: OkPayload = { kind: 'ok', nodeSuccessData: [items({ a: 1 }), [], [], []], runIndex: 0 };
    for (const o of splitOutputsOf(gadget(c, 'Q'))) put(m, o.ok, [ok]);
    const encode = (): unknown => encodeMarking(patched, live(m), emptyState(), { mode: 'cancelled', node: (n) => wf.nodes[n] });
    expect(encode).toThrow(CodecError);
    expect(encode).toThrow(/node 'S0' input 0: an arrival routed from 'id:Q\/ok_0' over edge #\d+ \(Q\.0 -> S0\.0\)/);
  });
});
