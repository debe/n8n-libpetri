/**
 * The junit tokenizer's element stack: where text and elements land as the scanner reads
 * them, and the balance checks — one root, every close matching its open, nothing left open.
 */
import type { XmlScanner } from './scanner.js';
import { JunitParseError, type XmlElement, type XmlNode } from './xml-model.js';

export interface MutableElement {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly children: XmlNode[];
}

export class XmlTreeBuilder {
  private readonly stack: MutableElement[] = [];
  private root: MutableElement | undefined;

  constructor(private readonly scan: XmlScanner) {}

  /** Append text to the open element; only whitespace may sit outside the root. */
  text(text: string): void {
    const top = this.stack.at(-1);
    if (top) top.children.push(text);
    else if (text.trim() !== '') this.scan.fail('text outside the root element');
  }

  /** Attach a start tag read at `tagStart`, and keep it open unless it closed itself. */
  open(element: MutableElement, selfClosing: boolean, tagStart: number): void {
    const parent = this.stack.at(-1);
    if (parent) parent.children.push(element);
    else if (this.root) this.scan.fail('more than one root element', tagStart);
    else this.root = element;
    if (!selfClosing) this.stack.push(element);
  }

  close(name: string): void {
    const open = this.stack.pop();
    if (!open) this.scan.fail(`closing </${name}> without an open element`);
    else if (open.name !== name) this.scan.fail(`closing </${name}> but <${open.name}> is open`);
  }

  /** The root, once the whole document is read and every element closed. */
  finish(): XmlElement {
    const unclosed = this.stack.at(-1);
    if (unclosed) this.scan.fail(`unclosed <${unclosed.name}>`, this.scan.text.length);
    if (!this.root) throw new JunitParseError('empty document', 0);
    return this.root;
  }
}
