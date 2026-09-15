/**
 * One proper-completion row: the stranding question every completion check asks — the
 * whole-net `deadlockFree` query with the report's completion sinks (VER-002, VER-014) — recorded
 * with its three-way explanation.
 */
import { deadlockFree } from 'libpetri/verification';
import { queryRecord, record } from '../record.js';
import { explain } from '../reasons.js';
import type { Context, Decision } from '../route.js';
import type { CheckSubject } from '../types.js';

/** A row's three sentences; the `bounded` arm is derived from `proven` (`reasons.ts` `explain`). */
export interface CompletionSentences {
  readonly proven: string;
  readonly violated: string;
  readonly unknown: string;
}

/** Records a proper-completion check named `name` about `subject`, decided by `decision`. */
export function recordCompletionRow(
  ctx: Context, name: string, subject: CheckSubject, decision: Decision, sentences: CompletionSentences,
): void {
  record(ctx, {
    property: 'proper-completion',
    name,
    subject,
    verdict: decision.verdict,
    explanation: explain(decision.verdict, sentences),
    reason: decision.reason,
    elapsedMs: decision.elapsedMs,
    query: queryRecord(deadlockFree(), decision, ctx.completion.recorded),
    counterexample: decision.counterexample,
  });
}
