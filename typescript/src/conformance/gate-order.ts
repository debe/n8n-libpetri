/**
 * The differ's second and third comparisons. **Happens-before**, a gate: every data
 * dependency the run realised is respected inside each engine, and every one n8n ordered is
 * ordered the same way under the net — the net's partial order is a *weakening* of n8n's
 * total order, never a reordering of it. The **ordering report**, not a gate: the
 * `executionIndex` sequences side by side, every move attributed by the register's rules
 * (`attribution.ts`).
 *
 * The module is both comparisons' one import path; each part lives under `gates/`:
 * `happens-before.ts`, `ordering.ts` (with the rank arithmetic in `ranks.ts` and the
 * attribution context in `ordering-context.ts`) and `reach.ts`, the reachability closure
 * the concurrency rule reads.
 */
export {
  checkHappensBefore, type HappensBefore, type HappensBeforeViolation,
} from './gates/happens-before.js';
export {
  compareOrdering, type LastNodeExecuted, type OrderDifference, type OrderingReport,
} from './gates/ordering.js';
export { executionOrder } from './gates/ranks.js';
export { reachableOf } from './gates/reach.js';
