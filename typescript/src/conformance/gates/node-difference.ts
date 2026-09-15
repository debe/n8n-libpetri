/**
 * A raw data difference before attribution: the difference and the node it is about. Every
 * part of the data gate — `runData`, the resumable state, the contract values — produces
 * these, and `compareData` attributes them.
 */
import type { DataDifference } from '../diff-value.js';

/** One raw difference plus the node it is about (`''` when it is about neither). */
export interface NodeDifference {
  readonly d: DataDifference;
  readonly node: string;
}

/** `d` about `node` as a list: empty when there is no difference. */
export function differenceAt(d: DataDifference | null, node: string): NodeDifference[] {
  return d === null ? [] : [{ d, node }];
}
