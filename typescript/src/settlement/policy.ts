/**
 * The net-backed `SettlementPolicy` (`tasks/v2-seam-plan.md` decisions 6–10): the two decisions
 * engine v2's `StepSettledHandler` takes from its step rows (patch 0003), answered by the
 * `engineV2` net instead of `settlement.ts` and `completion.ts`.
 *
 * Per call:
 * 1. the graph's net from the compile memo (`compile-cache.ts`, decision 10), or its refusal;
 * 2. the row snapshot from the reader (`rows.ts`, decision 9, step 14 and step 12's scoped read): the
 *    frontier of S at one instant, in one or two reads (four on a loop that ran two passes between
 *    them), never `countSettledSteps`; or, for `isFinished`, the snapshot `decideSuccessors` read in
 *    the same settlement (below), in no read at all;
 * 3. a pure function of those rows — {@link decideFromRows} or {@link finishedFromRows}.
 *
 * **One snapshot per settlement** (`tasks/v2-seam-plan.md`, step 12 rerun, with its safety
 * argument). `StepSettledHandler` calls `decideSuccessors(s)`, writes what it decided
 * (`createSteps`), and, when nothing was queued, calls `isFinished`, both with its one
 * `execution.graph` object. `decideSuccessors` keeps the rows it read and what it decided, keyed by
 * that graph object; `isFinished` on the same object and execution takes them, once, and answers
 * `isFinished(T ∪ D̂)`, where D̂ is the decided keys as `queued` and `skipped` rows. The snapshot may be
 * stale by then; the argument shows staleness can only make the answer false where a fresh read would
 * say true, never the reverse, and that the last settlement of a run still sees it finished. The
 * binding rests on the handler getting a fresh graph object per settlement, as
 * `TypeOrmExecutionStore.loadExecution` (`getRawOne`) gives. `reuseSnapshot: false` reads afresh.
 *
 * **What the net decides.** R(S) is `planFromMarking(decodeStepRows(S))`: every start and skip the
 * rows leave enabled. The policy computes it from S's frontier (`decodeFrontier`,
 * `codec/v2/frontier.ts`), which gives the same marking and row counts from at most 3 rows per loop
 * node, so neither the keys read nor the decode grow with a loop's passes. `snapshot: 'full'` reads
 * every row and decodes them all (`decodeStepRows`): the global decoder, kept for verification. `decideSuccessors(s)` answers R(S) restricted to the keys s's out-edges reach,
 * in n8n's edge order (`scope.ts`, decision 6): the candidate list is structure, the fates are the
 * net's. `isFinished` is decision 7 as amended after F3 fired at step 2: no failed row, every row
 * settled, R(S) empty.
 *
 * **The named races (decision 8).**
 * - A failed row: ∅, and not finished. The ∅ is the net's: `_halt` inhibits every start and skip.
 *   Not finished is decision 7 as amended. In n8n the handler checks `hasFailedSteps` before it
 *   plans, so the policy sees a failed row only when a failure lands between the two reads — F2's
 *   and F3's named race — and the failure's own settlement ends the execution as `failed`.
 *   n8n's count can say finished there and end it from the sibling's settlement (divergence row
 *   37).
 * - A cancelled row and no failed one: ∅, and not finished, decided here without decoding. That
 *   is a cancel on request, which the rows do not record and the net does not model (the decoder
 *   refuses it); the cancel path ends the execution. n8n would plan rows there that
 *   `StepReadyHandler` later cancels (divergence row 36).
 *
 * **No fallback.** A compile refusal, a snapshot the store answered wrongly or a `CodecError` on
 * the rows is reported as a `settlement policy error` diagnostic and thrown. The handler's
 * settlement fails and the execution stays `running`, which is visible; n8n's planner is never
 * asked instead.
 *
 * **Diagnostics.** `settlement policy entered` on every call, before anything else (F5 counts it),
 * `settlement policy race` when a named race is decided, `settlement policy error` before a throw.
 * A listener that throws is ignored: diagnostics never change an answer.
 */
import { planFromMarking } from '../codec/v2/plan.js';
import type { StepPlan } from '../codec/v2/plan.js';
import { decodeFrontier } from '../codec/v2/frontier.js';
import { decodeStepRows } from '../codec/v2/step-rows.js';
import type { StepKey, StepRow } from '../codec/v2/step-rows.js';
import { messageOf } from '../internal/errors.js';
import type { V2SettlementPolicy, V2SettlementReader, V2SuccessorDecisions } from '../n8n/v2-host.js';
import type { V2Graph } from '../n8n/v2-graph.js';
import { createCompileCache } from './compile-cache.js';
import type { CompileCache, CompiledGraph } from './compile-cache.js';
import { namedRace, readFullSnapshot, readSnapshot } from './rows.js';
import type { Snapshot, SnapshotScope } from './rows.js';
import { candidateKeys, isFinished, scopePlan } from './scope.js';

