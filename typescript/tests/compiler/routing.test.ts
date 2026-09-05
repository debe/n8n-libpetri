/**
 * README "Verifier scaling": above `SPLIT_ROUTING_ABOVE` connected outputs a node routes
 * per output (`X/ok_o`, `X_route_o`, `X/routed_o`, `X_done`), so the flat branch count the
 * verifier's flatteners see (IO-016, `enumerateBranches`) is linear in the output count
 * instead of `2^k`. Nodes with at most three connected outputs keep the single `X_route`.
 */
import { enumerateBranches } from 'libpetri';
import { compile, forwardAllActions, routingActions, SPLIT_ROUTING_ABOVE, type CompiledWorkflow } from '../../src/compiler/index.js';
import { diamond, fanOut4, switch20 } from '../fixtures/workflows.js';
import { failed, gadget, inputNames, outputNames, runCompiled, started, tokenCounts, transitionOf, type Executor } from './support.js';

const ITEMS = { items: [{ json: { n: 1 } }] };

function branchTotal(c: CompiledWorkflow, node?: string): number {
  let n = 0;
  for (const t of c.net.transitions) {
    if (node !== undefined && c.netMap.transition(t.name)!.node !== node) continue;
    if (t.outputSpec !== null) n += enumerateBranches(t.outputSpec).length;
  }
  return n;
}

describe('split routing structure', () => {
  it('the threshold is three connected outputs', () => {
    expect(SPLIT_ROUTING_ABOVE).toBe(3);
    expect(gadget(compile(diamond), 'IF').splitRouting).toBe(false);
    expect(gadget(compile(fanOut4), 'Q').splitRouting).toBe(true);
  });

  it('X_run succeeds into and(ok_o …); X_route_o: one(ok_o) → and(xor(data_o, empty_o), routed_o); X_done: one(routed_*) → and(_budget, done)', () => {
    const c = compile(fanOut4);
    const q = gadget(c, 'Q');
    expect(q.ok).toBeNull();
    expect(q.outputs.map((o) => [o.index, o.ok!.name, o.routed!.name])).toEqual([
      [0, 'id:Q/ok_0', 'id:Q/routed_0'], [1, 'id:Q/ok_1', 'id:Q/routed_1'], [2, 'id:Q/ok_2', 'id:Q/routed_2'], [3, 'id:Q/ok_3', 'id:Q/routed_3'],
    ]);
    const run = transitionOf(c, 'Q', 'run');
    expect(enumerateBranches(run.outputSpec!).map((b) => [...b].map((p) => p.name).sort())).toEqual([
      ['id:Q/idle', 'id:Q/ok_0', 'id:Q/ok_1', 'id:Q/ok_2', 'id:Q/ok_3'],
      ['_budget', '_halt', 'id:Q/idle'],
    ]);
    expect(q.transitions.routes).toEqual(['id:Q/route_0', 'id:Q/route_1', 'id:Q/route_2', 'id:Q/route_3']);
    for (const [o, name] of q.transitions.routes.entries()) {
      const t = c.netMap.transitionObject(name);
      expect(inputNames(t)).toEqual([`id:Q/ok_${o}`]);
      expect(outputNames(t)).toEqual([`id:Q/routed_${o}`, `id:S${o}/in`, `id:S${o}/in_empty`]);
      expect(enumerateBranches(t.outputSpec!)).toHaveLength(2);
      expect(c.netMap.transition(name)).toMatchObject({ role: 'route', node: 'Q', port: o });
      expect(c.netMap.transitionFor('Q', 'route', o)!.name).toBe(name);
    }
    const done = c.netMap.transitionObject(q.transitions.done!);
    expect(inputNames(done)).toEqual(['id:Q/routed_0', 'id:Q/routed_1', 'id:Q/routed_2', 'id:Q/routed_3']);
    expect(outputNames(done)).toEqual(['_budget', 'id:Q/done']);
    expect(c.netMap.transition('id:Q/done')).toMatchObject({ role: 'done', node: 'Q' });
    expect(c.netMap.placeFor('Q', 'ok', 2)!.name).toBe('id:Q/ok_2');
    expect(c.netMap.placeFor('Q', 'routed', 3)!.name).toBe('id:Q/routed_3');
  });

  it('a node with at most three connected outputs keeps one X_route refunding the budget itself', () => {
    const c = compile(diamond);
    const g = gadget(c, 'IF');
    expect(g.transitions.routes).toEqual(['id:IF/route']);
    expect(g.transitions.done).toBeNull();
    expect(g.outputs.every((o) => o.ok === null && o.routed === null)).toBe(true);
    expect(outputNames(transitionOf(c, 'IF', 'route'))).toContain('_budget');
  });

  it('Switch(20): the branch count is linear in the output count (45 for the Switch, not 2^20)', () => {
    const c = compile(switch20);
    const sw = gadget(c, 'Switch');
    expect(sw.splitRouting).toBe(true);
    expect(sw.transitions.routes).toHaveLength(20);
    for (const r of sw.transitions.routes) expect(enumerateBranches(c.netMap.transitionObject(r).outputSpec!)).toHaveLength(2);
    // start 1 + run 2 + 20 routes × 2 + done 1 + skip 1
    expect(branchTotal(c, 'Switch')).toBe(45);
    expect(branchTotal(c, 'Switch')).toBeLessThan(100);
    // Whole net: 20 leaves × 5 + Trigger 5 + Switch 45 + reap 1.
    expect(branchTotal(c)).toBe(151);
    expect(branchTotal(c)).toBeLessThan(200);
    expect(c.program.transitionCount).toBe(c.net.transitions.size);
  });
});

