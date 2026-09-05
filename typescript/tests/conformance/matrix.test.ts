/**
 * The matrix, the report and the CLI: identical reports, then a candidate derived from
 * the real baseline with a loop-driving regression, a helper regression, a missing case,
 * a new case and a fixed case.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseJunit, allCases, buildMatrix, renderMatrix, runCli, USAGE,
  type JunitReport, type JunitCase, type CliIo,
} from '../../src/conformance/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/baseline.junit.xml', import.meta.url));
const xml = readFileSync(FIXTURE, 'utf8');
const baseline = parseJunit(xml);

const LOOP_CASE = 'WorkflowExecute > v1 execution order > should run node twice when it has two input connections';
const HELPER_CASE = 'WorkflowExecute > assignPairedItems > should handle undefined node output';
const MISSING_CASE = 'WorkflowExecute > moveNodeMetadata > should do nothing when there is no metadata';

/** A report like the baseline with per-case edits applied to the workflow-execute suite. */
function derive(edit: (c: JunitCase) => JunitCase | null, extra: JunitCase[] = []): JunitReport {
  const suites = baseline.suites.map((s) => {
    const cases = s.cases.map(edit).filter((c): c is JunitCase => c !== null);
    const added = extra.filter((c) => c.file === s.name);
    return { ...s, cases: [...cases, ...added], tests: cases.length + added.length };
  });
  return { ...baseline, suites };
}

describe('buildMatrix', () => {
  it('reports two parses of the same file as identical', () => {
    const m = buildMatrix(baseline, parseJunit(xml));
    expect(m.identical).toBe(true);
    expect(m.rows).toHaveLength(1657);
    expect(m.regressions).toEqual([]);
    expect(m.fixed).toEqual([]);
    expect(m.added).toEqual([]);
    expect(m.loopDriving).toEqual({ total: 36, passed: 36, failed: 0, skipped: 0, missing: 0 });
    expect(m.helper).toEqual({ total: 1621, passed: 1621, failed: 0, skipped: 0, missing: 0 });
    // Pattern order, although the junit lists the waiting cases' file first; branch-order
    // has no rows and is absent.
    expect([...m.byPattern.entries()]).toEqual([
      ['execution-order', { total: 19, passed: 19, failed: 0, skipped: 0, missing: 0 }],
      ['hook-order', { total: 6, passed: 6, failed: 0, skipped: 0, missing: 0 }],
      ['waiting', { total: 9, passed: 9, failed: 0, skipped: 0, missing: 0 }],
      ['partial', { total: 2, passed: 2, failed: 0, skipped: 0, missing: 0 }],
    ]);
    expect(m.rows.every((r) => r.verdict === 'same')).toBe(true);
    expect(m.baselineLabel).toBe('baseline');
    expect(m.candidateLabel).toBe('candidate');
  });

  it('classifies regressions, missing, new and fixed cases', () => {
    const file = 'src/execution-engine/__tests__/workflow-execute.test.ts';
    const candidate = derive(
      (c) => {
        if (c.name === LOOP_CASE) return { ...c, status: 'fail', detail: 'expected order' };
        if (c.name === HELPER_CASE) return { ...c, status: 'skip' };
        if (c.name === MISSING_CASE) return null;
        return c;
      },
      [{ file, name: 'WorkflowExecute > brand new > case', status: 'pass', time: 0 }],
    );
    // A baseline where one helper case failed, to see it reported as fixed.
    const weakerBaseline = derive((c) => (c.name === MISSING_CASE ? { ...c, status: 'fail' } : c));

    const m = buildMatrix(weakerBaseline, candidate, { baselineLabel: 'legacy', candidateLabel: 'libpetri' });
    expect(m.identical).toBe(false);
    expect(m.regressions.map((r) => [r.name, r.baseline, r.candidate])).toEqual([
      [LOOP_CASE, 'pass', 'fail'],
      [HELPER_CASE, 'pass', 'skip'],
    ]);
    expect(m.rows.find((r) => r.name === MISSING_CASE)).toMatchObject({ baseline: 'fail', candidate: 'missing', verdict: 'changed' });
    expect(m.fixed).toEqual([]);
    expect(m.added.map((r) => [r.name, r.verdict])).toEqual([['WorkflowExecute > brand new > case', 'new']]);
    expect(m.loopDriving).toEqual({ total: 36, passed: 35, failed: 1, skipped: 0, missing: 0 });
    expect(m.helper).toEqual({ total: 1622, passed: 1620, failed: 0, skipped: 1, missing: 1 });
    expect(m.rows.at(-1)!.name).toBe('WorkflowExecute > brand new > case');

    const fixedBack = buildMatrix(weakerBaseline, baseline);
    expect(fixedBack.fixed.map((r) => r.name)).toEqual([MISSING_CASE]);
    expect(fixedBack.regressions).toEqual([]);
    expect(fixedBack.identical).toBe(false);
  });

  it('pairs repeated names positionally', () => {
    const doc = (a: string, b: string) =>
      parseJunit(`<testsuites><testsuite name="f"><testcase classname="f" name="dup">${a}</testcase>` +
        `<testcase classname="f" name="dup">${b}</testcase></testsuite></testsuites>`);
    const m = buildMatrix(doc('', ''), doc('', '<failure/>'));
    expect(m.rows.map((r) => [r.key, r.verdict])).toEqual([['f::dup', 'same'], ['f::dup#2', 'regression']]);
  });

  it('accepts a custom classifier', () => {
    const m = buildMatrix(baseline, baseline, { classify: (c) => ({ loopDriving: c.file.endsWith('routing-node.test.ts'), pattern: 'custom' }) });
    expect(m.loopDriving.total).toBe(29);
    expect([...m.byPattern.keys()]).toEqual(['custom']);
  });
});