/** The policy method a diagnostic is about. */
export type SettlementMethod = 'decideSuccessors' | 'isFinished';

/** How the policy reports what it does. `message` is the line a log greps for. */
export type SettlementDiagnostic =
  | {
    readonly kind: 'registered';
    readonly message: 'settlement policy registered';
    /** `settlement/register.ts`'s mode. */
    readonly mode: string;
  }
  | {
    readonly kind: 'entered';
    readonly message: 'settlement policy entered';
    readonly method: SettlementMethod;
    readonly executionId: string;
  }
  | {
    readonly kind: 'race';
    readonly message: 'settlement policy race';
    readonly method: SettlementMethod;
    readonly executionId: string;
    /** `failure`: a failed row; `cancel`: a cancelled row and no failed one (decision 8). */
    readonly race: 'failure' | 'cancel';
  }
  | {
    readonly kind: 'snapshot';
    readonly message: 'settlement policy snapshot';
    readonly method: SettlementMethod;
    readonly executionId: string;
    /**
     * `stored`: `decideSuccessors` kept its snapshot for this settlement's `isFinished`. `reused`:
     * `isFinished` answered from it, reading nothing. `overrun`: the scoped read's probe found a loop
     * two passes on, and the snapshot was read again (`rows.ts`).
     */
    readonly event: 'stored' | 'reused' | 'overrun';
    /** Pairs a `reused` with the `stored` it took; 0 on `overrun`. */
    readonly token: number;
  }
  | {
    readonly kind: 'error';
    readonly message: 'settlement policy error';
    readonly method: SettlementMethod;
    readonly executionId: string;
    /** The thrown error's `name`, e.g. `CodecError`, `SettlementCompileRefusal`. */
    readonly name: string;
    readonly error: string;
  };

export interface SettlementPolicyOptions {
  readonly onDiagnostic?: (diagnostic: SettlementDiagnostic) => void;
  /** The compile memo. Default: a fresh {@link createCompileCache} per policy. */
  readonly cache?: CompileCache;
  /**
   * `frontier` (the default): read and decode S's frontier (step 14). `full`: read every row and
   * decode them all with the global decoder, which costs O(rows) keys per settlement and is kept for
   * verification. The two give the same answers on every row set engine v2 produces.
   */
  readonly snapshot?: SnapshotScope;
  /**
   * `true` (the default): `isFinished` answers from the snapshot `decideSuccessors` read in the same
   * settlement (see the module doc). `false`: every call reads its own snapshot.
   */
  readonly reuseSnapshot?: boolean;
}

/** What the pure decisions read of a compile-memo entry: the graph and its net. */
export type DecisionNet = Pick<CompiledGraph, 'graph' | 'compiled'>;

const NOTHING = (): StepPlan => ({ toQueue: [], toSkip: [] });

/**
 * R(S): the net's answer at `rows`, S's frontier or S itself, decoded as `snapshot` says. Throws
 * `CodecError` for rows the net cannot have produced.
 */
function planAt(entry: DecisionNet, rows: readonly StepRow[], snapshot: SnapshotScope): StepPlan {
  const decoded = snapshot === 'full' ? decodeStepRows(entry.compiled, rows) : decodeFrontier(entry.compiled, rows);
  return planFromMarking(entry.compiled, decoded);
}

/**
 * What the settlement of `settled` decides at the rows `rows`: R(S) narrowed to `settled`'s
 * candidates in edge order. A pure function of its inputs. `rows` is S, or with `snapshot`
 * `frontier` (the default) any subset of S that holds its frontier and the settled row.
 *
 * On a failed row the net answers itself: `_halt` inhibits every start and skip, so R(S) is ∅,
 * and the rows are still checked by the decoder. A cancelled row without a failed one is the one
 * row set decided here (decision 8): the decoder refuses it, since the cancel is not in the net.
 */
export function decideFromRows(entry: DecisionNet, settled: StepKey, rows: readonly StepRow[], snapshot: SnapshotScope = 'frontier'): StepPlan {
  if (namedRace(rows) === 'cancel') return NOTHING();
  return scopePlan(planAt(entry, rows, snapshot), candidateKeys(entry.graph, settled, rows));
}

/**
 * Whether the execution at `rows` owes no further step: decision 7 as amended, false on a failed
 * row (`scope.ts`' `isFinished`), and false on a cancelled row without one (decision 8), which the
 * decoder refuses. A pure function of its inputs; `rows` as for {@link decideFromRows}.
 */
export function finishedFromRows(entry: DecisionNet, rows: readonly StepRow[], snapshot: SnapshotScope = 'frontier'): boolean {
  if (namedRace(rows) === 'cancel') return false;
  return isFinished(rows, planAt(entry, rows, snapshot));
}

