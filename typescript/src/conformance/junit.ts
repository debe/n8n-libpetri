/**
 * Reader for the junit XML that vitest's `junit` reporter writes (n8n turns it on under
 * `CI=true` through `@n8n/vitest-config`): `<testsuites>` holds one `<testsuite>` per test
 * file, each holding `<testcase>` elements with optional `<failure>`, `<error>`,
 * `<skipped>`, `<system-out>` and `<system-err>` children.
 *
 * No dependency: a small tokenizer (`junit/xml.ts`) that understands exactly the XML subset
 * involved (the declaration, comments, CDATA sections, the five named entities plus numeric
 * references, quoted attributes, self-closing tags) and rejects anything malformed, and the
 * mapper below from its tree to the junit vocabulary (`junit/model.ts`). Timing attributes
 * and the captured console output are read but never used for comparison: two runs of the
 * same suite differ only there (plus `timestamp`/`hostname`), and the matrix compares per
 * file and case name (`junit/case-keys.ts`).
 */
import type { JunitCase, JunitReport, JunitSuite } from './junit/model.js';
import { parseXml } from './junit/xml.js';
import { JunitParseError, type XmlElement } from './junit/xml-model.js';

export type { CaseStatus, JunitCase, JunitReport, JunitSuite } from './junit/model.js';
export { JunitParseError, type XmlElement, type XmlNode } from './junit/xml-model.js';
export { decodeEntities } from './junit/entities.js';
export { parseXml } from './junit/xml.js';
export { caseKeys } from './junit/case-keys.js';

function elementChildren(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== 'string' && c.name === name);
}

function textOf(el: XmlElement): string {
  return el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

function num(el: XmlElement, attr: string): number {
  const raw = el.attrs[attr];
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** A count attribute, or `fallback()` — the count its children add up to — when absent. */
function countOf(el: XmlElement, attr: string, fallback: () => number): number {
  return el.attrs[attr] === undefined ? fallback() : num(el, attr);
}

/** The `<failure>`/`<error>` messages and bodies of a failed case. */
function failureDetail(failed: readonly XmlElement[]): string {
  return failed
    .map((f) => [f.attrs['message'], textOf(f).trim()].filter((p) => p).join('\n'))
    .join('\n');
}

function toCase(el: XmlElement): JunitCase {
  const file = el.attrs['classname'] ?? el.attrs['file'] ?? '';
  const name = el.attrs['name'] ?? '';
  const time = num(el, 'time');
  const failed = [...elementChildren(el, 'failure'), ...elementChildren(el, 'error')];
  if (failed.length > 0) return { file, name, status: 'fail', time, detail: failureDetail(failed) };
  if (elementChildren(el, 'skipped').length > 0) return { file, name, status: 'skip', time };
  return { file, name, status: 'pass', time };
}

function toSuite(el: XmlElement): JunitSuite {
  const cases = elementChildren(el, 'testcase').map(toCase);
  return {
    name: el.attrs['name'] ?? '',
    tests: countOf(el, 'tests', () => cases.length),
    failures: num(el, 'failures'),
    errors: num(el, 'errors'),
    skipped: num(el, 'skipped'),
    time: num(el, 'time'),
    cases,
  };
}

/** `<testsuites>` or `<testsuite>`: the elements a report's suites are found under. */
function isSuiteName(name: string): boolean {
  return name === 'testsuite' || name === 'testsuites';
}

function collectSuites(el: XmlElement, into: JunitSuite[]): void {
  if (el.name === 'testsuite') into.push(toSuite(el));
  for (const child of el.children) {
    if (typeof child !== 'string' && isSuiteName(child.name)) collectSuites(child, into);
  }
}

/** Parse a junit report. The root may be `<testsuites>` or a single `<testsuite>`. */
export function parseJunit(xml: string): JunitReport {
  const root = parseXml(xml);
  if (!isSuiteName(root.name)) {
    throw new JunitParseError(`root element is <${root.name}>, expected <testsuites>`, 0);
  }
  const suites: JunitSuite[] = [];
  collectSuites(root, suites);
  const sum = (pick: (s: JunitSuite) => number) => (): number => suites.reduce((a, s) => a + pick(s), 0);
  return {
    name: root.attrs['name'] ?? '',
    tests: countOf(root, 'tests', sum((s) => s.tests)),
    failures: countOf(root, 'failures', sum((s) => s.failures)),
    errors: countOf(root, 'errors', sum((s) => s.errors)),
    suites,
  };
}

/** Every case of the report, in document order. */
export function allCases(report: JunitReport): readonly JunitCase[] {
  return report.suites.flatMap((s) => s.cases);
}
