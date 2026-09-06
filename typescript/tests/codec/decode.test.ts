/**
 * `decodeExecutionData`: n8n's `executionData` → the initial marking (ADR 0005, the
 * decode table in `src/codec.ts`). Every compiler fixture's fresh run decodes to
 * `initialMarking`; resume shapes — multi-entry stacks, partial `waitingExecution` slots
 * (items / `[]` / `null`), several slots per input queued FIFO, entries and slots on the
 * same join, choose-branch variants, OR rounds, seeded empties and markers rebuilt from
 * `runData` and from what the pending activations can still reach.
 */
import { isUnit } from 'libpetri';
import type { IExecuteData } from 'n8n-workflow';
import { CodecError, decodeExecutionData } from '../../src/codec.js';
import { compile } from '../../src/compiler/index.js';
import { isEntryPayload, type EdgePayload, type EntryPayload } from '../../src/scheduler/index.js';
import {
  ALL, chooseBranch, conn, diamond, expressionRef, ifBothOutputs, linear, node, twoTriggers, workflow,
} from '../fixtures/workflows.js';
import { fakeWorkflow, items, newRunExecutionData } from '../scheduler/support.js';
import { edgeData, entryFor, gadget, named, placeNamed, src, stateOf, taskData, values } from './support.js';

/** Start-node shapes beyond the fixture set (`tests/compiler/marking.test.ts`). */
const startJoin = workflow('start-join', [
  node('T1', 'trigger', [0, 0]), node('T2', 'trigger', [0, 100]), node('Merge', 'merge', [200, 50]),
], [conn('T1', 0, 'Merge', 0), conn('T2', 0, 'Merge', 1)], 'Merge');
const startOr = workflow('or-start', [
  node('T1', 'trigger', [0, 0]), node('T2', 'trigger', [0, 100]), node('C', 'set', [200, 50]),
], [conn('T1', 0, 'C', 0), conn('T2', 0, 'C', 0)], 'C');
const startChoose = workflow('cb-start', [
  node('T', 'trigger', [0, 0]), node('M', 'mergeChoose', [100, 0]), node('X', 'set', [200, 0]),
], [conn('T', 0, 'M', 0), conn('M', 0, 'X', 0), conn('X', 0, 'M', 1)], 'M');

describe('fresh run: decode equals initialMarking for every fixture', () => {
  it.each([...Object.entries(ALL), ['start-join', startJoin], ['or-start', startOr], ['cb-start', startChoose]] as const)(
    '%s', (_name, desc) => {
      const c = compile(desc);
      const wf = fakeWorkflow(desc);
      const start = desc.startNodes?.[0] ?? desc.startNode!;
      const red = newRunExecutionData(wf.nodes[start]!, { startItems: items({ n: 1 }) });
      const entry = red.executionData!.nodeExecutionStack[0]!;
      const m = decodeExecutionData(c, red.executionData!);
      expect(named(m)).toEqual(named(c.initialMarking(entry)));
      const g = gadget(c, start);
      const place = g.form === 'direct' ? g.in! : g.form === 'or' ? g.inputs[0]!.hasdata! : (g.form === 'choose-branch' && g.inputs[0]!.required ? g.inputs[0]!.readyData! : g.inputs[0]!.ready!);
      const [token] = values(m, place) as EntryPayload[];
      expect(isEntryPayload(token)).toBe(true);
      expect(token!.executionData).toBe(entry);
    });
});