describe('renderMatrix', () => {
  it('leads with the loop-driving headline and states helpers separately', () => {
    const md = renderMatrix(buildMatrix(baseline, baseline, { baselineLabel: 'baseline', candidateLabel: 'patched' }));
    const lines = md.split('\n');
    expect(lines[0]).toBe('# Conformance: baseline vs patched');
    expect(lines[2]).toBe('**Loop-driving cases passed: 36/36** — execution-order 19/19, hook-order 6/6, branch-order 0/0, waiting 9/9, partial 2/2.');
    expect(lines[4]).toBe('Pure-helper cases passed: 1621/1621.');
    expect(lines[6]).toBe('Case set and outcomes: identical (1657 cases).');
    expect(md).not.toContain('## Regressions');
    expect(md).toContain('## Loop-driving cases');
    expect(md.match(/^\| execution-order \|/gm)).toHaveLength(19);
    expect(md.match(/^\| waiting \|/gm)).toHaveLength(9);
    expect(md.match(/^\| partial \|/gm)).toHaveLength(2);
  });

  it('lists regressions with both statuses and escapes pipes', () => {
    const candidate = derive((c) => (c.name === LOOP_CASE ? { ...c, status: 'fail' } : c),
      [{ file: 'src/execution-engine/__tests__/workflow-execute.test.ts', name: 'a | b', status: 'pass', time: 0 }]);
    const md = renderMatrix(buildMatrix(baseline, candidate));
    expect(md).toContain('**Loop-driving cases passed: 35/36** (1 failed)');
    expect(md).toContain('Case set and outcomes: 1 regression(s), 0 fixed, 1 new, 0 missing, 1658 cases in total.');
    expect(md).toContain(`## Regressions\n\n| file | case | baseline | candidate |\n|---|---|---|---|\n| src/execution-engine/__tests__/workflow-execute.test.ts | ${LOOP_CASE} | pass | fail |`);
    expect(md).toContain('| a \\| b | missing | pass |');
  });
});

describe('runCli', () => {
  function io(files: Record<string, string>): CliIo & { out: string[]; err: string[]; written: Record<string, string> } {
    const out: string[] = [];
    const err: string[] = [];
    const written: Record<string, string> = {};
    return {
      out, err, written,
      readFile: (p) => {
        const f = files[p];
        if (f === undefined) throw new Error(`no such file ${p}`);
        return f;
      },
      writeFile: (p, c) => { written[p] = c; },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    };
  }

  it('exits 0 and prints the report for identical reports', () => {
    const i = io({ a: xml, b: xml });
    expect(runCli(['a', 'b', '--require-identical'], i)).toBe(0);
    expect(i.out.join('')).toContain('**Loop-driving cases passed: 36/36**');
    expect(i.err.join('')).toBe('loop-driving 36/36 passed, helper 1621/1621 passed, 0 regression(s), identical: true\n');
  });

  it('writes to --out, labels the engines and fails on a regression', () => {
    const broken = xml.replace(
      /(name="WorkflowExecute &gt; v0 execution order &gt; should run basic two node workflow"[^>]*>)/,
      '$1<failure message="x"/>',
    );
    // Sanity: the mutation produced a parseable report with one failure.
    expect(allCases(parseJunit(broken)).filter((c) => c.status === 'fail')).toHaveLength(1);
    const i = io({ base: xml, cand: broken });
    expect(runCli(['base', 'cand', '--baseline-label', 'legacy', '--candidate-label', 'libpetri', '--out', 'r.md'], i)).toBe(1);
    expect(i.out).toEqual([]);
    expect(i.written['r.md']).toContain('# Conformance: legacy vs libpetri');
    expect(i.err.join('')).toBe('loop-driving 35/36 passed, helper 1621/1621 passed, 1 regression(s)\n');
  });

  it('distinguishes "no regression" from "identical"', () => {
    const dropped = xml.replace(
      /\s*<testcase classname="[^"]*" name="WorkflowExecute &gt; moveNodeMetadata &gt; should do nothing when there is no metadata"[^]*?<\/testcase>/,
      '',
    );
    expect(dropped).not.toBe(xml);
    expect(runCli(['a', 'b'], io({ a: xml, b: dropped }))).toBe(1); // a missing case is a regression
    expect(runCli(['a', 'b'], io({ a: dropped, b: xml }))).toBe(0); // a new case is not
    expect(runCli(['a', 'b', '--require-identical'], io({ a: dropped, b: xml }))).toBe(1);
  });

  it('rejects bad usage with exit 2', () => {
    const one = io({});
    expect(runCli(['only-one'], one)).toBe(2);
    expect(one.err.join('')).toBe(`${USAGE}\n`);
    const opt = io({});
    expect(runCli(['a', 'b', '--bogus'], opt)).toBe(2);
    expect(opt.err.join('')).toContain('unknown option --bogus');
    const missingValue = io({});
    expect(runCli(['a', 'b', '--out'], missingValue)).toBe(2);
    expect(missingValue.err.join('')).toContain('--out needs a value');
  });
});
