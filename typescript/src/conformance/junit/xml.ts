/**
 * The junit tokenizer: exactly the XML subset vitest's reporter writes — the declaration,
 * comments, CDATA sections, entity references, quoted attributes, self-closing tags — and a
 * {@link JunitParseError} on anything unbalanced or unknown.
 */
import { decodeEntities } from './entities.js';
import { XmlScanner } from './scanner.js';
import { XmlTreeBuilder, type MutableElement } from './tree-builder.js';
import type { XmlElement } from './xml-model.js';

/**
 * Markup the tree does not keep, as `[opener, closer, where the closer search starts]`:
 * processing instructions, comments and any other `<!…>` declaration (a DOCTYPE). Checked in
 * order, so a comment is matched before the generic declaration.
 */
const SKIPPED_MARKUP: readonly (readonly [opener: string, closer: string, searchFrom: number])[] = [
  ['<?', '?>', 0],
  ['<!--', '-->', 4],
  ['<!', '>', 0],
];

const CDATA_OPEN = '<![CDATA[';

function readCdata(scan: XmlScanner, tree: XmlTreeBuilder): void {
  const end = scan.expectAt(']]>', scan.pos + CDATA_OPEN.length);
  tree.text(scan.text.slice(scan.pos + CDATA_OPEN.length, end));
  scan.pos = end + 3;
}

function readClosingTag(scan: XmlScanner, tree: XmlTreeBuilder): void {
  scan.pos += 2;
  const name = scan.readName();
  scan.skipSpace();
  scan.expectChar('>', 'malformed closing tag');
  tree.close(name);
}

/** One `name="value"` pair of a start tag. */
function readAttribute(scan: XmlScanner, attrs: Record<string, string>): void {
  const name = scan.readName();
  scan.skipSpace();
  scan.expectChar('=', `attribute "${name}" without a value`);
  scan.skipSpace();
  const quote = scan.char();
  if (quote !== '"' && quote !== "'") scan.fail(`attribute "${name}" value is not quoted`);
  const end = scan.expectAt(quote, scan.pos + 1);
  attrs[name] = decodeEntities(scan.text.slice(scan.pos + 1, end));
  scan.pos = end + 1;
}

/** The attributes up to the end of a start tag; whether the tag closed itself. */
function readAttributes(scan: XmlScanner, attrs: Record<string, string>, tagStart: number): boolean {
  for (;;) {
    scan.skipSpace();
    if (scan.done) scan.fail('unterminated start tag', tagStart);
    if (scan.char() === '>') {
      scan.pos++;
      return false;
    }
    if (scan.char() === '/') {
      if (scan.char(1) !== '>') scan.fail('malformed self-closing tag');
      scan.pos += 2;
      return true;
    }
    readAttribute(scan, attrs);
  }
}

function readStartTag(scan: XmlScanner, tree: XmlTreeBuilder): void {
  const tagStart = scan.pos;
  scan.pos++;
  const element: MutableElement = { name: scan.readName(), attrs: {}, children: [] };
  const selfClosing = readAttributes(scan, element.attrs, tagStart);
  tree.open(element, selfClosing, tagStart);
}

/** One construct starting at a `<`. */
function readMarkup(scan: XmlScanner, tree: XmlTreeBuilder): void {
  if (scan.at(CDATA_OPEN)) return readCdata(scan, tree);
  const skipped = SKIPPED_MARKUP.find(([opener]) => scan.at(opener));
  if (skipped !== undefined) return scan.skipPast(skipped[1], scan.pos + skipped[2]);
  if (scan.at('</')) return readClosingTag(scan, tree);
  return readStartTag(scan, tree);
}

/**
 * Parse one XML document and return its root element. Supports what vitest emits and the
 * usual decorations around it; throws `JunitParseError` on anything unbalanced or unknown.
 */
export function parseXml(xml: string): XmlElement {
  const scan = new XmlScanner(xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml);
  const tree = new XmlTreeBuilder(scan);
  while (!scan.done) {
    const lt = scan.text.indexOf('<', scan.pos);
    if (lt < 0) {
      tree.text(decodeEntities(scan.text.slice(scan.pos)));
      break;
    }
    if (lt > scan.pos) tree.text(decodeEntities(scan.text.slice(scan.pos, lt)));
    scan.pos = lt;
    readMarkup(scan, tree);
  }
  return tree.finish();
}
