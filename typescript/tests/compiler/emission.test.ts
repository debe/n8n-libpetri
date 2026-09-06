/**
 * The emission rule per edge kind (README "Emission rule", ADR 0002) read off the Out specs
 * of `X_route` / `X_skip`, the join gadget (ADR 0003), the chooseBranch enumeration, the
 * retry gadget, expression read arcs (CORE-032), the error output, unconnected outputs and
 * the halt / reap wiring (CORE-034).
 */
import { enumerateBranches, type Transition } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import {
  chooseBranch, continueErrorOutput, diamond, expressionRef, ifHalf, loopOverItems, multiProducer, retry,
  twoTriggers, userCycle,
} from '../fixtures/workflows.js';
import {
  edgeSlot, gadget, inhibitorNames, inputNames, outputNames, placeNames, readNames, resetNames, transitionOf,
} from './support.js';

function branchesOf(t: Transition): string[][] {
  return enumerateBranches(t.outputSpec!).map((b) => [...b].map((p) => p.name).sort());
}

describe('emission rule: tree edge from an acyclic producer carries data | empty', () => {
  const c = compile(diamond);

  it('X_route offers data or empty per edge, and refunds budget + marks done on every branch', () => {
    const route = transitionOf(c, 'IF', 'route');
    const toA = edgeSlot(c, 'IF', 0, 'A', 0);
    const toB = edgeSlot(c, 'IF', 1, 'B', 0);
    expect(toA.data.name).toBe('id:A/in');
    expect(toA.empty!.name).toBe('id:A/in_empty');
    expect(outputNames(route)).toEqual(['_budget', 'id:A/in', 'id:A/in_empty', 'id:B/in', 'id:B/in_empty', 'id:IF/done'].sort());
    const branches = branchesOf(route);
    expect(branches).toHaveLength(4); // 2 outputs × (data | empty)
    for (const b of branches) {
      expect(b).toContain('_budget');
      expect(b).toContain('id:IF/done');
      expect(b.includes(toA.data.name) !== b.includes(toA.empty!.name)).toBe(true);
      expect(b.includes(toB.data.name) !== b.includes(toB.empty!.name)).toBe(true);
    }
    expect(gadget(c, 'IF').outputs.every((o) => o.nil === null)).toBe(true);
  });

  it('X_skip emits empty on every outgoing tree edge and marks skipped; no nil places exist', () => {
    const skip = transitionOf(c, 'IF', 'skip');
    expect(inputNames(skip)).toEqual(['id:IF/in_empty']);
    expect(outputNames(skip)).toEqual(['id:A/in_empty', 'id:B/in_empty', 'id:IF/skipped']);
    expect(placeNames(c, (n) => n.includes('/nil_'))).toEqual([]);
    expect(c.netMap.transitions.filter((t) => t.role === 'sink')).toEqual([]);
  });

  it('a node with no connected outputs still refunds budget and marks done', () => {
    const route = transitionOf(c, 'End', 'route');
    expect(outputNames(route)).toEqual(['_budget', 'id:End/done']);
    expect(gadget(c, 'End').outputs).toEqual([]);
  });
});

