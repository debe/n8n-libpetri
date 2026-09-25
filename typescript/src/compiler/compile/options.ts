/**
 * `compile()`'s options, checked before anything is built: the profile, the requested budget,
 * and the analysis it builds on together with the refusals that keep a passed analysis honest.
 */
import { CompileError } from '../errors.js';
import { analyse } from '../graph.js';
import { profileOf } from '../analysis/validate.js';
import type { CompileOptions, WorkflowAnalysis, WorkflowDescription } from '../types.js';

/**
 * The requested concurrency budget `k`: `options.budget`, default 1, refused unless a positive
 * integer. Under the `engineV2` profile any budget is refused: v2's plan has no per-execution
 * concurrency bound (`StepSettledHandler.planSuccessors` in
 * `packages/@n8n/engine/src/execution/step-settled-handler.ts` queues every decidable successor
 * with a live edge; how many run at once is the step queue's concern), so the net has no
 * `_budget` for `k` to seed, and a `k` that was accepted and meant nothing would read as a bound.
 */
export function requestedBudgetOf(options: CompileOptions): number {
  if (profileOf(options.profile, 'compile') === 'engineV2') {
    if (options.budget !== undefined) {
      throw new CompileError('invalid-options',
        'compile: budget is the v1 concurrency budget; the engineV2 profile has no _budget');
    }
    return 1;
  }
  const requested = options.budget ?? 1;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new CompileError('invalid-budget', `compile: budget must be a positive integer, got ${requested}`);
  }
  return requested;
}

/**
 * The analysis `compile` builds on: the caller's, when it passed one (`options.analysis`), or a
 * fresh `analyse(workflow)` under the options' profile and agent budgets. The budgets and a
 * passed analysis are exclusive — the analysis already resolved them — and a hash without its
 * analysis is refused rather than trusted. A passed analysis must carry the profile `compile`
 * was asked for (default `v1`): the profile is hashed and decides the gadget, so an analysis of
 * the other profile would build the other engine's net under this call's cache key.
 */
export function analysisOf(workflow: WorkflowDescription, options: CompileOptions): WorkflowAnalysis {
  const profile = profileOf(options.profile, 'compile');
  if (profile === 'engineV2' && (options.maxAgentRounds !== undefined || options.maxAgentToolCalls !== undefined)) {
    throw new CompileError('invalid-options',
      'compile: maxAgentRounds / maxAgentToolCalls seed the agent round, which the engineV2 profile does not have');
  }
  if (options.analysis === undefined) {
    if (options.structuralHash !== undefined) {
      throw new CompileError('invalid-options', 'compile: structuralHash is given without the analysis it hashes');
    }
    return analyse(workflow, {
      profile, maxAgentRounds: options.maxAgentRounds, maxAgentToolCalls: options.maxAgentToolCalls,
    });
  }
  if (options.maxAgentRounds !== undefined || options.maxAgentToolCalls !== undefined) {
    throw new CompileError('invalid-options',
      'compile: maxAgentRounds / maxAgentToolCalls are analysis options; with a precomputed analysis, ' +
      'pass them to analyse()');
  }
  if (options.analysis.profile !== profile) {
    throw new CompileError('invalid-options',
      `compile: the precomputed analysis is for profile '${options.analysis.profile}', ` +
      `but compile was asked for '${profile}'; analyse with the same profile`);
  }
  return options.analysis;
}
