/**
 * Verification over the compiled net (the same net that executes).
 *
 * `verify(workflow, options)` compiles with the scheduler's own `compile()` and asks six
 * property families of the net it produced. Since M5 the **primary** decision procedure is
 * the solver-free one: libpetri's state-class graph (VER-010, `state-class.ts`), enumerated
 * once per report, which decides every reachability-safety question exactly when it closes.
 * libpetri's `SmtVerifier` (IC3/PDR through z3, VER-001/VER-013) is the **fallback**, run
 * only where the graph truncated — the order NU-053 prescribes, and the inverse of M4's.
 *
 * - **proper completion** — one whole-net check plus one per join input and per edge place:
 *   no reachable quiescent marking leaves pending work behind, with the designed terminals
 *   (a paused or halted run, whose pending activations the marking codec writes back)
 *   classified rather than reported. The SMT fallback is one whole-net `deadlockFree` query
 *   with the structural rest set as sinks (VER-002).
 * - **dead nodes** — `X/running` unreachable, which is the finding, so the check reports
 *   `violated`; a node the route *reaches* is `unknown`, never `proven` (VER-004 AC3).
 * - **no double activation** — `X/running` never holds two tokens.
 * - **budget** — `_budget` never exceeds `k`, plus the two-phase P-semiflow (VER-007), the
 *   one claim the solver-free route cannot make and the only reason a report still pays for
 *   the P-invariant pipeline.
 * - **retry bound** — `X/tries` bounded **and** a structural check that nothing produces it.
 * - **mutual exclusion** — two nodes never running at once, for a pair or every pair.
 *
 * Counterexamples are decoded through `NetMap` into node paths, never place names; a
 * stranding carries the firing sequence that reaches it. Without z3 the solver-free route
 * still decides everything a complete graph decides; the fallbacks come back `unknown` with
 * a reason naming `PATH` and `LIBPETRI_Z3` (VER-013), never a throw.
 *
 * A graph that **truncates** — a cyclic workflow's state space is unbounded, a heavily
 * parallel one's is combinatorial (NU-053) — never yields a `proven`. It still reports every
 * violation it found, and on a cyclic workflow it reports the fourth verdict, `bounded`:
 * the property holds for every run in which the workflow's cyclic nodes run at most
 * `stateSpace.boundedCyclicRuns` times, which the explored prefix closes exactly. That is
 * sound and is deliberately not a proof — it is counted apart from the proofs and fails
 * `--strict`.
 *
 * Both routes are priority-blind and value-blind (VER-004) and model a firing as atomic:
 * nothing here proves anything about order or about what a node returns, and only the
 * *proof* direction of a safety property is a verdict — a witness (a "live" node) is a
 * statement about the abstraction, so liveness comes back `unknown`. Every verdict is about
 * markings reachable from the **fresh initial marking**; a resumed or retried execution
 * starts from a codec-decoded marking outside that set. What each property does and does not
 * establish, and what each one costs, is in `docs/verification.md` and
 * `docs/adr/0007-verification.md`.
 *
 * Milestones M4 (the surface) and M5 (the solver-free route).
 */
export {
  verify, verifyCompiled, assertLibpetriSurface, DEFAULT_PROPERTIES, DEFAULT_TIMEOUT_MS, SMT_MAX_FLAT_PLACES,
  SMT_MAX_JOIN_INPUTS, alternativeEntryReach, budgetSemiflowOf, exclusionPairs, invariantTerms,
  markingStateOf, producersOf, renderInvariant, resolveSolver, selectProperties, smtRefusalFor,
  truncationShapeOf,
} from './verify.js';
export {
  decodeCounterexample, decodeMarking, decodeStep, renderMarkedPlace, renderNodePath, stripBranch,
} from './counterexample.js';
export { renderFinding, renderHeader, renderReport, renderSubject, renderTable } from './report.js';
export {
  CoMarkings, StateSpace, DEFAULT_MAX_CLASSES, HALT_REST_ROLES, MAX_WITNESSES, PAUSE_REST_ROLES,
  REST_ROLES, TERMINAL_ROLES, effectiveMaxClasses, loopTransitions, restRolesFor, terminalKindOf,
  witnessCounterexample,
} from './state-class.js';
export type { Stranding, TerminalKind, TruncationCause, TruncationShape, Witness } from './state-class.js';
export { PROPERTY_NAMES } from './types.js';
export type {
  CheckRoute, CheckSubject, CheckVerdict, Counterexample, CounterexampleStep, InvariantSummary,
  MarkedPlace, MutualExclusionRequest, NetSize, PropertyCheck, PropertyName, QueryRecord,
  SmtFallbackMode, SolverInfo, StateSpaceSummary, VerificationReport, VerifyOptions,
} from './types.js';
export {
  BUILT_IN_SHAPES, connectionsOf, describeWorkflowJson, looksLikeTrigger, parseWorkflowJson,
  pickStartNode, shapeOf,
} from './workflow-json.js';
export type { NodeTypesFile, WorkflowJsonOptions, WorkflowJsonResult } from './workflow-json.js';
export { USAGE, nodeIo, parseArgs, runCli } from './cli.js';
export type { CliIo } from './cli.js';