describe('emission rule inside a cycle (Loop Over Items)', () => {
  const c = compile(loopOverItems);

  it('classifies the edges: Trigger->Loop and Loop->After are tree edges, Loop->Body and Body->Loop cycle edges', () => {
    const kinds = Object.fromEntries(c.analysis.edges.map((e) => [`${e.from}.${e.outputIndex}->${e.to}.${e.inputIndex}`, e.kind]));
    expect(kinds).toEqual({
      'Trigger.0->Loop.0': 'tree', 'Loop.0->Body.0': 'cycle', 'Body.0->Loop.0': 'cycle', 'Loop.1->After.0': 'tree',
    });
    expect([...c.analysis.cyclic].sort()).toEqual(['Body', 'Loop']);
    expect(gadget(c, 'Loop').loopNode).toBe(true);
    expect(gadget(c, 'Loop').outputs.map((o) => o.name)).toEqual(['loop', 'done']);
  });

  it('tree edge from a cyclic producer: data | nil on run, empty on skip', () => {
    const loop = gadget(c, 'Loop');
    const exit = edgeSlot(c, 'Loop', 1, 'After', 0);
    expect(exit.empty!.name).toBe('id:After/in_empty'); // the consumer still owns the empty place
    const route = transitionOf(c, 'Loop', 'route');
    expect(outputNames(route)).toContain('id:After/in');
    expect(outputNames(route)).toContain('id:Loop/nil_1');
    expect(outputNames(route)).not.toContain('id:After/in_empty');
    const skip = transitionOf(c, 'Loop', 'skip');
    expect(outputNames(skip)).toEqual(['id:After/in_empty', 'id:Loop/free_0', 'id:Loop/skipped']);
    expect(loop.outputs[1]!.nil!.name).toBe('id:Loop/nil_1');
  });

  it('cycle edge: data | nil on run, nothing on skip, and no empty place at all', () => {
    const body = edgeSlot(c, 'Loop', 0, 'Body', 0);
    expect(body.empty).toBeNull();
    expect(placeNames(c, (n) => n.startsWith('id:Body/in'))).toEqual(['id:Body/in']);
    const route = transitionOf(c, 'Loop', 'route');
    const branches = branchesOf(route);
    expect(branches).toHaveLength(4);
    for (const b of branches) {
      expect(b.includes('id:Body/in') !== b.includes('id:Loop/nil_0')).toBe(true);
      expect(b.includes('id:After/in') !== b.includes('id:Loop/nil_1')).toBe(true);
    }
    // Body sits on a cycle edge only: no in_empty, no skip, no skipped marker.
    const bodyGadget = gadget(c, 'Body');
    expect(bodyGadget.inEmpty).toBeNull();
    expect(bodyGadget.skipped).toBeNull();
    expect(bodyGadget.transitions.skip).toEqual([]);
    expect(outputNames(transitionOf(c, 'Body', 'route'))).toEqual(['_budget', 'id:Body/done', 'id:Body/nil_0', 'id:Loop/in0_e3']);
  });

  it('nil places are consumed by genuine sinks with no Out spec (CORE-043 AC4)', () => {
    const sinks = c.netMap.transitions.filter((t) => t.role === 'sink').map((t) => t.name).sort();
    expect(sinks).toEqual(['id:Body/sink_0', 'id:Loop/sink_0', 'id:Loop/sink_1']);
    for (const s of sinks) {
      const t = c.netMap.transitionObject(s);
      expect(t.outputSpec).toBeNull();
      expect(t.inputSpecs).toHaveLength(1);
      expect(t.inputSpecs[0]!.place.name.includes('/nil_')).toBe(true);
    }
  });

  it('the loop node is a join over its single input (two producers), arms per edge', () => {
    // Edge ids follow canonical order (producer canvas index, output, consumer canvas index, input):
    // canvas order here is After, Trigger, Loop, Body, so Trigger->Loop is e0 and Body->Loop is e3.
    const loop = gadget(c, 'Loop');
    expect(loop.form).toBe('join');
    expect(loop.inputs).toHaveLength(1);
    expect(loop.inputs[0]!.edges.map((e) => `${e.edge.from}:${e.edge.kind}`)).toEqual(['Trigger:tree', 'Body:cycle']);
    expect(loop.transitions.arms).toEqual(['id:Loop/arm_e0_data', 'id:Loop/arm_e0_empty', 'id:Loop/arm_e3_data']);
  });
});

describe('a user cycle without a loop node', () => {
  const c = compile(userCycle);

  it('B (cyclic, no skip) never writes the empty place of its tree edge to Exit; Exit still owns it', () => {
    const route = transitionOf(c, 'B', 'route');
    expect(outputNames(route)).toEqual(['_budget', 'id:A/in0_e2', 'id:B/done', 'id:B/nil_0', 'id:Exit/in']);
    expect(gadget(c, 'B').transitions.skip).toEqual([]);
    expect(placeNames(c, (n) => n.startsWith('id:Exit/in'))).toEqual(['id:Exit/in', 'id:Exit/in_empty']);
    const branches = branchesOf(route);
    expect(branches).toHaveLength(2); // one output: and(both data edges) | nil
    expect(branches).toContainEqual(['_budget', 'id:A/in0_e2', 'id:B/done', 'id:Exit/in']);
    expect(branches).toContainEqual(['_budget', 'id:B/done', 'id:B/nil_0']);
  });

  it('A (cyclic entry) is a join with a skip that only touches its tree edges', () => {
    const skip = transitionOf(c, 'A', 'skip');
    expect(outputNames(skip)).toEqual(['id:A/free_0', 'id:A/skipped']); // A -> B is a cycle edge: nothing on skip
  });
});

