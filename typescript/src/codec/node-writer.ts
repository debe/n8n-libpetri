/**
 * The per-node view the per-form encoders write through ({@link NodeWriter}): the node's live
 * `INode`, and the two conversions every input form applies to a pending token (an entry, or
 * its stranded row). Its stack entries and rows land in the encode's `EncodeTarget`
 * (`writer.ts`) through a {@link NodeSink}.
 */
import type { Marking, Place } from 'libpetri';
import type { IExecuteData } from 'n8n-workflow';
import type { CompiledWorkflow, NodeGadget } from '../compiler/index.js';
import type { ExecutionDataState } from '../n8n/host.js';
import { isEdgePayload, isEntryPayload } from '../scheduler/payloads.js';
import { entryForEdge } from './entry.js';
import type { Diagnostic, SlotMain, SlotSource } from './shared.js';

export type EncodeMode = 'pause' | 'cancelled' | 'stranded';

/** A pending token of an input, and the place it was read from (named by every report on it). */
export interface Cell {
  readonly value: unknown;
  readonly place: Place<unknown>;
}

/** A fresh `waitingExecution[X][k]` row and its `waitingExecutionSource` twin, `null` per input. */
export interface SlotRow {
  readonly main: SlotMain;
  readonly source: SlotSource;
}

/** What every per-form encoder reads and writes for one node. */
export interface NodeWriter {
  readonly g: NodeGadget;
  readonly compiled: CompiledWorkflow;
  readonly marking: Marking;
  readonly mode: EncodeMode;
  readonly diag: Diagnostic;
  /** Adds a stack entry of this node. */
  push(e: IExecuteData, waiting?: boolean): void;
  /** The node's next `waitingExecution` row. */
  nextSlot(): SlotRow;
  /** The node's live `INode` ({@link EncodeScope.resolveNode}). */
  liveNode(): IExecuteData['node'];
  /** An `X/in` / `X/hasdata_i` token as n8n's stack entry; `null`, reported, for a token that carries none. */
  entryOf(inputIndex: number, value: unknown, place: Place<unknown>): IExecuteData | null;
  /** The stranded form of an entry: its input's data as a stuck row, reported. */
  strand(inputIndex: number, e: IExecuteData, place: Place<unknown>): void;
}

/** The inputs of one encode. */
export interface EncodeScope {
  readonly compiled: CompiledWorkflow;
  readonly marking: Marking;
  readonly mode: EncodeMode;
  readonly diag: Diagnostic;
  /** The state being rewritten; its stack is read for live `INode` objects before it is replaced. */
  readonly executionData: ExecutionDataState;
  /** `EncodeOptions.node`. */
  readonly resolveNode: ((name: string) => IExecuteData['node'] | undefined) | undefined;
}

/** Where one node's writes land: the encode's stack entries and its `waitingExecution` rows. */
export interface NodeSink {
  push(e: IExecuteData, waiting: boolean): void;
  nextSlot(): SlotRow;
}

/**
 * The live `INode` of a gadget, as n8n puts it on a stack entry (`workflow.nodes[name]`):
 * from `resolve`, else from any entry already on the stack that names the node, else a
 * name-only stub.
 */
function nodeOfGadget(
  g: NodeGadget,
  executionData: ExecutionDataState,
  resolve: EncodeScope['resolveNode'],
): IExecuteData['node'] {
  const live = resolve?.(g.node);
  if (live !== undefined) return live;
  for (const e of executionData.nodeExecutionStack) if (e.node.name === g.node) return e.node;
  return { id: g.id, name: g.node, type: g.type, typeVersion: g.typeVersion, position: [0, 0], parameters: {} };
}

/** The writer of node `g` in one encode, writing into `sink`. */
export function nodeWriter(scope: EncodeScope, g: NodeGadget, sink: NodeSink): NodeWriter {
  const { compiled, marking, mode, diag, executionData, resolveNode } = scope;
  const liveNode = (): IExecuteData['node'] => nodeOfGadget(g, executionData, resolveNode);
  const nextSlot = (): SlotRow => sink.nextSlot();
  return {
    g, compiled, marking, mode, diag, liveNode, nextSlot,
    push: (e, waiting = false) => sink.push(e, waiting),
    entryOf: (inputIndex, value, place) => {
      if (isEntryPayload(value)) return value.executionData;
      if (isEdgePayload(value)) return entryForEdge(liveNode(), inputIndex, value);
      diag(`node '${g.node}': token on '${place.name}' carries no executionData; dropped`);
      return null;
    },
    strand: (inputIndex, e, place) => {
      diag(`node '${g.node}': stranded token on '${place.name}' (divergence #2); written to waitingExecution`);
      const s = nextSlot();
      s.main[inputIndex] = e.data.main?.[inputIndex] ?? [];
      s.source[inputIndex] = e.source?.main?.[0] ?? null;
    },
  };
}
