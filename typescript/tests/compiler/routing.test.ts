/**
 * How a node's success outcome reaches its edges, and where `_budget` comes back.
 *
 * `X_run` routes every connected output **in its own `Out` spec** and marks `X/routed`;
 * `X_done: one(X/routed) → and(_budget, X/done)` refunds one scheduling cycle later, which
 * is the cycle a join / OR consumer's `arm` fires in (ADR 0004's M4 amendment — the phase
 * that gives n8n's depth-first order at k = 1). There is no `X/ok` and no `X_route`.
 *
 * A node with **more than `SPLIT_ROUTING_ABOVE` (3) connected outputs** keeps the older
 * split shape — `X_run` writes `X/ok_o`, `X_route_o` routes it and marks `X/routed_o`,
 * `X_done` consumes all of them — because an `and` of `k` `xor`s is `2^k` flat branches
 * (IO-016, `enumerateBranches`): `X_run` costs `2^k + 4` collapsed against `2k + 5` split.
 * `X_done` exists at both shapes, so the refund phase is identical either way.
 */
import { enumerateBranches } from 'libpetri';
import { compile, forwardAllActions, routingActions, SPLIT_ROUTING_ABOVE, type CompiledWorkflow } from '../../src/compiler/index.js';
import { diamond, fanOut3, fanOut4, switch20 } from '../fixtures/workflows.js';
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

