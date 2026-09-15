/**
 * How many state classes the enumeration may build: the caller's cap, and the heap-derived
 * ceiling that bounds its **memory** (`state-class.ts`, "Truncation is the honest limit").
 */
import { getHeapStatistics } from 'node:v8';

/**
 * Class cap for {@link StateSpace.explore}. The graph must never run unbounded: a workflow
 * with a cycle has an unbounded state space, and one with heavy independent parallelism has
 * a combinatorial one (NU-053: the graph has no partial-order reduction), so the cap is what
 * turns "hangs" into "reports truncation".
 *
 * 200 000 comes from the measurement in `docs/verification.md`: every acyclic fixture
 * without independent parallelism closes three orders of magnitude below it (1967 classes
 * for a 41-node chain, 5894 for an 8-wide fan-out), and the two shapes that do truncate cost
 * 4.1 s (a loop) and 36 s (a 20-way switch) to reach it — the same order as the 60 s the SMT
 * route spends per *query*, and paid once for the whole report rather than once per place.
 */
export const DEFAULT_MAX_CLASSES = 200_000;

/**
 * The worst **per class** cost measured, in bytes of peak RSS: `switch20` reaches its
 * 200 003 classes at 2.48 GB. The other two shapes measured are cheaper per class rather
 * than proportional to the net — `loopOverItems` (42 places) costs 4.4 kB a class and the
 * 49-node generated workflow (526 flat places) 12.1 kB — so the class count, not the net size, is
 * what bounds the enumeration's memory. `docs/verification.md` has the table.
 */
const BYTES_PER_CLASS = 12_500;

/** How much of the V8 heap limit the enumeration may plan to spend. */
const HEAP_SHARE = 0.75;

/**
 * The cap the enumeration actually runs with: the caller's, lowered to what the heap can
 * hold.
 *
 * A class cap bounds the class count; only this bounds the **memory**, and the difference
 * matters because a V8 heap exhaustion aborts the process — it is not an exception
 * {@link StateSpace.explore} could catch and turn into a truncation. At this machine's
 * default 4.4 GB heap limit nothing is lowered (0.75 x 4.4 GB / 12.5 kB = 264 000 > the
 * 200 000 default); under a container's 1 GB it becomes ~70 000, and a truncation is
 * reported instead of an abort.
 *
 * `requested <= 0` is passed through untouched: that is "turn the route off", not a cap.
 */
export function effectiveMaxClasses(
  requested: number, heapLimitBytes: number = getHeapStatistics().heap_size_limit,
): number {
  if (requested <= 0) return requested;
  const affordable = Math.floor((heapLimitBytes * HEAP_SHARE) / BYTES_PER_CLASS);
  return Math.max(1, Math.min(requested, affordable));
}
