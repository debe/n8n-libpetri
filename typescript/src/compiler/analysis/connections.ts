/**
 * Main connections validated against the nodes' port counts, deduplicated, and sorted into the
 * canonical order edge ids are assigned in (producer canvas index, output, consumer canvas
 * index, input).
 */
import { CompileError } from '../errors.js';
import type { EdgeRef, WorkflowDescription } from '../types.js';
import type { RawNode } from './validate.js';

/** A validated main connection with the canvas indexes its canonical order sorts on. */
export interface RawEdge extends Omit<EdgeRef, 'id' | 'kind'> {
  readonly fromIndex: number;
  readonly toIndex: number;
}

/** The validated, deduplicated main connections in canonical order. */
export function canonicaliseConnections(
  workflow: WorkflowDescription,
  rawByName: ReadonlyMap<string, RawNode>,
  diagnostics: string[],
): RawEdge[] {
  // ---- connections: validation, deduplication, canonical order ----
  const seen = new Set<string>();
  const raw: RawEdge[] = [];
  for (const c of workflow.connections) {
    const from = rawByName.get(c.from);
    const to = rawByName.get(c.to);
    if (from === undefined) {
      throw new CompileError('unknown-connection-node', `compile: connection from unknown node '${c.from}'`, c.from);
    }
    if (to === undefined) {
      throw new CompileError('unknown-connection-node', `compile: connection to unknown node '${c.to}'`, c.to);
    }
    if (!Number.isInteger(c.outputIndex) || c.outputIndex < 0 || c.outputIndex >= from.outputCount) {
      throw new CompileError('output-index-out-of-range',
        `compile: connection ${c.from}.${c.outputIndex} -> ${c.to}.${c.inputIndex}: ` +
        `output index out of range (node has ${from.outputCount} outputs)`, c.from);
    }
    if (!Number.isInteger(c.inputIndex) || c.inputIndex < 0 || c.inputIndex >= to.shape.inputCount) {
      throw new CompileError('input-index-out-of-range',
        `compile: connection ${c.from}.${c.outputIndex} -> ${c.to}.${c.inputIndex}: ` +
        `input index out of range (node has ${to.shape.inputCount} inputs)`, c.to);
    }
    const key = `${c.from} ${c.outputIndex} ${c.to} ${c.inputIndex}`;
    if (seen.has(key)) {
      diagnostics.push(`duplicate connection ${c.from}.${c.outputIndex} -> ${c.to}.${c.inputIndex}; ignored`);
      continue;
    }
    seen.add(key);
    raw.push({
      from: c.from, outputIndex: c.outputIndex, to: c.to, inputIndex: c.inputIndex,
      fromIndex: from.index, toIndex: to.index,
    });
  }
  raw.sort((x, y) =>
    (x.fromIndex - y.fromIndex) || (x.outputIndex - y.outputIndex) || (x.toIndex - y.toIndex) || (x.inputIndex - y.inputIndex));
  return raw;
}
