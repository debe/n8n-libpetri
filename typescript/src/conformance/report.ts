/**
 * Markdown rendering of a `ConformanceMatrix`. The first line after the title is the
 * headline the reporting rule asks for: loop-driving cases passed, with the pure-helper
 * population on its own line. Regressions are always listed in full; the loop-driving rows
 * are listed so the reviewer sees exactly which cases the headline counts.
 */
import { LOOP_DRIVING_PATTERNS } from './classify.js';
import { table } from './markdown.js';
import { EMPTY_TALLY, type ConformanceMatrix, type MatrixRow, type Tally } from './matrix.js';

const ratio = (t: Tally): string => `${t.passed}/${t.total}`;

function outcomeNote(t: Tally): string {
  const parts: string[] = [];
  if (t.failed) parts.push(`${t.failed} failed`);
  if (t.skipped) parts.push(`${t.skipped} skipped`);
  if (t.missing) parts.push(`${t.missing} missing`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** The cases with their outcome under each engine; `withPattern` adds the loop-driving pattern. */
function caseTable(rows: readonly MatrixRow[], m: ConformanceMatrix, withPattern: boolean): string[] {
  const head = withPattern ? ['pattern', 'file', 'case'] : ['file', 'case'];
  return table(
    [...head, m.baselineLabel, m.candidateLabel],
    rows.map((r) => [...(withPattern ? [r.classification.pattern ?? ''] : []), r.file, r.name, r.baseline, r.candidate]),
  );
}

/** Render the matrix as Markdown. */
export function renderMatrix(m: ConformanceMatrix): string {
  const perPattern = LOOP_DRIVING_PATTERNS.map((p) => {
    const t = m.byPattern.get(p.id) ?? EMPTY_TALLY;
    return `${p.id} ${ratio(t)}`;
  }).join(', ');
  const total = m.rows.length;
  const setLine = m.identical
    ? `Case set and outcomes: identical (${total} cases).`
    : `Case set and outcomes: ${m.regressions.length} regression(s), ${m.fixed.length} fixed, ` +
      `${m.added.length} new, ${m.rows.filter((r) => r.candidate === 'missing').length} missing, ` +
      `${total} cases in total.`;

  const out: string[] = [
    `# Conformance: ${m.baselineLabel} vs ${m.candidateLabel}`,
    '',
    `**Loop-driving cases passed: ${ratio(m.loopDriving)}**${outcomeNote(m.loopDriving)} — ${perPattern}.`,
    '',
    `Pure-helper cases passed: ${ratio(m.helper)}${outcomeNote(m.helper)}.`,
    '',
    setLine,
    '',
  ];
  if (m.regressions.length) {
    out.push('## Regressions', '', ...caseTable(m.regressions, m, false), '');
  }
  if (m.fixed.length) {
    out.push('## Fixed', '', ...caseTable(m.fixed, m, false), '');
  }
  if (m.added.length) {
    out.push('## New in candidate', '', ...caseTable(m.added, m, false), '');
  }
  const loopRows = m.rows.filter((r) => r.classification.loopDriving);
  out.push('## Loop-driving cases', '', ...caseTable(loopRows, m, true), '');
  return out.join('\n');
}
