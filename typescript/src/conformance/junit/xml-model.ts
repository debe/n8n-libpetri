/**
 * The tree the XML tokenizer (`xml.ts`) produces, and the one error it throws: elements with
 * attributes and children, text children as plain strings.
 */

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
