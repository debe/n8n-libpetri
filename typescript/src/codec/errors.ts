/**
 * The codec's one error class. What is a {@link CodecError} and what is a diagnostic is the
 * convention stated in `src/codec.ts`: a structural impossibility — the compiled net and the
 * data disagree — throws one, naming node and place; a foreign token shape is reported through
 * `onDiagnostic`, naming node and place, and the token is skipped.
 */

/** A marking the codec cannot encode or n8n state it cannot decode; the message names node and place. */
export class CodecError extends Error {
  constructor(what: string) {
    super(`n8n-libpetri codec: ${what}`);
    this.name = 'CodecError';
  }
}
