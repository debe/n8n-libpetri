/**
 * The value checks every layer-1 policy field is read through. Each records what it rejects on
 * the caller's problem list rather than throwing, so one parse reports every fault at once.
 */

/** A JSON object: not `null`, not an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A positive integer, or `undefined`. Anything else is a problem the caller records. The one
 * definition: `analysis/validate.ts` (`raising`) raises the same check at once, over this,
 * where it has no list to accumulate into, and refuses a missing or non-finite count first.
 */
export function positiveInt(v: unknown, what: string, problems: string[]): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    problems.push(`${what} must be a positive integer, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

/** A non-negative integer, or `undefined`. `waitMs: 0` is a legitimate "retry at once". */
export function nonNegativeInt(v: unknown, what: string, problems: string[]): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    problems.push(`${what} must be a non-negative integer, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}
