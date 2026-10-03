/**
 * In-memory `StepStore` and `ExecutionStore` for leg (d) of `tasks/v2-seam-plan.md` (step 8): the
 * patched engine's own `StepSettledHandler`, `StepReadyHandler` and `ExecutionStartHandler`, run
 * from its `dist` against these stores by `tasks/v2-handler-leg.mts`, with no database and no
 * queue.
 *
 * **The semantics are ours.** They are written to follow `TypeOrmStepStore` and
 * `TypeOrmExecutionStore` (`packages/@n8n/engine/src/database/` at the pin, n8n master `944afe5`),
 * but nothing here is n8n's code and nothing checks them against Postgres. A result produced on
 * them is settlement evidence about the handlers on these stores (decision 12), not a statement
 * about the TypeORM stores. What they keep from the TypeORM stores:
 * - **Dedupe.** `createSteps` inserts a key `(execution, node, iteration)` once: a key that has a
 *   row, or that came earlier in the same batch, is skipped and not returned (`orIgnore`). The
 *   rows it returns are the inserted ones, in the order the batch named them. Postgres promises
 *   no `RETURNING` order; this order is ours.
 * - **Refuse after a failure.** `createSteps` creates nothing, and `claimStep` claims nothing,
 *   once any row of the execution has failed (the execution-row lock `failStep` takes).
 * - **Compare-and-set.** `claimStep` is `queued → running`; `completeStep`, `suspendStep`,
 *   `failStep` and `cancelStep` are `running → …`; `resumeStep` is `waiting → queued`. Each
 *   returns whether it wrote. `cancelPendingSteps` moves every `queued` and `waiting` row to
 *   `cancelled` and leaves `running` rows alone. `finishExecution` is a compare-and-set on the live
 *   statuses (`running`, `waiting`); `cancelExecution` also takes `queued`.
 * - **Planning reads.** `filledOutputSlots` is, per output slot, whether the slot is not JSON
 *   `null` (`FILLED_OUTPUT_SLOTS`), and `[]` for a row without outputs. `loadLatestStepSummaries`
 *   gives each asked node's highest-iteration row keyed by node id; the keyed loads give the asked
 *   keys' rows keyed `nodeId@iteration`, a key with no row absent. `countSettledSteps` counts
 *   `completed`, `failed`, `skipped` and `cancelled`.
 * - **`refreshLiveStatus`** sets a live execution `running` when a row is `queued` or `running`,
 *   `waiting` when none is but one is `waiting`, and leaves it otherwise.
 *
 * Each method is atomic: after its optional yield ({@link MemoryStoreOptions.yieldTicks}) it runs
 * to the end without an `await`, as one statement or one transaction does. Rows and records are
 * copied on the way in and out, so a caller can never hold a live row, and `loadExecution` hands
 * back a fresh graph object every time, as a JSON column does.
 *
 * Two additions serve the leg and are not store semantics: {@link MemoryStepStore.version}, which
 * every write bumps, and {@link MemoryStepStore.snapshot} / {@link MemoryStepStore.frozen}, which
 * copy one execution's rows out into a store of their own, so two policies can be asked at the
 * same row set.
 */
import type { V2StepStatus } from '../../codec/v2/step-rows.js';
import { rng } from './reference.js';

/** `StepRecord` (`execution/step-store.ts`). Slot contents are opaque JSON. */
export interface MemoryStepRecord {
  readonly id: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly status: V2StepStatus;
  /** Outputs of a completed step, by output slot; `null` until it completes. */
  readonly outputs: unknown[] | null;
  readonly waitDeclaration: unknown;
  readonly resumeCause: unknown;
  readonly error?: { readonly name: string; readonly message: string; readonly stack?: string } | null;
}

/** `NewStepRecord`: the creation statuses only. */
export interface MemoryNewStepRecord {
  readonly nodeId: string;
  readonly iteration: number;
  readonly status: 'queued' | 'skipped' | 'completed';
  readonly outputs?: unknown[];
}

/** `StepSummary`: the planning view of a row. */
export interface MemoryStepSummary {
  readonly id: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly status: V2StepStatus;
  readonly filledOutputSlots: boolean[];
}

/** A key, as `StepKey`. */
export interface MemoryStepKey {
  readonly nodeId: string;
  readonly iteration: number;
}

/** The execution statuses of `execution.types.ts`. */
export type MemoryExecutionStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

