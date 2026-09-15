/**
 * The verify command line's value flags, each word checked: a bad one throws {@link UsageError}
 * naming the flag, so the first bad word on the line is the one reported.
 */
import { UsageError } from '../../cli/flags.js';
import { PROPERTY_NAMES } from '../types.js';
import type { PropertyName, SmtFallbackMode } from '../types.js';

/** `--budget k`: a positive integer. */
export function budgetOf(v: string): number {
  const budget = Number(v);
  if (!Number.isInteger(budget) || budget < 1) throw new UsageError('--budget must be a positive integer');
  return budget;
}

/** `--timeout MS`: a positive number of milliseconds. */
export function timeoutOf(v: string): number {
  const timeoutMs = Number(v);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new UsageError('--timeout must be a positive number of ms');
  return timeoutMs;
}

/** `--property NAME`: one of {@link PROPERTY_NAMES}. */
export function propertyOf(name: string): PropertyName {
  if (!PROPERTY_NAMES.includes(name as PropertyName)) {
    throw new UsageError(`unknown property '${name}'; one of ${PROPERTY_NAMES.join(', ')}`);
  }
  return name as PropertyName;
}

/** `--max-classes N`: a non-negative integer, 0 turning the solver-free route off. */
export function maxClassesOf(v: string): number {
  const maxClasses = Number(v);
  if (!Number.isInteger(maxClasses) || maxClasses < 0) {
    throw new UsageError('--max-classes must be a non-negative integer (0 turns the solver-free route off)');
  }
  return maxClasses;
}

/** `--smt-fallback MODE`: `auto`, `off` or `force`. */
export function smtFallbackOf(mode: string): SmtFallbackMode {
  if (mode !== 'auto' && mode !== 'off' && mode !== 'force') {
    throw new UsageError("--smt-fallback must be one of auto, off, force");
  }
  return mode;
}

/** `--mutex A,B`: two comma-separated node names. */
export function mutexPairOf(v: string): readonly [string, string] {
  const parts = v.split(',').map((s) => s.trim());
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new UsageError('--mutex takes two comma-separated node names');
  }
  return [parts[0]!, parts[1]!] as const;
}
