/**
 * `initialMarking(triggerItems)` (CORE-072): `_budget` × k, `X/idle` per node, `X/free_i`
 * per join input whose slot is not pre-filled, `X/tries` × (maxTries − 1), an empty token
 * on every join input fed only by nodes unreachable from the start node (one per
 * unreachable edge on an OR input), `Y/skipped` for a referenced unreachable node, and the
 * trigger data on the start node's `in` place.
 */
import { isUnit } from 'libpetri';
import { compile } from '../../src/compiler/index.js';
import {
  chooseBranch, conn, diamond, ifBothOutputs, linear, node, retry, twoTriggers, workflow,
} from '../fixtures/workflows.js';
import { gadget } from './support.js';

function named(m: Map<{ name: string }, unknown[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [p, tokens] of m) {
    if (p === null || p === undefined) throw new Error('null place key in the marking');
    out[p.name] = tokens.length;
  }
  return out;
}

describe('initialMarking', () => {
  it('linear at k = 1: budget, idles, trigger data on Trigger/in and nothing else', () => {
    const c = compile(linear);
    const items = { items: [{ json: { a: 1 } }] };
    const m = c.initialMarking(items);
    expect(named(m)).toEqual({
      _budget: 1,
      'id:Trigger/idle': 1, 'id:A/idle': 1, 'id:B/idle': 1, 'id:C/idle': 1,
      'id:Trigger/in': 1,
    });
    const trigger = m.get(gadget(c, 'Trigger').in!)!;
    expect(trigger[0]!.value).toBe(items); // by reference: the token holds the real items
    expect(isUnit(m.get(c.netMap.shared.budget)![0]!)).toBe(true);
  });

  it('budget k lands as k unit tokens when the k-safety check passes', () => {
    const c = compile(linear, { budget: 3 });
    expect(c.effectiveBudget).toBe(3);
    expect(c.initialMarking(null).get(c.netMap.shared.budget)).toHaveLength(3);
  });

  it('diamond: one free token per join input, no ready tokens', () => {
    const m = named(compile(diamond).initialMarking(null));
    expect(m['id:Merge/free_0']).toBe(1);
    expect(m['id:Merge/free_1']).toBe(1);
    expect(m['id:Merge/ready_0']).toBeUndefined();
    expect(m['id:Merge/hasdata']).toBeUndefined();
    expect(Object.keys(m).filter((n) => n.endsWith('/idle'))).toHaveLength(6);
  });

  it('two triggers: the join input fed only by the other trigger is seeded empty, its free token withheld', () => {
    const c = compile(twoTriggers);
    const merge = gadget(c, 'Merge');
    expect(merge.inputs.map((i) => [i.index, i.seedEmpty])).toEqual([[0, false], [1, true]]);
    expect(gadget(c, 'TrigB').reachable).toBe(false);
    const m = named(c.initialMarking(null));
    expect(m).toEqual({
      _budget: 1,
      'id:TrigA/idle': 1, 'id:TrigB/idle': 1, 'id:Merge/idle': 1, 'id:End/idle': 1,
      'id:Merge/free_0': 1,
      'id:Merge/ready_1': 1,
      'id:TrigA/in': 1,
    });
    expect(m['id:TrigB/in']).toBeUndefined();
  });

  it('retryOnFail: X/tries seeded with maxTries - 1, maxTries clamped as n8n clamps it ([2, 5])', () => {
    const c = compile(retry);
    const m = named(c.initialMarking(null));
    expect(m['id:A/tries']).toBe(2);
    expect(m['id:A/retry']).toBeUndefined();
    const tries = (maxTries: number | undefined) => named(compile(workflow('tries', [
      node('Trigger', 'trigger', [0, 0]), node('A', 'set', [100, 0], { retryOnFail: true, maxTries }),
    ], [conn('Trigger', 0, 'A', 0)], 'Trigger')).initialMarking(null))['id:A/tries'];
    expect(tries(1)).toBe(1);        // clamped up to 2 attempts
    expect(tries(10)).toBe(4);       // clamped down to 5
    expect(tries(0)).toBe(2);        // 0 is falsy: n8n's default 3
    expect(tries(undefined)).toBe(2);
  });

  it('chooseBranch: no ready variant is pre-filled, both free tokens present', () => {
    const m = named(compile(chooseBranch).initialMarking(null));
    expect(Object.keys(m).filter((n) => n.includes('/ready_'))).toEqual([]);
    expect(m['id:Merge/free_0']).toBe(1);
    expect(m['id:Merge/free_1']).toBe(1);
  });

  it('a join-form start node receives the trigger data on its first input, empty on the others', () => {
    const wf = workflow('start-join', [
      node('T1', 'trigger', [0, 0]), node('T2', 'trigger', [0, 100]), node('Merge', 'merge', [200, 50]),
    ], [conn('T1', 0, 'Merge', 0), conn('T2', 0, 'Merge', 1)], 'Merge');
    const c = compile(wf);
    const merge = gadget(c, 'Merge');
    expect(merge.isStart).toBe(true);
    const m = c.initialMarking('items');
    expect(named(m)).toEqual({
      _budget: 1, 'id:T1/idle': 1, 'id:T2/idle': 1, 'id:Merge/idle': 1,
      'id:Merge/ready_0': 1, 'id:Merge/hasdata': 1, 'id:Merge/ready_1': 1,
    });
    expect(m.get(merge.inputs[0]!.ready!)![0]!.value).toBe('items');
  });

  it('a choose-branch start node whose other input is fed only by a back edge gets no null key and can fire', () => {
    // T -> M.0, M -> X, X -> M.1 (cycle edge, never empty-capable), start at M.
    const wf = workflow('cb-start', [
      node('T', 'trigger', [0, 0]), node('M', 'mergeChoose', [100, 0]), node('X', 'set', [200, 0]),
    ], [conn('T', 0, 'M', 0), conn('M', 0, 'X', 0), conn('X', 0, 'M', 1)], 'M');
    const c = compile(wf);
    const m = gadget(c, 'M');
    expect(m.form).toBe('choose-branch');
    expect(m.inputs.map((i) => [i.index, i.emptyCapable, i.readyEmpty?.name ?? null])).toEqual([
      [0, true, 'id:M/ready_0_empty'], [1, false, null],
    ]);
    const marking = c.initialMarking('items');
    expect(named(marking)).toEqual({
      _budget: 1, 'id:T/idle': 1, 'id:M/idle': 1, 'id:X/idle': 1,
      'id:M/ready_0_data': 1, 'id:M/ready_1_data': 1,
    });
    expect(marking.get(m.inputs[0]!.readyData!)![0]!.value).toBe('items');
  });

  it('an OR-form start node gets the trigger payload on hasdata_i and a complete round of empties on ready_i', () => {
    const wf = workflow('or-start', [
      node('T1', 'trigger', [0, 0]), node('T2', 'trigger', [0, 100]), node('C', 'set', [200, 50]),
    ], [conn('T1', 0, 'C', 0), conn('T2', 0, 'C', 0)], 'C');
    const c = compile(wf);
    const g = gadget(c, 'C');
    expect(g.form).toBe('or');
    expect(g.inputs[0]!.unreachableEdges).toBe(2);
    const m = c.initialMarking('items');
    expect(named(m)).toEqual({
      _budget: 1, 'id:T1/idle': 1, 'id:T2/idle': 1, 'id:C/idle': 1,
      'id:C/ready_0': 2, 'id:C/hasdata_0': 1,
    });
    expect(m.get(g.inputs[0]!.hasdata!)![0]!.value).toBe('items');
  });

  it('an OR input seeds one empty per unreachable tree producer, none when every producer is reachable', () => {
    expect(named(compile(ifBothOutputs).initialMarking(null))['id:C/ready_0']).toBeUndefined();
    const wf = workflow('or-partial', [
      node('T', 'trigger', [0, 0]), node('Other', 'trigger', [0, 200]), node('IF', 'if', [200, 0]), node('C', 'set', [400, 0]),
    ], [conn('T', 0, 'IF', 0), conn('IF', 0, 'C', 0), conn('IF', 1, 'C', 0), conn('Other', 0, 'C', 0)], 'T');
    const c = compile(wf);
    expect(gadget(c, 'C').inputs[0]!.round).toBe(3);
    expect(named(c.initialMarking(null))['id:C/ready_0']).toBe(1);
  });

  it('a dead required input keeps its free token and is never pre-filled', () => {
    const wf = workflow('dead', [node('T', 'trigger', [0, 0]), node('M', 'mergeChoose', [100, 0])], [conn('T', 0, 'M', 1)], 'T');
    const m = named(compile(wf).initialMarking(null));
    expect(m['id:M/free_0']).toBe(1);
    expect(m['id:M/free_1']).toBe(1);
    expect(Object.keys(m).filter((n) => n.includes('/ready_'))).toEqual([]);
  });

  it("a referenced node unreachable from the start node has its skipped marker seeded", () => {
    const wf = workflow('ref-unreachable', [
      node('T', 'trigger', [0, 0]), node('Other', 'trigger', [0, 100]), node('A', 'set', [200, 0]),
    ], [conn('T', 0, 'A', 0)], 'T', { references: { A: ['Other'] } });
    const c = compile(wf);
    expect(named(c.initialMarking(null))['id:Other/skipped']).toBe(1);
    expect(gadget(c, 'Other').skipped!.name).toBe('id:Other/skipped');
  });

  it('unreachable single-input nodes are left unmarked (only join inputs are seeded)', () => {
    const wf = workflow('unreachable-chain', [
      node('T1', 'trigger', [0, 0]), node('T2', 'trigger', [0, 100]), node('X', 'set', [100, 100]),
      node('Merge', 'merge', [200, 50]),
    ], [conn('T1', 0, 'Merge', 0), conn('T2', 0, 'X', 0), conn('X', 0, 'Merge', 1)], 'T1');
    const c = compile(wf);
    const m = named(c.initialMarking(null));
    expect(m['id:Merge/ready_1']).toBe(1);
    expect(m['id:X/in']).toBeUndefined();
    expect(m['id:X/in_empty']).toBeUndefined();
    expect(gadget(c, 'X').reachable).toBe(false);
  });
});
