/**
 * The install this project cannot run on, refused with a message that says so (`tasks/todo.md`).
 *
 * The range asked for `libpetri@^5.0.0` until 5.1.0 shipped, and a registry install satisfied it
 * with a package predating VER-014 / VER-016 / VER-017. The floor is right now, so this guards a
 * downgrade or a stale lock rather than the default configuration. Every SMT query would then throw — loudly
 * since `rethrowIfBug`, but from several frames inside a query, reading as a bug in this
 * project rather than as an install that predates the API. This check names the gap instead.
 */
import { SmtVerifier, placeBound } from 'libpetri/verification';
import { assertLibpetriSurface, markingStateOf } from '../../src/verify/index.js';
import { compile } from '../../src/compiler/index.js';
import { diamond } from '../fixtures/workflows.js';

describe('the libpetri surface this verifier requires', () => {
  it('passes against the installed libpetri', () => {
    expect(() => assertLibpetriSurface()).not.toThrow();
  });

  it('names every missing method, and says which release carries them', () => {
    const proto = SmtVerifier.prototype as unknown as Record<string, unknown>;
    const saved = { sinkPlacesWhen: proto['sinkPlacesWhen'], stateEquation: proto['stateEquation'] };
    delete proto['sinkPlacesWhen'];
    delete proto['stateEquation'];
    try {
      expect(() => assertLibpetriSurface()).toThrow(/sinkPlacesWhen, stateEquation/);
      expect(() => assertLibpetriSurface()).toThrow(/libpetri 5\.1\.0/);
      // Not a verdict and not a warning: an install this verifier cannot report honestly on.
      expect(() => assertLibpetriSurface()).toThrow(/every proof missing/);
    } finally {
      proto['sinkPlacesWhen'] = saved.sinkPlacesWhen;
      proto['stateEquation'] = saved.stateEquation;
    }
  });

  /**
   * The report wording `verify.ts` parses, pinned.
   *
   * `unionedSemiflows()` decides whether the P-invariant cache may be reused by testing for the
   * presence of libpetri's `Semiflows encoded as invariants:` line — which it emits only when
   * the union actually ran. A wording change would make that read `false` forever: not a wrong
   * answer, just the whole flatten + P-invariant + semiflow pipeline re-running once per
   * property family, which nothing at run time would surface. Pinned here so an upgrade fails
   * in CI instead.
   *
   * No solver needed: with none installed the pipeline still runs and the route reports
   * `unavailable`, so the invariant section of the report is present either way.
   */
  it('still emits the semiflow line this verifier reads the invariant cache from', async () => {
    const compiled = compile(diamond, { budget: 1 });
    const result = await SmtVerifier.forNet(compiled.net)
      .initialMarking(markingStateOf(compiled.initialMarking(null)))
      .semiflowInvariants(true)
      .enumerationMaxClasses(0)
      .property(placeBound(compiled.netMap.shared.budget, 1))
      .verify();

    // The exact shape `SEMIFLOW_LINE` matches: two leading spaces, this wording, an integer.
    expect(result.report).toMatch(/^ {2}Semiflows encoded as invariants: \d+$/m);
    // And the companion line `FOUND_LINE` reads for the report's basis count.
    expect(result.report).toMatch(/^ {2}Found: \d+ P-invariant\(s\)$/m);
  }, 60_000);
});
