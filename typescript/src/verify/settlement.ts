/**
 * The `engineV2` report: the `settlement` family over the net's state-class graph
 * (`tasks/v2-profile-plan.md` step 12, decision 18).
 *
 * The same net serves execution and verification here too: {@link verifySettlement} reads the
 * `CompiledWorkflow` the differential and the golden replay run (`conformance/v2/`), never a
 * separate model of it.
 *
 * ## One route, and what it licenses
 *
 * The report is decided by libpetri's state-class graph (VER-010) alone. Every question is
 * reachability-safety, and the graph expands every base-enabled transition and every `xor`
 * branch, so the explored set is a superset of what the executor reaches: a `proven` over a
 * **complete** graph transfers. A violation is a class of that graph, which is a witness in the
 * priority- and value-blind abstraction (VER-004): a run in which some node produced the outputs
 * that branch names. That is the only direction a witness is reported in.
 *
 * Why the graph closes where v1's does not: an `engineV2` net has no counter a loop accumulates.
 * A loop is folded (decision 6), so a pass returns the loop's places to the marking the previous
 * pass started from, and the reachable markings of a loop workflow are finite. There is no
 * `bounded` verdict to give, and none is given.
 *
 * ## What is not here
 *
 * - **No SMT fallback.** A truncated graph reports every violation its prefix holds and leaves
 *   the rest `unknown`, with the cap in the reason. Wiring libpetri's `SmtVerifier` for these
 *   questions is open work; the at-rest checks would need `deadlockFree` with the settlement
 *   rest set as sinks and `_halt` as a conditional sink (VER-014).
 * - **No budget, no invariants.** An `engineV2` net has no `_budget` (decision 3), so the
 *   report's budget fields carry the compiler's unused default and the P-invariant pipeline is
 *   never run.
 * - **The v1 families.** Asked of an `engineV2` net, each is one `unknown` check saying it is not
 *   applicable and why (`families/not-applicable.ts`), never a silent pass.
 */
import { performance } from 'node:perf_hooks';
import type { PetriNet } from 'libpetri';
import type { MarkingState, StateClassGraph } from 'libpetri/verification';
import { flatten } from 'libpetri/verification';
import { assertProfile, type CompiledWorkflow, type NetMapView } from '../compiler/index.js';
import { messageOf } from '../internal/errors.js';
import { markingStateOf } from './marking.js';
import { runSettlementFamily } from './families/v2-settlement.js';
import { recordNotApplicable } from './families/not-applicable.js';
import { countVerdicts } from './report/assemble.js';
import { rethrowIfBug } from './rethrow-if-bug.js';
import { resolveSolver } from './solver.js';
import { buildStateClassGraph } from './state-space/build.js';
import { DEFAULT_MAX_CLASSES, effectiveMaxClasses } from './state-space/cap.js';
import { ClassDecoder } from './state-space/decode.js';
import { SettlementSurvey, settlementQuestionsOf, type SettlementQuestions } from './state-space/settlement-survey.js';
import { truncationCauseOf } from './state-space/truncation.js';
import type {
  PropertyCheck, PropertyName, StateSpaceSummary, TruncationCause, VerificationReport, VerifyOptions,
} from './types.js';

/** The `engineV2` report's own route: one exploration, its survey, and how it ran. */
export interface SettlementSpace {
  readonly graph: StateClassGraph | null;
  readonly survey: SettlementSurvey | null;
  readonly decoder: ClassDecoder | null;
  readonly questions: SettlementQuestions;
  readonly classes: number;
  readonly complete: boolean;
  readonly maxClasses: number;
  readonly requestedMaxClasses: number;
  readonly elapsedMs: number;
  readonly error: string | null;
  readonly truncation: TruncationCause | null;
}

/** What the `settlement` family and the not-applicable records share. */
export interface SettlementContext {
  readonly compiled: CompiledWorkflow;
  readonly space: SettlementSpace;
  readonly checks: PropertyCheck[];
  readonly onCheck: ((check: PropertyCheck) => void) | undefined;
}

