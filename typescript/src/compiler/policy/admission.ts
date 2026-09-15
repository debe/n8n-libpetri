/**
 * The admission fields of a layer-1 policy, `concurrency` and `rate`, each optionally shared
 * with a named group. Problems accumulate on the caller's list.
 */
import type { ExecutionPolicy } from '../policy.js';
import { isRecord, positiveInt } from './values.js';

function parseGroupRef(
  raw: Record<string, unknown>, at: string, problems: string[],
): string | undefined {
  const group = raw['group'];
  if (group === undefined) return undefined;
  if (typeof group !== 'string' || group === '') {
    problems.push(`${at}.group must be a non-empty string`);
    return undefined;
  }
  return group;
}

/** `raw.concurrency`: a required `limit`, and an optional `group`. */
export function parseConcurrency(
  raw: unknown, where: string, problems: string[],
): ExecutionPolicy['concurrency'] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    problems.push(`${where}.concurrency must be an object`);
    return undefined;
  }
  const limit = positiveInt(raw['limit'], `${where}.concurrency.limit`, problems);
  const group = parseGroupRef(raw, `${where}.concurrency`, problems);
  if (limit === undefined) {
    problems.push(`${where}.concurrency.limit is required`);
    return undefined;
  }
  return { ...(group === undefined ? {} : { group }), limit };
}

/** `raw.rate`: both `perMs` and `burst`, and an optional `group`. */
export function parseRate(raw: unknown, where: string, problems: string[]): ExecutionPolicy['rate'] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    problems.push(`${where}.rate must be an object`);
    return undefined;
  }
  const perMs = positiveInt(raw['perMs'], `${where}.rate.perMs`, problems);
  const burst = positiveInt(raw['burst'], `${where}.rate.burst`, problems);
  const group = parseGroupRef(raw, `${where}.rate`, problems);
  if (perMs === undefined || burst === undefined) {
    problems.push(`${where}.rate requires both perMs and burst`);
    return undefined;
  }
  return { ...(group === undefined ? {} : { group }), perMs, burst };
}
