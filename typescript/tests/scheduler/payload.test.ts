/**
 * Payload safety above k = 1 (ADR 0006).
 *
 * A token holds the very `INodeExecutionData[]` array n8n produced, and the routing hands the
 * *same* `EdgePayload` — same array, same item objects — to every edge of an output. That is
 * exactly what n8n does: `addNodeToBeExecuted` writes `nodeSuccessData[outputIndex]` by
 * reference into every waiting slot and stack entry (`workflow-execute.ts:534-537`,
 * `:786-800`). Above k = 1 two consumers of one output run at the same time, so the question
 * is what either of them may *write* through that shared reference.
 *
 * The answer at n8n `441970b` is: nothing. `addPairedItemLineage`
 * (`workflow-execute.ts:1742-1782`) does not stamp `pairedItem` in place — it `map`s to a new
 * array of `{ ...item, pairedItem }` shallow copies and `stack-scheduler.ts:65` assigns that
 * to `executionData.data`, so every activation reads and writes its own item objects.
 * `assignPairedItems` (`:2585-2641`) does write `item.pairedItem` in place, but only on the
 * node's own fresh output, which no other activation holds yet. The lineage copy is therefore
 * the isolation boundary, and this suite pins it: the same workflow run against a host whose
 * lineage step stamps in place races at k = 2 and does not at k = 1.
 */
import type { IExecuteData, INodeExecutionData, IRunExecutionData, ITaskDataConnections, Workflow } from 'n8n-workflow';
import { conn, node, workflow } from '../fixtures/workflows.js';
import {
  FakeHost, dataOf, execute, items, ranNodes, sleep, transitionsFailed,
  type FakeHostOptions, type NodeScript,
} from './support.js';

const START = items({ n: 1 });

/**
 * `addPairedItemLineage` without the `{ ...item }` of `workflow-execute.ts:1770` / `:1776`:
 * the stamp lands on the producer's own item objects, which every consumer of that output
 * shares. n8n does not do this; the subclass exists to show what the copy buys.
 */
class InPlaceLineageHost extends FakeHost {
  override addPairedItemLineage(executionData: IExecuteData): ITaskDataConnections {
    super.addPairedItemLineage(executionData); // keep the recorded call trace identical
    const out: ITaskDataConnections = {};
    for (const type of Object.keys(executionData.data)) {
      out[type] = executionData.data[type]!.map((input, inputIndex) => {
        if (input === null) return input;
        for (const [itemIndex, item] of input.entries()) {
          item.pairedItem = { item: itemIndex, input: inputIndex || undefined };
        }
        return input;
      });
    }
    return out;
  }
}

const inPlaceLineage = (
  w: Workflow, red: IRunExecutionData, scripts: Readonly<Record<string, NodeScript>>, options: FakeHostOptions,
): FakeHost => new InPlaceLineageHost(w, red, scripts, options);

/**
 * `Trigger` fans one output out to two consumers that stamp *different* lineage on it:
 * `A` is wired on input 0 (`pairedItem.input` is `0 || undefined`, i.e. absent) and `M` on
 * input 1 (`input: 1`). `A` reads its own `pairedItem` back after an await, so an
 * interleaved stamp by `M` is observable in `A`'s output.
 */
const sharedPayload = workflow('shared-payload', [
  node('Trigger', 'trigger', [0, 0]),
  node('A', 'set', [200, 0]),
  node('M', 'merge', [200, 100]),
], [conn('Trigger', 0, 'A', 0), conn('Trigger', 0, 'M', 1)], 'Trigger');

/** Reads `pairedItem` of its input item back after 20 ms, i.e. after a sibling could stamp it. */
const readsBackLineage: NodeScript = async ({ executionData }) => {
  await sleep(20);
  const item = executionData.data.main![0]![0]!;
  return { data: [[{ json: { seen: JSON.parse(JSON.stringify(item.pairedItem ?? null)) as never } }]] };
};

const mergeBothInputs: NodeScript = ({ executionData }) => ({
  data: [[...(executionData.data.main![0] ?? []), ...(executionData.data.main![1] ?? [])]],
});