/** `NewExecutionRecord`: opaque apart from `id` and `status`. */
export interface MemoryExecutionRecord {
  readonly id: string;
  readonly status: MemoryExecutionStatus;
  readonly [field: string]: unknown;
}

export interface MemoryStoreOptions {
  /**
   * Seed of a shuffle of the records a keyed load returns, which is the order `Object.values`
   * hands them back: a store promises no order. `undefined` keeps creation order.
   */
  readonly order?: number;
  /** Ticks (`setImmediate`) every call yields before it runs, so concurrent handlers interleave. */
  readonly yieldTicks?: () => number;
  /** The error `loadStep` throws for an unknown id; the leg passes n8n's `StepNotFoundError`. */
  readonly stepNotFound?: (id: string) => Error;
  /** The error `loadExecution` throws for an unknown id; the leg passes n8n's `ExecutionNotFoundError`. */
  readonly executionNotFound?: (id: string) => Error;
}

type Row = { -readonly [K in keyof MemoryStepRecord]: MemoryStepRecord[K] };

const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'skipped', 'cancelled']);
const LIVE: ReadonlySet<string> = new Set(['running', 'waiting']);
const CREATION: ReadonlySet<string> = new Set(['queued', 'completed', 'skipped']);

const keyId = (k: MemoryStepKey): string => `${k.nodeId}@${k.iteration}`;
const copy = <T>(value: T): T => structuredClone(value);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

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

/** `FILLED_OUTPUT_SLOTS`: per slot, whether it holds something other than JSON `null`. */
function filledSlots(outputs: unknown[] | null): boolean[] {
  return outputs === null ? [] : outputs.map((v) => v !== null && v !== undefined);
}

function summaryOf(r: Row): MemoryStepSummary {
  return { id: r.id, nodeId: r.nodeId, iteration: r.iteration, status: r.status, filledOutputSlots: filledSlots(r.outputs) };
}

/** An in-memory `StepStore` (see the module doc). */
export class MemoryStepStore {
  /** Bumped by every write that changed a row. */
  version = 0;
  /** Called after a row's status changed, with the row as it is now. The leg uses it to schedule resumes. */
  onTransition: ((row: MemoryStepRecord, from: V2StepStatus | null) => void) | undefined;

  private readonly rows = new Map<string, Row>();
  /** `execution id` → (`nodeId@iteration` → row id), in creation order. */
  private readonly byKey = new Map<string, Map<string, string>>();
  private nextId = 0;

  constructor(private readonly options: MemoryStoreOptions = {}) {}

  /** A store holding a copy of `rows` and nothing else: the rows one policy call was asked at. */
  static frozen(rows: readonly MemoryStepRecord[], options: MemoryStoreOptions = {}): MemoryStepStore {
    const store = new MemoryStepStore(options);
    for (const r of rows) store.insert(copy(r) as Row);
    return store;
  }

  /** One execution's rows, copied, in creation order. Synchronous: no other call interleaves. */
  snapshot(executionId: string): MemoryStepRecord[] {
    return [...(this.byKey.get(executionId)?.values() ?? [])].map((id) => copy(this.rows.get(id)!));
  }

  /** Whether any row of `executionId` has failed. Synchronous. */
  hasFailedNow(executionId: string): boolean {
    return this.executionRows(executionId).some((r) => r.status === 'failed');
  }

  private insert(row: Row): void {
    this.rows.set(row.id, row);
    let keys = this.byKey.get(row.executionId);
    if (keys === undefined) this.byKey.set(row.executionId, (keys = new Map()));
    keys.set(keyId(row), row.id);
    const n = Number(row.id.replace(/^s/, ''));
    if (Number.isInteger(n) && n >= this.nextId) this.nextId = n + 1;
  }

  private executionRows(executionId: string): Row[] {
    return [...(this.byKey.get(executionId)?.values() ?? [])].map((id) => this.rows.get(id)!);
  }

  private async pause(): Promise<void> {
    for (let n = this.options.yieldTicks?.() ?? 0; n > 0; n--) await tick();
  }

  private move(row: Row, to: V2StepStatus, fields: Partial<Row> = {}): void {
    const from = row.status;
    Object.assign(row, fields, { status: to });
    this.version++;
    this.onTransition?.(copy(row), from);
  }

