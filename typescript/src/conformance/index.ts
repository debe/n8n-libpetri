/**
 * Conformance harness: n8n's execution-engine suite is run under `CI=true` (which makes
 * `@n8n/vitest-config` emit junit.xml) on the unpatched tree, on the patched tree and,
 * once the libpetri scheduler exists, under both engines. This module parses those reports,
 * classifies every case as loop-driving or pure-helper and builds the matrix whose headline
 * is loop-driving cases passed. `scripts/run-conformance.sh` drives it through `cli.ts`.
 *
 * Milestone M1 (junit → matrix). The differential trace differ (data equivalence and
 * happens-before, never total order) is milestone M3.
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
