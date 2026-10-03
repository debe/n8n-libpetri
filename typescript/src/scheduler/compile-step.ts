/**
 * Step 2 of `PetriScheduler.run()` (see `petri-scheduler.ts`): the workflow description
 * compiled once per `(structural hash, budget)` with the actions bound, and cached. Always the
 * `v1` profile, named explicitly: this is the v1 scheduler, whatever the compiler's default.
 */
import {
  analyse, compile, structuralHash, type CompiledWorkflow, type WorkflowDescription,
} from '../compiler/index.js';
import { schedulerActions } from './bind.js';
import { CompiledWorkflowCache } from './cache.js';

/** The scheduler options that reach the analysis: an agent's round and tool-call budgets. */
export interface AgentBudgetOptions {
  readonly maxAgentRounds?: number;
  readonly maxAgentToolCalls?: number;
}

/**
 * The agent budgets the options set, in the shape the analysis and the compile take them. They
 * reach the analysis the key hashes *and* the compile, so an agent's resolved `maxRounds` /
 * `maxToolCalls` — both in the hash — reflect this scheduler's options and two schedulers
 * configured differently never share an entry.
 */
function agentBudgets(options: AgentBudgetOptions) {
  return {
    ...(options.maxAgentRounds === undefined ? {} : { maxAgentRounds: options.maxAgentRounds }),
    ...(options.maxAgentToolCalls === undefined ? {} : { maxAgentToolCalls: options.maxAgentToolCalls }),
  };
}

/**
 * Compile once per `(structural hash, budget)` with the actions bound; cached. The hash
 * is a function of the analysis, which is cheap; the net and its program are built only
 * on a miss, and the program itself compiles lazily on first access (CONC-020). The
 * analysis and the hash are computed once per call, for the key, and a miss compiles on
 * both rather than analysing and hashing the description again.
 */
export function compileCached(
  cache: CompiledWorkflowCache, description: WorkflowDescription, budget: number, options: AgentBudgetOptions,
): CompiledWorkflow {
  // The scheduler runs n8n's v1 loop (patch 0001's seam), so it names the v1 profile rather
  // than taking the compiler's default (`v1` again since ADR 0015, `engineV2` under ADR 0013).
  const analysis = analyse(description, { profile: 'v1', ...agentBudgets(options) });
  const hash = structuralHash(analysis);
  const key = CompiledWorkflowCache.key(hash, budget);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const fresh = compile(description, {
    profile: 'v1', budget, actions: schedulerActions(), analysis, structuralHash: hash,
  });
  cache.set(key, fresh);
  return fresh;
}

/**
 * The diagnostic that says this workflow did *not* run at the requested k, or `undefined` when
 * it did. It is the only place a budget leg can see it: the compiler's k-safety check lowered
 * the budget (README "Concurrency budget and its safety condition").
 * `scripts/run-conformance.sh` collects these into `<label>.budget.txt`.
 */
export function budgetLowered(compiled: CompiledWorkflow): string | undefined {
  if (compiled.budgetRestriction === null || compiled.requestedBudget <= 1) return undefined;
  return `budget: k=${compiled.requestedBudget} lowered to ${compiled.effectiveBudget} ` +
    `(${compiled.budgetRestriction.reason}: ${compiled.budgetRestriction.detail})`;
}
