/**
 * The SMT route's two boundaries: **when it may not run at all**, and **when asking it is
 * pointless**. The third case — what its `violated` is worth — needs a fake solver and lives
 * in `smt-fallback-violation.test.ts`.
 *
 * No `describeZ3`: nothing here needs a solver. The size ceiling is checked before one is
 * asked for, and the skipped-query case never reaches z3 by construction.
 *
 * What each suite protects:
 *
 * - **the size ceiling.** libpetri's pre-solver pipeline (flatten, structural pre-check,
 *   P-invariants, semiflows) exhausts the V8 heap on a big branchy net, and a heap
 *   exhaustion **aborts the process**: no report, no exit code, nothing to catch. Measured on
 *   this repository's generated workflows, the abort starts at 18 join inputs (37 nodes) and
 *   the shape below it already costs 118 s and 2.4 GB, so the route is refused above the
 *   ceiling and the check comes back `unknown` with the ceiling in the reason.
 * - **the question that is already answered.** `deadlockFree` with the structural rest set as
 *   sinks is false on any net with a reachable quiescent marking outside that set (VER-002:
 *   *quiescent ∧ some marked place is not a declared sink*), which is every workflow that can
 *   pause with a second branch in flight. Spending 30-60 s on a query whose `proven` cannot
 *   come back is not a fallback, it is a delay.
 */
import { flatten } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import {
  SMT_MAX_FLAT_PLACES, SMT_MAX_JOIN_INPUTS, smtRefusalFor, verify,
} from '../../src/verify/index.js';
import { loopOverItems, switch20 } from '../fixtures/workflows.js';
import { CASE_TIMEOUT_MS, TEST_TIMEOUT_MS, digest, generateWorkflow } from './support.js';

function wholeNet(report: Awaited<ReturnType<typeof verify>>) {
  const check = report.checks.find((c) => c.property === 'proper-completion' && c.subject.kind === 'net');
  if (check === undefined) throw new Error('no whole-net completion check');
  return check;
}

describe('the SMT route is refused above the measured size ceiling', () => {
  it('a 49-node workflow verifies instead of aborting the process', { timeout: CASE_TIMEOUT_MS }, async () => {
    // The regression this exists for: `verify()` on a workflow whose graph truncates used to
    // run the fallback unconditionally, and on this net that call exhausts a 4 GB heap and
    // aborts node with SIGABRT — no report, and none of the four exit codes the CLI promises.
    const workflow = generateWorkflow(12);
    expect(workflow.nodes.length).toBe(49);
    const report = await verify(workflow, {
      properties: ['proper-completion', 'budget'], maxClasses: 1_000, timeoutMs: TEST_TIMEOUT_MS,
    });
    expect(report.stateSpace.complete).toBe(false);
    expect(report.counts.violated).toBe(0);
    // Every unanswered row says why, and the reason is the ceiling rather than a timeout.
    const semiflow = report.checks.find((c) => c.name.includes('semiflow'))!;
    expect(semiflow.verdict).toBe('unknown');
    expect(semiflow.reason).toContain('the SMT route was not started');
    expect(semiflow.reason).toContain('exhaust the V8 heap');
    expect(semiflow.reason).toContain('--smt-fallback force');
  });

  it('the ceiling is a join-input count and a places count, and `force` lifts both', () => {
    const big = flatten(compile(generateWorkflow(12)).net);
    const small = flatten(compile(generateWorkflow(1)).net);
    expect(big.places.length).toBeGreaterThan(SMT_MAX_FLAT_PLACES);
    expect(smtRefusalFor(big, 24, 'auto')).toContain('599 flat places');
    expect(smtRefusalFor(big, 24, 'force')).toBeNull();
    // Under the places ceiling, the join count is what refuses: the pipeline's cost is
    // driven by joins, not by node count (a 41-node chain runs it in 1.8 s).
    expect(small.places.length).toBeLessThan(SMT_MAX_FLAT_PLACES);
    expect(smtRefusalFor(small, SMT_MAX_JOIN_INPUTS, 'auto')).toBeNull();
    expect(smtRefusalFor(small, SMT_MAX_JOIN_INPUTS + 1, 'auto')).toContain('join inputs');
    // `off` refuses everything, and says that is what happened rather than blaming a size.
    expect(smtRefusalFor(small, 0, 'off')).toContain('the SMT route is off');
  });

  it('`smtFallback: \'off\'` leaves the graph deciding and asks nothing of z3', { timeout: CASE_TIMEOUT_MS }, async () => {
    const report = await verify(loopOverItems, {
      properties: ['proper-completion'], maxClasses: 500, smtFallback: 'off', timeoutMs: TEST_TIMEOUT_MS,
    });
    expect(report.checks.every((c) => c.query.route !== 'smt'), digest(report)).toBe(true);
    expect(report.counts.proven).toBe(0);
  });
});

describe('the whole-net deadlockFree fallback is not asked when the graph has already refuted it', () => {
  it('a truncated cyclic graph skips it, and says why instead of blaming the solver', { timeout: CASE_TIMEOUT_MS }, async () => {
    const report = await verify(loopOverItems, {
      properties: ['proper-completion'], maxClasses: 2_000, timeoutMs: TEST_TIMEOUT_MS,
    });
    const whole = wholeNet(report);
    // The graph reached quiescent markings holding a place outside the declared sink set —
    // designed terminals, but the sink clause cannot tell them apart — so VER-002's error
    // condition is satisfied on this net and the query can only ever answer `violated` or
    // `unknown`. Asking it would spend the whole timeout to learn nothing.
    expect(whole.query.route).not.toBe('smt');
    expect(whole.reason).toContain('was not asked');
    expect(whole.reason).toContain('can never return proven');
    expect(whole.reason).not.toContain('did not decide it either');
    expect(whole.elapsedMs).toBeLessThan(TEST_TIMEOUT_MS);
  });

  it('a graph that has *not* refuted it still asks: the question is real there', { timeout: CASE_TIMEOUT_MS }, async () => {
    // switch20 truncates with six quiescent classes, all of them inside the rest set, so
    // nothing the graph saw makes `deadlockFree` false — and the fallback runs. The gate is
    // evidence-driven, not a blanket "never ask".
    const report = await verify(switch20, {
      properties: ['proper-completion'], maxClasses: 500, timeoutMs: 100, smtFallback: 'force',
    });
    const whole = wholeNet(report);
    expect(whole.query.route).toBe('smt');
  });
});