describe('join gadget (ADR 0003)', () => {
  const c = compile(diamond);
  const merge = () => gadget(c, 'Merge');

  it('arm per edge consuming free_i; data arms count hasdata', () => {
    const armData = c.netMap.transitionObject('id:Merge/arm_e0_data');
    expect(inputNames(armData)).toEqual(['id:Merge/free_0', 'id:Merge/in0_e0']);
    expect(outputNames(armData)).toEqual(['id:Merge/hasdata', 'id:Merge/ready_0']);
    const armEmpty = c.netMap.transitionObject('id:Merge/arm_e0_empty');
    expect(inputNames(armEmpty)).toEqual(['id:Merge/free_0', 'id:Merge/in0_e0_empty']);
    expect(outputNames(armEmpty)).toEqual(['id:Merge/ready_0']);
    expect(c.netMap.transition('id:Merge/arm_e0_data')!.edge!.from).toBe('A');
    expect(c.netMap.transition('id:Merge/arm_e5_data')!.edge!.from).toBe('B');
    expect(merge().inputs.map((i) => i.index)).toEqual([0, 1]);
  });

  it('X_start needs every ready_i plus all(hasdata), budget, idle; refunds free_*', () => {
    const start = transitionOf(c, 'Merge', 'start');
    expect(inputNames(start)).toEqual(['_budget', 'id:Merge/hasdata', 'id:Merge/idle', 'id:Merge/ready_0', 'id:Merge/ready_1']);
    expect(start.inputSpecs.find((s) => s.place.name === 'id:Merge/hasdata')!.type).toBe('all');
    expect(outputNames(start)).toEqual(['id:Merge/free_0', 'id:Merge/free_1', 'id:Merge/running']);
    // `_pause` (M2): a start never fires while the execution waits or is stopped.
    expect(inhibitorNames(start)).toEqual(['_halt', '_halted', '_pause']);
  });

  it('X_skip needs every ready_i under inhibitor(hasdata) and the halt inhibitors; emits empties, skipped, free_*', () => {
    const skip = transitionOf(c, 'Merge', 'skip');
    expect(inputNames(skip)).toEqual(['id:Merge/ready_0', 'id:Merge/ready_1']);
    expect(inhibitorNames(skip)).toEqual(['_halt', '_halted', 'id:Merge/hasdata']);
    expect(outputNames(skip)).toEqual(['id:End/in_empty', 'id:Merge/free_0', 'id:Merge/free_1', 'id:Merge/skipped']);
  });

  it('NetMap: place <-> (node, port) for the join input places', () => {
    expect(c.netMap.placeFor('Merge', 'ready', 1)!.name).toBe('id:Merge/ready_1');
    expect(c.netMap.placeFor('Merge', 'free', 0)!.name).toBe('id:Merge/free_0');
    expect(c.netMap.place('id:Merge/in1_e5')).toMatchObject({ role: 'edge-data', node: 'Merge', port: 1 });
    expect(c.netMap.place('id:A/in')).toMatchObject({ role: 'in-data', node: 'A', port: 0, edge: { from: 'IF', outputIndex: 0 } });
    expect(c.netMap.place('id:Trigger/in')).toMatchObject({ role: 'in-data', node: 'Trigger', port: 0 });
    expect(c.netMap.place('id:Trigger/in')!.edge).toBeUndefined();
  });

  it('a single input with two empty-capable producers is the OR form (README "OR-inputs"), not a slot join', () => {
    const m = compile(multiProducer);
    const g = gadget(m, 'C');
    expect(g.form).toBe('or');
    expect(g.inputs.map((i) => [i.index, i.round, i.free, i.ready!.name, i.hasdata!.name, i.ran!.name]))
      .toEqual([[0, 2, null, 'id:C/ready_0', 'id:C/hasdata_0', 'id:C/ran_0']]);
    expect(g.transitions.arms).toEqual(['id:C/arm_e0_data', 'id:C/arm_e0_empty', 'id:C/arm_e3_data', 'id:C/arm_e3_empty']);
    expect(inputNames(transitionOf(m, 'C', 'start'))).toEqual(['_budget', 'id:C/hasdata_0', 'id:C/idle']);
    expect(gadget(m, 'A').form).toBe('direct');
  });

  it('a single input with one tree and one cycle producer (Loop Over Items) stays a slot join', () => {
    expect(gadget(compile(loopOverItems), 'Loop').form).toBe('join');
  });
});

