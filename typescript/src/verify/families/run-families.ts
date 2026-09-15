/**
 * Every property family, in the order a report runs them (`verify.ts`, "The six property
 * families and what each one can and cannot say").
 */
import type { Context } from '../route.js';
import type { PropertyName, VerifyOptions } from '../types.js';
import { runBudget } from './budget.js';
import { runDeadNodes } from './dead-nodes.js';
import { runMutualExclusion } from './mutual-exclusion.js';
import { runNoDoubleActivation } from './no-double-activation.js';
import { runProperCompletion } from './proper-completion.js';
import { runRetryBound } from './retry-bound.js';

/** One property family's runner, given the report's context and the caller's options. */
type FamilyRunner = (ctx: Context, options: VerifyOptions) => Promise<void>;

/** Cheapest first, so a streamed run says something useful before the expensive family. */
const FAMILY_ORDER: readonly (readonly [PropertyName, FamilyRunner])[] = [
  ['budget', runBudget],
  ['no-double-activation', runNoDoubleActivation],
  ['retry-bound', runRetryBound],
  ['mutual-exclusion', (ctx, options) => runMutualExclusion(ctx, options.mutualExclusion ?? 'all-pairs')],
  ['dead-nodes', runDeadNodes],
  ['proper-completion', runProperCompletion],
];

/** Runs each selected family, one after another, recording into `ctx`. */
export async function runFamilies(
  ctx: Context, properties: readonly PropertyName[], options: VerifyOptions,
): Promise<void> {
  for (const [property, run] of FAMILY_ORDER) {
    if (properties.includes(property)) await run(ctx, options);
  }
}
