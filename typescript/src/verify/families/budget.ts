/**
 * `budget` — `_budget` never exceeds `k`, plus the two-phase P-semiflow
 * `w·_budget + w·Σ_X(running + retry + in-flight) = w·k` read off the validated invariants
 * (VER-007). A net whose budget were a self-loop would prove the bound trivially: the
 * incidence column is zero, so the encoder never sees the place move. The two-phase gadget is
 * what makes the bound mean something, and the semiflow is the half that carries the claim —
 * the one claim the solver-free route cannot make, and the only reason a report still pays
 * for the P-invariant pipeline.
 */
import { budgetSemiflowOf } from '../invariants.js';
import { queryRecord, record, recordBound, structuralDecision } from '../record.js';
import { collectInvariants, type Context } from '../route.js';

export async function runBudget(ctx: Context): Promise<void> {
  const k = ctx.compiled.effectiveBudget;
  await recordBound(ctx, {
    property: 'budget',
    name: `at most ${k} node${k === 1 ? '' : 's'} in flight`,
    subject: { kind: 'place', place: ctx.map.shared.budget.name },
    place: ctx.map.shared.budget,
    bound: k,
    explanation: {
      proven: `_budget never exceeds ${k}, so at most ${k} activation${k === 1 ? '' : 's'} can hold a unit at once.`,
      violated: `_budget can exceed ${k}: a transition refunds a unit it did not take.`,
      unknown: `Whether _budget stays within ${k} was not decided.`,
    },
  });

  // The semiflow is read off the invariants the encoder was given, not asked of z3: it is a
  // structural fact, and its absence is not a violation but a gap in what can be proven.
  // It is the one part of this family the solver-free route cannot supply — a P-invariant is
  // a statement about the incidence matrix, not about the reachable set.
  // `collectInvariants`, not `ctx.invariants ??`: the `placeBound` query above may have filled
  // the cache from an `'auto'` run, and only `collectInvariants` knows whether such a list
  // carries the semiflow union this search needs. Short-circuiting here made the law's presence
  // a function of whether `graphBound` answered — the same net reported it at a class cap large
  // enough to close and missing at one that truncated.
  const invariants = await collectInvariants(ctx);
  const semiflow = invariants === null ? null : budgetSemiflowOf(invariants, ctx.flat, ctx.map, k);
  const semiflowDecision = semiflow === null
    ? structuralDecision('unknown', null)
    : structuralDecision('proven', 'P-invariant');
  record(ctx, {
    property: 'budget',
    name: 'the two-phase budget semiflow holds',
    subject: { kind: 'net' },
    verdict: semiflowDecision.verdict,
    explanation: semiflow === null
      ? 'No validated conservation law covers _budget together with every X/running: the budget unit ' +
        'cannot be tracked structurally, so the bound above rests on the reachable-set enumeration alone.'
      : `_budget + the in-flight places of every node is conserved at ${k}, so a unit is held from ` +
        'X_start to X_done and refunded exactly once (ADR 0004).',
    reason: semiflow === null
      ? ctx.smtRefusal
        ?? 'the P-invariant computation returned no law giving _budget and every X/running the same positive weight'
      : null,
    elapsedMs: 0,
    query: queryRecord('none', semiflowDecision),
    counterexample: null,
  });
}
