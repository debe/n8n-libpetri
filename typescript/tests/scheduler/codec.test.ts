/**
 * The marking codec as the scheduler drives it (`src/codec.ts`): `decodeExecutionData`
 * builds the fresh-run marking (the shared part plus the start entry on the start node's
 * own input, `X/done` for every node with recorded runs) and `entryForEdge` produces n8n's
 * stack-entry shape. The resume shapes and the round trips live in `tests/codec/`; the
 * end-to-end encode paths (wait, destination stop, cancellation, stranded) are covered in
 * `control.test.ts` and `failures.test.ts`.
 */
import { isUnit } from 'libpetri';
import type { IExecuteData } from 'n8n-workflow';
import { decodeExecutionData, entryForEdge } from '../../src/codec.js';
import { compile } from '../../src/compiler/index.js';
import { isEntryPayload, type EdgePayload } from '../../src/scheduler/index.js';
import { diamond, linear, twoTriggers } from '../fixtures/workflows.js';
import { fakeWorkflow, items, newRunExecutionData } from './support.js';

function named(m: Map<{ name: string }, unknown[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [p, tokens] of m) out[p.name] = tokens.length;
  return out;
}

describe('decodeExecutionData — fresh run', () => {
  it('layers the one stack entry over sharedMarking(): the entry payload on the start node\'s in place, nothing else touched', () => {
    const c = compile(linear);
    const wf = fakeWorkflow(linear);
    const red = newRunExecutionData(wf.nodes.Trigger!, { startItems: items({ n: 1 }) });
    const entry = red.executionData!.nodeExecutionStack[0]!;
    const m = decodeExecutionData(c, red.executionData!);
    expect(named(m)).toEqual({ ...named(c.sharedMarking()), 'id:Trigger/in': 1 });
    const token = m.get(c.netMap.node('Trigger').in!)![0]!;
    expect(isEntryPayload(token.value)).toBe(true);
    expect((token.value as { executionData: IExecuteData }).executionData).toBe(entry); // by reference
  });

  it('a join-form start node pre-fills its slots and withholds the free tokens (free_i + ready_i ≤ 1), as initialMarking does', () => {
    // Start at the Merge itself (n8n hands nodeExecutionStack[0].data.main[0] to input 0).
    // Trigger is a second start node (a resumed execution lists the nodes with runData) so
    // A and B stay reachable and the shared marking carries Merge's free tokens rather than
    // seeding its inputs empty.
    const c = compile({ ...diamond, startNode: undefined, startNodes: ['Merge', 'Trigger'] });
    const wf = fakeWorkflow(diamond);
    const red = newRunExecutionData(wf.nodes.Merge!, { startItems: items(1) });
    const m = named(decodeExecutionData(c, red.executionData!));
    expect(m['id:Merge/ready_0']).toBe(1);
    expect(m['id:Merge/ready_1']).toBe(1);
    expect(m['id:Merge/hasdata']).toBe(1);
    expect(m['id:Merge/free_0']).toBeUndefined();
    expect(m['id:Merge/free_1']).toBeUndefined();
    const shared = named(c.sharedMarking());
    expect(shared['id:Merge/free_0']).toBe(1);
    expect(shared['id:Merge/free_1']).toBe(1);
  });

  it('keeps the seeded empties and skipped markers of the shared part (unreachable producers)', () => {
    const c = compile(twoTriggers);
    const wf = fakeWorkflow(twoTriggers);
    const red = newRunExecutionData(wf.nodes.TrigA!);
    const m = decodeExecutionData(c, red.executionData!);
    expect(named(m)['id:Merge/ready_1']).toBe(1); // TrigB is unreachable: input 1 seeded empty
    expect(isUnit(m.get(c.netMap.node('Merge').inputs[1]!.ready!)![0]!)).toBe(true);
    expect(named(m)['id:Merge/free_1']).toBeUndefined();
  });

  it('marks X/done for every node with at least one recorded run (options.runData), so resumed $(\'Y\') read arcs see it', () => {
    const c = compile(linear);
    const wf = fakeWorkflow(linear);
    const red = newRunExecutionData(wf.nodes.Trigger!);
    const m = named(decodeExecutionData(c, red.executionData!, { runData: { A: [{} as never], B: [] } }));
    expect(m['id:A/done']).toBe(1);
    expect(m['id:B/done']).toBeUndefined();
  });
});

describe('entryForEdge', () => {
  it('builds n8n\'s entry: main[inputIndex] = the items by reference, the source alongside', () => {
    const wf = fakeWorkflow(diamond);
    const payload: EdgePayload = { kind: 'edge', items: items({ b: 1 }), source: { previousNode: 'B', previousNodeOutput: 0, previousNodeRun: 0 } };
    const e = entryForEdge(wf.nodes.Merge!, 0, payload);
    expect(e.node).toBe(wf.nodes.Merge);
    expect(e.data.main).toEqual([payload.items]);
    expect(e.data.main![0]).toBe(payload.items);
    expect(e.source).toEqual({ main: [payload.source] });
    // An empty (unit) arrival never becomes an entry; a data arrival without a recorded source has a null source.
    expect(entryForEdge(wf.nodes.A!, 0, { kind: 'edge', items: items(1), source: null }).source).toBeNull();
  });

  it('fills the inputs below the arriving one with [], not null, so a node reading input 0 does not throw', () => {
    // n8n reaches a node wired only on a higher input through R6's stuck-join fallback,
    // which substitutes `[]` for every input that never arrived and keeps the sources
    // positional (`stack-scheduler.ts:467-491`). `addNodeToBeExecuted`'s single-input path
    // writes `null` below the index but is unreachable above input 0, so `null` there is a
    // shape n8n never produces: `getInputItems` throws 'Input index was not set' on it, which
    // is what n8n's Merge node does when it reads input 0
    // (n8n `workflow-execute.test.ts` "multiple Merge-Node have missing data", node Merge7).
    const wf = fakeWorkflow(diamond);
    const payload: EdgePayload = { kind: 'edge', items: items({ b: 1 }), source: { previousNode: 'B', previousNodeOutput: 0, previousNodeRun: 0 } };
    const e = entryForEdge(wf.nodes.Merge!, 1, payload);
    expect(e.data.main).toEqual([[], payload.items]);
    expect(e.data.main![1]).toBe(payload.items);
    expect(e.source).toEqual({ main: [null, payload.source] });
  });
});