  /** A compare-and-set on the row's status. */
  private transition(id: string, from: V2StepStatus, to: V2StepStatus, fields: Partial<Row> = {}): boolean {
    const row = this.rows.get(id);
    if (row === undefined || row.status !== from) return false;
    this.move(row, to, fields);
    return true;
  }

  async createSteps(executionId: string, records: readonly MemoryNewStepRecord[]): Promise<Array<{ id: string } & MemoryStepKey>> {
    await this.pause();
    if (records.length === 0) return [];
    for (const r of records) {
      if (!Number.isInteger(r.iteration) || r.iteration < 0) throw new Error(`step for node ${r.nodeId} is created with iteration ${r.iteration}`);
      if (!CREATION.has(r.status)) throw new Error(`step for node ${r.nodeId} is created ${r.status}`);
      if (r.status === 'completed' && !Array.isArray(r.outputs)) throw new Error(`step for node ${r.nodeId} is created completed without a slot list`);
    }
    if (this.hasFailedNow(executionId)) return [];
    const created: Array<{ id: string } & MemoryStepKey> = [];
    for (const r of records) {
      // The unique key: a key that has a row, or came earlier in this batch, is skipped.
      if (this.byKey.get(executionId)?.has(keyId(r)) === true) continue;
      const row: Row = {
        id: `s${this.nextId++}`, executionId, nodeId: r.nodeId, iteration: r.iteration, status: r.status,
        outputs: r.status === 'completed' ? copy(r.outputs!) : null, waitDeclaration: null, resumeCause: null,
      };
      this.insert(row);
      this.version++;
      this.onTransition?.(copy(row), null);
      created.push({ id: row.id, nodeId: row.nodeId, iteration: row.iteration });
    }
    return created;
  }

  async loadStep(id: string): Promise<MemoryStepRecord> {
    await this.pause();
    const row = this.rows.get(id);
    if (row === undefined) throw this.options.stepNotFound?.(id) ?? new Error(`Step not found: ${id}`);
    return copy(row);
  }

  async claimStep(id: string): Promise<MemoryStepRecord | null> {
    await this.pause();
    const row = this.rows.get(id);
    if (row === undefined || row.status !== 'queued' || this.hasFailedNow(row.executionId)) return null;
    this.move(row, 'running');
    return copy({ ...row, outputs: null });
  }

  async completeStep(id: string, outputs: unknown[]): Promise<boolean> {
    await this.pause();
    return this.transition(id, 'running', 'completed', { outputs: copy(outputs) });
  }

  async suspendStep(id: string, waitDeclaration: unknown): Promise<boolean> {
    await this.pause();
    return this.transition(id, 'running', 'waiting', { waitDeclaration: copy(waitDeclaration) });
  }

  async resumeStep(id: string, resumeCause: unknown): Promise<boolean> {
    await this.pause();
    return this.transition(id, 'waiting', 'queued', { resumeCause: copy(resumeCause) });
  }

  /** Deadline waits are not used by the leg: nothing is due. */
  async resumeDueSteps(): Promise<Array<{ id: string; executionId: string }>> {
    await this.pause();
    return [];
  }

  async nextWaitDeadline(): Promise<Date | null> {
    await this.pause();
    return null;
  }

  async failStep(id: string, error: { name: string; message: string; stack?: string }): Promise<boolean> {
    await this.pause();
    return this.transition(id, 'running', 'failed', { error: copy(error) });
  }

  async cancelStep(id: string): Promise<boolean> {
    await this.pause();
    return this.transition(id, 'running', 'cancelled');
  }

  async cancelPendingSteps(executionId: string): Promise<void> {
    await this.pause();
    for (const row of this.executionRows(executionId)) {
      if (row.status === 'queued' || row.status === 'waiting') this.move(row, 'cancelled');
    }
  }

  async loadStepsByKeys(executionId: string, keys: readonly MemoryStepKey[]): Promise<Record<string, MemoryStepRecord>> {
    await this.pause();
    const found = this.keyed(executionId, keys);
    return Object.fromEntries(shuffled(found, this.options.order).map((r) => [keyId(r), copy(r)]));
  }

  async loadStepSummariesByKeys(executionId: string, keys: readonly MemoryStepKey[]): Promise<Record<string, MemoryStepSummary>> {
    await this.pause();
    const found = this.keyed(executionId, keys);
    return Object.fromEntries(shuffled(found, this.options.order).map((r) => [keyId(r), summaryOf(r)]));
  }