describe('Merge chooseBranch: all inputs required, combinations enumerated', () => {
  const c = compile(chooseBranch);

  it('X_start consumes ready_i_data for every input; no hasdata place', () => {
    const g = gadget(c, 'Merge');
    expect(g.form).toBe('choose-branch');
    expect(g.hasdata).toBeNull();
    expect(inputNames(transitionOf(c, 'Merge', 'start'))).toEqual(['_budget', 'id:Merge/idle', 'id:Merge/ready_0_data', 'id:Merge/ready_1_data']);
  });

  it('the other three combinations are explicit skips', () => {
    const skips = c.netMap.transitionsOf('Merge').filter((t) => t.role === 'skip');
    expect(skips.map((s) => [s.name, s.combination])).toEqual([
      ['id:Merge/skip_de', ['data', 'empty']],
      ['id:Merge/skip_ed', ['empty', 'data']],
      ['id:Merge/skip_ee', ['empty', 'empty']],
    ]);
    expect(inputNames(c.netMap.transitionObject('id:Merge/skip_de'))).toEqual(['id:Merge/ready_0_data', 'id:Merge/ready_1_empty']);
    expect(outputNames(c.netMap.transitionObject('id:Merge/skip_ee'))).toEqual(['id:End/in_empty', 'id:Merge/free_0', 'id:Merge/free_1', 'id:Merge/skipped']);
  });

  it('arms route into the data / empty ready variant', () => {
    expect(outputNames(c.netMap.transitionObject('id:Merge/arm_e1_data'))).toEqual(['id:Merge/ready_0_data']);
    expect(outputNames(c.netMap.transitionObject('id:Merge/arm_e1_empty'))).toEqual(['id:Merge/ready_0_empty']);
    expect(c.netMap.place('id:Merge/ready_0_empty')).toMatchObject({ role: 'ready', port: 0, variant: 'empty' });
  });
});

describe('retry gadget', () => {
  const c = compile(retry);

  it('X_run offers ok | retry | halt (stopWorkflow default) | waiting | stopped and always returns idle', () => {
    const run = transitionOf(c, 'A', 'run');
    expect(outputNames(run)).toEqual([
      '_budget', '_halt', '_pause', 'id:A/idle', 'id:A/ok', 'id:A/retry', 'id:A/stopped', 'id:A/waiting',
    ]);
    // M2 adds the two pause outcomes (README "Retries, halt, cancellation"): the node put the
    // execution to wait, or the destination node ran. Both refund the budget, since nothing
    // routes afterwards, and deposit the `_pause` control terminal.
    expect(branchesOf(run)).toEqual([
      ['id:A/idle', 'id:A/ok'],
      ['id:A/idle', 'id:A/retry'],
      ['_budget', '_halt', 'id:A/idle'],
      ['_budget', '_pause', 'id:A/idle', 'id:A/waiting'],
      ['_budget', '_pause', 'id:A/idle', 'id:A/stopped'],
    ]);
  });

  it('X_retry_wait is delayed(waitBetweenTries), consumes a try and idle, inhibits on halt and pause', () => {
    const wait = transitionOf(c, 'A', 'retry');
    expect(inputNames(wait)).toEqual(['id:A/idle', 'id:A/retry', 'id:A/tries']);
    expect(wait.timing).toEqual({ type: 'delayed', afterMs: 10 });
    // `_pause` (M2): a retry never restarts while the execution waits or is stopped.
    expect(inhibitorNames(wait)).toEqual(['_halt', '_halted', '_pause']);
    expect(outputNames(wait)).toEqual(['id:A/running']);
  });

  it('X_exhausted fires under inhibitor(tries) and the halt inhibitors with the X_run outcome shape minus retry (and no idle)', () => {
    const ex = transitionOf(c, 'A', 'exhausted');
    expect(inputNames(ex)).toEqual(['id:A/retry']);
    // Not pause-inhibited: an exhausted retry must still resolve after a pause landed.
    expect(inhibitorNames(ex)).toEqual(['_halt', '_halted', 'id:A/tries']);
    expect(branchesOf(ex)).toEqual([
      ['id:A/ok'], ['_budget', '_halt'], ['_budget', '_pause', 'id:A/waiting'], ['_budget', '_pause', 'id:A/stopped'],
    ]);
    expect(gadget(c, 'A')).toMatchObject({ retryOnFail: true, maxTries: 3, waitBetweenTries: 10 });
  });

  it('nodes without retry have no retry places or transitions', () => {
    const b = gadget(c, 'B');
    expect(b.retry).toBeNull();
    expect(b.tries).toBeNull();
    expect(b.transitions.retryWait).toBeNull();
    // The pause outcomes (M2) exist on every node; only the retry alternative is missing.
    expect(outputNames(transitionOf(c, 'B', 'run'))).toEqual([
      '_budget', '_halt', '_pause', 'id:B/idle', 'id:B/ok', 'id:B/stopped', 'id:B/waiting',
    ]);
  });
});

