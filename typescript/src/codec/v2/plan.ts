/**
 * The stateless planner (`tasks/v2-profile-plan.md` decision 13, ADR 0012 §2): what engine v2's
 * `StepSettledHandler` would plan next, answered from a marking of the `engineV2` net rather than
 * from n8n's `decideSuccessors` (`packages/@n8n/engine/src/execution/settlement.ts`).
 *
 * The answer is the set of enabled starts and skips, nothing else:
 * - an enabled `X_start` (on a batch node `B_start_entry` or `B_start_back`) is a step to queue;
 * - an enabled `X_skip` (`B_skip_entry`, `B_skip_back`) is a step to record as skipped.
 *
 * Each is keyed `(node, rowCount(node))`: the next row of the node, which is iteration 0 outside a
 * loop, the pass for a loop member and the next pass for a batch node (decision 6). The row counts
 * come from the decoder ({@link decodeStepRows}), because a folded loop's marking does not hold
 * them.
 *
 * After a failure there is no special case: `_halt` inhibits every start and skip, so the answer
 * is empty, as `StepSettledHandler` plans nothing once a row has failed.
 *
 * Enabledness is judged by hand from the arcs (`net.ts`), not by running an executor; the tests
 * check it against libpetri's `StateClassGraph` on every marking they decode. Both answers are in
 * the net's declaration order, so a comparison with `decideSuccessors`' edge order is a comparison
 * of sets.
 */
import type { Place, Token, Transition } from 'libpetri';
import { assertProfile } from '../../compiler/index.js';
import type { CompiledWorkflow, SettlementGadget } from '../../compiler/index.js';
import { isEnabled, TokenCounts } from './net.js';
import type { StepKey, StepMarking } from './step-rows.js';

/** `SuccessorDecisions` (`settlement.ts`): steps to queue and steps to record as skipped. */
export interface StepPlan {
  readonly toQueue: StepKey[];
  readonly toSkip: StepKey[];
}

/** Every transition of the net enabled at `marking`, in declaration order (see `net.ts`). */
export function enabledTransitions(
  compiled: CompiledWorkflow,
  marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>,
): Transition[] {
  assertProfile('enabledTransitions', 'engineV2', compiled.netMap.profile);
  const counts = TokenCounts.of(marking);
  return [...compiled.net.transitions].filter((t) => isEnabled(t, counts));
}

/** A node's planning transitions: its starts, and its skips (none on the trigger). */
function planners(g: SettlementGadget): { starts: string[]; skips: string[] } {
  const starts = [g.transitions.start];
  const skips = g.transitions.skip === null ? [] : [g.transitions.skip];
  if (g.batch !== null) {
    starts.push(g.batch.transitions.startBack);
    skips.push(g.batch.transitions.skipBack);
  }
  return { starts, skips };
}

/**
 * The steps the rows behind `decoded` leave to plan: the enabled starts to queue and the enabled
 * skips to record, keyed `(node id, rowCount(node))`. Throws `ProfileMismatchError` for a v1 net.
 */
export function planFromMarking(compiled: CompiledWorkflow, decoded: StepMarking): StepPlan {
  assertProfile('planFromMarking', 'engineV2', compiled.netMap.profile);
  const enabled = new Set(enabledTransitions(compiled, decoded.marking).map((t) => t.name));
  const toQueue: StepKey[] = [];
  const toSkip: StepKey[] = [];
  for (const g of compiled.netMap.settlements) {
    const key: StepKey = { nodeId: g.id, iteration: decoded.rowCounts.get(g.id) ?? 0 };
    const { starts, skips } = planners(g);
    for (const t of starts) if (enabled.has(t)) toQueue.push(key);
    for (const t of skips) if (enabled.has(t)) toSkip.push(key);
  }
  return { toQueue, toSkip };
}
