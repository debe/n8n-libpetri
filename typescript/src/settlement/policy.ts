/**
 * The net-backed `SettlementPolicy` (`tasks/v2-seam-plan.md` decisions 6–10): the two decisions
 * engine v2's `StepSettledHandler` takes from its step rows (patch 0003), answered by the
 * `engineV2` net instead of `settlement.ts` and `completion.ts`.
 *
 * Per call:
 * 1. the graph's net from the compile memo (`compile-cache.ts`, decision 10), or its refusal;
 * 2. the row snapshot S from the reader (`rows.ts`, decision 9): one or two reads, never more,
 *    and never `countSettledSteps`;
 * 3. a pure function of S — {@link decideFromRows} or {@link finishedFromRows}.
 *
 * **What the net decides.** R(S) is `planFromMarking(decodeStepRows(S))`: every start and skip the
 * rows leave enabled. `decideSuccessors(s)` answers R(S) restricted to the keys s's out-edges reach,
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
import { decodeStepRows } from '../codec/v2/step-rows.js';
import type { StepKey, StepRow } from '../codec/v2/step-rows.js';
import { messageOf } from '../internal/errors.js';
import type { V2SettlementPolicy, V2SettlementReader, V2SuccessorDecisions } from '../n8n/v2-host.js';
import type { V2Graph } from '../n8n/v2-graph.js';
import { createCompileCache } from './compile-cache.js';
import type { CompileCache, CompiledGraph } from './compile-cache.js';
import { namedRace, readSnapshot } from './rows.js';
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
}

const NOTHING = (): StepPlan => ({ toQueue: [], toSkip: [] });

/** R(S): the net's answer at `rows`. Throws `CodecError` for rows the net cannot have produced. */
function planAt(entry: CompiledGraph, rows: readonly StepRow[]): StepPlan {
  return planFromMarking(entry.compiled, decodeStepRows(entry.compiled, rows));
}

/**
 * What the settlement of `settled` decides at the rows `rows`: R(S) narrowed to `settled`'s
 * candidates in edge order. A pure function of its inputs.
 *
 * On a failed row the net answers itself: `_halt` inhibits every start and skip, so R(S) is ∅,
 * and the rows are still checked by the decoder. A cancelled row without a failed one is the one
 * row set decided here (decision 8): the decoder refuses it, since the cancel is not in the net.
 */
export function decideFromRows(entry: CompiledGraph, settled: StepKey, rows: readonly StepRow[]): StepPlan {
  if (namedRace(rows) === 'cancel') return NOTHING();
  return scopePlan(planAt(entry, rows), candidateKeys(entry.graph, settled, rows));
}

/**
 * Whether the execution at `rows` owes no further step: decision 7 as amended, false on a failed
 * row (`scope.ts`' `isFinished`), and false on a cancelled row without one (decision 8), which the
 * decoder refuses. A pure function of its inputs.
 */
export function finishedFromRows(entry: CompiledGraph, rows: readonly StepRow[]): boolean {
  if (namedRace(rows) === 'cancel') return false;
  return isFinished(rows, planAt(entry, rows));
}

/** The net-backed policy (see the module doc). */
export function createSettlementPolicy(options: SettlementPolicyOptions = {}): V2SettlementPolicy {
  const cache = options.cache ?? createCompileCache();
  const listener = options.onDiagnostic;
  const emit = (d: SettlementDiagnostic): void => {
    if (listener === undefined) return;
    try {
      listener(d);
    } catch {
      // Diagnostics never change an answer.
    }
  };

  async function answer<T>(method: SettlementMethod, graph: V2Graph, reader: V2SettlementReader, decide: (entry: CompiledGraph, rows: readonly StepRow[]) => T): Promise<T> {
    const executionId = reader.executionId;
    emit({ kind: 'entered', message: 'settlement policy entered', method, executionId });
    try {
      const entry = cache.get(graph);
      const { rows } = await readSnapshot(entry, reader);
      const race = namedRace(rows);
      if (race !== null) emit({ kind: 'race', message: 'settlement policy race', method, executionId, race });
      return decide(entry, rows);
    } catch (error) {
      emit({
        kind: 'error', message: 'settlement policy error', method, executionId,
        name: error instanceof Error ? error.name : typeof error, error: messageOf(error),
      });
      throw error;
    }
  }

  return {
    decideSuccessors: (graph, settled, reader): Promise<V2SuccessorDecisions> =>
      answer('decideSuccessors', graph, reader, (entry, rows) => decideFromRows(entry, { nodeId: settled.nodeId, iteration: settled.iteration }, rows)),
    isFinished: (graph, reader): Promise<boolean> => answer('isFinished', graph, reader, finishedFromRows),
  };
}
