/**
 * Reader for the junit XML that vitest's `junit` reporter writes (n8n turns it on under
 * `CI=true` through `@n8n/vitest-config`): `<testsuites>` holds one `<testsuite>` per test
 * file, each holding `<testcase>` elements with optional `<failure>`, `<error>`,
 * `<skipped>`, `<system-out>` and `<system-err>` children.
 *
 * No dependency: a small tokenizer that understands exactly the XML subset involved (the
 * declaration, comments, CDATA sections, the five named entities plus numeric references,
 * quoted attributes, self-closing tags) and rejects anything malformed. Timing attributes
 * and the captured console output are read but never used for comparison: two runs of the
 * same suite differ only there (plus `timestamp`/`hostname`), and the matrix compares per
 * file and case name.
 */

export type CaseStatus = 'pass' | 'fail' | 'skip';

export interface JunitCase {
  /** The `classname` attribute: the test file, relative to the package root. */
  readonly file: string;
  /** The full case name, describe path included, joined with ` > ` as vitest does. */
  readonly name: string;
  readonly status: CaseStatus;
  /** Seconds, as reported; 0 when absent. */
  readonly time: number;
  /** For a failed case: the `<failure>`/`<error>` message and body. */
  readonly detail?: string;
}

export interface JunitSuite {
  readonly name: string;
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly skipped: number;
  readonly time: number;
  readonly cases: readonly JunitCase[];
}

export interface JunitReport {
  readonly name: string;
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly suites: readonly JunitSuite[];
}

/** One element of the parsed document. Text children are plain strings. */
export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | string;

export class JunitParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = 'JunitParseError';
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'",
};

/** Decode the entity references XML defines; unknown names are left untouched. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body] ?? whole;
  });
}

interface MutableElement {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly children: XmlNode[];
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_.:-]/.test(ch);
}

/**
 * Parse one XML document and return its root element. Supports what vitest emits and the
 * usual decorations around it; throws `JunitParseError` on anything unbalanced or unknown.
 */
