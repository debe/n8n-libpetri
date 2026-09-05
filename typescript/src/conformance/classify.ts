/**
 * Which n8n cases exercise the scheduler. The reporting rule (CLAUDE.md): of n8n's
 * execution-engine suite only a small set of cases drives the `executionLoop` that the
 * libpetri engine replaces; the headline is *loop-driving cases passed*, and the far larger
 * pure-helper population (`runNode`, `assignPairedItems`, `checkReadyForExecution`, error
 * reporting, contexts, request helpers, …) is stated separately as a regression guard.
 *
 * The classification is by name, so it is reviewable without reading n8n: a case is
 * loop-driving when its file matches `LOOP_DRIVING_FILE` and one of the describe blocks it
 * sits in — every ` > `-separated segment of its name except the last, which is the test's
 * own title — matches a pattern's `pattern`. Titles are matched only when a pattern also
 * sets `title`, and then only to narrow a block that already matched: a helper test may
 * well be titled "… for v1 execution order …", but a block such as `runPartialWorkflow2`
 * mixes cases that run the loop with cases that mock it away. Both lists are the whole
 * rule; the counts each pattern yields on the unpatched baseline are pinned in
 * `tests/conformance/classify.test.ts`.
 */
import type { JunitCase } from './junit.js';

export interface LoopDrivingPattern {
  readonly id: string;
  /** Tested against each describe block name of the case. */
  readonly pattern: RegExp;
  /**
   * When set, the case's own title must match as well. Narrows a block whose cases are
   * not all loop-driving; never widens (a title match without a block match is nothing).
   */
  readonly title?: RegExp;
  /** Why matching cases are scheduler semantics, and what the pattern deliberately avoids. */
  readonly rationale: string;
}

/**
 * The files whose cases can be loop-driving: `workflow-execute*.test.ts`, i.e.
 * `workflow-execute`, `workflow-execute-process-process-run-execution-data`,
 * `workflow-execute-run-node` and `workflow-execute-node-error-reporting`. Only the first
 * two run whole workflows through the loop; the patterns below select those cases.
 */
export const LOOP_DRIVING_FILE = /(^|\/)workflow-execute[^/]*\.test\.ts$/;

export const LOOP_DRIVING_PATTERNS: readonly LoopDrivingPattern[] = [
  {
    id: 'execution-order',
    pattern: /^v\d execution order$/i,
    rationale:
      "n8n's `v0 execution order` / `v1 execution order` suites run fixture workflows " +
      'end to end and assert which nodes ran, in which order, with which data: the loop ' +
      'itself. Whole-block match, so `runNode`\'s "execution order and input data ' +
      'handling" helper suite does not count.',
  },
  {
    id: 'hook-order',
    pattern: /^v\d hook order$/i,
    rationale:
      'The `v0/v1 hook order` suites assert which nodes run at all (run-node filter, ' +
      'missing input data, destination node in exclusive mode) through the per-node hooks ' +
      'the loop fires.',
  },
  {
    id: 'branch-order',
    pattern: /\bbranch(?:es)? order(?:ing)?\b/i,
    rationale:
      'Ordering between sibling branches. Matches nothing in the workflow-execute files at ' +
      'the pinned commit; the equivalent n8n suite lives in ' +
      '`webhook-respond-branch-order.test.ts`, which the file rule leaves out.',
  },
  {
    id: 'waiting',
    pattern: /^(?:runExecutionData\.waitTill|waiting tools)$/,
    rationale:
      "Resuming a waiting execution (`waitTill`, the marking codec's job) and the " +
      '`waiting tools` engine-request round trip that re-queues an agent after its tools ' +
      'ran. Whole-block match, so the `prepareWaitingToExecution` helper suite does not count.',
  },
  {
    id: 'partial',
    pattern: /^runPartialWorkflow2$/,
    title: /^increments partial execution index\b/,
    rationale:
      '`runPartialWorkflow2` rebuilds the execution stack from the previous run data and ' +
      'hands it to `processRunExecutionData`. Eleven of its thirteen cases at the pinned ' +
      'commit replace `processRunExecutionData` with a mock and assert on the stack, the ' +
      'run-node filter or the graph handed over: partial-execution-utils behaviour, not the ' +
      'loop. The two "increments partial execution index …" cases let the loop run and ' +
      'assert the `executionIndex` it stamps on `nodeExecuteBefore`; the title narrows the ' +
      'block to exactly those.',
  },
];

export interface CaseClassification {
  readonly loopDriving: boolean;
  /** The id of the first matching pattern when `loopDriving` is true. */
  readonly pattern?: string;
}

/** The describe blocks a case sits in: every segment of its name but the last. */
export function describeBlocks(name: string): readonly string[] {
  return name.split(' > ').slice(0, -1);
}

/** The test's own title: the last segment of its name. */
export function titleOf(name: string): string {
  return name.split(' > ').at(-1) ?? '';
}

/** Classify one case by file and name. */
export function classifyCase(c: Pick<JunitCase, 'file' | 'name'>): CaseClassification {
  if (!LOOP_DRIVING_FILE.test(c.file)) return { loopDriving: false };
  const blocks = describeBlocks(c.name);
  const title = titleOf(c.name);
  const match = LOOP_DRIVING_PATTERNS.find(
    (p) => blocks.some((b) => p.pattern.test(b)) && (p.title === undefined || p.title.test(title)),
  );
  return match ? { loopDriving: true, pattern: match.id } : { loopDriving: false };
}
