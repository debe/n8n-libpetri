/**
 * Why an enumeration stopped short, read from the evidence: the cap, the workflow's shape and
 * whether the route was switched off.
 */
import type { AgentBudget, TruncationCause } from '../types.js';

/** What the *workflow* looks like, for {@link StateSpace.truncationCause}. */
export interface TruncationShape {
  /** `analysis.hasCycle`. */
  readonly hasCycle: boolean;
  /** Some node has two or more distinct successors: branches that interleave. */
  readonly independentBranches: boolean;
  /**
   * Every agent, with its tool-call budget. The graph explores every round size up to the
   * budget — a product of per-tool and per-round counters, polynomial in K and in the tool
   * count — so this is the one truncation cause with
   * a knob the user can turn: a declared `options.maxToolCalls` is both the runtime cap and the
   * width of the claim, and an assumed one is the scheduler's runtime default, sized for
   * production and far too wide for a graph.
   */
  readonly agents: readonly AgentBudget[];
}

/**
 * The cause of a truncation the graph did report, given the cap it ran with: see
 * {@link TruncationCause}.
 *
 * The `'parallelism'` arm used to be the catch-all, which reported "independent parallel
 * branches (NU-053)" for a four-node chain whose only problem was a cap set below 50.
 */
export function truncationCauseOf(maxClasses: number, shape: TruncationShape): TruncationCause {
  if (maxClasses <= 0) return 'off';
  if (shape.hasCycle) return 'cycle';
  // An agent's budget is named before parallelism because it is the cause with a knob: the
  // branching an agent workflow shows is its own round, and lowering `maxToolCalls` is what
  // closes the graph, where nothing closes an independent fan-out but a reduction libpetri
  // does not have (NU-053).
  if (shape.agents.length > 0) return 'tool-calls';
  return shape.independentBranches ? 'parallelism' : 'cap';
}
