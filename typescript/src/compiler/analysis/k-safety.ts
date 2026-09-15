/**
 * The k-safety facts the budget check needs: inputs fed by more than one producer edge.
 */
import type { EdgeRef, MultiProducerInput } from '../types.js';

/** Every input with more than one producer edge. */
export function multiProducerInputsOf(edges: readonly EdgeRef[]): MultiProducerInput[] {
  // ---- k-safety facts ----
  const producers = new Map<string, MultiProducerInput>();
  for (const e of edges) {
    const key = `${e.to} ${e.inputIndex}`;
    const prev = producers.get(key);
    producers.set(key, prev === undefined
      ? { node: e.to, inputIndex: e.inputIndex, producers: 1 }
      : { ...prev, producers: prev.producers + 1 });
  }
  const multiProducerInputs = [...producers.values()].filter((p) => p.producers > 1);
  return multiProducerInputs;
}