describe('stack entries', () => {
  it('several entries decode FIFO onto their nodes\' inputs, entry objects kept by reference', () => {
    const c = compile(linear);
    const wf = fakeWorkflow(linear);
    const a1 = entryFor(wf.nodes.A!, [items(1)]);
    const a2 = entryFor(wf.nodes.A!, [items(2)]);
    const c1 = entryFor(wf.nodes.C!, [items(3)]);
    const m = decodeExecutionData(c, stateOf([a1, c1, a2]));
    expect((values(m, gadget(c, 'A').in!) as EntryPayload[]).map((v) => v.executionData)).toEqual([a1, a2]);
    expect((values(m, gadget(c, 'C').in!) as EntryPayload[]).map((v) => v.executionData)).toEqual([c1]);
    expect(named(m)['id:B/in']).toBeUndefined();
  });

  it('the first entry need not be the primary start node', () => {
    const c = compile(linear);
    const wf = fakeWorkflow(linear);
    const m = decodeExecutionData(c, stateOf([entryFor(wf.nodes.B!, [items(1)])]));
    expect(named(m)['id:B/in']).toBe(1);
    expect(named(m)['id:Trigger/in']).toBeUndefined();
  });

  it('a join entry heads the first slot with unit companions and one hasdata; a second entry queues on the edge places', () => {
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const e1 = entryFor(wf.nodes.Merge!, [items(1), []]);
    const e2 = entryFor(wf.nodes.Merge!, [items(2), items(3)]);
    const m = decodeExecutionData(c, stateOf([e1, e2]));
    const g = gadget(c, 'Merge');
    expect((values(m, g.inputs[0]!.ready!)[0] as EntryPayload).executionData).toBe(e1);
    expect(isUnit(m.get(g.inputs[1]!.ready!)![0]!)).toBe(true);
    expect(named(m)['id:Merge/hasdata']).toBe(1);
    expect(named(m)['id:Merge/free_0']).toBeUndefined();
    expect(named(m)['id:Merge/free_1']).toBeUndefined();
    expect((values(m, edgeData(c, 'A', 0, 'Merge', 0))[0] as EntryPayload).executionData).toBe(e2);
    expect(isUnit(m.get(edgeData(c, 'B', 0, 'Merge', 1))![0]!)).toBe(true);
  });

  it('an entry for a node the compiled workflow does not have is a CodecError', () => {
    const c = compile(linear);
    const ghost = { id: 'ghost', name: 'Ghost', type: 'set', typeVersion: 1, position: [0, 0], parameters: {} } as IExecuteData['node'];
    expect(() => decodeExecutionData(c, stateOf([entryFor(ghost, [items(1)])]))).toThrow(CodecError);
  });
});

