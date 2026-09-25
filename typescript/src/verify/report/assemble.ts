/**
 * The {@link VerificationReport} a finished run returns, read off the run's context: the
 * checks every family recorded, their verdict counts, the state-space figures and the
 * invariant summary.
 */
import { performance } from 'node:perf_hooks';
import type { PInvariant } from 'libpetri/verification';
import { FOUND_LINE, SEMIFLOW_LINE, budgetSemiflowOf, countFrom, renderInvariant } from '../invariants.js';
import type { Context } from '../route.js';
import type {
  CheckVerdict, InvariantSummary, PropertyCheck, PropertyName, StateSpaceSummary, VerificationReport,
} from '../types.js';

/** What the run adds to its context: the families it selected and when it started. */
export interface RunFacts {
  readonly properties: readonly PropertyName[];
  readonly shapeWarnings: readonly string[];
  /** `performance.now()` when the run began. */
  readonly started: number;
}

/** The report of a run whose families have all finished recording into `ctx`. */
export function assembleReport(ctx: Context, run: RunFacts): VerificationReport {
  const compiled = ctx.compiled;
  const counts = countVerdicts(ctx.checks);
  return {
    workflow: compiled.net.name,
    profile: 'v1',
    structuralHash: compiled.structuralHash,
    requestedBudget: compiled.requestedBudget,
    budget: compiled.effectiveBudget,
    budgetRestriction: compiled.budgetRestriction,
    solver: ctx.solver,
    net: {
      places: compiled.net.places.size,
      transitions: compiled.net.transitions.size,
      flatTransitions: ctx.flat.transitions.length,
    },
    stateSpace: stateSpaceSummary(ctx),
    invariants: invariantSummary(ctx),
    timeoutMs: ctx.timeoutMs,
    properties: run.properties,
    checks: ctx.checks,
    counts,
    ok: counts.violated === 0,
    diagnostics: compiled.diagnostics,
    shapeWarnings: run.shapeWarnings,
    elapsedMs: performance.now() - run.started,
  };
}

/** How many checks came back with each verdict. */
export function countVerdicts(checks: readonly PropertyCheck[]): Record<CheckVerdict, number> {
  const counts: Record<CheckVerdict, number> = { proven: 0, violated: 0, bounded: 0, unknown: 0 };
  for (const c of checks) counts[c.verdict]++;
  return counts;
}

/** The solver-free route's figures, as the report states them. */
function stateSpaceSummary(ctx: Context): StateSpaceSummary {
  const space = ctx.space;
  return {
    classes: space.classes,
    complete: space.complete,
    maxClasses: space.maxClasses,
    requestedMaxClasses: space.requestedMaxClasses,
    elapsedMs: space.elapsedMs,
    quiescent: space.quiescentClasses,
    terminal: space.terminalClasses,
    strandedPlaces: space.strandedPlaces().length,
    truncation: space.truncationCause(ctx.shape),
    agents: ctx.shape.agents,
    expanded: space.expandedClasses,
    boundedCyclicRuns: space.boundedCyclicRuns,
    loopSteps: space.loopSteps,
    error: space.error,
  };
}

/**
 * The P-invariant pipeline is the expensive half of the SMT route and nothing but the
 * budget semiflow needs it, so a report that did not select that family never runs it.
 */
function invariantSummary(ctx: Context): InvariantSummary {
  const invariants = ctx.invariants;
  const report = ctx.invariantReport;
  return {
    basis: report === null ? 0 : countFrom(report, FOUND_LINE) ?? 0,
    semiflowsEncoded: report === null ? 0 : countFrom(report, SEMIFLOW_LINE) ?? 0,
    encoded: invariants?.length ?? 0,
    budgetSemiflow: invariants === null ? null : budgetSemiflowLine(ctx, invariants),
  };
}

/** The budget semiflow among `invariants`, rendered; `null` when none has its form. */
function budgetSemiflowLine(ctx: Context, invariants: readonly PInvariant[]): string | null {
  const sf = budgetSemiflowOf(invariants, ctx.flat, ctx.map, ctx.compiled.effectiveBudget);
  return sf === null ? null : renderInvariant(sf, ctx.flat);
}
