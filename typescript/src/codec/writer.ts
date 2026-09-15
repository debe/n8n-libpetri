/**
 * What one {@link encodeMarking} writes, and the per-node view the per-form encoders write
 * through: stack entries in discovery order, `waitingExecution` rows numbered `0…` per node,
 * the live `INode` of a node, and the two conversions every input form applies to a pending
 * token (an entry, or its stranded row).
 */
import type { Marking, Place } from 'libpetri';
import type { IExecuteData, IWaitingForExecution, IWaitingForExecutionSource } from 'n8n-workflow';
import type { CompiledWorkflow, NodeGadget } from '../compiler/index.js';
import type { ExecutionDataState } from '../n8n/host.js';
import { isEdgePayload, isEntryPayload } from '../scheduler/payloads.js';
import { entryForEdge } from './entry.js';
import { inputCountOf, type Diagnostic, type SlotMain, type SlotSource } from './shared.js';

export type EncodeMode = 'pause' | 'cancelled' | 'stranded';

/** A pending token of an input, and the place it was read from (named by every report on it). */
export interface Cell {
  readonly value: unknown;
  readonly place: Place<unknown>;
}

/** A pending activation to be written back as a stack entry. */
interface PendingEntry {
  readonly executionData: IExecuteData;
  readonly depth: number;
  readonly canvas: number;
  readonly waiting: boolean;
  /** Discovery order: per node waiting, stopped, retry, running, then the input FIFO / positional rows. */
  readonly seq: number;
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

/** The stack entries and `waitingExecution` rows one encode collects, written back by {@link EncodeTarget.writeTo}. */
export class EncodeTarget {
  private readonly scope: EncodeScope;
  private readonly pending: PendingEntry[] = [];
  private readonly waiting: IWaitingForExecution = {};
  private readonly waitingSource: IWaitingForExecutionSource = {};
  private readonly slotCounts = new Map<string, number>();
  private seq = 0;

  constructor(scope: EncodeScope) {
    this.scope = scope;
  }

  /** The writer of the node at canvas position `canvas`. */
  writerFor(g: NodeGadget, canvas: number): NodeWriter {
    const { compiled, marking, mode, diag, executionData, resolveNode } = this.scope;
    const liveNode = (): IExecuteData['node'] => nodeOfGadget(g, executionData, resolveNode);
    const nextSlot = (): SlotRow => this.nextSlot(g);
    return {
      g, compiled, marking, mode, diag, liveNode, nextSlot,
      push: (e, waiting = false) => {
        this.pending.push({ executionData: e, depth: g.depth, canvas, waiting, seq: this.seq++ });
      },
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

  /**
   * The next `waitingExecution[node][k]` / `waitingExecutionSource[node][k]` row, `null` per
   * input; rows are numbered `0…` per node in the order they are written.
   */
  private nextSlot(g: NodeGadget): SlotRow {
    const k = this.slotCounts.get(g.node) ?? 0;
    this.slotCounts.set(g.node, k + 1);
    const inputCount = inputCountOf(this.scope.compiled, g);
    const main: SlotMain = Array.from({ length: inputCount }, () => null);
    const source: SlotSource = Array.from({ length: inputCount }, () => null);
    (this.waiting[g.node] ??= {})[k] = { main };
    (this.waitingSource[g.node] ??= {})[k] = { main: source };
    return { main, source };
  }

  /**
   * Rewrites `nodeExecutionStack`, `waitingExecution` and `waitingExecutionSource`. The stack
   * holds the waiting node first, then the deepest pending node, which is where n8n's LIFO
   * stack (`unshift`) has it; within a node the FIFO / positional order, which is the order
   * the net fires them in.
   */
  writeTo(executionData: ExecutionDataState): ExecutionDataState {
    this.pending.sort((x, y) => (Number(y.waiting) - Number(x.waiting)) || (y.depth - x.depth) || (x.canvas - y.canvas) || (x.seq - y.seq));
    executionData.nodeExecutionStack = this.pending.map((p) => p.executionData);
    executionData.waitingExecution = this.waiting;
    executionData.waitingExecutionSource = this.waitingSource;
    return executionData;
  }
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
