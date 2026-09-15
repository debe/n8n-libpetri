/**
 * The report's header block: what was verified, against what, with which solver.
 */
import type { VerificationReport } from '../types.js';
import { renderStateSpace } from './state-space-line.js';
import { table } from './table.js';

/** The one-line header block: what was verified, against what, with which solver. */
export function renderHeader(report: VerificationReport): string[] {
  return [
    `n8n-libpetri verify — ${report.workflow}`,
    ...table([
      ['  net', `${report.net.places} places, ${report.net.transitions} transitions, ${report.net.flatTransitions} flat (XOR-expanded, IO-016)`],
      ['  budget', budgetLine(report)],
      ['  state space', renderStateSpace(report)],
      ['  solver', solverLine(report)],
      ['  invariants', invariantsLine(report)],
      ['  budget semiflow', semiflowLine(report)],
      // Every query starts from `compiled.initialMarking(...)`, so a resumed or retried
      // execution — whose marking the codec rebuilds from n8n's own stack, and which need
      // not be reachable from M0 at all — is outside what any verdict here covers.
      ['  scope', 'markings reachable from the fresh initial marking; a resumed or retried execution starts from a codec-decoded marking outside that set'],
      ['  hash', report.structuralHash],
    ]),
  ];
}

function solverLine(report: VerificationReport): string {
  // Not "every verdict is unknown": since M5 the solver-free route decides everything a
  // complete graph decides, and saying otherwise contradicts the PROVEN rows on the same page.
  return report.solver.available
    ? `z3 ${report.solver.version} (${report.solver.program}), ${(report.timeoutMs / 1000).toFixed(0)}s per query`
    : 'none — the SMT fallback cannot run; the solver-free route still decides what a complete graph ' +
      `decides (VER-010) (${report.solver.reason})`;
}

function budgetLine(report: VerificationReport): string {
  return report.budgetRestriction === null
    ? `k = ${report.budget}`
    : `k = ${report.budget} (requested ${report.requestedBudget}, lowered: ${report.budgetRestriction.reason} — ${report.budgetRestriction.detail})`;
}

function invariantsLine(report: VerificationReport): string {
  return report.invariants.encoded === 0
    ? 'not computed (no family needed them)'
    : `${report.invariants.basis} basis + ${report.invariants.semiflowsEncoded} semiflow(s) encoded ` +
      `= ${report.invariants.encoded} handed to the encoder (VER-007)`;
}

function semiflowLine(report: VerificationReport): string {
  return report.invariants.budgetSemiflow
    ?? (report.invariants.encoded === 0
      ? 'not computed — the P-invariant pipeline runs only for the budget family'
      : 'not found among the validated invariants');
}
