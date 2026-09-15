/**
 * The ordering report's rule set: which mechanism moved a reordered activation
 * ({@link attribute}). Order-only movement is row #5; the move rules only decide which
 * *mechanism* to name, and `novel: true` marks one the register does not have.
 */
import { activationNodeOf } from '../trace.js';
import type { AttributionContext } from './context.js';
import { attributeOneSided } from './one-sided.js';
import { divergence, firstMatch, type Attribution, type Divergence, type Rule } from './vocabulary.js';

/** A reordered activation, the activations it passed, and what the rules read. */
interface Move {
  readonly activation: string;
  readonly node: string;
  readonly movedAgainst: readonly string[];
  readonly ctx: AttributionContext;
}

/** Whether neither activation reaches the other over the realised dependency edges. */
function independent(reachable: AttributionContext['reachable'], a: string, b: string): boolean {
  return !(reachable.get(a)?.has(b) ?? false) && !(reachable.get(b)?.has(a) ?? false);
}

/** At k > 1, a move against activations it has no dependency with either way. */
function concurrency({ activation, movedAgainst, ctx }: Move): Attribution | null {
  if (ctx.effectiveBudget <= 1) return null;
  if (!movedAgainst.every((other) => independent(ctx.reachable, activation, other))) return null;
  return {
    kind: 'concurrency',
    why: `k=${ctx.effectiveBudget}: no dependency either way with ${movedAgainst.join(', ') || 'the activations it passed'}, so the net leaves the pair unordered and either order is correct`,
  };
}

/** **#11** — two runs of the node are a permutation. */
function permutedNode({ node, ctx }: Move): Divergence | null {
  if (!ctx.permutedNodes.includes(node)) return null;
  return divergence(11, 'or-input-lifo',
    `two runs of '${node}' are a permutation: n8n delivers the most recent arrival first (unshift/shift), the net's hasdata place is FIFO`);
}

/** **#12** — a multi-input join is involved: n8n unshifts its entry behind every sibling. */
function joinUnshift({ activation, movedAgainst, ctx }: Move): Divergence | null {
  const joinsInvolved = [activation, ...movedAgainst].filter((k) => ctx.joinActivations.has(k));
  if (joinsInvolved.length === 0) return null;
  return divergence(12, 'join-unshift',
    `${joinsInvolved.join(', ')} completed a multi-input join: n8n unshifts such an entry so it runs after every queued sibling, the net fires it at priority = depth`);
}

/** **#11** — everything a permuted node's activations passed moved *because* they did: one event. */
function passedPermuted({ activation, movedAgainst, ctx }: Move): Divergence | null {
  const permutedPassed = movedAgainst.filter((o) => ctx.permutedNodes.includes(activationNodeOf(o)));
  if (permutedPassed.length === 0 || permutedPassed.length !== movedAgainst.length) return null;
  return divergence(11, 'or-input-lifo',
    `'${activation}' moved only against ${permutedPassed.join(', ')}, whose node delivers its arrivals in the other order (n8n most-recent-first, the net FIFO)`);
}

/** **#20** — an OR-input node's `arm` transition costs it a scheduling cycle. */
function orInputArm({ activation, movedAgainst, ctx }: Move): Divergence | null {
  const orInvolved = [activation, ...movedAgainst].filter((k) => ctx.orInputNodes?.has(activationNodeOf(k)) ?? false);
  if (orInvolved.length === 0) return null;
  return divergence(20, 'or-input-arm',
    `${orInvolved.join(', ')} is an OR-input node: its arm transition spends one scheduling cycle turning the arrival into X/ready + X/hasdata, and a shallower sibling takes the budget unit in that cycle, so the net runs breadth-first where priority = depth alone would have been depth-first`);
}

/** **#2** — the node, or one it moved against, is a stranded join or downstream of one. */
function strandedMove({ node, movedAgainst, ctx }: Move): Divergence | null {
  const stranded = (n: string): boolean => ctx.strandedNodes.includes(n);
  if (!stranded(node) && !movedAgainst.some((o) => stranded(activationNodeOf(o)))) return null;
  return divergence(2, 'stranded-join',
    `'${node}' is a stranded join or downstream of one, so the two engines ran it a different number of times`);
}

const MOVE_RULES: readonly Rule<Move, Attribution>[] = [
  concurrency, permutedNode, joinUnshift, passedPermuted, orInputArm, strandedMove,
];

/** **#5**, novel — order-only movement no registered row names a mechanism for. */
function unnamedMove({ activation, movedAgainst }: Move): Divergence {
  return divergence(5, 'unnamed',
    `order-only: '${activation}' moved relative to ${movedAgainst.join(', ') || '(nothing)'} with equal data — n8n's total order is the LIFO artifact row #5 abandons, but no registered row names this mechanism`,
    true);
}

/**
 * Attribute one reordered activation. Order-only movement is row #5; the rules below only
 * decide which *mechanism* to name, and `novel: true` marks one the register does not have.
 */
export function attribute(
  activation: string,
  movedAgainst: readonly string[],
  ctx: AttributionContext,
): Attribution {
  const ranIn = ctx.oneSided?.get(activation);
  if (ranIn !== undefined) return attributeOneSided(activation, ranIn, ctx);
  const move: Move = { activation, node: activationNodeOf(activation), movedAgainst, ctx };
  return firstMatch(MOVE_RULES, move) ?? unnamedMove(move);
}
