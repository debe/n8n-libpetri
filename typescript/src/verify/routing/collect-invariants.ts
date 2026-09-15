/**
 * The report's P-invariants: cached from the first SMT result that carried them, or computed
 * by one invariant-only pipeline run when the budget family needs them and no query did.
 */
import { SmtVerifier, placeBound, type PInvariant, type SmtVerificationResult } from 'libpetri/verification';
import { unionedSemiflows } from '../invariants.js';
import { rethrowIfBug } from '../rethrow-if-bug.js';
import type { Context } from './context.js';

/**
 * The solver budget for the invariant-only run. **One millisecond, on purpose**: the
 * invariants come out of phases 1-3 of the pipeline, not out of z3 — `no-z3.test.ts` pins
 * that they are computed with no solver at all — so this run wants the pipeline and nothing
 * else. Its verdict is discarded; the budget bound itself was already decided (by the graph,
 * or by the family's own query).
 */
const INVARIANT_SOLVER_TIMEOUT_MS = 1;

/**
 * Records `result`'s invariants as the report's, with its report text and whether the run
 * unioned the semiflows.
 *
 * A run that asked for the union and got no line back means libpetri's wording drifted, and
 * `unionedSemiflows` would then read `false` forever — a repeated pipeline rather than a
 * wrong answer, so nothing at run time would show it. `tests/verify/libpetri-surface.test.ts`
 * pins the line instead, which fails on upgrade rather than degrading quietly in production.
 */
export function cacheInvariants(ctx: Context, result: SmtVerificationResult): void {
  ctx.invariants = result.invariants;
  ctx.invariantReport = result.report;
  ctx.invariantsUnionedSemiflows = unionedSemiflows(result.report);
}

/**
 * One invariant-only pipeline run, for a report that ran no query that produced invariants.
 *
 * This is the expensive half of the SMT route — flatten, structural pre-check, P-invariant
 * and semiflow enumeration — and since M5 it is the *only* reason a report whose graph
 * closed pays it: it is run once, lazily, and only for the budget family's semiflow check,
 * which is the one claim the solver-free route cannot make. A report that does not select
 * `budget` never touches it, and neither does one whose net is above
 * `SMT_MAX_JOIN_INPUTS` / `SMT_MAX_FLAT_PLACES` — where running it would abort
 * the process.
 */
export async function collectInvariants(ctx: Context): Promise<readonly PInvariant[] | null> {
  // A cache filled by `query` came from a `'auto'` run, and `'auto'` skips the union
  // whenever the basis is complete — the very case this run exists for. Reusing it then reports
  // "no law giving _budget and every X/running the same positive weight" on a net that has one,
  // and *which* it reports depends on whether some other family happened to need the solver
  // first: measured, a nested agent at `maxToolCalls` 3 loses the law at the default class cap
  // and keeps it at a cap large enough to close, on one net with one marking. So the cache is
  // honoured only when it carries the union, or when semiflows are switched off and the basis
  // is all there is to have.
  if (ctx.invariants !== null && (ctx.invariantsUnionedSemiflows || !ctx.semiflowInvariants)) {
    return ctx.invariants;
  }
  // Same guard as `query`: this *is* the pipeline, so on a net above the ceiling it is
  // the call that would abort the process.
  // `null`, where the two failure paths below return `ctx.invariants` instead. Not an
  // inconsistency: `smtRefusal` is decided once when the context is built and never changes, and
  // `query()` returns on it before it can touch the cache — so on this path `ctx.invariants` is
  // provably still `null` and the two spellings agree. Stated because the reasoning is not
  // local: a future `smtRefusal` set lazily would turn this line into silent data loss.
  if (ctx.smtRefusal !== null) return null;
  try {
    const result = await invariantRun(ctx);
    // An *empty* invariant list is only meaningful from the SMT route, the one that runs the
    // pipeline (VER-003's route criterion): from any other it means "not computed" rather
    // than "none exist", and caching it would make the report state the pipeline found no law
    // when it never ran. A non-empty list is real whatever the route — with no solver at all
    // the pipeline still runs and the route reports `unavailable`, which is exactly what
    // `no-z3.test.ts` pins. Both call sites disable enumeration, so this guards against a
    // future default answering here without the pipeline rather than against today.
    if (result.invariants.length === 0 && result.route !== 'smt') return ctx.invariants;
    cacheInvariants(ctx, result);
    return result.invariants;
  } catch (e) {
    // Same rule as `query`: an invariant pipeline that failed is `null`, a bug is not.
    // This catch was bare, so a `TypeError` here emptied the report's structural section and
    // took the budget family's semiflow with it, silently.
    rethrowIfBug(e);
    return ctx.invariants;
  }
}

/** The pipeline run itself: the budget bound as the property, its verdict discarded. */
function invariantRun(ctx: Context): Promise<SmtVerificationResult> {
  return SmtVerifier.forNet(ctx.compiled.net)
    .initialMarking(ctx.state)
    // **Not `'auto'` here, and this is the one place the distinction bites.** `'auto'` unions
    // the semiflows when the basis lost a law to the H1 guard, which is a test of
    // *deficiency*; this run needs a law of a particular *form* — non-negative, weighting
    // `_budget` and every `X/running` positively — and `computePInvariants` returns a signed
    // null-space basis, which may span that law without containing it. Measured: with
    // `'auto'` on `diamond` the basis is complete, the semiflows are skipped, and
    // `budgetSemiflow` comes back null, so the budget family reports "no law giving _budget
    // and every X/running the same positive weight" on a net that has one. The union is what
    // produces it in non-negative form (`computePSemiflows`), so this run always asks for it.
    // It is lazy and runs only for the `budget` family, so the cost lands only on a report
    // that selects it.
    .semiflowInvariants(ctx.semiflowInvariants)
    .timeout(INVARIANT_SOLVER_TIMEOUT_MS)
    // This run exists *for* the pipeline's invariants, and libpetri's bounded enumeration
    // (VER-017) is a route around the pipeline: it reads the verdict off a state-class graph
    // and returns no invariants at all, which empties the report's structural section on
    // every net small enough to enumerate. The verdict here is discarded anyway.
    .enumerationMaxClasses(0)
    .property(placeBound(ctx.map.shared.budget, ctx.compiled.effectiveBudget))
    .verify();
}
