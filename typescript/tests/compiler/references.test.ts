/**
 * README "Expression references": `$('Y')` compiles by where `Y` sits relative to `X`.
 * Reachable avoiding `X`: `read(Y/done)` on `X_start` plus an `X_start_unmet` twin on
 * `Y/skipped` (lower priority) that tags the running token. Unreachable: the same arcs and
 * `Y/skipped` seeded. Reachable only through `X`: no arc, a diagnostic.
 */
import { compile, routingActions, type UnmetReferencePayload } from '../../src/compiler/index.js';
import { conn, expressionRef, node, workflow } from '../fixtures/workflows.js';
import { failed, gadget, readNames, runCompiled, started, transitionOf, type Executor } from './support.js';

const ITEMS = { items: [{ json: { n: 1 } }] };

describe('reference classification', () => {
  it('Y on a parallel branch: read arc + twin, no diagnostic', () => {
    const c = compile(expressionRef);
    expect(c.analysis.byName.get('B')!.references).toEqual([{ node: 'A', kind: 'read' }]);
    expect(c.diagnostics).toEqual([]);
    expect(gadget(c, 'A').skipped).not.toBeNull();
  });

  it('Y downstream of X (reachable only through X): no arc, a diagnostic naming the pair', () => {
    const c = compile(workflow('down', [node('T', 'trigger', [0, 0]), node('X', 'set', [100, 0]), node('Y', 'set', [200, 0])],
      [conn('T', 0, 'X', 0), conn('X', 0, 'Y', 0)], 'T', { references: { X: ['Y'] } }));
    expect(c.analysis.byName.get('X')!.references).toEqual([{ node: 'Y', kind: 'unguarded' }]);
    expect(readNames(transitionOf(c, 'X', 'start'))).toEqual([]);
    expect(gadget(c, 'X').transitions.startUnmet).toEqual([]);
    expect(gadget(c, 'X').references).toEqual([]);
    expect(gadget(c, 'X').unguardedReferences).toEqual(['Y']);
    expect(c.diagnostics).toEqual([
      "node 'X' references 'Y', which is reachable only through 'X'; no read arc, the expression fails inside the action as in n8n",
    ]);
  });

  it('Y in the same loop, later in the body (loop-back reference): no arc, so the first iteration is not deadlocked', () => {
    // T -> X -> Y -> X (cycle), X references Y.
    const c = compile(workflow('loop-back', [node('T', 'trigger', [0, 0]), node('X', 'set', [100, 0]), node('Y', 'set', [200, 0])],
      [conn('T', 0, 'X', 0), conn('X', 0, 'Y', 0), conn('Y', 0, 'X', 0)], 'T', { references: { X: ['Y'] } }));
    expect(c.analysis.byName.get('X')!.references).toEqual([{ node: 'Y', kind: 'unguarded' }]);
    expect(readNames(transitionOf(c, 'X', 'start'))).toEqual([]);
    expect(c.diagnostics).toHaveLength(1);
  });

  it('Y upstream on the same path (T -> Y -> X): Y is reachable avoiding X, so the read arc is kept', () => {
    const c = compile(workflow('up', [node('T', 'trigger', [0, 0]), node('Y', 'set', [100, 0]), node('X', 'set', [200, 0])],
      [conn('T', 0, 'Y', 0), conn('Y', 0, 'X', 0)], 'T', { references: { X: ['Y'] } }));
    expect(c.analysis.byName.get('X')!.references).toEqual([{ node: 'Y', kind: 'read' }]);
    expect(readNames(transitionOf(c, 'X', 'start'))).toEqual(['id:Y/done']);
    expect(readNames(c.netMap.transitionObject('id:X/start_unmet_0'))).toEqual(['id:Y/skipped']);
  });

  it('Y unreachable from the start node: read arc + twin, Y/skipped seeded, a diagnostic', () => {
    const c = compile(workflow('unreach', [node('T', 'trigger', [0, 0]), node('Other', 'trigger', [0, 100]), node('X', 'set', [200, 0])],
      [conn('T', 0, 'X', 0)], 'T', { references: { X: ['Other'] } }));
    expect(c.analysis.byName.get('X')!.references).toEqual([{ node: 'Other', kind: 'seeded' }]);
    expect(readNames(transitionOf(c, 'X', 'start'))).toEqual(['id:Other/done']);
    expect(gadget(c, 'X').transitions.startUnmet).toEqual(['id:X/start_unmet_0']);
    expect([...c.analysis.seededSkipped]).toEqual(['Other']);
    expect(c.diagnostics).toEqual([
      "node 'X' references 'Other', which is unreachable from the start node; 'Other/skipped' is seeded and the reference always fails",
    ]);
  });

  it('several references: one twin per guarded reference, each tagged; the hash sees the classification', () => {
    const base = workflow('multi', [
      node('T', 'trigger', [0, 0]), node('IF', 'if', [100, 0]), node('A', 'set', [200, -100]), node('B', 'set', [200, 100]),
      node('X', 'set', [300, 0]), node('Down', 'set', [400, 0]),
    ], [conn('T', 0, 'IF', 0), conn('IF', 0, 'A', 0), conn('IF', 1, 'B', 0), conn('B', 0, 'X', 0), conn('X', 0, 'Down', 0)], 'T');
    const c = compile({ ...base, expressionReferences: (n) => (n.name === 'X' ? ['A', 'Down', 'T'] : []) });
    const x = gadget(c, 'X');
    expect(x.references).toEqual(['A', 'T']);
    expect(x.unguardedReferences).toEqual(['Down']);
    expect(x.transitions.startUnmet).toEqual(['id:X/start_unmet_0', 'id:X/start_unmet_1']);
    expect(c.netMap.transition('id:X/start_unmet_0')!.reference).toBe('A');
    expect(c.netMap.transition('id:X/start_unmet_1')!.reference).toBe('T');
    expect(readNames(transitionOf(c, 'X', 'start'))).toEqual(['id:A/done', 'id:T/done']);
    const other = compile({ ...base, expressionReferences: (n) => (n.name === 'X' ? ['A', 'T'] : []) });
    expect(other.structuralHash).not.toBe(c.structuralHash);
  });
});

