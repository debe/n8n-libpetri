/**
 * CI gate for the z3 executable (VER-013).
 *
 * Every solver-backed spike (`describeZ3` in `tests/spikes/support.ts`) skips itself
 * when no usable `z3` resolves (`PATH` or `LIBPETRI_Z3`, >= 4.8.0), so the model could
 * ship with its proofs never having run. Locally that skip is a legitimate choice; on a
 * CI runner (`CI` set) it is a red build. This file carries no skip of its own, and
 * prints the solver version so the log shows which z3 the proofs ran on.
 */
import { formatZ3Version, resolveZ3, z3Available } from 'libpetri/verification';

describe('z3 gate', () => {
  it('a usable z3 executable must resolve on a CI runner', () => {
    const available = z3Available();
    if (available) {
      const solver = resolveZ3();
      console.log(`z3 ${formatZ3Version(solver.version)} (${solver.program})`);
    }
    if (process.env['CI'] == null) {
      // Developer machine: skipping is legitimate, but say so where the log is read.
      if (!available) console.log('z3 gate: no usable z3 >= 4.8.0 resolves; the verification spikes are skipped');
      return;
    }
    expect(
      available,
      'no usable z3 executable resolves (PATH or LIBPETRI_Z3, >= 4.8.0), so every verification ' +
        'spike skipped itself. Fix the runner rather than relaxing this assertion.',
    ).toBe(true);
  });
});
