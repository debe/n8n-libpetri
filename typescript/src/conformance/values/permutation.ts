/**
 * Whether two lists hold the same values in another order: divergence #11's signature, a
 * node whose runs came out permuted rather than different.
 */

/**
 * The identity of a value for the permutation check: the value serialised, with the one
 * guard `render` has — a payload `JSON.stringify` rejects (a `BigInt`, a cycle) is `null`,
 * and a list holding one is never called a permutation, because the alternative was the
 * gate throwing on it.
 */
function permutationKey(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
  } catch {
    return null;
  }
}

/** The sorted {@link permutationKey}s of `list`, or `null` when one of them has none. */
function sortedKeys(list: readonly unknown[]): string[] | null {
  const keys: string[] = [];
  for (const value of list) {
    const key = permutationKey(value);
    if (key === null) return null;
    keys.push(key);
  }
  return keys.sort();
}

/** Whether two lists hold the same values in another order, by {@link permutationKey}. */
export function isPermutation(left: readonly unknown[], right: readonly unknown[]): boolean {
  const a = sortedKeys(left);
  const b = sortedKeys(right);
  return a !== null && b !== null && a.length === b.length && a.every((key, i) => key === b[i]);
}
