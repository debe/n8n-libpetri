/**
 * What a value is, as the comparison walks it — a plain object it descends into key by key,
 * or an exotic one it cannot — and how a value is rendered for the report.
 */
import { MISSING } from './missing.js';

/** `[object Date]` → `Date`; the class of a value the plain-object walk cannot descend into. */
export function classOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/**
 * A `{}` literal (or a null-prototype object), the only shape the walk descends into key by
 * key. `Object.keys` of anything else — a `Date`, a `Map`, a `Set`, an `Error`, a class
 * instance — is empty, so treating them as plain objects made *every pair of them compare
 * equal*: `new Date(1)` vs `new Date(2)` was `null` (no difference), and n8n node output
 * routinely carries dates (`$now`, the Date & Time node, a Code node).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** An object the key walk cannot handle: not a plain object and not an array. */
export function isExotic(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isPlainObject(value);
}

/**
 * An exotic value JSON renders badly: a `Date` as its instant, an `Error` as its name and
 * message; a Map or a Set stringifies as `{}`, which says nothing, so those (and any other
 * class instance) are rendered by class and size instead. A Buffer (or any other view)
 * stringifies faithfully as `{"type":"Buffer","data":[…]}` and is left to JSON: `undefined`.
 */
function renderExotic(value: object): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (ArrayBuffer.isView(value)) return undefined;
  const size = (value as { size?: number }).size;
  return `[${classOf(value)}${typeof size === 'number' ? ` size ${size}` : ''}]`;
}

/** JSON, cut at 200 characters; `String(value)` for what JSON rejects or cannot express. */
function renderJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 197)}…` : text;
  } catch {
    return String(value);
  }
}

/** A value as the report shows it. */
export function render(value: unknown): string {
  if (value === MISSING) return '<missing>';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return (isExotic(value) ? renderExotic(value as object) : undefined) ?? renderJson(value);
}
