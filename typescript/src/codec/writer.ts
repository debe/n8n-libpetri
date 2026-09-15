/**
 * What one {@link encodeMarking} writes: stack entries in discovery order and
 * `waitingExecution` rows numbered `0…` per node, collected by {@link EncodeTarget}. The
 * per-node view the per-form encoders write through — the live `INode` of a node, and the two
 * conversions every input form applies to a pending token (an entry, or its stranded row) —
 * is `node-writer.ts`, whose vocabulary this module re-exports.
 */
import type { IExecuteData, IWaitingForExecution, IWaitingForExecutionSource } from 'n8n-workflow';
import type { NodeGadget } from '../compiler/index.js';
import type { ExecutionDataState } from '../n8n/host.js';
import { nodeWriter, type EncodeScope, type NodeWriter, type SlotRow } from './node-writer.js';
import { inputCountOf, type SlotMain, type SlotSource } from './shared.js';

export type { Cell, EncodeMode, EncodeScope, NodeWriter, SlotRow } from './node-writer.js';

/** A pending activation to be written back as a stack entry. */
interface PendingEntry {
  readonly executionData: IExecuteData;
  readonly depth: number;
  readonly canvas: number;
  readonly waiting: boolean;
  /** Discovery order: per node waiting, stopped, retry, running, then the input FIFO / positional rows. */
  readonly seq: number;
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
    return nodeWriter(this.scope, g, {
      push: (e, waiting) => {
        this.pending.push({ executionData: e, depth: g.depth, canvas, waiting, seq: this.seq++ });
      },
      nextSlot: () => this.nextSlot(g),
    });
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
