/**
 * The shapes {@link verify} returns: one {@link PropertyCheck} per named question asked of
 * the net, and one {@link VerificationReport} per workflow.
 *
 * A check's `verdict` is always about the **desirable** property, never about the SMT
 * query's polarity. That matters for {@link PropertyName} `'dead-nodes'`, whose underlying
 * query is `unreachable({X/running})`: a `proven` there means the node can never run, which
 * is the *bad* outcome, so the check reports `violated`. Every other property maps straight
 * through. {@link PropertyCheck.query} records which libpetri property was actually asked
 * and what libpetri answered, so the inversion is never hidden.
 */
import type { BudgetRestriction, PlaceRole, TransitionRole, Variant } from '../compiler/index.js';

/** The property families {@link verify} can ask about. CLI `--property` takes these names. */
export type PropertyName =
  | 'proper-completion'
  | 'dead-nodes'
  | 'no-double-activation'
  | 'budget'
  | 'retry-bound'
  | 'mutual-exclusion';

export const PROPERTY_NAMES: readonly PropertyName[] = [
  'proper-completion', 'dead-nodes', 'no-double-activation', 'budget', 'retry-bound', 'mutual-exclusion',
];

/** `proven`: the desirable property holds. `violated`: it does not. `unknown`: undecided. */
export type CheckVerdict = 'proven' | 'violated' | 'unknown';

/** What a check is about, in workflow terms rather than place names. */
export type CheckSubject =
  /** A join / OR input of `node`: the `ready_i` place a stranded arrival sits on (ADR 0003). */
  | { readonly kind: 'join-input'; readonly node: string; readonly inputIndex: number; readonly place: string }
  /**
   * A data edge place. `from` / `outputIndex` are absent for the start node's synthetic
   * `X/in`, which no connection feeds.
   */
  | {
    readonly kind: 'edge';
    readonly node: string;
    readonly place: string;
    readonly from?: string;
    readonly outputIndex?: number;
    readonly inputIndex?: number;
  }
  | { readonly kind: 'node'; readonly node: string; readonly place?: string }
  | { readonly kind: 'node-pair'; readonly nodes: readonly [string, string] }
  | { readonly kind: 'place'; readonly place: string }
  /** A structural fact read off the P-invariants, with no solver query of its own. */
  | { readonly kind: 'net' };

/** One step of a decoded counterexample: a flat transition put back in workflow terms. */
export interface CounterexampleStep {
  /** The flat transition name, `_b<k>` branch suffix included (the flattener's own name). */
  readonly transition: string;
  /** The net transition the branch belongs to (`nodeId/run`, `_halt_reap`, …). */
  readonly source: string;
  /** Owning node name, `null` for the host-level `_halt_reap`. */
  readonly node: string | null;
  readonly role: TransitionRole | null;
  readonly port?: number;
  readonly variant?: Variant;
}

/** A place holding tokens in the violating marking, in workflow terms. */
export interface MarkedPlace {
  readonly place: string;
  readonly tokens: number;
  readonly node: string | null;
  readonly role: PlaceRole | null;
  readonly port: number | null;
}

/**
 * A violation witness, decoded through `NetMap`.
 *
 * `ordered` is `true` only when libpetri's abstract replay confirmed a firing order
 * (`SmtVerificationResult.counterexampleConfirmed === true`). Otherwise the steps are the
 * decoded derivation set in traversal order — every step is real, the sequence is not
 * necessarily a firing sequence, and {@link nodePath} must be read as "these nodes are
 * involved", not "in this order".
 */
export interface Counterexample {
  /** Node names in first-occurrence order over {@link steps}; the host transition is skipped. */
  readonly nodePath: readonly string[];
  readonly steps: readonly CounterexampleStep[];
  /** The marking of the violating state: for proper completion, the stuck marking. */
  readonly stuckMarking: readonly MarkedPlace[];
  readonly confirmed: boolean | null;
  readonly ordered: boolean;
}

/** What libpetri was actually asked, and what it answered. */
export interface QueryRecord {
  /** libpetri `SmtProperty.type`, or `'none'` for a structural check that runs no query. */
  readonly property: string;
  /** The place the property names, when it names one. */
  readonly place: string | null;
  /** libpetri's own verdict, before any polarity inversion this module applies. */
  readonly verdict: CheckVerdict;
  /**
   * Sink places declared on the query (VER-002); empty for every property but proper
   * completion. Note that `joined-or-dead-lettered` **ignores** them by design (NU-040 AC4),
   * so on that property this records the intent, not an exclusion the encoder applied — see
   * `verify.ts` and `docs/verification.md` for the pause-witness downgrade that stands in.
   */
  readonly sinks: readonly string[];
  /** `'IC3/PDR'`, `'structural'`, `null` when no query ran. */
  readonly method: string | null;
}