  private keyed(executionId: string, keys: readonly MemoryStepKey[]): Row[] {
    const index = this.byKey.get(executionId);
    if (index === undefined) return [];
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const k of keys) {
      const id = keyId(k);
      const rowId = index.get(id);
      if (rowId === undefined || seen.has(id)) continue;
      seen.add(id);
      out.push(this.rows.get(rowId)!);
    }
    return out;
  }

  async loadLatestStepSummaries(executionId: string, nodeIds: readonly string[]): Promise<Record<string, MemoryStepSummary>> {
    await this.pause();
    const asked = new Set(nodeIds);
    const latest = new Map<string, Row>();
    for (const r of this.executionRows(executionId)) {
      if (!asked.has(r.nodeId)) continue;
      const known = latest.get(r.nodeId);
      if (known === undefined || known.iteration < r.iteration) latest.set(r.nodeId, r);
    }
    return Object.fromEntries(shuffled([...latest.values()], this.options.order).map((r) => [r.nodeId, summaryOf(r)]));
  }

  async loadAllSteps(executionId: string): Promise<MemoryStepRecord[]> {
    await this.pause();
    return this.executionRows(executionId)
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : a.iteration - b.iteration))
      .map((r) => copy(r));
  }

  async countSettledSteps(executionId: string): Promise<number> {
    await this.pause();
    return this.executionRows(executionId).filter((r) => SETTLED.has(r.status)).length;
  }

  async hasFailedSteps(executionId: string): Promise<boolean> {
    await this.pause();
    return this.hasFailedNow(executionId);
  }
}

/** An in-memory `ExecutionStore` over the rows of `steps` (see the module doc). */
export class MemoryExecutionStore {
  private readonly records = new Map<string, Record<string, unknown> & { id: string; status: MemoryExecutionStatus; finishedAt: Date | null }>();

  constructor(private readonly steps: MemoryStepStore, private readonly options: MemoryStoreOptions = {}) {}

  private async pause(): Promise<void> {
    for (let n = this.options.yieldTicks?.() ?? 0; n > 0; n--) await tick();
  }

  /** The record's status now. Synchronous. */
  statusNow(id: string): MemoryExecutionStatus | undefined {
    return this.records.get(id)?.status;
  }

  async createExecution(record: MemoryExecutionRecord): Promise<void> {
    await this.pause();
    if (this.records.has(record.id)) throw new Error(`execution ${record.id} exists`);
    this.records.set(record.id, { ...copy(record), finishedAt: null });
  }

  async loadExecution(id: string): Promise<Record<string, unknown> & { id: string; status: MemoryExecutionStatus; finishedAt: Date | null }> {
    await this.pause();
    const r = this.records.get(id);
    if (r === undefined) throw this.options.executionNotFound?.(id) ?? new Error(`Execution not found: ${id}`);
    return copy(r);
  }

  async transitionStatus(id: string, from: MemoryExecutionStatus, to: MemoryExecutionStatus): Promise<boolean> {
    await this.pause();
    const r = this.records.get(id);
    if (r === undefined || r.status !== from) return false;
    r.status = to;
    return true;
  }

  async finishExecution(id: string, status: 'completed' | 'failed'): Promise<{ finishedAt: Date } | null> {
    await this.pause();
    const r = this.records.get(id);
    if (r === undefined || !LIVE.has(r.status)) return null;
    const finishedAt = new Date();
    r.status = status;
    r.finishedAt = finishedAt;
    return { finishedAt };
  }

  async cancelExecution(id: string): Promise<{ finishedAt: Date } | null> {
    await this.pause();
    const r = this.records.get(id);
    if (r === undefined || !(r.status === 'queued' || LIVE.has(r.status))) return null;
    const finishedAt = new Date();
    r.status = 'cancelled';
    r.finishedAt = finishedAt;
    return { finishedAt };
  }

  async refreshLiveStatus(id: string): Promise<void> {
    await this.pause();
    const r = this.records.get(id);
    if (r === undefined || !LIVE.has(r.status)) return;
    const rows = this.steps.snapshot(id);
    const runnable = rows.some((s) => s.status === 'queued' || s.status === 'running');
    const waiting = rows.some((s) => s.status === 'waiting');
    if (runnable) r.status = 'running';
    else if (waiting) r.status = 'waiting';
  }
}
