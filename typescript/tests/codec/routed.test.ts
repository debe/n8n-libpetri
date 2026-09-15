/**
 * `encodeMarking` under `cancelled`: the arrivals a token still on `X/ok_o` would have
 * produced, and what the encoder does when one of them names an edge the consumer's input
 * does not carry. The compiler never builds such a pair — producer and consumer are cut
 * from one analysis — so the mismatch is manufactured here by narrowing the consumer's
 * gadget: the point is that the encoder refuses it instead of parking the arrival on
 * `X/running`, a place the join never reads.
 */
import type { NodeGadget } from '../../src/compiler/index.js';
import { CodecError, encodeMarking } from '../../src/codec.js';
import { compile, type CompiledWorkflow, type NetMapView } from '../../src/compiler/index.js';
import type { OkPayload } from '../../src/scheduler/index.js';
import { conn, node, workflow } from '../fixtures/workflows.js';
import { fakeWorkflow, items } from '../scheduler/support.js';
import { emptyState, gadget, live, put, src } from './support.js';
import { inputOf, splitOutputsOf } from '../compiler/support.js';

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
});
