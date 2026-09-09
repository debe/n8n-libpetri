/**
 * The install this project cannot run on, refused with a message that says so (`tasks/todo.md`).
 *
 * The range asked for `libpetri@^5.0.0` until 5.1.0 shipped, and a registry install satisfied it
 * with a package predating VER-014 / VER-016 / VER-017. The floor is right now, so this guards a
 * downgrade or a stale lock rather than the default configuration. Every SMT query would then throw — loudly
 * since `rethrowIfBug`, but from several frames inside a query, reading as a bug in this
 * project rather than as an install that predates the API. This check names the gap instead.
 */
import { SmtVerifier } from 'libpetri/verification';
import { assertLibpetriSurface } from '../../src/verify/index.js';

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
});