/**
 * Builds the state-class graph of an `engineV2` net from `initialMarking`, bounded by
 * `maxClasses` and by the heap (`state-space/cap.ts`), and surveys it. The one place the
 * `engineV2` graph is constructed, as `StateSpace.explore` is for v1. Refuses a v1 map with
 * `ProfileMismatchError`, and never throws on a net libpetri refuses: the space is then unusable
 * and every check `unknown`.
 *
 * A report explores from `compiled.initialMarking(null)`, one unit on the trigger's `T/in`. The
 * marking is a parameter so that a test can start the net somewhere else and watch a check fail.
 */
export function exploreSettlement(
  net: PetriNet, initialMarking: MarkingState, map: NetMapView, maxClasses: number = DEFAULT_MAX_CLASSES,
): SettlementSpace {
  assertProfile('exploreSettlement', 'engineV2', map.profile);
  const started = performance.now();
  const questions = settlementQuestionsOf(map);
  const cap = effectiveMaxClasses(maxClasses);
  let graph: StateClassGraph | null = null;
  let error: string | null = null;
  try {
    graph = buildStateClassGraph(net, initialMarking, cap);
  } catch (e) {
    rethrowIfBug(e);
    error = messageOf(e);
  }
  const survey = graph === null ? null : new SettlementSurvey(graph, map, questions);
  const complete = graph !== null && graph.isComplete();
  return {
    graph,
    survey,
    decoder: graph === null ? null : new ClassDecoder(graph, map),
    questions,
    classes: graph === null ? 0 : graph.size(),
    complete,
    maxClasses: cap,
    requestedMaxClasses: maxClasses,
    elapsedMs: performance.now() - started,
    error,
    truncation: complete || graph === null ? null : truncationCauseOf(cap, {
      // A folded loop has finite markings (see the module note), so a cycle is not the cause.
      hasCycle: false,
      independentBranches: branches(map),
      agents: [],
    }),
  };
}

/** Verifies an `engineV2` net: the `settlement` family, plus a not-applicable record per v1 family asked for. */
export function verifySettlement(
  compiled: CompiledWorkflow, options: VerifyOptions, properties: readonly PropertyName[], started: number,
): VerificationReport {
  const space = exploreSettlement(
    compiled.net, markingStateOf(compiled.initialMarking(null)), compiled.netMap, options.maxClasses ?? DEFAULT_MAX_CLASSES);
  const ctx: SettlementContext = { compiled, space, checks: [], onCheck: options.onCheck };
  for (const property of properties) {
    if (property === 'settlement') runSettlementFamily(ctx);
    else recordNotApplicable(ctx, property, 'engineV2');
  }
  const counts = countVerdicts(ctx.checks);
  return {
    workflow: compiled.net.name,
    profile: 'engineV2',
    structuralHash: compiled.structuralHash,
    requestedBudget: compiled.requestedBudget,
    budget: compiled.effectiveBudget,
    budgetRestriction: compiled.budgetRestriction,
    solver: resolveSolver(),
    net: {
      places: compiled.net.places.size,
      transitions: compiled.net.transitions.size,
      flatTransitions: flatten(compiled.net).transitions.length,
    },
    stateSpace: summaryOf(space),
    invariants: { basis: 0, semiflowsEncoded: 0, encoded: 0, budgetSemiflow: null },
    timeoutMs: 0,
    properties,
    checks: ctx.checks,
    counts,
    ok: counts.violated === 0,
    diagnostics: compiled.diagnostics,
    shapeWarnings: options.shapeWarnings ?? [],
    elapsedMs: performance.now() - started,
  };
}

/** Some node has two or more distinct successors: branches that interleave. */
function branches(map: NetMapView): boolean {
  return map.settlements.some((g) =>
    new Set(g.outputs.flatMap((o) => o.edges.map((e) => e.edge.to))).size > 1);
}

function summaryOf(space: SettlementSpace): StateSpaceSummary {
  const survey = space.survey;
  return {
    classes: space.classes,
    complete: space.complete,
    maxClasses: space.maxClasses,
    requestedMaxClasses: space.requestedMaxClasses,
    elapsedMs: space.elapsedMs,
    quiescent: survey?.quiescentClasses ?? 0,
    terminal: survey?.haltedClasses ?? 0,
    strandedPlaces: survey?.residueBy.size ?? 0,
    truncation: space.truncation,
    agents: [],
    expanded: survey?.expandedClasses ?? 0,
    boundedCyclicRuns: null,
    loopSteps: 0,
    error: space.error,
  };
}
