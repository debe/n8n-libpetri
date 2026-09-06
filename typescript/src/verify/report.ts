/**
 * Rendering a {@link VerificationReport} for a terminal: a header, the property table, the
 * findings with their node paths, and the unproven list.
 *
 * Two rules the format follows. A violation is never printed as place names — the
 * counterexample is a node path (`counterexample.ts`), and the stuck marking is printed in
 * node / role terms with the place name in parentheses for anyone who wants to look it up.
 * And an `unknown` is never silently dropped: it gets its own section with the reason, so a
 * run whose expensive property did not close cannot be mistaken for a clean bill of health.
 */
import { renderMarkedPlace, renderNodePath } from './counterexample.js';
import type { CheckSubject, PropertyCheck, VerificationReport } from './types.js';

const VERDICT_LABEL = { proven: 'PROVEN', violated: 'VIOLATED', unknown: 'unknown' } as const;

/** `Merge input 0`, `A -> Merge.0`, `Set2`, `A | B`, `_budget`, `net`. */
export function renderSubject(subject: CheckSubject): string {
  switch (subject.kind) {
    case 'join-input':
      return `${subject.node} input ${subject.inputIndex}`;
    case 'edge':
      return subject.from === undefined
        ? `${subject.node} input`
        : `${subject.from}.${subject.outputIndex} -> ${subject.node}.${subject.inputIndex ?? 0}`;
    case 'node':
      return subject.node;
    case 'node-pair':
      return `${subject.nodes[0]} | ${subject.nodes[1]}`;
    case 'place':
      return subject.place;
    case 'net':
      return '(whole net)';
  }
}

function seconds(ms: number): string {
  if (ms === 0) return '-';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i] ?? 0))).join('  ').trimEnd());
}

/** The one-line header block: what was verified, against what, with which solver. */
export function renderHeader(report: VerificationReport): string[] {
  const solver = report.solver.available
    ? `z3 ${report.solver.version} (${report.solver.program}), ${(report.timeoutMs / 1000).toFixed(0)}s per query`
    : `none — every verdict is unknown (${report.solver.reason})`;
  const budget = report.budgetRestriction === null
    ? `k = ${report.budget}`
    : `k = ${report.budget} (requested ${report.requestedBudget}, lowered: ${report.budgetRestriction.reason} — ${report.budgetRestriction.detail})`;
  const invariants =
    `${report.invariants.basis} basis + ${report.invariants.semiflowsEncoded} semiflow(s) encoded ` +
    `= ${report.invariants.encoded} handed to the encoder (VER-007)`;
  return [
    `n8n-libpetri verify — ${report.workflow}`,
    ...table([
      ['  net', `${report.net.places} places, ${report.net.transitions} transitions, ${report.net.flatTransitions} flat (XOR-expanded, IO-016)`],
      ['  budget', budget],
      ['  solver', solver],
      ['  invariants', invariants],
      ['  budget semiflow', report.invariants.budgetSemiflow ?? 'not found among the validated invariants'],
      // Every query starts from `compiled.initialMarking(...)`, so a resumed or retried
      // execution — whose marking the codec rebuilds from n8n's own stack, and which need
      // not be reachable from M0 at all — is outside what any verdict here covers.
      ['  scope', 'markings reachable from the fresh initial marking; a resumed or retried execution starts from a codec-decoded marking outside that set'],
      ['  hash', report.structuralHash],
    ]),
  ];
}

/**
 * One row per check: property, the check's own name, verdict, wall clock.
 *
 * The name and not the subject: a family can ask two different questions about one subject
 * (a join input gets both the quiescence query and the arrival bound), and two rows reading
 * `proper-completion  Merge input 0` with different verdicts would be unreadable.
 */
export function renderTable(checks: readonly PropertyCheck[]): string[] {
  const rows: string[][] = [['PROPERTY', 'CHECK', 'VERDICT', 'TIME']];
  for (const c of checks) {
    rows.push([c.property, c.name, VERDICT_LABEL[c.verdict], seconds(c.elapsedMs)]);
  }
  return table(rows);
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

export function renderReport(report: VerificationReport): string {
  const lines: string[] = [...renderHeader(report), ''];
  // Before the diagnostics: a guessed shape changes which net the rest of the page is about.
  if (report.shapeWarnings.length > 0) {
    lines.push(`Guessed node shapes (${report.shapeWarnings.length}) — the compiled net may differ from the workflow`);
    for (const w of report.shapeWarnings) lines.push(`  - ${w}`);
    lines.push('');
  }
  if (report.diagnostics.length > 0) {
    lines.push('Compiler diagnostics');
    for (const d of report.diagnostics) lines.push(`  - ${d}`);
    lines.push('');
  }
  if (report.checks.length === 0) {
    lines.push('No checks ran (no property selected).', '');
    return lines.join('\n');
  }
  lines.push(...renderTable(report.checks), '');

  const violated = report.checks.filter((c) => c.verdict === 'violated');
  if (violated.length > 0) {
    lines.push(`Findings (${violated.length})`);
    violated.forEach((c, i) => lines.push(...renderFinding(c, i + 1)));
    lines.push('');
  }
  const unknown = report.checks.filter((c) => c.verdict === 'unknown');
  if (unknown.length > 0) {
    lines.push(`Unproven (${unknown.length}) — not a clean result, just an undecided one`);
    for (const c of unknown) {
      lines.push(`  - ${c.property} / ${c.name}: ${c.reason ?? 'no reason given'}`);
    }
    lines.push('');
  }
  lines.push(
    `${report.counts.proven} proven, ${report.counts.violated} violated, ${report.counts.unknown} unknown ` +
    `in ${(report.elapsedMs / 1000).toFixed(1)}s`,
  );
  return lines.join('\n');
}