describe.each<Executor>(['precompiled', 'bitmap'])('reference twin end to end on %s', (executor) => {
  it('IF routes to A only: B waits for A/done and runs through X_start', async () => {
    const c = compile(expressionRef).withActions(routingActions(() => 'data'));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(marking.tokenCount(gadget(c, 'B').done)).toBe(1);
    expect(started(store, (n) => n.startsWith('id:B/start'))).toEqual(['id:B/start']);
    const order = started(store);
    expect(order.indexOf('id:A/route')).toBeLessThan(order.indexOf('id:B/start'));
  });

  it('IF routes to B only (A skipped): B runs through the twin with the running token tagged, nothing strands', async () => {
    let tagged: unknown = null;
    const c = compile(expressionRef)
      .withActions(routingActions((g, o) => (g.node === 'IF' ? (o.index === 1 ? 'data' : 'no-data') : 'data')))
      .withActions((info, map) => {
        if (info.role !== 'run' || info.node !== 'B') return null;
        const g = map.node('B');
        return async (ctx) => {
          tagged = ctx.input(g.running);
          // B has one connected output; `X_run` routes it and marks `X/routed` (ADR 0004).
          for (const out of g.outputs) for (const e of out.edges) ctx.output(e.data, tagged);
          ctx.output(g.routed!, null);
          ctx.output(g.idle, null);
        };
      });
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(marking.tokenCount(gadget(c, 'A').skipped!)).toBe(1);
    expect(marking.tokenCount(gadget(c, 'B').done)).toBe(1);
    expect(marking.tokenCount(gadget(c, 'B').in!)).toBe(0);
    expect(started(store, (n) => n.startsWith('id:B/start'))).toEqual(['id:B/start_unmet_0']);
    expect(tagged as UnmetReferencePayload).toEqual({ unmetReference: 'A', input: ITEMS });
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
  });

  it('a reference to an unreachable node fires the twin from the seeded Y/skipped', async () => {
    const wf = workflow('unreach', [node('T', 'trigger', [0, 0]), node('Other', 'trigger', [0, 100]), node('X', 'set', [200, 0])],
      [conn('T', 0, 'X', 0)], 'T', { references: { X: ['Other'] } });
    const c = compile(wf).withActions(routingActions(() => 'data'));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(started(store, (n) => n.startsWith('id:X/start'))).toEqual(['id:X/start_unmet_0']);
    expect(marking.tokenCount(gadget(c, 'X').done)).toBe(1);
    expect(marking.tokenCount(gadget(c, 'Other').skipped!)).toBe(1); // read arcs do not consume
  });
});
