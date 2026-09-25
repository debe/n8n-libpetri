/**
 * How a family turns a {@link Decision} into a {@link PropertyCheck}: the check is appended to
 * the report and streamed to `VerifyOptions.onCheck`, and its {@link QueryRecord} states what
 * was asked and which route answered — so the polarity inversion the dead-nodes family applies
 * is never hidden.
 *
 * {@link recordBound} is the one shape four families share: a `placeBound` question decided by
 * the graph first and the SMT fallback where it truncated (NU-053), with `bounded` offered on a
 * cyclic workflow and the undecided reason composed the one way `reasons.ts` spells it.
 */
import type { Place } from 'libpetri';
import { placeBound, type SmtProperty } from 'libpetri/verification';
import { explain, unknownReason } from './reasons.js';
import {
  boundedOrUnknown, graphBound, smtDecision,
  type Context, type Decision, type SinkRecord,
} from './route.js';
import type { CheckSubject, CheckVerdict, PropertyCheck, PropertyName, QueryRecord } from './types.js';

/**
 * Appends one check to the report and streams it; `counterexample` defaults to `null`. Reads
 * only the check list and the stream, so the `engineV2` report (`settlement.ts`) records through
 * it too.
 */
export function record(
  ctx: Pick<Context, 'checks' | 'onCheck'>,
  check: Omit<PropertyCheck, 'counterexample'> & { readonly counterexample?: PropertyCheck['counterexample'] },
): void {
  const full: PropertyCheck = { counterexample: null, ...check };
  ctx.checks.push(full);
  ctx.onCheck?.(full);
}

/**
 * The place(s) a property names, for the report. The `default` is deliberate rather than an
 * exhaustive switch: `SmtProperty` is a libpetri union that gains members (VER-002 added
 * `terminates-at-sink`), and a property this module does not use must not break its build.
 */
function placeOf(property: SmtProperty): string | null {
  switch (property.type) {
    case 'place-bound':
    case 'branch-place-bound':
      return property.place.name;
    case 'joined-or-dead-lettered':
      return property.pending.name;
    case 'mutual-exclusion':
      return `${property.p1.name}, ${property.p2.name}`;
    case 'unreachable':
      return [...property.places].map((p) => p.name).join(', ');
    default:
      return null;
  }
}

/** The sink declaration of every question but proper completion: none. */
const NO_SINKS: SinkRecord = { sinks: [], conditionalSinks: [] };

/**
 * What was asked and how it was answered. `property` names the question, `route` the answer,
 * and `sinks` the declaration the question is scoped by — for proper completion the
 * per-report `Context.completion.recorded`, referenced rather than copied.
 */
export function queryRecord(
  property: SmtProperty | 'none', decision: Decision, sinks: SinkRecord = NO_SINKS,
): QueryRecord {
  return {
    property: property === 'none' ? 'none' : property.type,
    place: property === 'none' ? null : placeOf(property),
    verdict: decision.verdict,
    sinks: sinks.sinks,
    conditionalSinks: sinks.conditionalSinks,
    method: decision.method,
    route: decision.route,
  };
}

/**
 * A verdict read off the flattened net or the P-invariants, with no reachability question at
 * all: the retry producer check, the attempt-chain line check, the budget semiflow. It never
 * carries a reason, a counterexample or a wall clock of its own.
 */
export function structuralDecision(verdict: CheckVerdict, method: string | null): Decision {
  return { verdict, reason: null, route: 'structural', method, elapsedMs: 0, counterexample: null };
}

/** One `placeBound` check as a family names it: which question, about what, in which words. */
export interface BoundSpec {
  readonly property: PropertyName;
  readonly name: string;
  readonly subject: CheckSubject;
  readonly place: Place<unknown>;
  readonly bound: number;
  /** The three-way explanation; the `bounded` arm is derived from `proven` (`reasons.ts` `explain`). */
  readonly explanation: { proven: string; violated: string; unknown: string };
}

/**
 * Asks `placeBound(spec.place, spec.bound)` — the graph first, the SMT fallback only where it
 * did not decide, then `bounded` on a cyclic workflow whose prefix closes a run — records the
 * check, and returns the decision for a family that conjoins it with a structural half.
 */
export async function recordBound(ctx: Context, spec: BoundSpec): Promise<Decision> {
  const property = placeBound(spec.place, spec.bound);
  const decision = graphBound(ctx, spec.place, spec.bound)
    ?? boundedOrUnknown(ctx, await smtDecision(ctx, property));
  record(ctx, {
    property: spec.property,
    name: spec.name,
    subject: spec.subject,
    verdict: decision.verdict,
    explanation: explain(decision.verdict, spec.explanation),
    reason: unknownReason(ctx, decision),
    elapsedMs: decision.elapsedMs,
    query: queryRecord(property, decision),
    counterexample: decision.counterexample,
  });
  return decision;
}
