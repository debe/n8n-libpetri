/**
 * The junit tokenizer's cursor: one document, one position, and the reads every construct is
 * built from. Every failure is a {@link JunitParseError} carrying the offset it happened at.
 */
import { isNameCode, isSpaceCode } from './char-class.js';
import { JunitParseError } from './xml-model.js';

export class XmlScanner {
  /** The offset of the next character to read. */
  pos = 0;

  constructor(readonly text: string) {}

  get done(): boolean {
    return this.pos >= this.text.length;
  }

  fail(message: string, at = this.pos): never {
    throw new JunitParseError(message, at);
  }

  /** Whether the document continues with `prefix` at the current position. */
  at(prefix: string): boolean {
    return this.text.startsWith(prefix, this.pos);
  }

  /** The character `offset` places past the current position; `''` past the end. */
  char(offset = 0): string {
    return this.text.charAt(this.pos + offset);
  }

  /** Where `needle` next occurs at or after `from`; a construct it never closes is malformed. */
  expectAt(needle: string, from: number): number {
    const end = this.text.indexOf(needle, from);
    return end < 0 ? this.fail(`unterminated construct, expected "${needle}"`, from) : end;
  }

  /** Move past the next `needle` at or after `from`. */
  skipPast(needle: string, from: number): void {
    this.pos = this.expectAt(needle, from) + needle.length;
  }

  /** Consume `ch`, or fail with `message` when something else is there. */
  expectChar(ch: string, message: string): void {
    if (this.char() !== ch) this.fail(message);
    this.pos++;
  }

  readName(): string {
    const start = this.pos;
    while (this.pos < this.text.length && isNameCode(this.text.charCodeAt(this.pos))) this.pos++;
    return this.pos === start ? this.fail('expected a name') : this.text.slice(start, this.pos);
  }

  skipSpace(): void {
    while (this.pos < this.text.length && isSpaceCode(this.text.charCodeAt(this.pos))) this.pos++;
  }
}
