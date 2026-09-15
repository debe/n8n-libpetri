/**
 * The solver-free decisions: a verdict read straight off the explored state-class graph
 * (VER-010), or `null` where the graph did not decide and the SMT route must be asked.
 */
import type { Place } from 'libpetri';
import { boundedReason } from '../reasons.js';
import { witnessCounterexample } from '../state-space/decode.js';
import type { CheckVerdict, Counterexample } from '../types.js';
import type { Context, Decision } from './context.js';

/** A verdict read straight off the graph. */
export function graphDecision(
  verdict: CheckVerdict, counterexample: Counterexample | null = null, reason: string | null = null,
): Decision {
  return {
    verdict,
    reason,
    route: 'state-class-graph',
    method: verdict === 'bounded' ? 'state-class graph (bounded)' : 'state-class graph',
    elapsedMs: 0,
    counterexample,
  };
}

/**
 * `placeBound(place, bound)` from the graph. `null` when the graph decided nothing — it
 * truncated with no violation in the prefix, or failed to build — in which case the caller
 * runs the SMT fallback and then {@link boundedOrUnknown}.
 *
 * A complete graph decides this **exactly**: the peak token count over every reachable class
 * either exceeds the bound or does not. There is no abstraction gap on the bound itself; the
 * gap is the one every verdict here carries (priority-blind, value-blind, atomic firing).
 *
 * A peak *above* the bound is a verdict at any completeness: the class holding it was
 * genuinely reached, so a truncated graph that finds one has found a real violation. Only
 * the *absence* of one needs the graph to have closed.
 */
export function graphBound(ctx: Context, place: Place<unknown>, bound: number): Decision | null {
  if (!ctx.space.usable) return null;
  if (ctx.space.peak(place) > bound) {
    const witness = ctx.space.peakWitness(place);
    return graphDecision('violated', witness === null ? null : witnessCounterexample(witness));
  }
  return ctx.space.complete ? graphDecision('proven') : null;
}

/**
 * `unreachable({place})` from the graph, for the dead-nodes family.
 *
 * A class marking `place` is a real witness whether or not the graph closed, so *reachable*
 * (libpetri's `violated`) is decided from a truncated graph too — which matters, because the
 * family's fallback is one SMT query per node and a truncated graph is exactly the big
 * workflow where that is unaffordable. **Unreachable** needs a complete graph and gets no
 * `bounded` arm: "the node did not run within `k` cyclic-node runs" is not evidence that it
 * is dead, and reporting it as the family's finding would send a reader after a non-bug.
 */
export function graphUnreachable(ctx: Context, place: Place<unknown>): Decision | null {
  if (!ctx.space.usable) return null;
  if (ctx.space.everMarked(place)) return graphDecision('violated');
  return ctx.space.complete ? graphDecision('proven') : null;
}

/**
 * The route order for a question the graph examined and found nothing wrong with, over a
 * graph that then truncated: the SMT fallback first (a `proven` from it would be a real
 * proof and outranks any bound), and the bounded verdict only if the solver did not decide.
 *
 * `bounded` is offered only when {@link StateSpace.boundedCyclicRuns} is non-null, i.e. only
 * on a workflow with a cycle whose explored prefix closes at least one whole cyclic-node run.
 * The other truncation shapes — heavy independent parallelism (NU-053), or a cap set too
 * low — have nothing to count and stay `unknown`, which is the honest answer there.
 */
export function boundedOrUnknown(ctx: Context, decision: Decision, note: string | null = decision.reason): Decision {
  if (decision.verdict !== 'unknown') return decision;
  const iterations = ctx.space.boundedCyclicRuns;
  if (iterations === null) return decision;
  // "The SMT route:" and not "the fallback did not close it either": the note may say the
  // query was never asked, and stacking a false claim on top of that was the shape of the
  // reason strings this route had to stop producing.
  const reason = note === null || note === ''
    ? boundedReason(ctx, iterations)
    : `${boundedReason(ctx, iterations)}. The SMT route: ${note}`;
  return { ...graphDecision('bounded', null, reason), elapsedMs: decision.elapsedMs };
}

/**
 * The weaker of two verdicts, for a claim that is the conjunction of several checks.
 *
 * `violated` dominates: one counterexample refutes the conjunction whatever the rest say. Among
 * the others the order is `unknown` < `bounded` < `proven`, because `bounded` carries a real
 * statement (it holds within the explored bound) where `unknown` carries none.
 *
 * Written as a rank rather than a chain of ternaries: the chain this replaced kept the *last*
 * non-proven verdict instead of the weakest, so an `unknown` attempt followed by a `bounded` one
 * reported `bounded` for the pair and over-claimed.
 */
export function weakerVerdict(a: CheckVerdict, b: CheckVerdict): CheckVerdict {
  if (a === 'violated' || b === 'violated') return 'violated';
  const rank: Record<CheckVerdict, number> = { violated: 0, unknown: 1, bounded: 2, proven: 3 };
  return rank[a] <= rank[b] ? a : b;
}
