/**
 * The exit code of a run that produced a report: 0, 1 or 3 of the CI contract `verify/cli.ts`'s
 * module doc sets out (2, an input error, never gets this far).
 */
import type { CliOutput } from '../../cli/io.js';
import type { VerificationReport } from '../types.js';

/** `report`'s exit code, with the reason on stderr whenever it is not a finding or a clean run. */
export function exitCodeOf(report: VerificationReport, strict: boolean, io: CliOutput): number {
  // A finding outranks a missing solver: the solver-free route (VER-010) decides the
  // reachability-safety families without z3, so a stranding it found is a finding whether or
  // not the fallback could run.
  if (!report.ok) return 1;
  // No solver: the SMT fallback never ran. That is not a clean run either.
  if (!report.solver.available) {
    io.stderr(`the SMT fallback did not run: ${report.solver.reason ?? 'no usable z3'}\n`);
    return 3;
  }
  const unproven = report.counts.unknown + report.counts.bounded;
  if (strict && unproven > 0) {
    io.stderr(
      `--strict: ${unproven} check(s) are not proven (${report.counts.unknown} unknown, ` +
      `${report.counts.bounded} bounded)\n`);
    return 1;
  }
  return 0;
}
