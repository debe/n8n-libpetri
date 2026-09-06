/**
 * VER-013 without a usable solver — and, since M5, what *still works* without one.
 *
 * The solver-free route (VER-010) decides every reachability-safety family from the
 * state-class graph, so a missing z3 no longer empties the report: it costs the **SMT
 * fallback** (a truncated graph's last resort) and the P-invariant summary the budget
 * semiflow is read from. What is left `unknown` must still carry a reason naming `PATH` and
 * `LIBPETRI_Z3`, and nothing may throw.
 *
 * Simulated by pointing `LIBPETRI_Z3` at a path that does not exist, which is exactly what
 * `resolveZ3` reads. The variable is restored in a `finally`, and the suite is not gated on
 * z3 — the no-solver path must hold on a machine that has one, which is the only place this
 * regression could hide.
 */
import { compile } from '../../src/compiler/index.js';
import { diamond } from '../fixtures/workflows.js';
import { renderReport, resolveSolver, verify } from '../../src/verify/index.js';
import { retryFour } from './support.js';

const MISSING = '/nonexistent/definitely-not-a-z3-binary';

async function withoutZ3<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env['LIBPETRI_Z3'];
  process.env['LIBPETRI_Z3'] = MISSING;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env['LIBPETRI_Z3'];
    else process.env['LIBPETRI_Z3'] = before;
  }
}

describe('verify without z3 (VER-013)', () => {
  it('resolveSolver reports the absence with a reason naming PATH and LIBPETRI_Z3', async () => {
    const solver = await withoutZ3(async () => resolveSolver());
    expect(solver.available).toBe(false);
    expect(solver.program).toBeNull();
    expect(solver.version).toBeNull();
    expect(solver.reason).toMatch(/PATH/);
    expect(solver.reason).toMatch(/LIBPETRI_Z3/);
  });

  it('the whole report still closes: the graph needs no solver, and nothing throws', { timeout: 120_000 }, async () => {
    const report = await withoutZ3(async () => verify(retryFour, { timeoutMs: 1_000 }));
    expect(report.solver.available).toBe(false);
    expect(report.counts.violated).toBe(0);
    expect(report.ok).toBe(true);
    // `retryFour` is acyclic and narrow, so its graph closes and every family is decided
    // from it. The SMT fallback is never reached, so nothing is `unknown`.
    expect(report.stateSpace.complete).toBe(true);
    for (const check of report.checks) {
      expect(check.query.route === 'state-class-graph' || check.query.route === 'structural', check.name).toBe(true);
      // The only `unknown` left is the one that is `unknown` by design whatever the route:
      // a node the abstraction *reaches* is not thereby proven live (VER-004 AC3).
      if (check.verdict === 'unknown') {
        expect(check.property, check.name).toBe('dead-nodes');
        expect(check.reason, check.name).toMatch(/VER-004/);
      }
    }
    expect(report.counts.proven).toBeGreaterThan(0);
  });

  it('a check that has to fall back is unknown with the reason naming PATH and LIBPETRI_Z3', { timeout: 120_000 }, async () => {
    // `maxClasses: 0` turns the solver-free route off, so every family falls back — which
    // without a solver is exactly M4's no-z3 behaviour, and the reason must still say why.
    const report = await withoutZ3(async () => verify(retryFour, { timeoutMs: 1_000, maxClasses: 0 }));
    const solverChecks = report.checks.filter((c) => c.query.route === 'smt');
    expect(solverChecks.length).toBeGreaterThan(0);
    for (const check of solverChecks) {
      expect(check.verdict, check.name).toBe('unknown');
      expect(check.reason, check.name).toMatch(/LIBPETRI_Z3/);
      expect(check.counterexample).toBeNull();
      expect(check.query.method).toBeNull();
      // No query ran, so the only wall clock on the row is the (here trivial) exploration
      // that failed to close, never a solver process.
      expect(check.elapsedMs).toBeLessThan(1_000);
    }
  });

  it('the structural part of the report still works: invariants come from the pipeline, not from z3', { timeout: 120_000 }, async () => {
    const report = await withoutZ3(async () => verify(diamond, { timeoutMs: 1_000, properties: ['budget'] }));
    expect(report.invariants.encoded).toBeGreaterThan(0);
    expect(report.invariants.basis).toBeGreaterThan(0);
    expect(report.invariants.budgetSemiflow).toMatch(/_budget/);
    // The semiflow check is structural, so it is the one thing that is still `proven`
    // without a solver.
    const structural = report.checks.find((c) => c.subject.kind === 'net')!;
    expect(structural.verdict).toBe('proven');
    expect(report.net.places).toBe(compile(diamond).net.places.size);
  });

  it('renders a report that says the solver is missing, and what still closed without it', { timeout: 120_000 }, async () => {
    const report = await withoutZ3(async () => verify(diamond, { timeoutMs: 1_000, properties: ['budget'] }));
    const text = renderReport(report);
    // Not "every verdict is unknown": the same page carries PROVEN rows off the complete
    // graph, so the header has to say what a missing solver actually costs.
    expect(text).toContain('the SMT fallback cannot run');
    expect(text).toContain('the solver-free route still decides what a complete graph decides');
    expect(text).not.toContain('every verdict is unknown');
    expect(text).toContain('LIBPETRI_Z3');
    // The budget bound came off the graph, so the page is not empty of proofs.
    expect(text).toContain('complete (VER-010)');
    expect(text).toContain('PROVEN');

    // With the route off, there is nothing left to decide and the unproven section returns.
    const blind = await withoutZ3(async () => verify(diamond, { timeoutMs: 1_000, properties: ['budget'], maxClasses: 0 }));
    expect(renderReport(blind)).toContain('Unproven');
  });
});
