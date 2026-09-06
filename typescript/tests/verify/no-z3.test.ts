/**
 * VER-013: without a usable solver every verdict is `unknown` with a reason naming `PATH`
 * and `LIBPETRI_Z3`, and nothing throws.
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

  it('every verdict is unknown with that reason, and nothing throws', { timeout: 120_000 }, async () => {
    const report = await withoutZ3(async () => verify(retryFour, { timeoutMs: 1_000 }));
    const solverChecks = report.checks.filter((c) => c.query.property !== 'none');
    expect(solverChecks.length).toBeGreaterThan(0);
    expect(report.counts.violated).toBe(0);
    // `ok` is about findings, and there are none — the run is unproven, not clean.
    expect(report.ok).toBe(true);
    for (const check of solverChecks) {
      expect(check.verdict, check.name).toBe('unknown');
      expect(check.reason, check.name).toMatch(/LIBPETRI_Z3/);
      expect(check.counterexample).toBeNull();
      expect(check.query.method).toBeNull();
      // No query ran, so no wall clock was spent in the solver.
      expect(check.elapsedMs).toBe(0);
    }
    // The one check that is not a query is the structural semiflow: see below.
    expect(report.counts.unknown).toBe(report.checks.length - report.counts.proven);
    expect(report.counts.proven).toBeLessThanOrEqual(1);
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

  it('renders a report that says the solver is missing', { timeout: 120_000 }, async () => {
    const report = await withoutZ3(async () => verify(diamond, { timeoutMs: 1_000, properties: ['budget'] }));
    const text = renderReport(report);
    expect(text).toContain('every verdict is unknown');
    expect(text).toContain('LIBPETRI_Z3');
    expect(text).toContain('Unproven');
  });
});