describe('waitingExecution slots (join / choose-branch)', () => {
  it('items → an edge payload on ready_i with its source and one hasdata; free_i withheld, the other input keeps its free token', () => {
    const c = compile(diamond);
    const a = items({ a: 1 });
    const m = decodeExecutionData(c, stateOf([], { Merge: { 0: { main: [a, null] } } }, { Merge: { 0: { main: [src('A'), null] } } }));
    const g = gadget(c, 'Merge');
    const [v] = values(m, g.inputs[0]!.ready!) as EdgePayload[];
    expect(v!.kind).toBe('edge');
    expect(v!.items).toBe(a);
    expect(v!.source).toEqual(src('A'));
    expect(named(m)['id:Merge/hasdata']).toBe(1);
    expect(named(m)['id:Merge/free_0']).toBeUndefined();
    expect(named(m)['id:Merge/free_1']).toBe(1);
    expect(named(m)['id:Merge/ready_1']).toBeUndefined();
  });

  it('[] is n8n\'s "arrived empty": a unit on ready_i without hasdata; null is not arrived', () => {
    const c = compile(diamond);
    const m = decodeExecutionData(c, stateOf([], { Merge: { 0: { main: [null, []] } } }));
    const g = gadget(c, 'Merge');
    expect(isUnit(m.get(g.inputs[1]!.ready!)![0]!)).toBe(true);
    expect(named(m)['id:Merge/hasdata']).toBeUndefined();
    expect(named(m)['id:Merge/free_1']).toBeUndefined();
    expect(named(m)['id:Merge/free_0']).toBe(1);
  });

  it('a missing source array leaves the payload source null', () => {
    const c = compile(diamond);
    const m = decodeExecutionData(c, stateOf([], { Merge: { 0: { main: [items(1), null] } } }));
    expect((values(m, gadget(c, 'Merge').inputs[0]!.ready!)[0] as EdgePayload).source).toBeNull();
  });

  it('a required choose-branch input takes ready_i_data for items and ready_i_empty for []', () => {
    const c = compile(chooseBranch);
    const m = decodeExecutionData(c, stateOf([], { Merge: { 0: { main: [items(1), []] } } }));
    expect(named(m)['id:Merge/ready_0_data']).toBe(1);
    expect(named(m)['id:Merge/ready_1_empty']).toBe(1);
    expect(named(m)['id:Merge/free_0']).toBeUndefined();
    expect(named(m)['id:Merge/free_1']).toBeUndefined();
    expect(gadget(c, 'Merge').hasdata).toBeNull();
  });

  it('several slots on one input queue in ascending run index: the head on ready_i, the rest on the input\'s first edge place', () => {
    const c = compile(diamond);
    const a1 = items(1);
    const a2 = items(2);
    const a3 = items(3);
    const m = decodeExecutionData(c, stateOf([], { Merge: { 7: { main: [a2, null] }, 3: { main: [a1, null] }, 12: { main: [a3, null] } } }));
    const g = gadget(c, 'Merge');
    expect((values(m, g.inputs[0]!.ready!) as EdgePayload[]).map((v) => v.items)).toEqual([a1]);
    expect((values(m, edgeData(c, 'A', 0, 'Merge', 0)) as EdgePayload[]).map((v) => v.items)).toEqual([a2, a3]);
    expect(named(m)['id:Merge/hasdata']).toBe(1); // only the head is armed
  });

  it('a stack entry and a waiting slot for the same join: the entry heads, the slot queues behind it', () => {
    const c = compile(diamond);
    const wf = fakeWorkflow(diamond);
    const e = entryFor(wf.nodes.Merge!, [items(1)]);
    const b = items({ b: 1 });
    const m = decodeExecutionData(c, stateOf([e], { Merge: { 0: { main: [null, b] } } }));
    const g = gadget(c, 'Merge');
    expect((values(m, g.inputs[0]!.ready!)[0] as EntryPayload).executionData).toBe(e);
    expect(isUnit(m.get(g.inputs[1]!.ready!)![0]!)).toBe(true);
    expect((values(m, edgeData(c, 'B', 0, 'Merge', 1))[0] as EdgePayload).items).toBe(b);
  });

  it('a decoded head replaces the seeded empty of an unreachable input (never two heads)', () => {
    const c = compile(twoTriggers);
    const seeded = decodeExecutionData(c, stateOf([], { Merge: { 0: { main: [null, []] } } }));
    expect(named(seeded)['id:Merge/ready_1']).toBe(1);
    const data = decodeExecutionData(c, stateOf([], { Merge: { 0: { main: [null, items(1)] } } }));
    expect(named(data)['id:Merge/ready_1']).toBe(1);
    expect(named(data)['id:Merge/hasdata']).toBe(1);
    expect(named(data)['id:Merge/free_1']).toBeUndefined();
  });

  it('the seed is a one-off: a stack entry consumes it exactly as initialMarking does, and nothing queues behind it', () => {
    // The seed is R6's null → [] substitution done once (ADR 0005). n8n's entry already
    // carries that `[]` in its own data.main[1], so re-queuing the seed behind the entry
    // would be the substitution done twice — and would strand a token after the run.
    const c = compile(twoTriggers);
    const wf = fakeWorkflow(twoTriggers);
    expect(gadget(c, 'Merge').inputs[1]!.seedEmpty).toBe(true);
    const e = entryFor(wf.nodes.Merge!, [items(1), []], [src('TrigA'), null]);
    const m = decodeExecutionData(c, stateOf([e]));
    const g = gadget(c, 'Merge');
    expect((values(m, g.inputs[0]!.ready!)[0] as EntryPayload).executionData).toBe(e);
    expect(m.get(g.inputs[1]!.ready!)).toHaveLength(1); // the unit companion, not companion + seed
    expect(isUnit(m.get(g.inputs[1]!.ready!)![0]!)).toBe(true);
    expect(named(m)['id:Merge/hasdata']).toBe(1);
    expect(named(m)['id:Merge/free_0']).toBeUndefined();
    expect(named(m)['id:Merge/free_1']).toBeUndefined();
    // Nothing left queued on the unreachable producer's edge places.
    const edges = g.inputs[1]!.edges;
    for (const s of edges) {
      expect(named(m)[s.data.name]).toBeUndefined();
      if (s.empty !== null) expect(named(m)[s.empty.name]).toBeUndefined();
    }
    // Same rule for the primary start node's own entry: `initialMarking` builds exactly this.
    expect(named(m)).toEqual(named(compile({ ...twoTriggers, startNode: 'Merge' }).initialMarking(e)));
  });

  it('an arrival on the seeded input queues behind the entry; the seed itself does not', () => {
    const c = compile(twoTriggers);
    const wf = fakeWorkflow(twoTriggers);
    const e = entryFor(wf.nodes.Merge!, [items(1), []], [src('TrigA'), null]);
    const b = items({ b: 1 });
    const m = decodeExecutionData(c, stateOf([e], { Merge: { 0: { main: [null, b] } } }));
    const g = gadget(c, 'Merge');
    expect(isUnit(m.get(g.inputs[1]!.ready!)![0]!)).toBe(true);
    expect((values(m, edgeData(c, 'TrigB', 0, 'Merge', 1)) as EdgePayload[]).map((v) => v.items)).toEqual([b]);
    const emptyPlace = g.inputs[1]!.edges[0]!.empty!;
    expect(named(m)[emptyPlace.name]).toBeUndefined();
  });

  it('an [] for a required choose-branch input fed only by a cycle edge has no place and is a CodecError', () => {
    const c = compile(startChoose);
    expect(gadget(c, 'M').inputs[1]!.readyEmpty).toBeNull();
    expect(() => decodeExecutionData(c, stateOf([], { M: { 0: { main: [null, []] } } }))).toThrow(CodecError);
  });

  it('a second [] on an input without an empty-capable edge cannot queue and is a CodecError', () => {
    // Merge.1 is fed by X -> Merge.1 (cycle edge, no empty place) in a generic join.
    const wf = workflow('cycle-in', [
      node('T', 'trigger', [0, 0]), node('M', 'merge', [100, 0]), node('X', 'set', [200, 0]),
    ], [conn('T', 0, 'M', 0), conn('M', 0, 'X', 0), conn('X', 0, 'M', 1)], 'T');
    const c = compile(wf);
    expect(gadget(c, 'M').inputs[1]!.emptyCapable).toBe(false);
    expect(() => decodeExecutionData(c, stateOf([], { M: { 0: { main: [null, []] }, 1: { main: [null, []] } } }))).toThrow(CodecError);
  });
});

