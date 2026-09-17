/**
 * Every sentence a check's `reason` or `explanation` is built from: why a route could not
 * decide, what a `bounded` verdict quantifies over, and why a reachable node is not a proof of
 * liveness.
 *
 * Kept apart from the routes that produce the verdicts so the prose has one home. A reason is
 * a claim about what was established, and the rules this surface keeps — a truncated graph is
 * never a proof, a witness in the priority- and value-blind abstraction is never liveness
 * (VER-004), a `bounded` verdict is sound and not a proof — are stated here once rather than
 * re-spelled at every call site where they could drift apart.
 *
 * This module is a leaf: it reads the explored state space and the workflow's shape through
 * {@link ReasonContext}, which the route's `Context` satisfies structurally, so it imports
 * nothing that imports it back.
 */
import type { StateSpace, TruncationShape } from './state-class.js';
import type { CheckRoute, CheckVerdict } from './types.js';

/** What a reason reads: the explored state space and the workflow shape behind its truncation. */
export interface ReasonContext {
  readonly space: StateSpace;
  readonly shape: TruncationShape;
}

/**
 * Why the truncated graph cannot answer, and what to do about it — with the cause taken from
 * {@link StateSpace.truncationCause}, which is evidence rather than a default. Two of its
 * four values are the shapes NU-053 names (a cycle, and heavy independent parallelism); the
 * other two are a cap set below what the workflow needs and a route the caller switched off,
 * and telling those apart is the difference between "raise the cap" and "this workflow cannot
 * be enumerated".
 *
 * The sentence is deliberate about what *was* established: "nothing was stranded among the
 * `n` classes explored" is a bounded fact and never a proof. Reporting it as `proven` is the
 * one failure mode this route must not have.
 */
export function truncationReason(ctx: ReasonContext): string {
  const space = ctx.space;
  if (!space.usable) {
    return `the state-class graph could not be built (${space.error ?? 'unknown reason'}), so the ` +
      'solver-free route decided nothing';
  }
  const cause = space.truncationCause(ctx.shape);
  if (cause === 'off') {
    return `the solver-free route was turned off (maxClasses = ${space.requestedMaxClasses}), so nothing ` +
      'was enumerated and every question went to the SMT route';
  }
  const lowered = space.maxClasses < space.requestedMaxClasses
    ? ` (lowered from the requested ${space.requestedMaxClasses} to what this process's heap can hold)`
    : '';
  const explored = `the state-class graph truncated at its ${space.maxClasses}-class cap${lowered} ` +
    `(${space.classes} classes explored in ${(space.elapsedMs / 1000).toFixed(1)}s), so completeness — ` +
    'and with it any proof — is out of reach.';
  const advice = cause === 'cycle'
    ? ' The workflow has a cycle, so its reachable state space is unbounded and no class cap can ' +
      'close it (NU-053). Nothing was stranded among the classes explored, which is a bounded fact ' +
      'about a prefix of the runs, not a proof about all of them.'
    : cause === 'tool-calls'
      ? agentAdvice(ctx.shape)
    : cause === 'parallelism'
      ? ' This workflow has branching nodes, and independent parallel branches blow the class count up ' +
        'combinatorially (NU-053: the graph has no partial-order reduction). Raising maxClasses may ' +
        'close it; verifying a smaller slice of the workflow certainly will.'
      : ' No cycle and no branching node explains it, so the cap is simply below what this workflow ' +
        'needs: raise maxClasses.';
  return explored + advice;
}

/**
 * Why an agent workflow's graph did not close. The graph explores every round size up to each
 * agent's tool-call budget, so a smaller declared budget shrinks the count; branching nodes
 * multiply the same count by their interleavings, and no budget reaches those. Saying only
 * "lower the budget" to a workflow that also branches points at a knob that cannot close it —
 * measured on a two-branch chat bot, whose graph still truncated with its agent at two calls.
 */
function agentAdvice(shape: TruncationShape): string {
  const each = shape.agents.map((a) =>
    `'${a.node}' ${a.maxToolCalls} call(s) across ${a.tools} tool(s)${a.assumed ? ', the scheduler default' : ', declared'}`);
  const budgets = ` The graph explores every round size up to each agent's tool-call budget (${each.join('; ')})`;
  return shape.independentBranches
    ? `${budgets}, multiplied by the interleavings of the workflow's branching nodes (NU-053: the graph ` +
      'has no partial-order reduction). A smaller executionPolicy.maxToolCalls shrinks only the first factor.'
    : `${budgets}. A smaller executionPolicy.maxToolCalls may close it — a declared budget is both the ` +
      'runtime cap and the width of the claim.';
}

