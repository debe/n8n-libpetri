/**
 * `compile()`'s options, checked before anything is built: the requested budget, and the
 * analysis it builds on together with the refusals that keep a passed analysis honest.
 */
import { CompileError } from '../errors.js';
import { analyse } from '../graph.js';
import type { CompileOptions, WorkflowAnalysis, WorkflowDescription } from '../types.js';

/** The requested concurrency budget `k`: `options.budget`, default 1, refused unless a positive integer. */
export function requestedBudgetOf(options: CompileOptions): number {
  const requested = options.budget ?? 1;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new CompileError('invalid-budget', `compile: budget must be a positive integer, got ${requested}`);
  }
  return requested;
}

/**
 * The analysis `compile` builds on: the caller's, when it passed one (`options.analysis`), or a
 * fresh `analyse(workflow)` under the options' agent budgets. The budgets and a passed analysis
 * are exclusive — the analysis already resolved them — and a hash without its analysis is
 * refused rather than trusted.
 */
export function analysisOf(workflow: WorkflowDescription, options: CompileOptions): WorkflowAnalysis {
  if (options.analysis === undefined) {
    if (options.structuralHash !== undefined) {
      throw new CompileError('invalid-options', 'compile: structuralHash is given without the analysis it hashes');
    }
    return analyse(workflow, {
      maxAgentRounds: options.maxAgentRounds, maxAgentToolCalls: options.maxAgentToolCalls,
    });
  }
  if (options.maxAgentRounds !== undefined || options.maxAgentToolCalls !== undefined) {
    throw new CompileError('invalid-options',
      'compile: maxAgentRounds / maxAgentToolCalls are analysis options; with a precomputed analysis, ' +
      'pass them to analyse()');
  }
  return options.analysis;
}
