/**
 * The vocabulary both routes share: a {@link Decision}, whichever route made it, and the
 * per-report {@link Context} every family reads.
 */
import type { FlatNet, MarkingState, PInvariant } from 'libpetri/verification';
import type { CompiledWorkflow, NetMapView } from '../../compiler/index.js';
import type { StateSpace, TruncationShape } from '../state-class.js';
import type {
  CheckRoute, CheckVerdict, Counterexample, PropertyCheck, SmtFallbackMode, SolverInfo,
} from '../types.js';
import type { CompletionSinks } from './completion.js';

/**
 * A decided (or undecided) question, whichever route answered it. `verdict` is libpetri's
 * own polarity — the polarity inversion the dead-nodes family applies happens at the call
 * site, so {@link PropertyCheck.query} can record what was actually asked.
 */
export interface Decision {
  readonly verdict: CheckVerdict;
  readonly reason: string | null;
  readonly route: CheckRoute;
  readonly method: string | null;
  readonly elapsedMs: number;
  readonly counterexample: Counterexample | null;
}

/** Everything one report's families share: the net, both routes, and the checks recorded so far. */
export interface Context {
  readonly compiled: CompiledWorkflow;
  readonly map: NetMapView;
  readonly state: MarkingState;
  readonly flat: FlatNet;
  readonly timeoutMs: number;
  readonly semiflowInvariants: boolean;
  readonly solver: SolverInfo;
  /** How far the SMT route may go (`VerifyOptions.smtFallback`). */
  readonly smtFallback: SmtFallbackMode;
  /** Why no `SmtVerifier` may be constructed for this net; `null` when it may. */
  readonly smtRefusal: string | null;
  /** What the workflow's shape is, for the truncation cause. */
  readonly shape: TruncationShape;
  /** The solver-free route, explored once and shared by every family (`state-class.ts`). */
  readonly space: StateSpace;
  /** Node → the alternative entry point that is the only reason it cannot run here. */
  readonly entryReach: ReadonlyMap<string, string>;
  /** The whole-net completion question's sink declaration, built once per report ({@link completionSinksOf}). */
  readonly completion: CompletionSinks;
  readonly checks: PropertyCheck[];
  readonly onCheck: ((check: PropertyCheck) => void) | undefined;
  /** The invariant list of the first result that carried one: what the encoder actually saw. */
  invariants: readonly PInvariant[] | null;
  /** That result's report, for the two canonical count lines. */
  invariantReport: string | null;
  /**
   * Whether {@link invariants} came from a run that actually unioned the semiflows. A query's
   * run asks `'auto'`, which *skips* the union whenever the basis is complete, and
   * {@link collectInvariants} needs the union's non-negative form. Without this flag the cache
   * hands it a basis-only list and the budget semiflow is reported missing on a net that has
   * one — see the comment in `collectInvariants`, and "reports the same semiflow whether or not
   * the class cap let the graph close" in `tests/verify/properties.test.ts`.
   *
   * Set from `unionedSemiflows` (`invariants.ts`), which tests for the *presence* of libpetri's
   * `Semiflows encoded as invariants:` line rather than for a non-zero count: the line appears
   * exactly when the union ran, and a count of zero means the basis already covered it.
   */
  invariantsUnionedSemiflows: boolean;
  /**
   * The whole-net `deadlockFree` fallback, memoised for this report ({@link smtFallbackCompletion}):
   * **one** query per workflow, not one per place — that was M4's shape and it is what made the
   * family cost (places x timeout). `null` until a completion row first needs it. Held on the
   * context, so concurrent `verifyCompiled` calls never share an entry.
   */
  completionFallback: Promise<Decision> | null;
}
