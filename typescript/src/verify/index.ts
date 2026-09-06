/**
 * Verification over the compiled net (the same net that executes).
 *
 * `verify(workflow, options)` compiles with the scheduler's own `compile()` and hands the
 * result to libpetri's `SmtVerifier` (`spec/07-verification.md`): proper completion via
 * `joinedOrDeadLettered` per join-input `ready_i` place and per edge data place, with
 * `_pause` and `_halted` as the declared sinks (VER-002, NU-040), plus an arrival bound per
 * input; dead nodes via `unreachable({X/running})`; no double activation via `placeBound`;
 * the retry bound via `placeBound` **and** a structural producer check; the concurrency
 * budget via `placeBound(_budget, k)` plus the two-phase P-semiflow (VER-007); and mutual
 * exclusion of a caller-supplied node pair. Counterexamples are decoded through `NetMap`
 * into node paths, never place names. Without z3 every verdict is `unknown` with a reason
 * naming `PATH` and `LIBPETRI_Z3` (VER-013), never a throw.
 *
 * The encoding is untimed, priority-blind and value-blind (VER-004): nothing here proves
 * anything about firing order or about what a node returns, and only the *proof* direction
 * of a safety property is reported as a verdict — a witness (a "live" node, a violated
 * exclusion) is a statement about the abstraction, so liveness comes back `unknown`. Every
 * verdict is about markings reachable from the **fresh initial marking**; a resumed or
 * retried execution starts from a codec-decoded marking outside that set. What each property
 * does and does not establish — and what each one costs, including the ones that do not
 * close on a real workflow — is in `docs/verification.md` and `docs/adr/0007-verification.md`.
 *
 * Milestone M4.
 */
export {
  verify, verifyCompiled, DEFAULT_PROPERTIES, DEFAULT_TIMEOUT_MS,
  alternativeEntryReach, budgetSemiflowOf, exclusionPairs, invariantTerms, markingStateOf,
  producersOf, renderInvariant, resolveSolver, selectProperties,
} from './verify.js';
export {
  decodeCounterexample, decodeMarking, decodeStep, renderMarkedPlace, renderNodePath, stripBranch,
} from './counterexample.js';
export { renderFinding, renderHeader, renderReport, renderSubject, renderTable } from './report.js';
export { PROPERTY_NAMES } from './types.js';
export type {
  CheckSubject, CheckVerdict, Counterexample, CounterexampleStep, InvariantSummary, MarkedPlace,
  MutualExclusionRequest, NetSize, PropertyCheck, PropertyName, QueryRecord, SolverInfo,
  VerificationReport, VerifyOptions,
} from './types.js';
export {
  BUILT_IN_SHAPES, connectionsOf, describeWorkflowJson, looksLikeTrigger, parseWorkflowJson,
  pickStartNode, shapeOf,
} from './workflow-json.js';
export type { NodeTypesFile, WorkflowJsonOptions, WorkflowJsonResult } from './workflow-json.js';
export { USAGE, nodeIo, parseArgs, runCli } from './cli.js';
export type { CliIo } from './cli.js';