describe('expression references and onError', () => {
  it("$('A') in B becomes a read arc on A/done at B_start and a start_unmet twin reading A/skipped (CORE-032)", () => {
    const c = compile(expressionRef);
    expect(readNames(transitionOf(c, 'B', 'start'))).toEqual(['id:A/done']);
    expect(readNames(transitionOf(c, 'A', 'start'))).toEqual([]);
    expect(gadget(c, 'B').references).toEqual(['A']);
    expect(gadget(c, 'B').transitions.startUnmet).toEqual(['id:B/start_unmet_0']);
    const twin = c.netMap.transitionObject('id:B/start_unmet_0');
    expect(readNames(twin)).toEqual(['id:A/skipped']);
    expect(inputNames(twin)).toEqual(inputNames(transitionOf(c, 'B', 'start')));
    expect(outputNames(twin)).toEqual(['id:B/running']);
    expect(c.netMap.transition('id:B/start_unmet_0')).toMatchObject({ role: 'start-unmet', node: 'B', reference: 'A' });
    expect(c.net.places.has(gadget(c, 'A').done)).toBe(true);
  });

  it('continueErrorOutput appends the error output as the last index and drops the halt branch', () => {
    const c = compile(continueErrorOutput);
    const a = gadget(c, 'A');
    expect(a.onError).toBe('continueErrorOutput');
    expect(a.outputs.map((o) => [o.index, o.isErrorOutput, o.name])).toEqual([[0, false, null], [1, true, 'error']]);
    expect(edgeSlot(c, 'A', 1, 'Err', 0).data.name).toBe('id:Err/in');
    // No _halt alternative; the M2 pause outcomes (waiting / stopped, refunding _budget) stay.
    expect(outputNames(transitionOf(c, 'A', 'run'))).toEqual([
      '_budget', '_pause', 'id:A/idle', 'id:A/ok', 'id:A/stopped', 'id:A/waiting',
    ]);
    expect(outputNames(transitionOf(c, 'Trigger', 'run'))).toContain('_halt'); // stopWorkflow default keeps it
  });

  it('unconnected outputs get no places', () => {
    const c = compile(ifHalf);
    expect(gadget(c, 'IF').outputs.map((o) => o.index)).toEqual([0]);
    expect(outputNames(transitionOf(c, 'IF', 'route'))).toEqual(['_budget', 'id:A/in', 'id:A/in_empty', 'id:IF/done']);
  });
});

describe('halt and reap', () => {
  it('_halt_reap consumes _halt, resets every edge / in / ready / hasdata place but not X/retry, produces _halted', () => {
    const c = compile(retry);
    const reap = c.netMap.transitionObject('_halt_reap');
    expect(inputNames(reap)).toEqual(['_halt']);
    expect(outputNames(reap)).toEqual(['_halted']);
    expect(resetNames(reap)).toEqual(['id:A/in', 'id:A/in_empty', 'id:B/in', 'id:B/in_empty', 'id:Trigger/in']);
    expect(c.netMap.transition('_halt_reap')).toEqual({ name: '_halt_reap', role: 'reap', node: null });
  });

  it('the reap covers join places too', () => {
    const c = compile(twoTriggers);
    expect(resetNames(c.netMap.transitionObject('_halt_reap'))).toEqual([
      'id:End/in', 'id:End/in_empty', 'id:Merge/hasdata', 'id:Merge/in0_e0', 'id:Merge/in0_e0_empty',
      'id:Merge/in1_e2', 'id:Merge/in1_e2_empty', 'id:Merge/ready_0', 'id:Merge/ready_1', 'id:TrigA/in', 'id:TrigB/in',
    ]);
  });

  it('the reap covers the OR form\'s ready and hasdata places but not ran', () => {
    const c = compile(multiProducer);
    const names = resetNames(c.netMap.transitionObject('_halt_reap'));
    expect(names).toContain('id:C/ready_0');
    expect(names).toContain('id:C/hasdata_0');
    expect(names).not.toContain('id:C/ran_0');
  });
});
