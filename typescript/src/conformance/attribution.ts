/**
 * The divergence register, as rules. Every difference the differ finds is attributed: to a
 * `docs/divergences.md` row, to the concurrency the budget bought (an ordering move only —
 * concurrency never excuses a data difference), or to nothing, which is `unattributed` and a
 * finding. One vocabulary serves both gates, so a data difference and an ordering move that
 * the same row explains carry the same row and the same mechanism name.
 *
 * Three rule sets, one per thing that can differ: {@link attributeDataDifference} (the data
 * gate), {@link attribute} (a reordered or one-sided activation) and
 * {@link attributeLastNodeExecuted} (`resultData.lastNodeExecuted`). What they read off the
 * workflow's static shape is computed once per fixture ({@link fixtureStatics}).
 *
 * The module is the register's one import path; each part lives under `attribution/`:
 *
 * - `vocabulary.ts` — what an attribution can say;
 * - `halt-window.ts` — `inHaltWindow`, the one test every row-#17 rule asks, so tightening
 *   the coarse rule (`tasks/todo.md`) is one change;
 * - `statics.ts` — what the rules read off the workflow's shape and the net's diagnostics;
 * - `data-rules.ts`, `order.ts` with `one-sided.ts`, and `last-node.ts` — the three rule sets.
 */
export type { Attribution, DataAttribution } from './attribution/vocabulary.js';
export { isStoppedOutcome } from './attribution/halt-window.js';
export {
  descendantsOf, fixtureStatics, orInputNodesOf, strandedNodesOf, type FixtureStatics,
} from './attribution/statics.js';
export { attributeDataDifference, type DataAttributionFacts } from './attribution/data-rules.js';
export type { AttributionContext } from './attribution/context.js';
export { attribute } from './attribution/order.js';
export { attributeLastNodeExecuted } from './attribution/last-node.js';
