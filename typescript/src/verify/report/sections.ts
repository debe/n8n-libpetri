/**
 * The report's sections under the property table: the findings with their node paths, the
 * bounded checks with the bound they hold within, the unproven checks with their reasons, and
 * the closing tally.
 */
import { renderMarkedPlace, renderNodePath } from '../counterexample.js';
import type { PropertyCheck, VerificationReport } from '../types.js';

/** A titled bullet list followed by a blank line; nothing at all when there are no items. */
export function listSection(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [title, ...items.map((item) => `  - ${item}`), ''];
}

/** A violation with its node path and, for a stranding, the marking the run got stuck in. */
export function renderFinding(check: PropertyCheck, index: number): string[] {
  const lines = [`  ${index}. [${check.property}] ${check.explanation}`];
  const cex = check.counterexample;
  if (cex === null) return lines;
  lines.push(`     node path${cex.ordered ? '' : ' (unordered — the replay did not confirm a firing sequence)'}: ${renderNodePath(cex)}`);
  if (cex.stuckMarking.length > 0) {
    lines.push(`     marking at the violation: ${cex.stuckMarking.map(renderMarkedPlace).join('; ')}`);
  }
  return lines;
}

/** Every violated check, numbered, with its finding block. */
export function findingsSection(checks: readonly PropertyCheck[]): string[] {
  const violated = checks.filter((c) => c.verdict === 'violated');
  if (violated.length === 0) return [];
  return [`Findings (${violated.length})`, ...violated.flatMap((c, i) => renderFinding(c, i + 1)), ''];
}

/** The bounded checks, under a title stating the bound they hold within. */
export function boundedSection(report: VerificationReport): string[] {
  const bounded = report.checks.filter((c) => c.verdict === 'bounded');
  if (bounded.length === 0) return [];
  const k = report.stateSpace.boundedCyclicRuns;
  const steps = report.stateSpace.loopSteps;
  // The quantity is runs of the cyclic nodes, which is what `closedCyclicRuns` counts.
  // With `steps` of them on the cycle, `floor(k / steps)` complete passes of the body are
  // guaranteed; printing the raw count as "loop iterations" overstated it by that factor.
  const passes = k === null || steps <= 1 ? null : Math.floor(k / steps);
  return listSection(
    `Bounded (${bounded.length}) — holds for every run of at most ${k ?? '?'} cyclic-node run(s)` +
    `${passes === null ? '' : ` (at least ${passes} complete pass(es) of the ${steps} cyclic node(s))`}, ` +
    'which is sound and is not a proof',
    bounded.map((c) => `${c.property} / ${c.name}`));
}

/** The undecided checks, each with its reason: an `unknown` is never silently dropped. */
export function unknownSection(checks: readonly PropertyCheck[]): string[] {
  const unknown = checks.filter((c) => c.verdict === 'unknown');
  return listSection(
    `Unproven (${unknown.length}) — not a clean result, just an undecided one`,
    unknown.map((c) => `${c.property} / ${c.name}: ${c.reason ?? 'no reason given'}`));
}

/** The closing count of every verdict, and the run's wall clock. */
export function tallyLine(report: VerificationReport): string {
  return `${report.counts.proven} proven, ${report.counts.violated} violated, ${report.counts.bounded} bounded, ` +
    `${report.counts.unknown} unknown in ${(report.elapsedMs / 1000).toFixed(1)}s`;
}
