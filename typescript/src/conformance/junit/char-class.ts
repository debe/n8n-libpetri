/**
 * The two character classes the junit tokenizer tests, by char code: it asks one of them once
 * per character, so neither goes through a RegExp.
 */

/** `[A-Za-z0-9_.:-]`, by char code: the tokenizer asks this once per character. */
export function isNameCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)       // 0-9
    || (code >= 0x41 && code <= 0x5a)         // A-Z
    || (code >= 0x61 && code <= 0x7a)         // a-z
    || code === 0x5f || code === 0x2e || code === 0x3a || code === 0x2d; // _ . : -
}

/** `\s` of a JavaScript RegExp, by char code, so the tokenizer skips exactly what it did. */
export function isSpaceCode(code: number): boolean {
  return code === 0x20
    || (code >= 0x09 && code <= 0x0d)         // \t \n \v \f \r
    || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f
    || code === 0x3000 || code === 0xfeff;
}
