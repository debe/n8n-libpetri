/**
 * Markdown rendering of a `ConformanceMatrix`. The first line after the title is the
 * headline the reporting rule asks for: loop-driving cases passed, with the pure-helper
 * population on its own line. Regressions are always listed in full; the loop-driving rows
 * are listed so the reviewer sees exactly which cases the headline counts.
 */
import { LOOP_DRIVING_PATTERNS } from './classify.js';
import type { ConformanceMatrix, MatrixRow, Tally } from './matrix.js';

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const ratio = (t: Tally): string => `${t.passed}/${t.total}`;

function outcomeNote(t: Tally): string {
  const parts: string[] = [];
  if (t.failed) parts.push(`${t.failed} failed`);
  if (t.skipped) parts.push(`${t.skipped} skipped`);
  if (t.missing) parts.push(`${t.missing} missing`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function table(rows: readonly MatrixRow[], m: ConformanceMatrix, withPattern: boolean): string[] {
  const head = withPattern ? ['pattern', 'file', 'case'] : ['file', 'case'];
  const lines = [
    `| ${[...head, m.baselineLabel, m.candidateLabel].join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|---|---|`,
  ];
  for (const r of rows) {
    const cols = withPattern ? [r.classification.pattern ?? '', r.file, r.name] : [r.file, r.name];
    lines.push(`| ${[...cols.map(cell), r.baseline, r.candidate].join(' | ')} |`);
  }
  return lines;
}

/** Render the matrix as Markdown. */
export function renderMatrix(m: ConformanceMatrix): string {
  const perPattern = LOOP_DRIVING_PATTERNS.map((p) => {
    const t = m.byPattern.get(p.id) ?? { total: 0, passed: 0, failed: 0, skipped: 0, missing: 0 };
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
    out.push('## Regressions', '', ...table(m.regressions, m, false), '');
  }
  if (m.fixed.length) {
    out.push('## Fixed', '', ...table(m.fixed, m, false), '');
  }
  if (m.added.length) {
    out.push('## New in candidate', '', ...table(m.added, m, false), '');
  }
  const loopRows = m.rows.filter((r) => r.classification.loopDriving);
  out.push('## Loop-driving cases', '', ...table(loopRows, m, true), '');
  return out.join('\n');
}
