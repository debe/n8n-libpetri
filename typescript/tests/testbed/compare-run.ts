/**
 * Compares the executions `run.mjs` captured from a real n8n server, one file per engine leg.
 *
 * The claim under test is the project's own: **the data is identical and the order is not.**
 * So the three sections are kept apart rather than folded into one verdict —
 *
 *  1. *Data*: every node's `ITaskData` compared field by field, minus the fields that are
 *     clocks or positions. The field list mirrors `comparableTask` in
 *     `src/conformance/differ.ts` — `startTime`, `executionTime` and `executionIndex` are left
 *     out there for exactly this reason, and are left out here for the same one.
 *  2. *Happens-before*: every realised dependency edge (`dependencyEdges`, reused verbatim)
 *     must be respected inside each leg. The observation here is the clock n8n stamps on each
 *     task, not a `runNode` trace — a live server has no trace — so an edge is respected when
 *     the producer's `startTime + executionTime` is at or before the consumer's `startTime`.
 *  3. *Order*: `executionOrder` over n8n's own `executionIndex`. Reported, never asserted.
 *     A different order at k > 1 is the feature.
 *
 * Lives under `tests/` and not under `scripts/` so that `npm run check` typechecks it:
 * `tsconfig.test.json` covers every TypeScript file under `tests/`, and vitest collects only
 * the ones named `*.test.ts`, so this is checked but never run as a suite.
 *
 *   npx tsx tests/testbed/compare-run.ts <reference.json> <candidate.json> [more.json ...]
 */
import { readFileSync } from 'node:fs';
import type { IRunData, ITaskData } from 'n8n-workflow';
import { activationKey, dependencyEdges, executionOrder, firstDifference } from '../../src/conformance/differ.js';

interface Capture {
  readonly path: string;
  readonly label: string;
  readonly workflow: string;
  readonly elapsedMs: number;
  readonly status: string;
  readonly runData: IRunData;
}

function load(path: string): Capture {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    workflow: string;
    elapsedMs: number;
    execution: { status: string; data: { resultData: { runData: IRunData } } };
  };
  const label = path.replace(/^.*\//, '').replace(/\.json$/, '');
  return {
    path,
    label,
    workflow: raw.workflow,
    elapsedMs: raw.elapsedMs,
    status: raw.execution.status,
    runData: raw.execution.data.resultData.runData,
  };
}

/** The comparable fields of one task: everything but the clocks and the position. */
function comparable(task: ITaskData): Record<string, unknown> {
  const error = task.error as { name?: string; message?: string } | undefined;
  return {
    data: task.data,
    source: task.source,
    executionStatus: task.executionStatus,
    metadata: task.metadata,
    error: error === undefined ? undefined : { name: error.name, message: error.message },
  };
}

const comparableRunData = (runData: IRunData): Record<string, unknown> =>
  Object.fromEntries(Object.entries(runData).map(([node, tasks]) => [node, tasks.map(comparable)]));

/** `(node, runIndex) -> [start, finish]` from n8n's own per-task clock. */
function windows(runData: IRunData): Map<string, { start: number; finish: number }> {
  const out = new Map<string, { start: number; finish: number }>();
  for (const [node, tasks] of Object.entries(runData)) {
    tasks.forEach((task, runIndex) => {
      const start = task.startTime ?? 0;
      out.set(activationKey(node, runIndex), { start, finish: start + (task.executionTime ?? 0) });
    });
  }
  return out;
}

interface Violation { readonly edge: string; readonly detail: string }

function happensBefore(runData: IRunData): { checked: number; violations: Violation[] } {
  const clock = windows(runData);
  const violations: Violation[] = [];
  const edges = dependencyEdges(runData);
  for (const edge of edges) {
    const from = clock.get(edge.from);
    const to = clock.get(edge.to);
    if (from === undefined || to === undefined) {
      violations.push({ edge: `${edge.from} -> ${edge.to}`, detail: 'an endpoint is absent from runData' });
      continue;
    }
    // `<=` and not `<`: n8n's clock is whole milliseconds, so a node that takes under a
    // millisecond finishes at the instant its consumer starts. Sub-millisecond ordering is
    // below this instrument's resolution and is not evidence of an inversion.
    if (from.finish > to.start) {
      violations.push({ edge: `${edge.from} -> ${edge.to}`, detail: `finish=${from.finish} > start=${to.start}` });
    }
  }
  return { checked: edges.length, violations };
}

const paths = process.argv.slice(2);
if (paths.length < 2) {
  console.error('usage: tsx tests/testbed/compare-run.ts <reference.json> <candidate.json> [more.json ...]');
  process.exit(2);
}

const [reference, ...candidates] = paths.map(load) as [Capture, ...Capture[]];
let failed = false;

console.log(`\n## ${reference.workflow}\n`);
console.log('| leg | status | wall clock | data vs reference | happens-before | order |');
console.log('| --- | --- | --- | --- | --- | --- |');

const referenceOrder = executionOrder(reference.runData).join(' → ');
const referenceHb = happensBefore(reference.runData);
if (referenceHb.violations.length > 0) failed = true;
console.log(
  `| ${reference.label} (reference) | ${reference.status} | ${reference.elapsedMs} ms | — | ` +
    `${referenceHb.violations.length === 0 ? `${referenceHb.checked} edges ok` : `${referenceHb.violations.length} VIOLATED`} | see below |`,
);

const notes: string[] = [];
for (const candidate of candidates) {
  if (candidate.workflow !== reference.workflow) {
    throw new Error(`${candidate.path} is '${candidate.workflow}', not '${reference.workflow}'`);
  }
  const difference = firstDifference(comparableRunData(reference.runData), comparableRunData(candidate.runData), 'runData');
  const hb = happensBefore(candidate.runData);
  const order = executionOrder(candidate.runData).join(' → ');
  if (difference !== null || hb.violations.length > 0 || candidate.status !== reference.status) failed = true;

  console.log(
    `| ${candidate.label} | ${candidate.status} | ${candidate.elapsedMs} ms | ` +
      `${difference === null ? '**identical**' : `**DIFFERS** at \`${difference.path}\``} | ` +
      `${hb.violations.length === 0 ? `${hb.checked} edges ok` : `${hb.violations.length} VIOLATED`} | ` +
      `${order === referenceOrder ? 'same' : 'reordered'} |`,
  );
  if (difference !== null) {
    notes.push(`- \`${candidate.label}\` data difference at \`${difference.path}\`:\n  - reference: ${difference.n8n}\n  - candidate: ${difference.libpetri}`);
  }
  for (const v of hb.violations) notes.push(`- \`${candidate.label}\` happens-before violation on \`${v.edge}\`: ${v.detail}`);
}

console.log('\nExecution order:\n');
console.log(`- ${reference.label}: ${referenceOrder}`);
for (const candidate of candidates) console.log(`- ${candidate.label}: ${executionOrder(candidate.runData).join(' → ')}`);
if (notes.length > 0) console.log(`\n${notes.join('\n')}`);

process.exit(failed ? 1 : 0);
