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
 *
 * The barrel exports what the tests and the benchmark consume, each name from the module
 * that defines it; everything else is reached by its module path.
 */
export { allCases, caseKeys, decodeEntities, JunitParseError, parseJunit, parseXml, type JunitCase, type JunitReport } from './junit.js';
export { classifyCase, describeBlocks, LOOP_DRIVING_FILE, LOOP_DRIVING_PATTERNS, titleOf } from './classify.js';
export { buildMatrix } from './matrix.js';
export { renderMatrix } from './report.js';
export { runCli, USAGE, type CliIo } from './cli.js';
export { items } from './harness/run-data.js';
export { passThrough, sleep, type NodeScript } from './harness/scripts.js';
export { ReferenceHost } from './stack-reference.js';
export { runPetri, runReference, type DifferFixture, type EngineRun } from './engines.js';
export { activationKey, activationsOf, dependencyEdges, type TraceEvent } from './trace.js';
export { firstDifference } from './diff-value.js';
export { compareData } from './gate-data.js';
export { checkHappensBefore, compareOrdering, executionOrder, reachableOf } from './gate-order.js';
export { attribute, descendantsOf, orInputNodesOf, strandedNodesOf, type AttributionContext } from './attribution.js';
export { diffFixture, type DiffResult } from './differ.js';
export { renderDiffReport } from './differ-report.js';
export { fixturesOf, runDifferCli, type DifferCliIo } from './differ-cli.js';