describe('routing inside X_run (at or below SPLIT_ROUTING_ABOVE)', () => {
  it('the threshold is 3: collapsed up to and including three outputs, split from four', () => {
    expect(SPLIT_ROUTING_ABOVE).toBe(3);
    expect(gadget(compile(diamond), 'Trigger').splitRouting).toBe(false); // 1 output
    expect(gadget(compile(diamond), 'IF').splitRouting).toBe(false);      // 2 outputs
    expect(gadget(compile(diamond), 'End').splitRouting).toBe(false);     // terminal
    expect(gadget(compile(fanOut3), 'Q').splitRouting).toBe(false);       // 3 outputs
    expect(gadget(compile(fanOut4), 'Q').splitRouting).toBe(true);        // 4 outputs
  });

  it('three outputs is where it is a trade: one more flat branch, five fewer places, three fewer transitions', () => {
    // `X_run` alone costs `2^k + 4` collapsed and `2k + 5` split (IO-016,
    // `tests/spikes/collapsed-outcome.test.ts`), so at k = 3 the split is one branch
    // cheaper — 11 against 12 — and that is the only axis on which it wins. Measured on
    // `fanOut3` with the threshold moved to 2, i.e. the same workflow compiled split:
    // 51 places / 22 transitions / 41 net branches / **461** state classes, against the
    // collapsed 46 / 19 / 42 / **360**. One flat branch buys 22 % of the state-class graph,
    // which is why the threshold is 3 and not 2. From four outputs the branch count runs
    // away (20 against 13, then 68 against 17) and the split wins outright.
    const c = compile(fanOut3);
    const q = gadget(c, 'Q');
    expect(q.splitRouting).toBe(false);
    expect(q.routed!.name).toBe('id:Q/routed');
    expect(q.transitions.routes).toEqual([]);
    expect({ places: c.net.places.size, transitions: c.net.transitions.size }).toEqual({ places: 46, transitions: 19 });
    expect(branchTotal(c)).toBe(42);
    expect(branchTotal(c, 'Q')).toBe(14); // 2^3 success + halt + waiting + stopped + start + done + skip
  });

  it('one output: X_run routes it and marks X/routed; X_done refunds the budget; no X/ok, no X_route', () => {
    const c = compile(diamond);
    const g = gadget(c, 'Trigger');
    expect(g.routed!.name).toBe('id:Trigger/routed');
    expect(g.outputs.map((o) => [o.index, o.ok, o.routed])).toEqual([[0, null, null]]);
    expect(g.transitions.routes).toEqual([]);
    expect(g.transitions.done).toBe('id:Trigger/done');
    expect(c.netMap.placeFor('Trigger', 'ok', 0)).toBeUndefined();
    expect(c.netMap.transitionFor('Trigger', 'route')).toBeUndefined();

    const run = transitionOf(c, 'Trigger', 'run');
    expect(inputNames(run)).toEqual(['id:Trigger/running']);
    expect(enumerateBranches(run.outputSpec!).map((b) => [...b].map((p) => p.name).sort())).toEqual([
      ['id:IF/in', 'id:Trigger/idle', 'id:Trigger/routed'],
      ['id:IF/in_empty', 'id:Trigger/idle', 'id:Trigger/routed'],
      ['_budget', '_halt', 'id:Trigger/idle'],
      ['_budget', '_pause', 'id:Trigger/idle', 'id:Trigger/waiting'],
      ['_budget', '_pause', 'id:Trigger/idle', 'id:Trigger/stopped'],
    ]);

    const done = c.netMap.transitionObject(g.transitions.done);
    expect(inputNames(done)).toEqual(['id:Trigger/routed']);
    expect(outputNames(done)).toEqual(['_budget', 'id:Trigger/done']);
    expect(c.netMap.transition('id:Trigger/done')).toMatchObject({ role: 'done', node: 'Trigger' });
    expect(c.netMap.placeFor('Trigger', 'routed')!.name).toBe('id:Trigger/routed');
  });

  it('two outputs: the success branch is the and of both xors — four success branches, still one X/routed', () => {
    const c = compile(diamond);
    const g = gadget(c, 'IF');
    expect(g.routed!.name).toBe('id:IF/routed');
    expect(g.transitions.routes).toEqual([]);
    expect(g.transitions.done).toBe('id:IF/done');
    expect(g.outputs.map((o) => [o.ok, o.routed])).toEqual([[null, null], [null, null]]);
    const branches = enumerateBranches(transitionOf(c, 'IF', 'run').outputSpec!);
    // 2^2 success combinations + halt + waiting + stopped.
    expect(branches).toHaveLength(7);
    expect(branches.slice(0, 4).map((b) => [...b].map((p) => p.name).filter((n) => /^id:[AB]\//.test(n)).sort())).toEqual([
      ['id:A/in', 'id:B/in'], ['id:A/in', 'id:B/in_empty'],
      ['id:A/in_empty', 'id:B/in'], ['id:A/in_empty', 'id:B/in_empty'],
    ]);
    for (const b of branches.slice(0, 4)) expect([...b].map((p) => p.name)).toContain('id:IF/routed');
  });

  it('no connected output: the success branch is just X/routed, and X_done still refunds', () => {
    const c = compile(diamond);
    const g = gadget(c, 'End');
    expect(g.outputs).toEqual([]);
    expect(g.transitions.routes).toEqual([]);
    expect(g.transitions.done).toBe('id:End/done');
    expect(g.routed!.name).toBe('id:End/routed');
    expect(enumerateBranches(transitionOf(c, 'End', 'run').outputSpec!).map((b) => [...b].map((p) => p.name).sort())).toEqual([
      ['id:End/idle', 'id:End/routed'],
      ['_budget', '_halt', 'id:End/idle'],
      ['_budget', '_pause', 'id:End/idle', 'id:End/waiting'],
      ['_budget', '_pause', 'id:End/idle', 'id:End/stopped'],
    ]);
    expect(outputNames(c.netMap.transitionObject(g.transitions.done))).toEqual(['_budget', 'id:End/done']);
  });
});

describe('per-output routing (above SPLIT_ROUTING_ABOVE)', () => {
  it('X_run succeeds into and(ok_o …); X_route_o: one(ok_o) → and(xor(data_o, empty_o), routed_o); X_done: one(routed_*) → and(_budget, done)', () => {
    const c = compile(fanOut4);
    const q = gadget(c, 'Q');
    expect(q.routed).toBeNull();
    expect(q.outputs.map((o) => [o.index, o.ok!.name, o.routed!.name])).toEqual([
      [0, 'id:Q/ok_0', 'id:Q/routed_0'], [1, 'id:Q/ok_1', 'id:Q/routed_1'], [2, 'id:Q/ok_2', 'id:Q/routed_2'], [3, 'id:Q/ok_3', 'id:Q/routed_3'],
    ]);
    const run = transitionOf(c, 'Q', 'run');
    // Success, halt, plus the two M2 pause outcomes (waiting / stopped).
    expect(enumerateBranches(run.outputSpec!).map((b) => [...b].map((p) => p.name).sort())).toEqual([
      ['id:Q/idle', 'id:Q/ok_0', 'id:Q/ok_1', 'id:Q/ok_2', 'id:Q/ok_3'],
      ['_budget', '_halt', 'id:Q/idle'],
      ['_budget', '_pause', 'id:Q/idle', 'id:Q/waiting'],
      ['_budget', '_pause', 'id:Q/idle', 'id:Q/stopped'],
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
    const done = c.netMap.transitionObject(q.transitions.done);
    expect(inputNames(done)).toEqual(['id:Q/routed_0', 'id:Q/routed_1', 'id:Q/routed_2', 'id:Q/routed_3']);
    expect(outputNames(done)).toEqual(['_budget', 'id:Q/done']);
    expect(c.netMap.transition('id:Q/done')).toMatchObject({ role: 'done', node: 'Q' });
    expect(c.netMap.placeFor('Q', 'ok', 2)!.name).toBe('id:Q/ok_2');
    expect(c.netMap.placeFor('Q', 'routed', 3)!.name).toBe('id:Q/routed_3');
  });

  it('Switch(20): the branch count is linear in the output count (47 for the Switch, not 2^20)', () => {
    const c = compile(switch20);
    const sw = gadget(c, 'Switch');
    expect(sw.splitRouting).toBe(true);
    expect(sw.transitions.routes).toHaveLength(20);
    for (const r of sw.transitions.routes) expect(enumerateBranches(c.netMap.transitionObject(r).outputSpec!)).toHaveLength(2);
    // start 1 + run 4 (ok | halt | waiting | stopped: M2 added the two pause outcomes to
    // every X_run, +2 per node) + 20 routes × 2 + done 1 + skip 1
    expect(branchTotal(c, 'Switch')).toBe(47);
    expect(branchTotal(c, 'Switch')).toBeLessThan(100);
    // Whole net: 20 leaves × 7 (start 1, run 4 — the success branch is the bare X/routed —,
    // done 1, skip 1) + Trigger 7 (start 1, run 5: two success combinations for its one
    // output plus halt / waiting / stopped, done 1) + Switch 47 = 194. It was 196 when every
    // node carried an X/ok and an X_route and the net carried a `_halt_reap`: collapsing the
    // routing removes one branch per leaf's route and adds one per leaf's run, so switch20 —
    // dominated by the Switch, which still splits — barely moves. Linear either way.
    expect(branchTotal(c)).toBe(194);
    expect(branchTotal(c)).toBeLessThan(250);
    expect(c.program.transitionCount).toBe(c.net.transitions.size);
  });
});

describe.each<Executor>(['precompiled', 'bitmap'])('per-output routing end to end on %s', (executor) => {
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

describe.each<Executor>(['precompiled', 'bitmap'])('collapsed routing end to end on %s', (executor) => {
  it('a two-output node deposits both edges and marks X/routed in one firing; X_done refunds one cycle later', async () => {
    const c = compile(diamond).withActions(forwardAllActions());
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(started(store, (n) => n.startsWith('id:IF/'))).toEqual(['id:IF/start', 'id:IF/run', 'id:IF/done']);
    for (const g of c.netMap.nodes) expect(marking.tokenCount(g.routed!), g.node).toBe(0);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
    // The consumers' arms and X_done fire in the same cycle, so both candidate starts land
    // in one ready set and priority decides (ADR 0004, divergence #20).
    const all = started(store);
    expect(all.indexOf('id:IF/done')).toBeLessThan(all.indexOf('id:A/start'));
  });
});
