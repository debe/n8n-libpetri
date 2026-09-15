/**
 * An absent key, told apart from a present one holding `undefined`: every key-by-key
 * comparison of the data gate reads a record through {@link ownValue}.
 */

/**
 * An absent key, as opposed to a present one holding `undefined`: the two compare equal
 * (`firstDifference`) but render differently (`<missing>` against `undefined`).
 */
export const MISSING = Symbol('missing');

/** `record[key]` when the key is the record's own, {@link MISSING} otherwise. */
export function ownValue(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : MISSING;
}
