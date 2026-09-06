/**
 * A small LRU of compiled workflows keyed by `(structural hash, budget)`: the net, the
 * `PrecompiledNet` program and the actions are built once per workflow version (CONC-020)
 * and shared by every execution of it. Per-execution state never lives in the compiled
 * workflow: it reaches the actions through the executor's execution context.
 */
import type { CompiledWorkflow } from '../compiler/index.js';

export class CompiledWorkflowCache {
  private readonly entries = new Map<string, CompiledWorkflow>();
  private hitCount = 0;
  private missCount = 0;

  constructor(readonly capacity: number = 16) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`CompiledWorkflowCache: capacity must be >= 1, got ${capacity}`);
  }

  static key(structuralHash: string, budget: number): string {
    return `${structuralHash}:${budget}`;
  }

  get(key: string): CompiledWorkflow | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) {
      this.missCount++;
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, hit);
    this.hitCount++;
    return hit;
  }

  set(key: string, value: CompiledWorkflow): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }
}
