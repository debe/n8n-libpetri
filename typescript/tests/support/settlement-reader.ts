/**
 * An in-memory `SettlementReader` (patch 0003, mirrored in `src/n8n/v2-host.ts`) over a fixed row
 * set, for the settlement policy suites. It answers as `TypeormStepStore` does at the pin: the
 * latest row per asked node keyed by node id, the rows of the asked keys keyed `nodeId@iteration`
 * (`stepKeyId`), absent keys left out, and the settled count over completed, failed, skipped and
 * cancelled rows.
 *
 * - `order` permutes the order the records are built in (a seeded shuffle), which is the order
 *   `Object.values` hands them back: a store promises no order.
 * - `delay` makes every call yield first, so concurrent policy calls interleave at their awaits.
 * - `calls` counts every call by method, `countSettledSteps` included.
 */
import type { StepRow } from '../../src/codec/v2/step-rows.js';
import type { V2SettlementReader, V2StepKey, V2StepSummary } from '../../src/n8n/v2-host.js';
import { rng } from '../../src/conformance/v2/reference.js';

const SETTLED = new Set(['completed', 'failed', 'skipped', 'cancelled']);

export interface ReaderOptions {
  readonly executionId?: string;
  /** Seed of the record-order shuffle; `undefined` keeps the rows' order. */
  readonly order?: number;
  /** Ticks to yield before each answer (`setImmediate`), `0` for none. */
  readonly delay?: () => number;
}

export interface CountingReader extends V2SettlementReader {
  readonly calls: { loadLatestStepSummaries: number; loadStepSummariesByKeys: number; countSettledSteps: number };
  /** Every call, all methods. */
  total(): number;
}

function shuffled<T>(items: readonly T[], seed: number | undefined): T[] {
  const out = [...items];
  if (seed === undefined) return out;
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A reader over `rows` (see the module doc). Rows without an `id` get one from their position. */
export function memoryReader(rows: readonly (StepRow & { readonly id?: string })[], options: ReaderOptions = {}): CountingReader {
  const summaries: V2StepSummary[] = rows.map((r, i) => ({
    id: r.id ?? String(i), nodeId: r.nodeId, iteration: r.iteration, status: r.status, filledOutputSlots: [...r.filledOutputSlots],
  }));
  const calls = { loadLatestStepSummaries: 0, loadStepSummariesByKeys: 0, countSettledSteps: 0 };
  const wait = async () => {
    for (let n = options.delay?.() ?? 0; n > 0; n--) await tick();
  };
  return {
    executionId: options.executionId ?? 'execution-1',
    calls,
    total: () => calls.loadLatestStepSummaries + calls.loadStepSummariesByKeys + calls.countSettledSteps,
    async loadLatestStepSummaries(nodeIds) {
      calls.loadLatestStepSummaries++;
      await wait();
      const asked = new Set(nodeIds);
      const latest = new Map<string, V2StepSummary>();
      for (const s of summaries) {
        if (!asked.has(s.nodeId)) continue;
        const known = latest.get(s.nodeId);
        if (known === undefined || known.iteration < s.iteration) latest.set(s.nodeId, s);
      }
      return Object.fromEntries(shuffled([...latest.values()], options.order).map((s) => [s.nodeId, { ...s, filledOutputSlots: [...s.filledOutputSlots] }]));
    },
    async loadStepSummariesByKeys(keys: V2StepKey[]) {
      calls.loadStepSummariesByKeys++;
      await wait();
      const asked = new Set(keys.map((k) => `${k.nodeId}@${k.iteration}`));
      const found = summaries.filter((s) => asked.has(`${s.nodeId}@${s.iteration}`));
      return Object.fromEntries(shuffled(found, options.order).map((s) => [`${s.nodeId}@${s.iteration}`, { ...s, filledOutputSlots: [...s.filledOutputSlots] }]));
    },
    async countSettledSteps() {
      calls.countSettledSteps++;
      await wait();
      return summaries.filter((s) => SETTLED.has(s.status)).length;
    },
  };
}
