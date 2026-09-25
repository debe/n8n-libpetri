/**
 * The `pairedItem` bookkeeping `WorkflowExecute` does around a node run (`n8n@2.41.3`): the
 * lineage stamped on a node's input, the pairing of its output items, and the one item
 * `alwaysOutputData` puts into an empty output. `FakeHost` records each call and delegates
 * here.
 */
import type { IExecuteData, INodeExecutionData, IPairedItemData, ITaskDataConnections } from 'n8n-workflow';

/** `addPairedItemLineage`: every input item, copied, with its own position as its `pairedItem`. */
export function pairedItemLineage(data: ITaskDataConnections): ITaskDataConnections {
  const out: ITaskDataConnections = {};
  for (const type of Object.keys(data)) {
    out[type] = data[type]!.map((input, inputIndex) => {
      if (input === null) return input;
      return input.map((item, itemIndex) => ({ ...item, pairedItem: { item: itemIndex, input: inputIndex || undefined } }));
    });
  }
  return out;
}

/** The `pairedItem` an unpaired output item at `index` gets. */
type PairingRule = (index: number) => IPairedItemData;

/**
 * Which of `assignPairedItems`' three shapes the run has — one input item and one output
 * item, as many output items as input items, or one output item from several — or none.
 */
function pairingRuleOf(nodeSuccessData: INodeExecutionData[][], main: ITaskDataConnections['main']): PairingRule | undefined {
  const isSingleInputAndOutput = main.length === 1 && main[0]?.length === 1;
  const isSameNumberOfItems = nodeSuccessData.length === 1 && main.length === 1 && main[0]?.length === nodeSuccessData[0]!.length;
  const isSingleOutput = nodeSuccessData.length === 1 && nodeSuccessData[0]?.length === 1 && main.length === 1 && (main[0]?.length ?? 0) > 1;
  if (isSingleInputAndOutput) return () => ({ item: 0 });
  if (isSameNumberOfItems) return (index) => ({ item: index });
  if (isSingleOutput) return () => ({ item: 0 });
  return undefined;
}

/**
 * `assignPairedItems`: when the run's shape says which input item an output item came from,
 * every output item without a `pairedItem` gets that one; otherwise none is assigned.
 */
export function pairOutputItems(
  nodeSuccessData: INodeExecutionData[][] | null | undefined, executionData: IExecuteData,
): INodeExecutionData[][] | null {
  if (!nodeSuccessData?.length) return nodeSuccessData ?? null;
  const rule = pairingRuleOf(nodeSuccessData, executionData.data.main!);
  if (rule === undefined) return nodeSuccessData;
  for (const outputData of nodeSuccessData) {
    if (outputData === null) continue;
    for (const [index, item] of outputData.entries()) {
      if (item.pairedItem === undefined) item.pairedItem = rule(index);
    }
  }
  return nodeSuccessData;
}

/**
 * `ensureAlwaysOutputData`: an `alwaysOutputData` node whose first output is empty emits one
 * empty item, paired with every input item.
 */
export function withAlwaysOutputData(
  nodeSuccessData: INodeExecutionData[][] | null | undefined, executionData: IExecuteData,
): INodeExecutionData[][] | null | undefined {
  if (nodeSuccessData?.[0]?.[0]) return nodeSuccessData;
  if (executionData.node.alwaysOutputData !== true) return nodeSuccessData;
  const pairedItem: IPairedItemData[] = [];
  executionData.data.main!.forEach((inputData, inputIndex) => {
    if (!inputData) return;
    inputData.forEach((_item, itemIndex) => pairedItem.push({ item: itemIndex, input: inputIndex }));
  });
  nodeSuccessData ??= [];
  nodeSuccessData[0] = [{ json: {}, pairedItem }];
  return nodeSuccessData;
}