/** The rows of `rows` with each decided key added: `toQueue` as `queued`, `toSkip` as `skipped` (D̂). */
export function withDecided(rows: readonly StepRow[], decided: StepPlan): StepRow[] {
  const have = new Set(rows.map((r) => `${r.nodeId}\u0000${r.iteration}`));
  const out = [...rows];
  const add = (keys: readonly StepKey[], status: 'queued' | 'skipped') => {
    for (const k of keys) {
      const id = `${k.nodeId}\u0000${k.iteration}`;
      if (have.has(id)) continue;
      have.add(id);
      out.push({ nodeId: k.nodeId, iteration: k.iteration, status, filledOutputSlots: [] });
    }
  };
  add(decided.toQueue, 'queued');
  add(decided.toSkip, 'skipped');
  return out;
}

/**
 * `isFinished` at the snapshot `rows` one settlement's `decideSuccessors` read, after the handler
 * wrote what it decided: {@link finishedFromRows} at `rows` ∪ D̂. A queued key is an unsettled row,
 * so the answer is false without decoding.
 */
export function finishedAfterDecision(entry: DecisionNet, rows: readonly StepRow[], decided: StepPlan, snapshot: SnapshotScope = 'frontier'): boolean {
  if (decided.toQueue.length > 0) return false;
  return finishedFromRows(entry, decided.toSkip.length === 0 ? rows : withDecided(rows, decided), snapshot);
}

/** What one settlement's `decideSuccessors` leaves for its `isFinished`. */
interface Kept {
  readonly executionId: string;
  readonly token: number;
  readonly entry: CompiledGraph;
  readonly rows: readonly StepRow[];
  readonly decided: StepPlan;
}

/** The net-backed policy (see the module doc). */
export function createSettlementPolicy(options: SettlementPolicyOptions = {}): V2SettlementPolicy {
  const cache = options.cache ?? createCompileCache();
  const snapshot = options.snapshot ?? 'frontier';
  const reuse = options.reuseSnapshot ?? true;
  const listener = options.onDiagnostic;
  /** Keyed by the graph object the handler passed: one per settlement (see the module doc). */
  const kept = new WeakMap<V2Graph, Kept>();
  let tokens = 0;
  const emit = (d: SettlementDiagnostic): void => {
    if (listener === undefined) return;
    try {
      listener(d);
    } catch {
      // Diagnostics never change an answer.
    }
  };

  async function answer<T>(
    method: SettlementMethod, graph: V2Graph, reader: V2SettlementReader,
    run: (entry: CompiledGraph, executionId: string) => Promise<T>,
  ): Promise<T> {
    const executionId = reader.executionId;
    emit({ kind: 'entered', message: 'settlement policy entered', method, executionId });
    try {
      return await run(cache.get(graph), executionId);
    } catch (error) {
      emit({
        kind: 'error', message: 'settlement policy error', method, executionId,
        name: error instanceof Error ? error.name : typeof error, error: messageOf(error),
      });
      throw error;
    }
  }

  async function read(method: SettlementMethod, entry: CompiledGraph, reader: V2SettlementReader, settled: StepKey | undefined): Promise<Snapshot> {
    const got = snapshot === 'full' ? await readFullSnapshot(entry, reader) : await readSnapshot(entry, reader, settled);
    const executionId = reader.executionId;
    if (got.overrun) emit({ kind: 'snapshot', message: 'settlement policy snapshot', method, executionId, event: 'overrun', token: 0 });
    const race = namedRace(got.rows);
    if (race !== null) emit({ kind: 'race', message: 'settlement policy race', method, executionId, race });
    return got;
  }

  return {
    decideSuccessors: (graph, settled, reader): Promise<V2SuccessorDecisions> => {
      const key: StepKey = { nodeId: settled.nodeId, iteration: settled.iteration };
      // A snapshot kept by an earlier call on this graph object is never this settlement's.
      kept.delete(graph);
      return answer('decideSuccessors', graph, reader, async (entry, executionId) => {
        const { rows } = await read('decideSuccessors', entry, reader, key);
        const decided = decideFromRows(entry, key, rows, snapshot);
        if (reuse) {
          const token = ++tokens;
          kept.set(graph, { executionId, token, entry, rows, decided });
          emit({ kind: 'snapshot', message: 'settlement policy snapshot', method: 'decideSuccessors', executionId, event: 'stored', token });
        }
        return decided;
      });
    },
    isFinished: (graph, reader): Promise<boolean> => {
      const mine = kept.get(graph);
      kept.delete(graph);
      return answer('isFinished', graph, reader, async (entry, executionId) => {
        if (mine !== undefined && mine.executionId === executionId && mine.entry === entry) {
          emit({ kind: 'snapshot', message: 'settlement policy snapshot', method: 'isFinished', executionId, event: 'reused', token: mine.token });
          const race = namedRace(mine.rows);
          if (race !== null) emit({ kind: 'race', message: 'settlement policy race', method: 'isFinished', executionId, race });
          return finishedAfterDecision(entry, mine.rows, mine.decided, snapshot);
        }
        const { rows } = await read('isFinished', entry, reader, undefined);
        return finishedFromRows(entry, rows, snapshot);
      });
    },
  };
}
