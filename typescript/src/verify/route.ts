/**
 * The two routes a reachability-safety question can take, the order they are asked in, and
 * the per-report {@link Context} both read.
 *
 * The **solver-free route** is libpetri's state-class graph (VER-010, `state-class.ts`),
 * explored once per report; {@link graphBound}, {@link graphUnreachable} and
 * {@link graphStranding} read a verdict off it, or return `null` when it did not decide. The
 * **SMT route** is libpetri's `SmtVerifier` (IC3/PDR through z3, VER-001/VER-013), run through
 * {@link smtDecision} only where the graph truncated or failed to build — the order NU-053
 * prescribes. {@link boundedOrUnknown} is the last step of that order on a cyclic workflow,
 * and {@link decideStranding} is the whole of it for the proper-completion family.
 *
 * Nothing here throws on a solver problem: a refusal, a missing z3 or a failed query is an
 * `unknown` carrying the reason (VER-013), and only a programming error is re-thrown
 * (`state-class.ts` `rethrowIfBug`).
 *
 * Each concern has its own module under `routing/`: the shared vocabulary (`context.ts`), the
 * SMT route (`smt.ts`), its size ceiling (`smt-refusal.ts`) and its invariant pipeline
 * (`collect-invariants.ts`), the solver-free decisions (`graph.ts`) and proper completion's
 * route (`completion.ts`).
 */
export type { Context, Decision } from './routing/context.js';
export { SMT_MAX_FLAT_PLACES, SMT_MAX_JOIN_INPUTS, smtRefusalFor } from './routing/smt-refusal.js';
export { smtDecision, type ConditionalSink } from './routing/smt.js';
export { collectInvariants } from './routing/collect-invariants.js';
export {
  boundedOrUnknown, graphBound, graphDecision, graphUnreachable, weakerVerdict,
} from './routing/graph.js';
export {
  completionSinksOf, decideStranding, graphStranding, smtFallbackCompletion,
  type CompletionSinks, type SinkRecord,
} from './routing/completion.js';
