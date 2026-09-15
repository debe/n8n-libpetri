/**
 * Which n8n cases exercise the scheduler. The reporting rule (CLAUDE.md): of n8n's
 * execution-engine suite only a small set of cases drives the `executionLoop` that the
 * libpetri scheduler stands in for; the headline is *loop-driving cases passed*, and the far larger
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
 *
 * The rule's data, `LOOP_DRIVING_FILE` and `LOOP_DRIVING_PATTERNS`, lives in `classify/patterns.ts`.
 */
import type { JunitCase } from './junit.js';
import { LOOP_DRIVING_FILE, LOOP_DRIVING_PATTERNS } from './classify/patterns.js';

export { LOOP_DRIVING_FILE, LOOP_DRIVING_PATTERNS } from './classify/patterns.js';
export type { LoopDrivingPattern } from './classify/patterns.js';

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
