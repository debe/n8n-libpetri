/**
 * Structural mirrors of the engine v2 settlement seam (`tasks/v2-seam-plan.md` decisions 1–5):
 * the types `patches/n8n/0003-settlement-policy.patch` adds in `@n8n/engine`
 * `execution/settlement-policy.ts`, and the registry `0004-settlement-policy-registry.patch` adds
 * in `execution/settlement-policy-registry.ts`, at n8n master `944afe5`. As with `host.ts` for
 * patches 0001/0002, `src/` never imports `.n8n`: the process that hosts both passes the engine's
 * module in, and these shapes are what it is checked against.
 *
 * Names keep n8n's with a `V2` prefix, so a reader can find each in the patch. What is mirrored:
 * - `StepKey`, `StepSummary` and `SuccessorDecisions` (`execution.types.ts`, `step-store.ts`,
 *   `settlement.ts`): the rows a policy reads and the answer it gives;
 * - `SettlementReader`: the execution-bound, read-only port (decision 2). It has no write method,
 *   so a policy given only this cannot change the rows it decides from;
 * - `SettlementPolicy`: `decideSuccessors` and `isFinished` (decision 1);
 * - the registry functions and `defaultSettlementPolicy`, the members of the engine's module that
 *   registering a policy uses (`settlement/register.ts`).
 *
 * The graph is the mirror in `v2-graph.ts`.
 */
import type { V2Graph } from './v2-graph.js';

/** `StepKey` (`execution/execution.types.ts`): one row's identity within an execution, by node id. */
export interface V2StepKey {
  readonly nodeId: string;
  readonly iteration: number;
}

/**
 * `StepSummary` (`execution/step-store.ts`): the planning view of one row. `status` is a string
 * here: the rows come from n8n, and a status the pin does not know is the decoder's `CodecError`,
 * not a type error at a distance.
 */
export interface V2StepSummary extends V2StepKey {
  readonly id: string;
  readonly status: string;
  /** Per output slot: whether the completed step put data there. Empty unless completed. */
  readonly filledOutputSlots: readonly boolean[];
}

/** `SuccessorDecisions` (`execution/settlement.ts`): steps to queue and to record as skipped, in edge order. */
export interface V2SuccessorDecisions {
  readonly toQueue: V2StepKey[];
  readonly toSkip: V2StepKey[];
}

/**
 * `SettlementReader` (patch 0003): the planning reads of one execution's rows. Each method is the
 * `StepStore` method of the same name with the execution bound; `settlementReaderFor` passes
 * every call through, with no cache.
 */
export interface V2SettlementReader {
  readonly executionId: string;
  /** Each named node's highest-iteration row, keyed by node id; a node with no row is absent. */
  loadLatestStepSummaries(nodeIds: string[]): Promise<Record<string, V2StepSummary>>;
  /** The rows of the given keys, keyed `nodeId@iteration`; a key with no row is absent. */
  loadStepSummariesByKeys(keys: V2StepKey[]): Promise<Record<string, V2StepSummary>>;
  /** How many of the execution's rows have settled. */
  countSettledSteps(): Promise<number>;
}

/** `SettlementPolicy` (patch 0003): the two decisions `StepSettledHandler` takes from the rows. */
export interface V2SettlementPolicy {
  /**
   * The successor steps the settlement of `settled` decides: in edge order, leaving out every
   * step that already has a row. The handler passes its `StepRecord`; only the key is read.
   */
  decideSuccessors(graph: V2Graph, settled: V2StepKey, reader: V2SettlementReader): Promise<V2SuccessorDecisions>;
  /** Whether every step the execution owes has settled. */
  isFinished(graph: V2Graph, reader: V2SettlementReader): Promise<boolean>;
}

/**
 * The members of `@n8n/engine` (patches 0003 and 0004) a host hands `registerSettlementPolicy`:
 * the registry `createEngineRuntime` reads, and n8n's own policy, which a shadow compares against.
 * The process may load the engine twice (`src` for its own tests, `dist` for the compat package's),
 * and registering on one instance leaves the other on the default: pass the one the runtime uses.
 */
export interface V2SettlementRegistry {
  setSettlementPolicy(policy: V2SettlementPolicy): void;
  getSettlementPolicy(): V2SettlementPolicy;
  resetSettlementPolicy(): void;
  readonly defaultSettlementPolicy: V2SettlementPolicy;
}
