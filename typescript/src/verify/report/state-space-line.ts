/**
 * The solver-free route's line of the report header: how much was enumerated, whether it
 * closed, and — when it did not — what stopped it and what its prefix still certifies.
 */
import type { VerificationReport } from '../types.js';

type StateSpaceFigures = VerificationReport['stateSpace'];

/**
 * The solver-free route's line: how much was enumerated, whether it closed, and — when it
 * did not — what stopped it (one of {@link TruncationCause}'s four, which is measured rather
 * than assumed) plus, on a cyclic workflow, the bound its prefix closes. A truncated graph is
 * printed as such, because it is the difference between a proof and a bounded observation.
 */
export function renderStateSpace(report: VerificationReport): string {
  const space = report.stateSpace;
  if (space.error !== null) return `not built: ${space.error} — every check fell back to the solver`;
  const size = `${space.classes} classes in ${(space.elapsedMs / 1000).toFixed(1)}s, ` +
    `${space.quiescent} quiescent (${space.terminal} paused or halted)`;
  if (space.complete) return `${size}, complete (VER-010)`;
  if (space.truncation === 'off') {
    return `${size}, the solver-free route is off (maxClasses = ${space.requestedMaxClasses})`;
  }
  const lowered = space.maxClasses < space.requestedMaxClasses
    ? ` (lowered from ${space.requestedMaxClasses} to fit the heap)`
    : '';
  return `${size}, TRUNCATED at the ${space.maxClasses}-class cap${lowered} — ${truncationWhy(space)}` +
    cyclicBound(space);
}

/** What stopped the enumeration, in words; a cap set too low is what is left. */
function truncationWhy(space: StateSpaceFigures): string {
  switch (space.truncation) {
    case 'cycle': return 'the workflow has a cycle, so its state space is unbounded';
    case 'tool-calls': return agentBudgets(space.agents);
    case 'parallelism': return 'independent parallel branches (NU-053: no partial-order reduction)';
    default: return 'the class cap is below what this workflow needs (no cycle, no branching node)';
  }
}

/**
 * The bound is the only thing a truncated cyclic graph can still certify, so it belongs on
 * the same line as the truncation rather than buried in a per-check reason. It counts the
 * *runs of cyclic nodes*, not iterations of the loop body: on a two-node cycle one pass of
 * the body is two of them ({@link loopTransitions}).
 */
function cyclicBound(space: StateSpaceFigures): string {
  return space.boundedCyclicRuns === null
    ? ''
    : `; ${space.expanded} classes expanded, closing every run of at most ` +
      `${space.boundedCyclicRuns} cyclic-node run(s) across ${space.loopSteps} cyclic node(s)`;
}

/**
 * The one truncation with a knob. The graph explores every round size up to an agent's
 * tool-call budget — a product of per-tool and per-round counters, polynomial in both — so a
 * smaller declared budget shrinks it, and the message says which agent, what it has now, and
 * whether that number was the workflow's or the scheduler's runtime default. It does not promise
 * a complete graph: branching nodes multiply the same count, and no budget reaches those
 * (the per-check reason names both, `reasons.ts`).
 */
function agentBudgets(agents: StateSpaceFigures['agents']): string {
  const each = agents.map((a) =>
    `'${a.node}' may make ${a.maxToolCalls} tool call(s) across ${a.tools} tool(s)` +
    (a.assumed ? ' (the scheduler default — nothing declared)' : ' (declared)'));
  return `an agent's tool-call budget: ${each.join('; ')}. The graph explores every round size up to ` +
    'the budget, so a small executionPolicy.maxToolCalls on the agent shrinks it — a declared budget ' +
    'is both the runtime cap and the width of the claim';
}
