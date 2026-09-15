/**
 * How a case is paired across two reports. One function, so the pairing rule is one change:
 * `tasks/todo.md` queues the move from positional to status-multiset pairing here.
 */
import type { JunitCase } from './model.js';

/**
 * Identity of a case across reports: file and full name. vitest allows the same name
 * twice in one file (`it.each` rows, copy-pasted titles), so repeats within one report are
 * numbered in document order (`…#2`, `…#3`) and pair up positionally.
 */
export function caseKeys(cases: readonly JunitCase[]): ReadonlyMap<string, JunitCase> {
  const seen = new Map<string, number>();
  const keyed = new Map<string, JunitCase>();
  for (const c of cases) {
    const base = `${c.file}::${c.name}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keyed.set(n === 1 ? base : `${base}#${n}`, c);
  }
  return keyed;
}
