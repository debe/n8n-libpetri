/**
 * The junit reader against hand-written documents covering the XML subset vitest emits,
 * and against the real unpatched baseline (`fixtures/baseline.junit.xml`, produced by
 * `scripts/bootstrap-n8n.sh` on n8n `441970b`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseJunit, parseXml, decodeEntities, allCases, caseKeys, JunitParseError,
} from '../../src/conformance/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/baseline.junit.xml', import.meta.url));

describe('decodeEntities', () => {
  it('decodes the five named entities and numeric references', () => {
    expect(decodeEntities('a &gt; b &lt; c &amp; d &quot;e&quot; &apos;f&apos;')).toBe('a > b < c & d "e" \'f\'');
    expect(decodeEntities('&#65;&#x42;&#x1F600;')).toBe('AB\u{1F600}');
  });

  it('leaves unknown entities and bare ampersands alone', () => {
    expect(decodeEntities('&nbsp; & &unknown;')).toBe('&nbsp; & &unknown;');
  });
});

describe('parseXml', () => {
  it('builds an element tree with attributes, text, CDATA and self-closing tags', () => {
    const root = parseXml(
      '<?xml version="1.0" encoding="UTF-8" ?>\n<!-- comment -->\n' +
      '<a x="1" y=\'two &gt; one\'>text<b/><c><![CDATA[<raw> & stuff]]></c>&amp;</a>',
    );
    expect(root.name).toBe('a');
    expect(root.attrs).toEqual({ x: '1', y: 'two > one' });
    expect(root.children).toEqual([
      'text',
      { name: 'b', attrs: {}, children: [] },
      { name: 'c', attrs: {}, children: ['<raw> & stuff'] },
      '&',
    ]);
  });

  it('ignores a BOM and a DOCTYPE', () => {
    expect(parseXml('﻿<!DOCTYPE x><x/>').name).toBe('x');
  });

  it('rejects malformed documents with the offset', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(JunitParseError);
    expect(() => parseXml('<a><b></a>')).toThrow(/closing <\/a> but <b> is open/);
    expect(() => parseXml('<a>')).toThrow(/unclosed <a>/);
    expect(() => parseXml('<a x=1/>')).toThrow(/not quoted/);
    expect(() => parseXml('<a x/>')).toThrow(/without a value/);
    expect(() => parseXml('<a/><b/>')).toThrow(/more than one root/);
    expect(() => parseXml('')).toThrow(/empty document/);
    expect(() => parseXml('<a><!-- never closed')).toThrow(/unterminated/);
    try {
      parseXml('<a></b>');
    } catch (e) {
      expect(e).toBeInstanceOf(JunitParseError);
      expect((e as JunitParseError).offset).toBe(7);
    }
  });
});

describe('parseJunit', () => {
  const doc = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="5" failures="1" errors="1" time="1.5">
  <testsuite name="src/a.test.ts" timestamp="2026-09-05T00:00:00.000Z" hostname="h" tests="5" failures="1" errors="1" skipped="1" time="0.3">
    <testcase classname="src/a.test.ts" name="suite &gt; passes" time="0.001">
    </testcase>
    <testcase classname="src/a.test.ts" name="suite &gt; fails" time="0.002">
      <failure message="expected 1 to be 2" type="AssertionError">AssertionError: expected 1 to be 2
 ❯ src/a.test.ts:3:5</failure>
      <system-out>
noise
      </system-out>
    </testcase>
    <testcase classname="src/a.test.ts" name="suite &gt; errors" time="0">
      <error message="boom"><![CDATA[Error: boom]]></error>
    </testcase>
    <testcase classname="src/a.test.ts" name="suite &gt; skipped">
      <skipped/>
    </testcase>
    <testcase classname="src/a.test.ts" name="suite &gt; passes" time="0.003"/>
  </testsuite>
</testsuites>`;

  it('reads suites, cases, statuses and failure details', () => {
    const report = parseJunit(doc);
    expect(report.name).toBe('vitest tests');
    expect([report.tests, report.failures, report.errors]).toEqual([5, 1, 1]);
    expect(report.suites).toHaveLength(1);
    const suite = report.suites[0]!;
    expect([suite.name, suite.tests, suite.failures, suite.errors, suite.skipped, suite.time])
      .toEqual(['src/a.test.ts', 5, 1, 1, 1, 0.3]);
    expect(suite.cases.map((c) => [c.name, c.status, c.time])).toEqual([
      ['suite > passes', 'pass', 0.001],
      ['suite > fails', 'fail', 0.002],
      ['suite > errors', 'fail', 0],
      ['suite > skipped', 'skip', 0],
      ['suite > passes', 'pass', 0.003],
    ]);
    expect(suite.cases[1]!.detail).toBe('expected 1 to be 2\nAssertionError: expected 1 to be 2\n ❯ src/a.test.ts:3:5');
    expect(suite.cases[2]!.detail).toBe('boom\nError: boom');
    expect(suite.cases[0]!.detail).toBeUndefined();
    expect(suite.cases.every((c) => c.file === 'src/a.test.ts')).toBe(true);
  });

  it('numbers repeated names in document order', () => {
    const keys = [...caseKeys(allCases(parseJunit(doc))).keys()];
    expect(keys).toEqual([
      'src/a.test.ts::suite > passes',
      'src/a.test.ts::suite > fails',
      'src/a.test.ts::suite > errors',
      'src/a.test.ts::suite > skipped',
      'src/a.test.ts::suite > passes#2',
    ]);
  });

  it('accepts a single <testsuite> root and nested suites, deriving missing totals', () => {
    const single = parseJunit('<testsuite name="s"><testcase classname="f" name="n"/></testsuite>');
    expect(single.suites).toHaveLength(1);
    expect(single.tests).toBe(1);
    const nested = parseJunit(
      '<testsuites><testsuite name="outer"><testcase classname="f" name="a"/>' +
      '<testsuite name="inner"><testcase classname="f" name="b"/></testsuite></testsuite></testsuites>',
    );
    expect(nested.suites.map((s) => s.name)).toEqual(['outer', 'inner']);
    expect(allCases(nested).map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('rejects a document whose root is not a junit element', () => {
    expect(() => parseJunit('<html/>')).toThrow(/expected <testsuites>/);
  });
});

describe('the real baseline (n8n 441970b, unpatched)', () => {
  const report = parseJunit(readFileSync(FIXTURE, 'utf8'));
  const cases = allCases(report);

  it('has 75 files and 1657 cases, none failed or skipped', () => {
    expect(report.suites).toHaveLength(75);
    expect(cases).toHaveLength(1657);
    expect(report.tests).toBe(1657);
    expect(report.failures).toBe(0);
    expect(report.errors).toBe(0);
    expect(cases.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(report.suites.reduce((a, s) => a + s.tests, 0)).toBe(1657);
    expect(report.suites.every((s) => s.cases.length === s.tests)).toBe(true);
  });

  it('names every suite after its test file and every case after its file', () => {
    expect(report.suites.every((s) => /^src\/execution-engine\/.*\.test\.ts$/.test(s.name))).toBe(true);
    expect(report.suites.every((s) => s.cases.every((c) => c.file === s.name))).toBe(true);
    expect(new Set(report.suites.map((s) => s.name)).size).toBe(75);
  });

  it('holds the four workflow-execute files with 208 cases', () => {
    const we = report.suites.filter((s) => /workflow-execute/.test(s.name));
    expect(we.map((s) => [s.name.replace('src/execution-engine/__tests__/', ''), s.tests])).toEqual([
      ['workflow-execute-node-error-reporting.test.ts', 16],
      ['workflow-execute-process-process-run-execution-data.test.ts', 21],
      ['workflow-execute-run-node.test.ts', 46],
      ['workflow-execute.test.ts', 125],
    ]);
  });

  it('decodes the describe separator in names', () => {
    expect(cases.some((c) => c.name.includes('&gt;'))).toBe(false);
    expect(cases.some((c) => c.name.includes(' > '))).toBe(true);
    expect(cases.find((c) => c.name === 'WorkflowExecute > v1 execution order > should run node twice when it has two input connections')).toBeDefined();
  });

  it('keys 1657 cases uniquely, numbering the six repeated names', () => {
    const keys = caseKeys(cases);
    expect(keys.size).toBe(1657);
    const repeats = [...keys.keys()].filter((k) => /#\d+$/.test(k));
    expect(repeats).toHaveLength(6);
    expect(repeats.every((k) => k.endsWith('#2'))).toBe(true);
  });
});