export function parseXml(xml: string): XmlElement {
  const s = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const stack: MutableElement[] = [];
  let root: MutableElement | undefined;
  let i = 0;

  const fail = (message: string, at = i): never => { throw new JunitParseError(message, at); };
  const appendText = (text: string): void => {
    const top = stack[stack.length - 1];
    if (top) top.children.push(text);
    else if (text.trim() !== '') fail('text outside the root element');
  };
  const expectAt = (needle: string, from: number): number => {
    const end = s.indexOf(needle, from);
    return end < 0 ? fail(`unterminated construct, expected "${needle}"`, from) : end;
  };
  const readName = (): string => {
    const start = i;
    while (i < s.length && isNameChar(s.charAt(i))) i++;
    return i === start ? fail('expected a name') : s.slice(start, i);
  };
  const skipSpace = (): void => { while (i < s.length && /\s/.test(s.charAt(i))) i++; };

  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { appendText(decodeEntities(s.slice(i))); break; }
    if (lt > i) appendText(decodeEntities(s.slice(i, lt)));
    i = lt;

    if (s.startsWith('<?', i)) { i = expectAt('?>', i) + 2; continue; }
    if (s.startsWith('<!--', i)) { i = expectAt('-->', i + 4) + 3; continue; }
    if (s.startsWith('<![CDATA[', i)) {
      const end = expectAt(']]>', i + 9);
      appendText(s.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (s.startsWith('<!', i)) { i = expectAt('>', i) + 1; continue; }

    if (s.startsWith('</', i)) {
      i += 2;
      const name = readName();
      skipSpace();
      if (s.charAt(i) !== '>') fail('malformed closing tag');
      i++;
      const open = stack.pop();
      if (!open) fail(`closing </${name}> without an open element`);
      else if (open.name !== name) fail(`closing </${name}> but <${open.name}> is open`);
      continue;
    }

    // A start tag.
    const tagStart = i;
    i++;
    const element: MutableElement = { name: readName(), attrs: {}, children: [] };
    let selfClosing = false;
    for (;;) {
      skipSpace();
      if (i >= s.length) fail('unterminated start tag', tagStart);
      const ch = s.charAt(i);
      if (ch === '>') { i++; break; }
      if (ch === '/') {
        if (s.charAt(i + 1) !== '>') fail('malformed self-closing tag');
        i += 2;
        selfClosing = true;
        break;
      }
      const attrName = readName();
      skipSpace();
      if (s.charAt(i) !== '=') fail(`attribute "${attrName}" without a value`);
      i++;
      skipSpace();
      const quote = s.charAt(i);
      if (quote !== '"' && quote !== "'") fail(`attribute "${attrName}" value is not quoted`);
      const end = expectAt(quote, i + 1);
      element.attrs[attrName] = decodeEntities(s.slice(i + 1, end));
      i = end + 1;
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root) fail('more than one root element', tagStart);
    else root = element;
    if (!selfClosing) stack.push(element);
  }

  if (stack.length > 0) fail(`unclosed <${stack[stack.length - 1]!.name}>`, s.length);
  if (!root) throw new JunitParseError('empty document', 0);
  return root;
}

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

function toCase(el: XmlElement): JunitCase {
  const file = el.attrs['classname'] ?? el.attrs['file'] ?? '';
  const name = el.attrs['name'] ?? '';
  const time = num(el, 'time');
  const failed = [...elementChildren(el, 'failure'), ...elementChildren(el, 'error')];
  if (failed.length > 0) {
    const detail = failed
      .map((f) => [f.attrs['message'], textOf(f).trim()].filter((p) => p).join('\n'))
      .join('\n');
    return { file, name, status: 'fail', time, detail };
  }
  if (elementChildren(el, 'skipped').length > 0) return { file, name, status: 'skip', time };
  return { file, name, status: 'pass', time };
}

function toSuite(el: XmlElement): JunitSuite {
  const cases = elementChildren(el, 'testcase').map(toCase);
  return {
    name: el.attrs['name'] ?? '',
    tests: el.attrs['tests'] === undefined ? cases.length : num(el, 'tests'),
    failures: num(el, 'failures'),
    errors: num(el, 'errors'),
    skipped: num(el, 'skipped'),
    time: num(el, 'time'),
    cases,
  };
}

function collectSuites(el: XmlElement, into: JunitSuite[]): void {
  if (el.name === 'testsuite') into.push(toSuite(el));
  for (const child of el.children) {
    if (typeof child !== 'string' && (child.name === 'testsuite' || child.name === 'testsuites')) {
      collectSuites(child, into);
    }
  }
}

/** Parse a junit report. The root may be `<testsuites>` or a single `<testsuite>`. */
export function parseJunit(xml: string): JunitReport {
  const root = parseXml(xml);
  if (root.name !== 'testsuites' && root.name !== 'testsuite') {
    throw new JunitParseError(`root element is <${root.name}>, expected <testsuites>`, 0);
  }
  const suites: JunitSuite[] = [];
  collectSuites(root, suites);
  const sum = (pick: (s: JunitSuite) => number): number => suites.reduce((a, s) => a + pick(s), 0);
  return {
    name: root.attrs['name'] ?? '',
    tests: root.attrs['tests'] === undefined ? sum((s) => s.tests) : num(root, 'tests'),
    failures: root.attrs['failures'] === undefined ? sum((s) => s.failures) : num(root, 'failures'),
    errors: root.attrs['errors'] === undefined ? sum((s) => s.errors) : num(root, 'errors'),
    suites,
  };
}

/** Every case of the report, in document order. */
export function allCases(report: JunitReport): readonly JunitCase[] {
  return report.suites.flatMap((s) => s.cases);
}

/**
 * Identity of a case across reports: file and full name. vitest allows the same name
 * twice in one file (`it.each` rows, copy-pasted titles), so repeats within one report are
 * numbered in document order (`…#2`, `…#3`) and pair up positionally.
 */
export function caseKeys(cases: readonly JunitCase[]): ReadonlyMap<string, JunitCase> {
  const seen = new Map<string, number>();
  const keyed = new Map<string, JunitCase>();
  for (const c of cases) {
    const base = `${c.file}::${c.name}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keyed.set(n === 1 ? base : `${base}#${n}`, c);
  }
  return keyed;
}
