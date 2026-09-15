/**
 * What the direction modules and the per-form modules share: the marking-map and slot-row
 * shapes, the `waitingExecution` row as decode reads it, the token helpers, and the two facts
 * about a gadget's input side the slot arrays are cut from (the input index a direct-form
 * node's `X/in` serves, and n8n's input count).
 */
import type { Place, Token } from 'libpetri';
import type { INodeExecutionData, ISourceData } from 'n8n-workflow';
import type { CompiledWorkflow, DirectGadget, NodeGadget } from '../compiler/index.js';
import type { EdgePayload } from '../scheduler/payloads.js';

export type MarkingMap = Map<Place<unknown>, Token<unknown>[]>;
export type Items = INodeExecutionData[];
/** One `waitingExecution[X][k].main` row: items, `[]` (arrived empty) or `null` (not arrived) per input. */
export type SlotMain = Array<Items | null>;
/** The matching `waitingExecutionSource[X][k].main` row. */
export type SlotSource = Array<ISourceData | null>;
/** Receives one line per report, naming node and place. */
export type Diagnostic = (message: string) => void;

export const noop: Diagnostic = (): void => {};

/** One `waitingExecution[X][k]` row (with its `waitingExecutionSource` twin) as decode reads it. */
export interface WaitingRow {
  /** The row's run index `k`. */
  readonly k: number;
  /** `main[index]`: items, `[]` (arrived empty), or `null` for a missing or `null` cell (not arrived). */
  valueAt(index: number): Items | null;
  sourceAt(index: number): ISourceData | null;
  /**
   * Reports every arrived cell at an index `owned` rejects — an input the node does not model,
   * the shape n8n leaves behind when a node's input count shrinks — and skips it.
   */
  foreign(owned: (index: number) => boolean): void;
}

export function add(marking: MarkingMap, place: Place<unknown>, token: Token<unknown>): void {
  const queue = marking.get(place);
  if (queue === undefined) marking.set(place, [token]);
  else queue.push(token);
}

export function count(marking: MarkingMap, place: Place<unknown> | null): number {
  return place === null ? 0 : (marking.get(place)?.length ?? 0);
}

export function edgePayload(items: Items, source: ISourceData | null): EdgePayload {
  return { kind: 'edge', items, source };
}

/** The input index a direct-form node's `X/in` serves (0 for a synthetic `in`). */
export function directInputIndex(compiled: CompiledWorkflow, g: DirectGadget): number {
  return compiled.netMap.place(g.in.name)?.edge?.inputIndex ?? 0;
}

/** n8n's `connectionsByDestinationNode[node].main.length`: the slot arrays are this long. */
export function inputCountOf(compiled: CompiledWorkflow, g: NodeGadget): number {
  if (g.form === 'direct') return directInputIndex(compiled, g) + 1;
  return Math.max(1, ...g.inputs.map((i) => i.index + 1));
}