describe.each<Executor>(['precompiled', 'bitmap'])('split routing end to end on %s', (executor) => {
  it('a four-output node routes every output, X/done is marked exactly once and the budget is back at k', async () => {
    const c = compile(fanOut4, { budget: 2 }).withActions(forwardAllActions());
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    const q = gadget(c, 'Q');
    expect(marking.tokenCount(q.done)).toBe(1);
    for (const g of c.netMap.nodes) expect(marking.tokenCount(g.done), g.node).toBe(1);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(2);
    expect(tokenCounts(marking, q.outputs.flatMap((o) => [o.ok!, o.routed!])).every((n) => n === 0)).toBe(true);
    expect(started(store, (n) => n.startsWith('id:Q/'))).toEqual([
      'id:Q/start', 'id:Q/run', 'id:Q/route_0', 'id:Q/route_1', 'id:Q/route_2', 'id:Q/route_3', 'id:Q/done',
    ]);
    // The budget is refunded by X_done, after every edge was deposited (depth-first at k = 1 keeps holding).
    const names = started(store);
    expect(names.indexOf('id:Q/done')).toBeLessThan(names.indexOf('id:S0/start'));
  });

  it('under no-data routing Q is skipped (its skip writes every empty edge) and the four successors skip once each', async () => {
    const c = compile(fanOut4);
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(marking.tokenCount(gadget(c, 'Q').skipped!)).toBe(1);
    expect(marking.tokenCount(gadget(c, 'Q').done)).toBe(0);
    for (const s of ['S0', 'S1', 'S2', 'S3']) expect(marking.tokenCount(gadget(c, s).skipped!)).toBe(1);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
  });

  it('Q runs but routes empty everywhere: every route_o takes the empty branch and X_done still refunds once', async () => {
    const c = compile(fanOut4).withActions(routingActions((g) => (g.node === 'Q' ? 'no-data' : 'data')));
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(marking.tokenCount(gadget(c, 'Q').done)).toBe(1);
    for (const s of ['S0', 'S1', 'S2', 'S3']) expect(marking.tokenCount(gadget(c, s).skipped!)).toBe(1);
    expect(started(store, (n) => n === 'id:Q/done')).toHaveLength(1);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
  });
});