/**
 * Why the SMT fallback is asked, and what it asks.
 *
 * The fallback is one **whole-net** `deadlockFree` query per workflow — the VER-002 shape
 * that is literally workflow-net proper completion, one query rather than M4's one per
 * place — with the structural rest set declared as sinks and the pause / halt widenings
 * declared as *conditional* sinks (`route.ts` `completionSinksOf`, libpetri VER-014):
 * a token may rest on an `in` / `ready` / `hasdata` place while `_pause` holds a token, and
 * on those plus the empty-arrival markers while `_halt` does. That is the solver-free route's
 * classification (`state-class.ts`, "The pause filter") stated as a property, so the two
 * routes now ask the same question and a `proven` from either transfers.
 *
 * Until libpetri 5.0.x (2026-09-08) no property could express the widening, and the plain
 * VER-002 question was false by construction on any workflow with a reachable paused marking
 * holding an arrival — which is most of them — so it was skipped wherever the graph had
 * already reached such a marking, and answered `violated` with a designed-terminal witness
 * everywhere else (nought for ten, `docs/verification.md`). Measured after the change:
 * `fanOut` proven in 0.2 s where it used to return that witness in 2 s. What it still cannot
 * do is *prove* quiescence on a net whose proof needs chained inequality invariants —
 * `agentTwoTools` at `maxToolCalls` 64 is `unknown` at 120 s — the same limit as the
 * reachability cliff (`tasks/todo.md` §4, libpetri's inequality-invariant work).
 *
 * Its `violated` is a finding: a stranding the solver found outside the explored prefix. A
 * witness that is nevertheless a designed terminal would mean the sink declaration and the
 * graph's classification disagree; that is downgraded and named
 * ({@link TERMINAL_WITNESS_REASON}) rather than reported as a defect.
 *
 * All of that is a claim about **this** query only. The other families' fallbacks decide
 * plenty on the same truncated graphs — on `switch20`, z3 proves `placeBound(_budget, 1)`
 * and all 22 `placeBound(X/running, 1)` at ~2.8 s each — which is why the fallback stays per
 * family rather than being dropped wholesale.
 */
export const SMT_FALLBACK_REASON =
  'the whole-net deadlockFree fallback (VER-002 with the rest set as sinks and the pause / halt ' +
  'widenings as conditional sinks, VER-014) did not decide it either';

/**
 * Why an SMT proper-completion violation the graph's own rule excuses is downgraded.
 *
 * A witness is classified exactly as the solver-free route classifies a quiescent class:
 * `terminalKindOf` picks the kind (halt over pause), and every marked place is checked
 * against that kind's rest set — the same widening the conditional sinks declare to the
 * solver. **Holding a terminal marker is not itself an excuse.** With the widenings declared
 * the conditional sinks have already excused everything the marker excuses, so a witness that
 * still marks something outside the widened set is a real stranding *even though it is also a
 * paused or halted run* — a workflow that pauses on one branch and strands another — and it
 * is reported. (Before VER-014 the test was "does the witness hold any terminal role", which
 * was right while the query could not tell the two apart and would now discard that finding.)
 *
 * What remains excused is a witness the graph would call a designed terminal outright. That
 * can only mean the two disagree — `terminalKindOf` widens on a marked `waiting` / `stopped`
 * place, `sinkPlacesWhen` on `_pause` / `_halt`, and every gadget branch that produces one of
 * the former produces `_pause` beside it — so it is a bug in one of them, not a defect in the
 * workflow, and it is reported as that.
 *
 * A place the `NetMap` does not resolve (`role === null`) counts as stranded: no rest set
 * contains it, and over-reporting is the safe direction.
 */
export const TERMINAL_WITNESS_REASON =
  'the only witness the solver returned is a paused or halted run — a designed terminal marking ' +
  'the conditional sink declaration (VER-014) should have excused. The SMT declaration and the ' +
  "solver-free route's classification disagree on this net; treated as undecided — report it";

/**
 * Why a node the route says is *reachable* is `unknown` and never `proven`.
 *
 * Both routes explore an abstraction that is priority-blind and value-blind: every `xor`
 * branch of a routing transition is available whatever the data (VER-004 AC2), so "the IF
 * sent items down this branch" is reachable on a workflow where no real run does it.
 * VER-004 AC3 licenses the proof direction only, so `unreachable` *proven* — the node is
 * dead — is a verdict and its negation is not. Calling a reached node "live" would be a
 * claim neither encoding supports, and it would be counted among the proofs.
 */
