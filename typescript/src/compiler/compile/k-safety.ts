/** The k-safety check that decides whether the requested concurrency budget survives. */
import type { BudgetRestriction, WorkflowAnalysis } from '../types.js';

/**
 * README "Concurrency budget and its safety condition": positional pairing is sound above
 * k = 1 only if every node fires at most once per execution, so the budget is forced to 1
 * for a cyclic workflow or one where an input index has more than one producer.
 */
export function kSafety(analysis: WorkflowAnalysis): BudgetRestriction | null {
  // Engine v2 has no concurrency budget to restrict (`compile/options.ts` refuses one, and the
  // settlement gadget has no `_budget`): a batch loop is a cycle, but nothing is forced to 1.
  if (analysis.profile === 'engineV2') return null;
  if (analysis.hasCycle) {
    return {
      reason: 'cyclic',
      detail: `nodes in a cycle: ${[...analysis.cyclic].sort().join(', ')}`,
    };
  }
  if (analysis.multiProducerInputs.length > 0) {
    const detail = analysis.multiProducerInputs
      .map((m) => `${m.node}.${m.inputIndex} has ${m.producers} producers`)
      .join('; ');
    return { reason: 'multi-producer-input', detail };
  }
  return null;
}
