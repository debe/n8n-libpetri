/**
 * Markdown tables: the one renderer both conformance reports use, the matrix
 * (`report.ts`) and the differ's (`differ-report.ts`). Every cell is escaped here and only
 * here — a node name, a path, an error message or a rendered value may contain `|` or a
 * newline, either of which breaks the table. Callers pass raw text, inline markup
 * (`**bold**`, `` `code` ``) included, and never escape it themselves: escaping twice turns
 * `\|` into `\\|`, which ends the cell after all.
 */

/** Text as a Markdown table cell: a `|` would end the cell and a newline would end the row. */
export const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** One row, every cell escaped; an empty cell is a single space (`| a | |`). */
function row(cells: readonly string[]): string {
  return `|${cells.map((c) => { const text = cell(c); return text === '' ? ' ' : ` ${text} `; }).join('|')}|`;
}

/** A header row, its separator and one row per entry; every entry should be the header's width. */
export function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(head), `|${head.map(() => '---').join('|')}|`, ...rows.map(row)];
}
