/**
 * Rendering a {@link VerificationReport} for a terminal: a header, the property table, the
 * findings with their node paths, and the unproven list.
 *
 * Three rules the format follows. A violation is never printed as place names — the
 * counterexample is a node path (`counterexample.ts`), and the stuck marking is printed in
 * node / role terms with the place name in parentheses for anyone who wants to look it up.
 * An `unknown` is never silently dropped: it gets its own section with the reason, so a
 * run whose expensive property did not close cannot be mistaken for a clean bill of health.
 * And a `bounded` verdict gets a section of its own too, never the proven tally: it holds
 * over every run within the graph's closed prefix — counted in **runs of the workflow's
 * cyclic nodes**, which is what `loopTransitions` counts, so a two-node loop spends two per
 * pass of its body and the rendered line says both figures — and it says nothing beyond it,
 * so folding it into `proven` would be exactly the false proof this surface must not have.
 *
 * The parts live under `report/`: the header (`header.ts`) and its state-space line
 * (`state-space-line.ts`), the property table (`table.ts`) and the sections under it
 * (`sections.ts`).
 */
import type { CheckSubject, VerificationReport } from './types.js';
import { renderHeader } from './report/header.js';
import {
  boundedSection, findingsSection, listSection, tallyLine, unknownSection,
} from './report/sections.js';
import { renderTable } from './report/table.js';

export { renderHeader } from './report/header.js';
export { renderFinding } from './report/sections.js';
export { renderStateSpace } from './report/state-space-line.js';
export { renderTable } from './report/table.js';

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

export function renderReport(report: VerificationReport): string {
  const lines: string[] = [
    ...renderHeader(report), '',
    // Before the diagnostics: a guessed shape changes which net the rest of the page is about.
    ...listSection(
      `Guessed node shapes (${report.shapeWarnings.length}) — the compiled net may differ from the workflow`,
      report.shapeWarnings),
    ...listSection('Compiler diagnostics', report.diagnostics),
  ];
  if (report.checks.length === 0) {
    lines.push('No checks ran (no property selected).', '');
    return lines.join('\n');
  }
  lines.push(
    ...renderTable(report.checks), '',
    ...findingsSection(report.checks),
    ...boundedSection(report),
    ...unknownSection(report.checks),
    tallyLine(report),
  );
  return lines.join('\n');
}