describe('OR-form nodes', () => {
  it('an entry goes to hasdata_i; a source over a tree edge from a reachable producer counts as a round delivery', () => {
    const c = compile(ifBothOutputs);
    const wf = fakeWorkflow(ifBothOutputs);
    const counted = decodeExecutionData(c, stateOf([entryFor(wf.nodes.C!, [items(1)], [src('IF', 0)])]));
    expect(named(counted)['id:C/hasdata_0']).toBe(1);
    expect(named(counted)['id:C/ready_0']).toBe(1);
    const uncounted = decodeExecutionData(c, stateOf([entryFor(wf.nodes.C!, [items(1)], null)]));
    expect(named(uncounted)['id:C/hasdata_0']).toBe(1);
    expect(named(uncounted)['id:C/ready_0']).toBeUndefined();
  });

  it('[] slots are the open round\'s delivered empties; X/ran_i is rebuilt only for an open round the node already ran in', () => {
    const c = compile(ifBothOutputs);
    const open = decodeExecutionData(c, stateOf([], { C: { 0: { main: [[]] }, 1: { main: [[]] } } }));
    expect(named(open)['id:C/ready_0']).toBe(2);
    expect(named(open)['id:C/hasdata_0']).toBeUndefined();
    expect(named(open)['id:C/ran_0']).toBeUndefined();
    const ran = decodeExecutionData(c, stateOf([], { C: { 0: { main: [[]] } } }), { runData: { C: [taskData()] } });
    expect(named(ran)['id:C/ran_0']).toBe(1);
    const closed = decodeExecutionData(c, stateOf([]), { runData: { C: [taskData()] } });
    expect(named(closed)['id:C/ran_0']).toBeUndefined(); // no open round: no residue
    expect(named(closed)['id:C/done']).toBe(1);
  });
});