const seenBy = (r: { runData: Record<string, unknown> }, name: string): unknown =>
  ((r.runData as never as Record<string, Array<{ data: { main: INodeExecutionData[][] } }>>)[name]![0]!.data.main[0]![0]!.json as { seen: unknown }).seen;

describe('the lineage copy is what isolates two concurrent activations', () => {
  const scripts = { A: readsBackLineage, M: mergeBothInputs };

  it('with n8n\'s own copy-on-write lineage step, k = 2 gives byte-identical data to k = 1', async () => {
    const one = await execute(sharedPayload, scripts, { startItems: START, budget: 1 });
    const two = await execute(sharedPayload, scripts, { startItems: START, budget: 2 });
    expect(one.error).toBeUndefined();
    expect(two.error).toBeUndefined();
    expect(transitionsFailed(two.store)).toEqual([]);
    expect(two.scheduler.compiled!.effectiveBudget).toBe(2);
    expect(two.scheduler.maxInFlight).toBe(2); // A and M really did overlap
    // `A` reads its own copy back: input 0, so `pairedItem.input` is absent.
    expect(seenBy(one, 'A')).toEqual({ item: 0 });
    expect(seenBy(two, 'A')).toEqual({ item: 0 });
    expect(dataOf(two.runData)).toEqual(dataOf(one.runData));
  });

  it('with an in-place lineage step the two branches race: A reads back M\'s stamp at k = 2, its own at k = 1', async () => {
    const one = await execute(sharedPayload, scripts, { startItems: START, budget: 1, host: inPlaceLineage });
    const two = await execute(sharedPayload, scripts, { startItems: START, budget: 2, host: inPlaceLineage });
    expect(one.error).toBeUndefined();
    expect(two.error).toBeUndefined();
    expect(ranNodes(two.calls).sort()).toEqual(['A', 'M', 'Trigger']);
    // Sequentially the stamp `A` reads back is its own, because `M` has not run yet.
    expect(seenBy(one, 'A')).toEqual({ item: 0 });
    // Concurrently `M` stamps the very same item object while `A` is awaiting: `A` reads
    // back `M`'s lineage (input 1). This is the data race the copy prevents.
    expect(seenBy(two, 'A')).toEqual({ item: 0, input: 1 });
    expect(dataOf(two.runData)).not.toEqual(dataOf(one.runData));
  });

  it('every activation gets its own item objects; only the payload array and the json stay shared', async () => {
    const r = await execute(sharedPayload, scripts, { startItems: START, budget: 2 });
    const produced = r.runData.Trigger![0]!.data!.main![0]!;
    const toA = r.host.runNodeCalls.find((c) => c.node === 'A')!.main![0]!;
    const toM = r.host.runNodeCalls.find((c) => c.node === 'M')!.main![1]!;
    // n8n's own sharing: the producer hands the same array to every connection…
    expect(toA).not.toBe(toM);
    expect(toA[0]).not.toBe(produced[0]);
    expect(toM[0]).not.toBe(produced[0]);
    expect(toA[0]).not.toBe(toM[0]);
    // …and the copy is shallow, so `json` is still one object (as it is in n8n).
    expect(toA[0]!.json).toBe(produced[0]!.json);
    expect(toM[0]!.json).toBe(produced[0]!.json);
    // The producer's recorded run keeps the lineage it recorded: no consumer wrote it.
    expect(produced[0]!.pairedItem).toEqual({ item: 0 });
    expect(toM[0]!.pairedItem).toEqual({ item: 0, input: 1 });
  });

  it('assignPairedItems stamps only the node\'s own fresh output, never an input it shares', async () => {
    // `A` returns a brand-new item with no `pairedItem`; the host's auto-assignment fills it
    // (`isSingleInputAndOutput`). Nothing on the producer's items changes.
    const r = await execute(sharedPayload, { A: () => ({ data: [[{ json: { a: 1 } }]] }), M: mergeBothInputs },
      { startItems: START, budget: 2 });
    expect(r.error).toBeUndefined();
    expect(r.runData.A![0]!.data!.main![0]![0]!.pairedItem).toEqual({ item: 0 });
    expect(r.runData.Trigger![0]!.data!.main![0]![0]!.pairedItem).toEqual({ item: 0 });
    expect(r.runData.Trigger![0]!.data!.main![0]![0]!.json).toEqual({ n: 1 });
  });
});
