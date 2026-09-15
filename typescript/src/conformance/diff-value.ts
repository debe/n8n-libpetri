/**
 * Values, compared: the first difference between two JSON-shaped values, rendered for a
 * report, and whether two lists hold the same values in another order. The data gate
 * (`gate-data.ts`) is built on these. They know nothing about n8n or the net — only about
 * values — which is why this module imports nothing.
 */

/** One difference between the two `IRunData`s, addressed by a JSON-pointer-ish path. */
export interface DataDifference {
  readonly path: string;
  readonly n8n: string;
  readonly libpetri: string;
}

/**
 * An absent key, as opposed to a present one holding `undefined`: the two compare equal
 * ({@link firstDifference}) but render differently (`<missing>` against `undefined`).
 */
export const MISSING = Symbol('missing');

/** `[object Date]` → `Date`; the class of a value the plain-object walk cannot descend into. */
function classOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

function render(value: unknown): string {
  if (value === MISSING) return '<missing>';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (isExotic(value)) {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    // A Buffer stringifies as `{"type":"Buffer","data":[…]}`; a Map or a Set as `{}`, which
    // says nothing, so those are rendered by class and size instead.
    if (!ArrayBuffer.isView(value)) {
      const size = (value as { size?: number }).size;
      return `[${classOf(value)}${typeof size === 'number' ? ` size ${size}` : ''}]`;
    }
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 197)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * A `{}` literal (or a null-prototype object), the only shape the walk below descends into
 * key by key. `Object.keys` of anything else — a `Date`, a `Map`, a `Set`, an `Error`, a
 * class instance — is empty, so treating them as plain objects made *every pair of them
 * compare equal*: `new Date(1)` vs `new Date(2)` was `null` (no difference), and n8n node
 * output routinely carries dates (`$now`, the Date & Time node, a Code node).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** An object the key walk cannot handle: not a plain object and not an array. */
function isExotic(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isPlainObject(value);
}

/**
 * The first difference between two JSON-shaped values, depth first, or `null`. `undefined`
 * and an absent key are the same thing (n8n writes both).
 */
export function firstDifference(a: unknown, b: unknown, path: string): DataDifference | null {
  const left = a === MISSING ? undefined : a;
  const right = b === MISSING ? undefined : b;
  if (left === right) return null;
  if (typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)) return null;
  if (left === undefined || right === undefined || left === null || right === null) {
    return { path, n8n: render(a), libpetri: render(b) };
  }
  if (isExotic(left) || isExotic(right)) {
    const different = { path, n8n: render(a), libpetri: render(b) };
    if (classOf(left) !== classOf(right)) return different;
    // A `Date` is its instant; an `Error` is the `{ name, message }` the gate compares
    // everywhere else; a `Buffer` (or any other view) is its bytes, which `JSON.stringify`
    // renders faithfully, so it goes through the key walk below. Anything else — a `Map`, a
    // `Set`, a class instance — has no comparable structure here and is different unless it
    // is literally the same object.
    if (left instanceof Date && right instanceof Date) {
      return left.getTime() === right.getTime() ? null : different;
    }
    if (left instanceof Error && right instanceof Error) {
      return firstDifference({ name: left.name, message: left.message }, { name: right.name, message: right.message }, path);
    }
    if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
      return firstDifference([...(left as Uint8Array)], [...(right as Uint8Array)], path);
    }
    return different;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return { path, n8n: render(a), libpetri: render(b) };
    if (left.length !== right.length) {
      return { path: `${path}.length`, n8n: String(left.length), libpetri: String(right.length) };
    }
    for (let i = 0; i < left.length; i++) {
      const d = firstDifference(left[i], right[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const d = firstDifference(
        Object.hasOwn(left, key) ? left[key] : MISSING,
        Object.hasOwn(right, key) ? right[key] : MISSING,
        `${path}.${key}`,
      );
      if (d !== null) return d;
    }
    return null;
  }
  // Two primitives (or a primitive against a container) that are not `===`.
  return { path, n8n: render(a), libpetri: render(b) };
}

/**
 * The identity of a value for the permutation check: the value serialised, with the one
 * guard {@link render} has — a payload `JSON.stringify` rejects (a `BigInt`, a cycle) is
 * `null`, and a list holding one is never called a permutation, because the alternative was
 * the gate throwing on it.
 */
function permutationKey(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
  } catch {
    return null;
  }
}

/** Whether two lists hold the same values in another order, by {@link permutationKey}. */
export function isPermutation(left: readonly unknown[], right: readonly unknown[]): boolean {
  const keysOf = (list: readonly unknown[]): string[] | null => {
    const keys: string[] = [];
    for (const value of list) {
      const key = permutationKey(value);
      if (key === null) return null;
      keys.push(key);
    }
    return keys.sort();
  };
  const a = keysOf(left);
  const b = keysOf(right);
  return a !== null && b !== null && a.length === b.length && a.every((key, i) => key === b[i]);
}
