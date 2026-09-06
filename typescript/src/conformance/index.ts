/**
 * Conformance harness: n8n's execution-engine suite is run under `CI=true` (which makes
 * `@n8n/vitest-config` emit junit.xml) on the unpatched tree, on the patched tree and,
 * once the libpetri scheduler exists, under both engines. This module parses those reports,
 * classifies every case as loop-driving or pure-helper and builds the matrix whose headline
 * is loop-driving cases passed. `scripts/run-conformance.sh` drives it through `cli.ts`.
 *
 * Milestone M1 (junit → matrix). Milestone M3 adds the in-process differential harness:
 * `harness.ts` (the fake n8n host both engines run on), `stack-reference.ts` (n8n's own
 * loop, ported) and `differ.ts` (data equivalence, happens-before, attributed ordering).
 */
export type { CaseStatus, JunitCase, JunitSuite, JunitReport, XmlElement, XmlNode } from './junit.js';
export { parseJunit, parseXml, decodeEntities, allCases, caseKeys, JunitParseError } from './junit.js';
export type { LoopDrivingPattern, CaseClassification } from './classify.js';
export { LOOP_DRIVING_FILE, LOOP_DRIVING_PATTERNS, classifyCase, describeBlocks, titleOf } from './classify.js';
export type { EngineStatus, Verdict, MatrixRow, Tally, ConformanceMatrix, MatrixOptions } from './matrix.js';
export { buildMatrix } from './matrix.js';
export { renderMatrix } from './report.js';
export type { CliIo } from './cli.js';
export { runCli, USAGE } from './cli.js';
export type {
  FakeWorkflowOptions, FakeHostOptions, RunDataOptions, ScriptContext, NodeScript, HookFailures,
} from './harness.js';
export {
  FakeHost, fakeHooks, fakeNodeHelpers, fakeWorkflow, newRunExecutionData, toINode, passThrough, items, sleep, ITEM,
} from './harness.js';
export { ReferenceHost, StackReferenceScheduler, referenceHost } from './stack-reference.js';
export type {
  DifferFixture, EngineName, TraceEvent, Activation, EngineRun, DataDifference, DataAttribution,
  AttributedDifference, DataComparison, DependencyEdge, HappensBeforeViolation, HappensBefore,
  Attribution, OrderDifference, OrderingReport, LastNodeExecuted, AttributionContext, DiffResult,
  SchedulerContract, DataContext,
} from './differ.js';
export {
  activationKey, activationsOf, runReference, runPetri, firstDifference, compareData, descendantsOf,
  strandedNodesOf, orInputNodesOf, dependencyEdges, checkHappensBefore, executionOrder, attribute,
  compareOrdering, diffFixture, diffAll, renderDiffReport,
} from './differ.js';
export type { DifferCliIo } from './differ-cli.js';
export { runDifferCli, fixturesOf, DIFFER_USAGE } from './differ-cli.js';