export interface PropertyCheck {
  readonly property: PropertyName;
  /** A one-line human name, e.g. `Merge input 1 always completes`. */
  readonly name: string;
  readonly subject: CheckSubject;
  readonly verdict: CheckVerdict;
  /** What the verdict means for the workflow, in one sentence. */
  readonly explanation: string;
  /** Why the verdict is `unknown`; `null` otherwise. */
  readonly reason: string | null;
  readonly counterexample: Counterexample | null;
  readonly elapsedMs: number;
  readonly query: QueryRecord;
}

/** The solver the run resolved (VER-013). */
export interface SolverInfo {
  readonly available: boolean;
  readonly program: string | null;
  readonly version: string | null;
  /** Why no solver resolved; `null` when one did. Names `PATH` and `LIBPETRI_Z3`. */
  readonly reason: string | null;
}

/** Size of the net every query ran against. */
export interface NetSize {
  readonly places: number;
  readonly transitions: number;
  /**
   * Transitions after XOR expansion — what the SMT encoder actually sees. An `and` of `k`
   * `xor`s expands to `2^k` (IO-016), which is why the compiler splits routing above
   * `SPLIT_ROUTING_ABOVE` connected outputs.
   */
  readonly flatTransitions: number;
}

/**
 * The conservation laws handed to the encoder (VER-007).
 *
 * `basis` and `semiflowsEncoded` are read off libpetri's own report — the canonical
 * `  Found: N P-invariant(s)` and `  Semiflows encoded as invariants: N` lines, which
 * VER-013 fixes byte for byte across the four implementations — so they are the
 * post-validation figures, not a re-derivation. `encoded` is the length of the invariant
 * list the result carries, which is the list the CHC rule bodies were conjoined with.
 */
export interface InvariantSummary {
  /** Null-space basis rows that survived the exact re-check. */
  readonly basis: number;
  /** Semiflows `strengthenWithSemiflows` added on top of the basis — what VER-007 bought here. */
  readonly semiflowsEncoded: number;
  /** Basis ∪ added semiflows: the set every query's rule bodies carry. */
  readonly encoded: number;
  /**
   * Rendered `w·_budget + w·Σ(running + ok + retry) = w·k` when it survives validation;
   * `null` when no law covering `_budget` and every `X/running` was found (the H1 guard
   * drops any row whose support touches a reset or consume-all place).
   */
  readonly budgetSemiflow: string | null;
}

export interface VerificationReport {
  readonly workflow: string;
  readonly structuralHash: string;
  readonly requestedBudget: number;
  /** The budget the net was compiled with: `requestedBudget`, or 1 under a k-safety restriction. */
  readonly budget: number;
  readonly budgetRestriction: BudgetRestriction | null;
  readonly solver: SolverInfo;
  readonly net: NetSize;
  readonly invariants: InvariantSummary;
  /** Per-query timeout in milliseconds. */
  readonly timeoutMs: number;
  readonly properties: readonly PropertyName[];
  readonly checks: readonly PropertyCheck[];
  readonly counts: Readonly<Record<CheckVerdict, number>>;
  /** No check came back `violated`. `unknown` checks do not make a workflow unsound; they make it unproven. */
  readonly ok: boolean;
  /** The compiler's own non-fatal findings, carried through. */
  readonly diagnostics: readonly string[];
  /**
   * Node shapes the caller had to guess, one line each (`workflow-json.ts`). A guessed
   * input / output count changes the compiled net — it decides the join versus the direct
   * form and how routing is split — so a report carrying any of these may be about a net
   * that is not quite the workflow. The CLI prints them to stderr as well; they are in the
   * report so the stored JSON is self-describing.
   */
  readonly shapeWarnings: readonly string[];
  readonly elapsedMs: number;
}

/** A pair of node names for {@link PropertyName} `'mutual-exclusion'`, or every pair. */
export type MutualExclusionRequest = readonly (readonly [string, string])[] | 'all-pairs';

export interface VerifyOptions {
  /** Concurrency budget `k`. Default 1. The compiler may lower it (`budgetRestriction`). */
  readonly budget?: number;
  /** Which property families to run. Default: everything except `'mutual-exclusion'`. */
  readonly properties?: readonly PropertyName[];
  /** Per-query timeout handed to z3 (VER-013). Default 60 000 ms. */
  readonly timeoutMs?: number;
  /** VER-007. Default `true`: without it the reset-arc chains lose their conservation laws. */
  readonly semiflowInvariants?: boolean;
  /**
   * Node pairs for `'mutual-exclusion'`, or `'all-pairs'`. Supplying any of these turns the
   * property on even when `properties` was not given.
   */
  readonly mutualExclusion?: MutualExclusionRequest;
  /** The value on the start node's `in` place. Irrelevant to every verdict (VER-004). */
  readonly triggerItems?: unknown;
  /**
   * Warnings about the description itself, carried into
   * {@link VerificationReport.shapeWarnings}. The CLI passes `parseWorkflowJson`'s guessed
   * node shapes here.
   */
  readonly shapeWarnings?: readonly string[];
  /** Called as each check completes, so a CLI can stream a long run. */
  readonly onCheck?: (check: PropertyCheck) => void;
}