describe('direct-form waiting slots (foreign: n8n never writes them, the stranded encoder does)', () => {
  it('items → X/in as an edge payload, [] → X/in_empty, [] where no empty place exists is dropped with a diagnostic', () => {
    const c = compile(linear);
    const diags: string[] = [];
    const a = items(1);
    const m = decodeExecutionData(c, stateOf([], { A: { 0: { main: [a] } }, B: { 0: { main: [[]] } }, Trigger: { 0: { main: [[]] } } }), { onDiagnostic: (d) => diags.push(d) });
    expect((values(m, gadget(c, 'A').in!)[0] as EdgePayload).items).toBe(a);
    expect(named(m)['id:B/in_empty']).toBe(1);
    expect(named(m)['id:Trigger/in']).toBeUndefined();
    expect(diags).toEqual([expect.stringContaining("node 'Trigger'")]);
  });
});

describe('markers', () => {
  it('X/done for every node with a recorded run; an empty runData array is not a run', () => {
    const c = compile(linear);
    const m = decodeExecutionData(c, stateOf([]), { runData: { A: [taskData()], B: [] } });
    expect(named(m)['id:A/done']).toBe(1);
    expect(named(m)['id:B/done']).toBeUndefined();
  });

  it('a referenced node with no run that no pending activation can reach is seeded skipped, so the reference fails as in n8n instead of stranding', () => {
    // B references $('A'); IF ran and took the false branch, A was skipped, B is pending.
    const resumed = { ...expressionRef, startNode: undefined, startNodes: ['B', 'Trigger', 'IF'] };
    const c = compile(resumed);
    const wf = fakeWorkflow(expressionRef);
    const runData = { Trigger: [taskData()], IF: [taskData()] };
    const m = decodeExecutionData(c, stateOf([entryFor(wf.nodes.B!, [items(1)], [src('IF', 1)])]), { runData });
    expect(named(m)['id:A/skipped']).toBe(1);
    expect(named(m)['id:A/done']).toBeUndefined();
    // A ran: done, not skipped.
    const ran = decodeExecutionData(c, stateOf([entryFor(wf.nodes.B!, [items(1)])]), { runData: { ...runData, A: [taskData()] } });
    expect(named(ran)['id:A/skipped']).toBeUndefined();
    expect(named(ran)['id:A/done']).toBe(1);
    // IF is still pending: A may yet run, nothing is seeded.
    const pendingIf = decodeExecutionData(c, stateOf([entryFor(wf.nodes.IF!, [items(1)])]), { runData: { Trigger: [taskData()] } });
    expect(named(pendingIf)['id:A/skipped']).toBeUndefined();
    // A unreachable from every start node is seeded by the shared marking already: still exactly one.
    const cShared = compile({ ...expressionRef, startNode: undefined, startNodes: ['B'] });
    expect(named(cShared.sharedMarking())['id:A/skipped']).toBe(1);
    expect(named(decodeExecutionData(cShared, stateOf([entryFor(wf.nodes.B!, [items(1)])])))['id:A/skipped']).toBe(1);
  });

  it('the shared part is always present: budget, idles, tries, free tokens of untouched inputs', () => {
    const c = compile(diamond);
    const m = named(decodeExecutionData(c, stateOf([])));
    expect(m._budget).toBe(1);
    expect(Object.keys(m).filter((n) => n.endsWith('/idle'))).toHaveLength(6);
    expect(m['id:Merge/free_0']).toBe(1);
    expect(m['id:Merge/free_1']).toBe(1);
    expect(placeNamed(c, 'id:Merge/ready_0')).toBeDefined();
  });
});