export const LIVENESS_REASON =
  'the running place is reachable only in the priority-blind and value-blind over-approximation ' +
  '(VER-004): every xor branch of a router is explored whatever the data, so this witness does not ' +
  'establish that a real run reaches the node. VER-004 AC3 licenses the proof direction only — ' +
  'liveness is not provable by this abstraction';

/**
 * What a `bounded` verdict quantifies over, spelled out where it is reported.
 *
 * It is the honest middle between the two things M5 refuses to do on a cyclic workflow:
 * claim a proof it cannot have, and say nothing at all. The closure argument is in
 * `state-class.ts` (`closedCyclicRuns`); this is its statement in workflow terms.
 */
export function boundedReason(ctx: ReasonContext, iterations: number): string {
  const space = ctx.space;
  // The unit is a *run of a cyclic node*, not a pass of the loop body: `loopTransitions`
  // counts the `X_run` of every node on a cycle, so a two-node loop spends two per pass.
  // What is guaranteed in the author's own unit is therefore floor(k / loopSteps) passes.
  const passes = space.loopSteps <= 1
    ? ''
    : ` (at least ${Math.floor(iterations / space.loopSteps)} complete pass(es) of the ` +
      `${space.loopSteps} cyclic node(s) on the cycle, and more of a run that visits only some of them)`;
  return `not a proof: the state-class graph truncated at its ${space.maxClasses}-class cap ` +
    `(${space.classes} classes, ${space.expandedClasses} of them expanded, in ` +
    `${(space.elapsedMs / 1000).toFixed(1)}s). What *was* established is bounded and exact — every run ` +
    `in which this workflow's cyclic nodes run at most ${iterations} time(s) in total${passes} was ` +
    'enumerated in full, together with every marking such a run can come to rest in, and none of them ' +
    'breaks this check. A run with more cyclic-node runs than that was not explored. The workflow has ' +
    'a cycle, so its reachable state space is unbounded (NU-053) and no class cap can close it; raising ' +
    '--max-classes raises the bound rather than reaching a proof';
}

/**
 * The three-way explanation of a check, with the `bounded` arm derived from the `proven`
 * one: the claim is the same, the quantifier is smaller, and saying so in one place keeps
 * the two from drifting apart.
 */
export function explain(verdict: CheckVerdict, text: { proven: string; violated: string; unknown: string }): string {
  switch (verdict) {
    case 'proven': return text.proven;
    case 'violated': return text.violated;
    case 'bounded': return `Only within the explored cyclic-node-run bound — ${text.proven}`;
    case 'unknown': return text.unknown;
  }
}

/**
 * Why the SMT fallback did not close it, on its own — the half a bounded reason still wants.
 *
 * When the query was never asked (the fallback skipping a question the graph has already
 * shown to be false), its own reason *is* the note: saying "the fallback did not decide it
 * either" about a query that never ran would be a second false statement stacked on the
 * first.
 */
export function smtFallbackNote(fallback: { readonly route: CheckRoute; readonly reason: string | null }): string {
  if (fallback.route === 'none') return fallback.reason ?? SMT_FALLBACK_REASON;
  return `${SMT_FALLBACK_REASON}${fallback.reason === null ? '' : ` (${fallback.reason})`}`;
}

/**
 * The one spelling of an undecided reason: why the graph could not decide it, then why the SMT
 * route could not. Every composed `unknown` reason goes through here, so the two halves are
 * always in the same order with the same joint.
 */
export function undecidedReason(ctx: ReasonContext, smtNote: string): string {
  return `${truncationReason(ctx)} — and ${smtNote}`;
}

/** Both halves of an undecided completion question: why the graph could not, why z3 could not. */
export function completionUnknownReason(
  ctx: ReasonContext, fallback: { readonly route: CheckRoute; readonly reason: string | null },
): string {
  return undecidedReason(ctx, smtFallbackNote(fallback));
}

/**
 * An SMT-fallback `unknown`, prefixed with why the solver-free route did not decide it.
 *
 * On a complete graph the SMT reason stands alone — the graph decided everything it could —
 * but a complete graph never sends a question to the fallback in the first place (every graph
 * decision is non-null once the graph closed), so in practice the prefix is always there.
 */
export function unknownReason(
  ctx: ReasonContext, decision: { readonly verdict: CheckVerdict; readonly reason: string | null },
): string | null {
  if (decision.verdict !== 'unknown') return decision.reason;
  const smt = decision.reason ?? 'the SMT fallback did not decide it either';
  return ctx.space.complete ? smt : undecidedReason(ctx, smt);
}
