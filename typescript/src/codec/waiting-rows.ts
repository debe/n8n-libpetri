/**
 * n8n's `waitingExecution` as decode reads it: per node, the rows in ascending run index, each
 * paired with its `waitingExecutionSource` twin as one {@link WaitingRow}.
 */
import type { ISourceData } from 'n8n-workflow';
import type { NodeGadget } from '../compiler/index.js';
import type { ExecutionDataState } from '../n8n/host.js';
import type { Diagnostic, Items, WaitingRow } from './shared.js';

/** Row `k` of `waitingExecution[g]`, read against its `waitingExecutionSource` twin. */
function waitingRow(
  g: NodeGadget,
  k: number,
  main: ReadonlyArray<Items | null | undefined>,
  sources: ReadonlyArray<ISourceData | null | undefined>,
  diag: Diagnostic,
): WaitingRow {
  return {
    k,
    valueAt: (index) => main[index] ?? null,
    sourceAt: (index) => sources[index] ?? null,
    foreign: (owned) => {
      main.forEach((v, index) => {
        if (v !== null && v !== undefined && !owned(index)) {
          diag(`node '${g.node}': waitingExecution[${k}].main[${index}] names an input the node does not have; dropped`);
        }
      });
    },
  };
}

/**
 * Every node's `waitingExecution` rows, per node in ascending run index, each read against its
 * `waitingExecutionSource` twin. Lazy: `nodeOf` resolves a node only once the rows before it
 * have been consumed.
 */
export function* waitingRows(
  executionData: ExecutionDataState,
  nodeOf: (name: string) => NodeGadget,
  diag: Diagnostic,
): Generator<{ readonly g: NodeGadget; readonly row: WaitingRow }> {
  const waiting = executionData.waitingExecution ?? {};
  const waitingSource = executionData.waitingExecutionSource ?? {};
  for (const [name, slots] of Object.entries(waiting)) {
    if (slots === undefined || slots === null) continue;
    const g = nodeOf(name);
    const keys = Object.keys(slots).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    for (const k of keys) {
      yield { g, row: waitingRow(g, k, slots[k]?.main ?? [], waitingSource?.[name]?.[k]?.main ?? [], diag) };
    }
  }
}
