/**
 * Values, compared: the first difference between two JSON-shaped values, rendered for a
 * report, and whether two lists hold the same values in another order. The data gate
 * (`gate-data.ts`) is built on these. They know nothing about n8n or the net — only about
 * values — which is why this module and `values/` import nothing else: `values/render.ts`
 * says what a value is and how it renders, `values/permutation.ts` holds the permutation
 * check.
 */
import { MISSING, ownValue } from './values/missing.js';
import { classOf, isExotic, isPlainObject, render } from './values/render.js';

export { MISSING } from './values/missing.js';
export { isPermutation } from './values/permutation.js';

/** One difference between the two `IRunData`s, addressed by a JSON-pointer-ish path. */
export interface DataDifference {
  readonly path: string;
  readonly n8n: string;
  readonly libpetri: string;
}

/** `a` and `b` as the difference at `path`, each rendered for the report. */
function mismatch(a: unknown, b: unknown, path: string): DataDifference {
  return { path, n8n: render(a), libpetri: render(b) };
}

/** Equal without a walk: the same value, or `NaN` on both sides. */
function identical(left: unknown, right: unknown): boolean {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

/**
 * An `Error` pair as the `{ name, message }` the gate compares everywhere else, and a
 * `Buffer` (or any other view) pair as its bytes, which the walk renders faithfully; `null`
 * for anything else.
 */
function walkableForms(left: unknown, right: unknown): readonly [unknown, unknown] | null {
  if (left instanceof Error && right instanceof Error) {
    return [{ name: left.name, message: left.message }, { name: right.name, message: right.message }];
  }
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    return [[...(left as Uint8Array)], [...(right as Uint8Array)]];
  }
  return null;
}

/**
 * Two values at least one of which the key walk cannot handle. A `Date` is its instant; an
 * `Error` and a view go through the walk in their {@link walkableForms}. Anything else — a
 * `Map`, a `Set`, a class instance — has no comparable structure here and is different
 * unless it is literally the same object.
 */
function exoticDifference(a: unknown, b: unknown, left: unknown, right: unknown, path: string): DataDifference | null {
  if (classOf(left) !== classOf(right)) return mismatch(a, b, path);
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime() ? null : mismatch(a, b, path);
  }
  const forms = walkableForms(left, right);
  return forms === null ? mismatch(a, b, path) : firstDifference(forms[0], forms[1], path);
}

/** Two values at least one of which is an array: element by element when both are. */
function arrayDifference(a: unknown, b: unknown, left: unknown, right: unknown, path: string): DataDifference | null {
  if (!Array.isArray(left) || !Array.isArray(right)) return mismatch(a, b, path);
  if (left.length !== right.length) {
    return { path: `${path}.length`, n8n: String(left.length), libpetri: String(right.length) };
  }
  for (let i = 0; i < left.length; i++) {
    const d = firstDifference(left[i], right[i], `${path}[${i}]`);
    if (d !== null) return d;
  }
  return null;
}

/** Two plain objects, key by key in sorted order; an absent key is {@link MISSING}. */
function keyDifference(left: Record<string, unknown>, right: Record<string, unknown>, path: string): DataDifference | null {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    const d = firstDifference(ownValue(left, key), ownValue(right, key), `${path}.${key}`);
    if (d !== null) return d;
  }
  return null;
}

/**
 * The first difference between two JSON-shaped values, depth first, or `null`. `undefined`
 * and an absent key are the same thing (n8n writes both).
 */
export function firstDifference(a: unknown, b: unknown, path: string): DataDifference | null {
  const left = a === MISSING ? undefined : a;
  const right = b === MISSING ? undefined : b;
  if (identical(left, right)) return null;
  if (left === undefined || right === undefined || left === null || right === null) return mismatch(a, b, path);
  if (isExotic(left) || isExotic(right)) return exoticDifference(a, b, left, right, path);
  if (Array.isArray(left) || Array.isArray(right)) return arrayDifference(a, b, left, right, path);
  if (isPlainObject(left) && isPlainObject(right)) return keyDifference(left, right, path);
  // Two primitives (or a primitive against a container) that are not `===`.
  return mismatch(a, b, path);
}
