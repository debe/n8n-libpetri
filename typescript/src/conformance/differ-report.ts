/**
 * The differ's Markdown report, as `differ-cli.ts` writes it: one summary table, then a
 * section per failing or reordered fixture. Its columns are pinned by the tests.
 */
import type { DiffResult } from './differ.js';
import { table } from './markdown.js';

const tick = (ok: boolean): string => (ok ? 'yes' : '**no**');

/** Inline code in a table cell; {@link table} escapes it, so a `|` inside does not end the cell. */
const code = (s: string): string => `\`${s}\``;

/** Ordering mechanisms no register row names, over a set of results, sorted and unique. */
export function novelMechanismsOf(results: readonly DiffResult[]): string[] {
  return [...new Set(results.flatMap((r) => r.ordering.novelMechanisms))].sort();
}

/** The summary table's row for one run. */
function summaryRow(r: DiffResult): string[] {
  const attributed = r.ordering.differences.length - r.ordering.unattributed;
  const dataCell = r.data.equal
    ? 'equal'
    : r.data.unattributed > 0 ? `**${r.data.unattributed} unattributed**` : `${r.data.differences.length} attributed`;
  const skipped = r.happensBefore.unmatchedEdges;
  return [
    r.fixture,
    `${r.requestedBudget}`,
    `${r.effectiveBudget}`,
    dataCell,
    `${tick(r.happensBefore.respected)}${skipped > 0 ? ` (${skipped} skipped)` : ''}`,
    r.ordering.equal ? 'equal' : `${r.ordering.differences.length} moved`,
    `${attributed}/${r.ordering.differences.length}${r.ordering.unattributed > 0 ? ' **(unattributed)**' : ''}`,
    r.verdict === 'fail' ? '**fail**' : r.verdict,
  ];
}

/** The data gate's differences, the first 20 and a row counting the rest. */
function dataRows(r: DiffResult): string[][] {
  const rows = r.data.differences.slice(0, 20).map((d) => {
    const a = d.attribution;
    return [code(d.path), code(d.n8n), code(d.libpetri), a.kind === 'divergence' ? `divergence #${a.row}: ${a.why}` : '**unattributed**'];
  });
  if (r.data.differences.length > 20) rows.push(['…', `${r.data.differences.length - 20} more`, '', '']);
  return rows;
}

/** One row per ordering difference, with its attribution. */
function orderRows(r: DiffResult): string[][] {
  return r.ordering.differences.map((d) => {
    const a = d.attribution;
    const label = a.kind === 'divergence'
      ? `divergence #${a.row} (${a.mechanism}${a.novel ? ', **not in the register**' : ''})`
      : a.kind === 'concurrency' ? 'concurrency' : '**unattributed**';
    return [d.activation, `${d.n8nRank ?? '—'}`, `${d.libpetriRank ?? '—'}`, `${label}: ${a.why}`];
  });
}

/**
 * The Markdown report: one summary table, then a section per failing or reordered fixture.
 * Every table goes through {@link table}, which escapes each cell: a node name, a path, an
 * error message or a rendered value may contain `|` or a newline.
 */
export function renderDiffReport(results: readonly DiffResult[], title = 'Differential report'): string {
  const lines: string[] = [`# ${title}`, ''];
  const passed = results.filter((r) => r.verdict === 'pass').length;
  const divergent = results.filter((r) => r.verdict === 'divergent').length;
  const failed = results.filter((r) => r.verdict === 'fail').length;
  const novel = novelMechanismsOf(results);
  lines.push(
    `${passed} pass, ${divergent} divergent (every difference attributed to a \`docs/divergences.md\` row), ` +
    `${failed} fail, of ${results.length} runs.`,
    '',
    ...table(['fixture', 'k', 'effective k', 'data', 'happens-before', 'order', 'attributed', 'verdict'], results.map(summaryRow)),
  );
  if (novel.length > 0) {
    lines.push('', `Ordering mechanisms with no row in \`docs/divergences.md\`: ${novel.map((m) => `\`${m}\``).join(', ')}.`);
  }
  for (const r of results) {
    if (r.verdict === 'pass' && r.budgetRestriction === null) continue;
    lines.push('', `## ${r.fixture} @ k=${r.requestedBudget}`, '');
    if (r.budgetRestriction !== null) {
      lines.push(`Budget forced to ${r.effectiveBudget}: ${r.budgetRestriction.reason} (${r.budgetRestriction.detail}).`, '');
    }
    if (!r.data.equal) {
      lines.push('### Data differences (the gate)', '', ...table(['path', 'n8n', 'libpetri', 'attribution'], dataRows(r)));
      if (r.data.permutedNodes.length > 0) {
        lines.push('', `Permuted (same runs, other order): ${r.data.permutedNodes.join(', ')}.`);
      }
      lines.push('');
    }
    if (!r.happensBefore.respected) {
      lines.push('### Happens-before violations', '');
      for (const v of r.happensBefore.violations) lines.push(`- **${v.engine}**: ${v.detail}`);
      lines.push('');
    }
    // Always stated, so an edge the check could not look at is never invisible: `unmatched`
    // is an n8n dependency the net never realised (only reachable under a data difference,
    // where the producer/consumer pairing itself moved) and `absent` is an activation with
    // no `runNode` observation, which is a violation above.
    lines.push(
      `Happens-before: ${r.happensBefore.checkedEdges} edge(s) checked, ` +
      `${r.happensBefore.unmatchedEdges} n8n edge(s) the net never realised (not comparable), ` +
      `${r.happensBefore.absentEdges} with no runNode observation.`, '');
    lines.push('### Ordering', '', `- n8n: \`${r.ordering.n8n.join(' → ')}\``, `- libpetri: \`${r.ordering.libpetri.join(' → ')}\``);
    if (!r.ordering.lastNodeExecuted.equal) {
      lines.push(`- \`lastNodeExecuted\`: n8n \`${r.ordering.lastNodeExecuted.n8n ?? 'undefined'}\`, libpetri \`${r.ordering.lastNodeExecuted.libpetri ?? 'undefined'}\``);
    }
    lines.push('');
    if (r.ordering.differences.length > 0) {
      lines.push(...table(['activation', 'n8n rank', 'libpetri rank', 'attribution'], orderRows(r)), '');
    }
    if (r.errors.n8n !== r.errors.libpetri) {
      lines.push(`Run errors differ — n8n: \`${r.errors.n8n ?? 'none'}\`, libpetri: \`${r.errors.libpetri ?? 'none'}\`.`, '');
    }
    if (r.diagnostics.length > 0) {
      lines.push('Engine diagnostics:', '');
      for (const d of r.diagnostics) lines.push(`- ${d}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
