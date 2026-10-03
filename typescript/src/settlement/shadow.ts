/**
 * Shadow mode (`tasks/v2-seam-plan.md` decision 9 and steps 11–12): one policy answers, a second
 * runs beside it on the same reader, and every call is reported with both answers. It is how the
 * live testbed compares the net-backed policy with n8n's own, in either direction, without either
 * changing what the execution does.
 *
 * - **The primary answers.** Its answer is returned and its throw is thrown, unchanged.
 * - **The candidate is contained.** It runs after the primary, on the same reader; its answer is
 *   only compared. A throw is reported as `candidate-threw` and never reaches the handler.
 * - **Reads are recorded, not changed.** Each side gets its own pass-through recorder over the
 *   reader, so the report carries the rows each side read and how many reads it made.
 * - **Verdicts.** `agree` when the answers are equal (`decideSuccessors` as ordered queue and skip
 *   sequences, `isFinished` as booleans). When they differ, the rows both sides read are checked
 *   for F2's and F3's named races (decision 8): a failed row is the race `failure`, a cancelled
 *   row with no failed one the race `cancel`; those are `race`, counted and not compared. Any other
 *   difference is `disagree`. Nothing else is excused.
 * - **Skew.** The two sides read at different moments. `skew` says whether a row both read differed
 *   between them: a `disagree` with skew may be the moment, not the policy, and the report keeps the
 *   rows to tell.
 *
 * A listener that throws is ignored: a report never changes an answer.
 */
import type { StepRow } from '../codec/v2/step-rows.js';
import { messageOf } from '../internal/errors.js';
import type { V2SettlementPolicy, V2SettlementReader, V2StepKey, V2StepSummary, V2SuccessorDecisions } from '../n8n/v2-host.js';
import type { SettlementMethod } from './policy.js';
import { namedRace } from './rows.js';

/** One shadowed call. */
export interface ShadowReport {
  readonly method: SettlementMethod;
  readonly executionId: string;
  /** The settled step's key, for `decideSuccessors`; `null` for `isFinished`. */
  readonly settled: V2StepKey | null;
  readonly verdict: 'agree' | 'disagree' | 'race' | 'candidate-threw';
  /** The named race, when `verdict` is `race`. */
  readonly race: 'failure' | 'cancel' | null;
  readonly primary: V2SuccessorDecisions | boolean;
  /** `null` when the candidate threw. */
  readonly candidate: V2SuccessorDecisions | boolean | null;
  /** The candidate's error message, when it threw. */
  readonly error: string | null;
  /** Rows each side read, in the order read, without ids. */
  readonly primaryRows: readonly StepRow[];
  readonly candidateRows: readonly StepRow[];
  /** Reader calls each side made, `countSettledSteps` included. */
  readonly primaryReads: number;
  readonly candidateReads: number;
  /** Whether a row both sides read differed between their reads. */
  readonly skew: boolean;
  readonly primaryMs: number;
  readonly candidateMs: number;
}

export interface ShadowOptions {
  /** The policy whose answers the handler gets. */
  readonly primary: V2SettlementPolicy;
  /** The policy compared with it. */
  readonly candidate: V2SettlementPolicy;
  readonly onReport: (report: ShadowReport) => void;
}

/** A pass-through reader that records what it returned. */
function recorder(reader: V2SettlementReader): { reader: V2SettlementReader; rows: StepRow[]; reads: () => number } {
  const rows: StepRow[] = [];
  let reads = 0;
  const keep = (summaries: Record<string, V2StepSummary>) => {
    for (const s of Object.values(summaries)) {
      rows.push({ nodeId: s.nodeId, iteration: s.iteration, status: s.status, filledOutputSlots: [...s.filledOutputSlots] });
    }
    return summaries;
  };
  return {
    rows,
    reads: () => reads,
    reader: {
      executionId: reader.executionId,
      loadLatestStepSummaries: async (nodeIds) => {
        reads++;
        return keep(await reader.loadLatestStepSummaries(nodeIds));
      },
      loadStepSummariesByKeys: async (keys) => {
        reads++;
        return keep(await reader.loadStepSummariesByKeys(keys));
      },
      countSettledSteps: async () => {
        reads++;
        return await reader.countSettledSteps();
      },
    },
  };
}

const keyText = (k: V2StepKey) => `${k.nodeId}@${k.iteration}`;
const rowText = (r: StepRow) => `${r.status}[${r.filledOutputSlots.map(Number).join('')}]`;

function sameAnswer(a: V2SuccessorDecisions | boolean, b: V2SuccessorDecisions | boolean): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  const seq = (d: V2SuccessorDecisions) => `${d.toQueue.map(keyText).join(' ')}|${d.toSkip.map(keyText).join(' ')}`;
  return seq(a) === seq(b);
}

function skewOf(a: readonly StepRow[], b: readonly StepRow[]): boolean {
  const seen = new Map(a.map((r) => [keyText(r), rowText(r)]));
  return b.some((r) => {
    const other = seen.get(keyText(r));
    return other !== undefined && other !== rowText(r);
  });
}

/** A policy whose answers are `primary`'s, with `candidate` run and compared beside it (see the module doc). */
export function createShadowPolicy(options: ShadowOptions): V2SettlementPolicy {
  const { primary, candidate, onReport } = options;
  const report = (r: ShadowReport): void => {
    try {
      onReport(r);
    } catch {
      // A report never changes an answer.
    }
  };

  async function shadow<T extends V2SuccessorDecisions | boolean>(
    method: SettlementMethod,
    settled: V2StepKey | null,
    reader: V2SettlementReader,
    ask: (policy: V2SettlementPolicy, reader: V2SettlementReader) => Promise<T>,
  ): Promise<T> {
    const p = recorder(reader);
    let t0 = performance.now();
    const primaryAnswer = await ask(primary, p.reader);
    const primaryMs = performance.now() - t0;
    const c = recorder(reader);
    let candidateAnswer: T | null = null;
    let error: string | null = null;
    t0 = performance.now();
    try {
      candidateAnswer = await ask(candidate, c.reader);
    } catch (e) {
      error = messageOf(e);
    }
    const candidateMs = performance.now() - t0;
    let verdict: ShadowReport['verdict'];
    let race: ShadowReport['race'] = null;
    if (candidateAnswer === null) verdict = 'candidate-threw';
    else if (sameAnswer(primaryAnswer, candidateAnswer)) verdict = 'agree';
    else {
      race = namedRace([...p.rows, ...c.rows]);
      verdict = race === null ? 'disagree' : 'race';
    }
    report({
      method, executionId: reader.executionId, settled, verdict, race,
      primary: primaryAnswer, candidate: candidateAnswer, error,
      primaryRows: p.rows, candidateRows: c.rows, primaryReads: p.reads(), candidateReads: c.reads(),
      skew: skewOf(p.rows, c.rows), primaryMs, candidateMs,
    });
    return primaryAnswer;
  }

  return {
    decideSuccessors: (graph, settled, reader) =>
      shadow('decideSuccessors', { nodeId: settled.nodeId, iteration: settled.iteration }, reader, (policy, r) => policy.decideSuccessors(graph, settled, r)),
    isFinished: (graph, reader) => shadow('isFinished', null, reader, (policy, r) => policy.isFinished(graph, r)),
  };
}
