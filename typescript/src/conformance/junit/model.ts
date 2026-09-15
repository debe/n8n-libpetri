/**
 * What a junit report says, as the matrix reads it: one suite per test file, one case per
 * test, each case passed, failed or skipped. `junit.ts` builds these from the XML tree.
 */

export type CaseStatus = 'pass' | 'fail' | 'skip';

export interface JunitCase {
  /** The `classname` attribute: the test file, relative to the package root. */
  readonly file: string;
  /** The full case name, describe path included, joined with ` > ` as vitest does. */
  readonly name: string;
  readonly status: CaseStatus;
  /** Seconds, as reported; 0 when absent. */
  readonly time: number;
  /** For a failed case: the `<failure>`/`<error>` message and body. */
  readonly detail?: string;
}

export interface JunitSuite {
  readonly name: string;
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly skipped: number;
  readonly time: number;
  readonly cases: readonly JunitCase[];
}

export interface JunitReport {
  readonly name: string;
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly suites: readonly JunitSuite[];
}
