/**
 * The report's aligned columns: the verdict and route labels, the wall-clock format, and the
 * property table itself.
 */
import type { PropertyCheck } from '../types.js';

const VERDICT_LABEL = {
  proven: 'PROVEN', violated: 'VIOLATED', bounded: 'BOUNDED', unknown: 'unknown',
} as const;

/** Which route answered: the solver-free graph, the SMT fallback, or neither. */
const ROUTE_LABEL = {
  'state-class-graph': 'graph', smt: 'z3', structural: 'struct', none: '-',
} as const;

function seconds(ms: number): string {
  if (ms === 0) return '-';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** `rows` as aligned columns two spaces apart; the last column is never padded. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i] ?? 0))).join('  ').trimEnd());
}

/**
 * One row per check: property, the check's own name, verdict, wall clock.
 *
 * The name and not the subject: a family can ask two different questions about one subject
 * (a join input gets both the quiescence query and the arrival bound), and two rows reading
 * `proper-completion  Merge input 0` with different verdicts would be unreadable.
 */
export function renderTable(checks: readonly PropertyCheck[]): string[] {
  const rows: string[][] = [['PROPERTY', 'CHECK', 'VERDICT', 'ROUTE', 'TIME']];
  for (const c of checks) {
    rows.push([c.property, c.name, VERDICT_LABEL[c.verdict], ROUTE_LABEL[c.query.route], seconds(c.elapsedMs)]);
  }
  return table(rows);
}
