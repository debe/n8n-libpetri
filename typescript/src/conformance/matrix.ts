/**
 * The conformance matrix: every case of a baseline report against the same case in a
 * candidate report (the patched tree, or the suite under another engine), each classified
 * as loop-driving or pure-helper. The verdict per row is about the pass/fail/skip status
 * only; timing, output and the reports' own totals do not take part.
 */
import { classifyCase, LOOP_DRIVING_PATTERNS, type CaseClassification } from './classify.js';
import { allCases, caseKeys, type CaseStatus, type JunitCase, type JunitReport } from './junit.js';

/** A case's status in one report, or `missing` when the report has no such case. */
export type EngineStatus = CaseStatus | 'missing';

/**
 * - `same`: identical status in both reports;
 * - `regression`: passed in the baseline, does not pass in the candidate (fail, skip or missing);
 * - `fixed`: did not pass in the baseline, passes in the candidate;
 * - `new`: not in the baseline at all;
 * - `changed`: any other difference (e.g. fail → skip).
 */
export type Verdict = 'same' | 'regression' | 'fixed' | 'new' | 'changed';

export interface MatrixRow {
  readonly key: string;
  readonly file: string;
  readonly name: string;
  readonly classification: CaseClassification;
  readonly baseline: EngineStatus;
  readonly candidate: EngineStatus;
  readonly verdict: Verdict;
}

/** Candidate-side outcome counts over a group of rows. */
export interface Tally {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly missing: number;
}

export interface ConformanceMatrix {
  readonly baselineLabel: string;
  readonly candidateLabel: string;
  readonly rows: readonly MatrixRow[];
  /** The headline: loop-driving rows, by candidate outcome. */
  readonly loopDriving: Tally;
  /** Everything else, stated separately. */
  readonly helper: Tally;
  /**
   * Loop-driving rows per classifier pattern id, in `LOOP_DRIVING_PATTERNS` order; ids a
   * custom classifier introduced follow in order of first appearance. Patterns without a
   * row are absent.
   */
  readonly byPattern: ReadonlyMap<string, Tally>;
  readonly regressions: readonly MatrixRow[];
  readonly fixed: readonly MatrixRow[];
  readonly added: readonly MatrixRow[];
  /** Same case set and same status for every case: what a pure refactor must produce. */
  readonly identical: boolean;
}

export interface MatrixOptions {
  readonly baselineLabel?: string;
  readonly candidateLabel?: string;
  /** Defaults to `classifyCase`. */
  readonly classify?: (c: Pick<JunitCase, 'file' | 'name'>) => CaseClassification;
}

function verdictOf(baseline: EngineStatus, candidate: EngineStatus): Verdict {
  if (baseline === candidate) return 'same';
  if (baseline === 'missing') return 'new';
  if (baseline === 'pass') return 'regression';
  if (candidate === 'pass') return 'fixed';
  return 'changed';
}

function tally(rows: readonly MatrixRow[]): Tally {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let missing = 0;
  for (const r of rows) {
    if (r.candidate === 'pass') passed++;
    else if (r.candidate === 'fail') failed++;
    else if (r.candidate === 'skip') skipped++;
    else missing++;
  }
  return { total: rows.length, passed, failed, skipped, missing };
}

/** Build the matrix. Rows follow the baseline's document order; candidate-only rows come last. */
export function buildMatrix(
  baseline: JunitReport,
  candidate: JunitReport,
  options: MatrixOptions = {},
): ConformanceMatrix {
  const classify = options.classify ?? classifyCase;
  const base = caseKeys(allCases(baseline));
  const cand = caseKeys(allCases(candidate));
  const rows: MatrixRow[] = [];
  const row = (key: string, c: JunitCase, b: EngineStatus, k: EngineStatus): MatrixRow => ({
    key, file: c.file, name: c.name, classification: classify(c),
    baseline: b, candidate: k, verdict: verdictOf(b, k),
  });
  for (const [key, c] of base) rows.push(row(key, c, c.status, cand.get(key)?.status ?? 'missing'));
  for (const [key, c] of cand) if (!base.has(key)) rows.push(row(key, c, 'missing', c.status));

  const loop = rows.filter((r) => r.classification.loopDriving);
  // Pattern order, not document order: the junit lists the waiting cases' file before
  // workflow-execute.test.ts, and the headline should still read in the classifier's order.
  const ids = [...LOOP_DRIVING_PATTERNS.map((p) => p.id), ...loop.map((r) => r.classification.pattern ?? '')];
  const byPattern = new Map<string, Tally>();
  for (const id of ids) {
    if (byPattern.has(id)) continue;
    const group = loop.filter((r) => r.classification.pattern === id);
    if (group.length > 0) byPattern.set(id, tally(group));
  }
  return {
    baselineLabel: options.baselineLabel ?? 'baseline',
    candidateLabel: options.candidateLabel ?? 'candidate',
    rows,
    loopDriving: tally(loop),
    helper: tally(rows.filter((r) => !r.classification.loopDriving)),
    byPattern,
    regressions: rows.filter((r) => r.verdict === 'regression'),
    fixed: rows.filter((r) => r.verdict === 'fixed'),
    added: rows.filter((r) => r.verdict === 'new'),
    identical: rows.every((r) => r.verdict === 'same' && r.baseline !== 'missing'),
  };
}
