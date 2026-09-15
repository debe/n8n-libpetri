/**
 * `markdown.ts`: the one table renderer both conformance reports use. It escapes every cell
 * exactly once — the header included — so a `|` or a newline in a case name, a path or an
 * engine label cannot break a table.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildMatrix, parseJunit, renderMatrix } from '../../src/conformance/index.js';
import { table } from '../../src/conformance/markdown.js';

/** The cells of a table row, splitting on the pipes that are not escaped. */
const cells = (line: string): string[] => line.split(/(?<!\\)\|/).slice(1, -1);

describe('table', () => {
  it('escapes every cell once, the header included, and renders an empty cell as one space', () => {
    expect(table(['a|b', 'c'], [['x\ny', '`p|q`'], ['…', '']])).toEqual([
      '| a\\|b | c |',
      '|---|---|',
      '| x y | `p\\|q` |',
      '| … | |',
    ]);
  });
});

describe('renderMatrix', () => {
  it('keeps the header one cell per column when an engine label contains |', () => {
    const xml = readFileSync(fileURLToPath(new URL('./fixtures/baseline.junit.xml', import.meta.url)), 'utf8');
    const baseline = parseJunit(xml);
    const out = renderMatrix(buildMatrix(baseline, parseJunit(xml), { baselineLabel: 'stack|k=1', candidateLabel: 'petri|k=2' }));
    const header = out.split('\n').find((l) => l.startsWith('| pattern |'))!;
    expect(`${header} -> ${cells(header).length}`).toBe(`${header} -> 5`);
  });
});
