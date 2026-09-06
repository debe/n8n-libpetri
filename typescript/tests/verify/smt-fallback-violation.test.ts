/**
 * The one branch of the proper-completion fallback a real z3 has never taken on any fixture:
 * a `violated` whose witness is **not** a designed terminal — a stranding the solver found
 * and the pause filter does not excuse.
 *
 * `docs/verification.md` measures that query as nought for ten, with both of its `violated`
 * answers being paused runs that get downgraded. That makes the branch unreachable in a
 * measurement and *not* unreachable in code, so it is pinned with a fake `SmtVerifier`
 * returning one fixed violation. Everything else in `libpetri/verification` stays real; the
 * mock is file-wide, which is why this suite is its own file.
 *
 * Two rules it protects, both of which were broken before: a violation the route found is
 * reported rather than mapped to `unknown`, and no reason ever says the fallback "did not
 * decide it either" about a query that returned a verdict.
 */
import type { SmtVerificationResult } from 'libpetri/verification';
import { compile } from '../../src/compiler/index.js';
import { verify } from '../../src/verify/index.js';
import { CASE_TIMEOUT_MS, TEST_TIMEOUT_MS, digest, unbalancedJoin } from './support.js';

function wholeNet(report: Awaited<ReturnType<typeof verify>>) {
  const check = report.checks.find((c) => c.property === 'proper-completion' && c.subject.kind === 'net');
  if (check === undefined) throw new Error('no whole-net completion check');
  return check;
}

/**
 * A fake `SmtVerifier` returning one fixed `violated` result, so the branch a real z3 has
 * never taken on any fixture (`docs/verification.md`: nought for ten, both violations paused
 * artifacts) is still exercised. Everything else in `libpetri/verification` stays real.
 */
const STRANDED_PLACE = 'stranded/place';

/**
 * The place the fake witness marks. `mock`-prefixed because vitest hoists the `vi.mock`
 * factory above the imports and only allows a factory to close over such a name; it is read
 * inside `verify()`, long after initialisation.
 */
const mockWitness = { place: STRANDED_PLACE };

vi.mock('libpetri/verification', async (importOriginal) => {
  const real = await importOriginal<typeof import('libpetri/verification')>();
  class FakeVerifier {
    static forNet(): FakeVerifier { return new FakeVerifier(); }
    initialMarking(): this { return this; }
    semiflowInvariants(): this { return this; }
    timeout(): this { return this; }
    property(): this { return this; }
    sinkPlaces(): this { return this; }
    async verify(): Promise<SmtVerificationResult> {
      const marking = real.MarkingState.builder()
        .tokens({ name: mockWitness.place } as never, 1)
        .build();
      return {
        verdict: { type: 'violated' },
        report: 'fake',
        invariants: [],
        discoveredInvariants: [],
        counterexampleTrace: [marking],
        counterexampleTransitions: [],
        counterexampleConfirmed: true,
        elapsedMs: 1,
        statistics: {},
      } as unknown as SmtVerificationResult;
    }
  }
  return {
    ...real,
    SmtVerifier: FakeVerifier,
    // The route must believe a solver resolved; no process is ever started.
    resolveZ3: () => ({ program: '/fake/z3', version: { major: 4, minor: 13, patch: 0 }, dumpDir: null }),
  };
});

describe('a fallback violation the pause filter does not excuse is a finding', () => {
  beforeEach(() => {
    mockWitness.place = STRANDED_PLACE;
  });

  it('the whole-net row reports it instead of downgrading it to unknown', { timeout: CASE_TIMEOUT_MS }, async () => {
    // `maxClasses: 0` turns the solver-free route off, so every completion row falls back —
    // and the fake fallback returns a stranding on a place that is not a designed terminal.
    // Before the fix this was mapped to `unknown` with "the fallback did not decide it
    // either", which threw away the only violation the route had found.
    const report = await verify(unbalancedJoin, {
      properties: ['proper-completion'], maxClasses: 0, timeoutMs: TEST_TIMEOUT_MS,
    });
    const whole = wholeNet(report);
    expect(whole.verdict, digest(report)).toBe('violated');
    expect(whole.query.route).toBe('smt');
    expect(whole.counterexample!.stuckMarking.some((p) => p.place === STRANDED_PLACE)).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('a per-place row takes it only when the witness marks that place, and never claims the query said nothing', { timeout: CASE_TIMEOUT_MS }, async () => {
    const report = await verify(unbalancedJoin, {
      properties: ['proper-completion'], maxClasses: 0, timeoutMs: TEST_TIMEOUT_MS,
    });
    const perPlace = report.checks.filter(
      (c) => c.property === 'proper-completion' && c.subject.kind !== 'net' && c.name.includes('completes'));
    expect(perPlace.length).toBeGreaterThan(0);
    // None of the workflow's own places is the fake witness place, so every row stays
    // undecided — with a reason that says the finding is on the whole-net row.
    for (const check of perPlace) {
      expect(check.verdict, digest(report)).toBe('unknown');
      expect(check.reason).toContain('found a stranding elsewhere in this net');
      expect(check.reason).not.toContain('did not decide it either');
    }
  });

  it('the per-place row whose place the witness marks takes the finding', { timeout: CASE_TIMEOUT_MS }, async () => {
    // The other half of the same rule: a whole-net witness that holds *this* place is this
    // row's finding, so the report names the input rather than only the net.
    const compiled = compile(unbalancedJoin);
    const readyPlace = compiled.joinReadyPlaces[0]!.places[0]!;
    mockWitness.place = readyPlace.name;
    const report = await verify(unbalancedJoin, {
      properties: ['proper-completion'], maxClasses: 0, timeoutMs: TEST_TIMEOUT_MS,
    });
    const rows = report.checks.filter(
      (c) => c.property === 'proper-completion' && c.name.includes('completes')
        && 'place' in c.subject && c.subject.place === readyPlace.name);
    expect(rows.length).toBe(1);
    expect(rows[0]!.verdict, digest(report)).toBe('violated');
    expect(rows[0]!.counterexample!.stuckMarking.some((p) => p.place === readyPlace.name)).toBe(true);
    // Every other per-place row stays undecided: the witness says nothing about them.
    const others = report.checks.filter(
      (c) => c.property === 'proper-completion' && c.name.includes('completes')
        && 'place' in c.subject && c.subject.place !== readyPlace.name);
    expect(others.every((c) => c.verdict === 'unknown'), digest(report)).toBe(true);
  });
});
