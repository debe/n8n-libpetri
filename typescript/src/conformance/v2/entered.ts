/**
 * The engine v2 settlement leg's report (`tasks/v2-seam-plan.md` step 10, decision 12): the leg's
 * junit joined with the ledger the setup shim wrote (`n8n-v2-vitest-setup.ts`), so the headline is
 * **policy-entering cases passed** — cases in which n8n's handler consulted the registered policy
 * at least once — and every other case is labelled as not entering instead of counted.
 *
 * F5 is read here: a registered policy that no case of the leg entered means the registry was set
 * on a module instance the runtime does not read (`src` against `dist`), or that the scope never
 * builds a runtime through `createEngineRuntime` and settles a step. The caller says which it
 * expects (`expectEntering`); the report states the count either way.
 *
 * Cases are paired by `caseKeys`' rule: file and full name, repeats numbered in order. The ledger
 * is written in run order and junit in definition order, which agree for a file whose cases run
 * one after another; a ledger record without a junit case, or the reverse, is listed.
 */
import { caseKeys } from '../junit/case-keys.js';
import type { CaseStatus, JunitCase, JunitReport } from '../junit/model.js';
import { allCases } from '../junit.js';
import type { SettlementCounts, SettlementLedgerRecord } from '../../n8n-v2-vitest-setup.js';

/** A ledger line that is not JSON, or not a record the shim writes. */
export class LedgerParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`ledger line ${line}: ${message}`);
    this.name = 'LedgerParseError';
  }
}

const KINDS = new Set(['case', 'file', 'error', 'shadow']);

/** Parses the JSONL ledger. Blank lines are skipped. */
export function parseLedger(text: string): SettlementLedgerRecord[] {
  const out: SettlementLedgerRecord[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new LedgerParseError('not JSON', i + 1);
    }
    const kind = (value as { kind?: unknown } | null)?.kind;
    if (typeof kind !== 'string' || !KINDS.has(kind)) throw new LedgerParseError(`unknown record kind ${JSON.stringify(kind)}`, i + 1);
    out.push(value as SettlementLedgerRecord);
  });
  return out;
}

const entered = (c: SettlementCounts): number => c.decideSuccessors + c.isFinished;

export interface EnteredCase {
  readonly file: string;
  readonly name: string;
  readonly status: CaseStatus;
  /** `null` when the shim wrote no record for the case (skipped, todo, or the shim did not run). */
  readonly counts: SettlementCounts | null;
}

export interface FileSummary {
  readonly file: string;
  /** `null` when the ledger has no file record (the shim did not run in that file). */
  readonly registered: boolean | null;
  readonly reason: string | null;
  readonly cases: number;
  readonly enteringCases: number;
  readonly enteringPassed: number;
  /** Policy calls inside cases, and outside every case window. */
  readonly callsInCases: number;
  readonly callsOutside: number;
  readonly errors: number;
  readonly races: number;
}

export interface EnteredReport {
  readonly label: string;
  readonly mode: string | null;
  readonly cases: readonly EnteredCase[];
  readonly entering: { readonly total: number; readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly notEntering: { readonly total: number; readonly passed: number; readonly failed: number; readonly skipped: number };
  /** Junit cases with no ledger record. */
  readonly unrecorded: { readonly total: number; readonly passed: number; readonly failed: number; readonly skipped: number };
  /** Ledger case records with no junit case. */
  readonly orphanRecords: readonly string[];
  readonly files: readonly FileSummary[];
  readonly registeredFiles: number;
  readonly unregisteredFiles: readonly { readonly file: string; readonly reason: string | null }[];
  /** Every `settlement policy entered`, in cases and outside them. */
  readonly totalCalls: number;
  readonly errors: readonly Extract<SettlementLedgerRecord, { kind: 'error' }>[];
  readonly shadow: { readonly agree: number; readonly disagree: number; readonly race: number; readonly candidateThrew: number; readonly stale: number };
  /**
   * In the shadow modes, policy calls no verdict accounts for: every shadowed call yields exactly
   * one verdict, except a `primary-shadowed` call whose primary (ours) threw, which is an error
   * and no report. Nonzero means a verdict went uncounted; 0 in `primary`.
   */
  readonly shadowUnaccounted: number;
  readonly shadowFindings: readonly Extract<SettlementLedgerRecord, { kind: 'shadow' }>[];
  readonly races: number;
  /** F5 as the leg reads it: registered in some file, entered in none. */
  readonly registeredWithoutEntering: boolean;
}

const tally = (cases: readonly EnteredCase[]) => ({
  total: cases.length,
  passed: cases.filter((c) => c.status === 'pass').length,
  failed: cases.filter((c) => c.status === 'fail').length,
  skipped: cases.filter((c) => c.status === 'skip').length,
});

/** Joins the leg's junit with its ledger (see the module doc). */
export function buildEnteredReport(junit: JunitReport, ledger: readonly SettlementLedgerRecord[], label = 'leg'): EnteredReport {
  const caseRecords = ledger.filter((r): r is Extract<SettlementLedgerRecord, { kind: 'case' }> => r.kind === 'case');
  const fileRecords = ledger.filter((r): r is Extract<SettlementLedgerRecord, { kind: 'file' }> => r.kind === 'file');
  const errors = ledger.filter((r): r is Extract<SettlementLedgerRecord, { kind: 'error' }> => r.kind === 'error');
  const shadowFindings = ledger.filter((r): r is Extract<SettlementLedgerRecord, { kind: 'shadow' }> => r.kind === 'shadow');

  const recordKeys = caseKeys(caseRecords.map((r): JunitCase => ({ file: r.file, name: r.name, status: 'pass', time: 0 })));
  const countsByKey = new Map<string, SettlementCounts>();
  let i = 0;
  for (const key of recordKeys.keys()) countsByKey.set(key, caseRecords[i++]!.counts);

  const junitKeys = caseKeys(allCases(junit));
  const cases: EnteredCase[] = [];
  for (const [key, c] of junitKeys) cases.push({ file: c.file, name: c.name, status: c.status, counts: countsByKey.get(key) ?? null });
  const orphanRecords = [...countsByKey.keys()].filter((k) => !junitKeys.has(k));

  // A file record per file; a file run twice (vitest retries a crashed worker) keeps the last.
  const fileByName = new Map(fileRecords.map((r) => [r.file, r]));
  const fileNames = [...new Set([...cases.map((c) => c.file), ...fileByName.keys()])];
  const files: FileSummary[] = fileNames.map((file) => {
    const fc = cases.filter((c) => c.file === file);
    const rec = fileByName.get(file);
    const inCases = fc.reduce((a, c) => a + (c.counts === null ? 0 : entered(c.counts)), 0);
    const entering = fc.filter((c) => c.counts !== null && entered(c.counts) > 0);
    return {
      file,
      registered: rec?.registered ?? null,
      reason: rec?.reason ?? null,
      cases: fc.length,
      enteringCases: entering.length,
      enteringPassed: entering.filter((c) => c.status === 'pass').length,
      callsInCases: inCases,
      callsOutside: rec === undefined ? 0 : entered(rec.outside),
      errors: fc.reduce((a, c) => a + (c.counts?.errors ?? 0), 0) + (rec?.outside.errors ?? 0),
      races: fc.reduce((a, c) => a + (c.counts?.races ?? 0), 0) + (rec?.outside.races ?? 0),
    };
  });

  const sumAll = (pick: (c: SettlementCounts) => number): number =>
    caseRecords.reduce((a, r) => a + pick(r.counts), 0) + fileRecords.reduce((a, r) => a + pick(r.outside), 0);
  const totalCalls = sumAll(entered);
  const registeredFiles = fileRecords.filter((r) => r.registered).length;
  const mode = fileRecords[0]?.mode ?? null;
  const shadow = {
    agree: sumAll((c) => c.agree),
    disagree: sumAll((c) => c.disagree),
    race: sumAll((c) => c.shadowRace),
    candidateThrew: sumAll((c) => c.candidateThrew),
    // A ledger written before the shim counted `stale` has no field: 0 here, and the verdict
    // shows up in `shadowUnaccounted` instead of disappearing.
    stale: sumAll((c) => c.stale ?? 0),
  };

  return {
    label,
    mode,
    cases,
    entering: tally(cases.filter((c) => c.counts !== null && entered(c.counts) > 0)),
    notEntering: tally(cases.filter((c) => c.counts !== null && entered(c.counts) === 0)),
    unrecorded: tally(cases.filter((c) => c.counts === null)),
    orphanRecords,
    files,
    registeredFiles,
    unregisteredFiles: fileRecords.filter((r) => !r.registered).map((r) => ({ file: r.file, reason: r.reason })),
    totalCalls,
    errors,
    shadow,
    shadowUnaccounted: mode === 'shadow' || mode === 'primary-shadowed'
      ? totalCalls - (shadow.agree + shadow.disagree + shadow.race + shadow.candidateThrew + shadow.stale) - (mode === 'primary-shadowed' ? errors.length : 0)
      : 0,
    shadowFindings,
    races: sumAll((c) => c.races),
    registeredWithoutEntering: registeredFiles > 0 && totalCalls === 0,
  };
}

const verdicts = (r: EnteredReport): string =>
  `agree ${r.shadow.agree}, disagree ${r.shadow.disagree}, stale ${r.shadow.stale}, race ${r.shadow.race}, candidate threw ${r.shadow.candidateThrew}` +
  (r.shadowUnaccounted === 0 ? '' : `, UNACCOUNTED ${r.shadowUnaccounted}`);

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * The one-line headline: policy-entering cases passed, with what is not counted beside it. In
 * `shadow` mode n8n's default answered and the net-backed policy only ran beside it, so the pass
 * count is n8n's and the headline says so; the shadow verdicts are the result there.
 */
export function enteredHeadline(r: EnteredReport): string {
  const shadow = r.mode === 'shadow'
    ? `shadow mode, n8n's default answered (${verdicts(r)}); `
    : r.mode === 'primary-shadowed'
      ? `primary-shadowed (${verdicts(r)}); `
      : '';
  const what = r.mode === 'shadow' ? 'cases that entered the shadowed policy, passed under n8n\'s answers' : 'policy-entering cases passed';
  return `${shadow}${what}: ${r.entering.passed} of ${r.entering.total}` +
    ` (${r.entering.failed} failed); not entering: ${r.notEntering.total}` +
    ` (${r.notEntering.passed} passed, ${r.notEntering.failed} failed); no record: ${r.unrecorded.total}` +
    ` (${r.unrecorded.skipped} skipped); policy calls ${r.totalCalls}, errors ${r.errors.length}` +
    `; registered in ${r.registeredFiles} file(s)`;
}

/** The Markdown report. */
export function renderEnteredReport(r: EnteredReport): string {
  const lines: string[] = [];
  lines.push(`# Settlement leg ${r.label}: policy-entering cases`);
  lines.push('');
  lines.push(enteredHeadline(r));
  lines.push('');
  lines.push('This counts cases in which the registered net-backed `SettlementPolicy` was consulted by n8n\'s');
  lines.push('`StepSettledHandler` at least once. It is not a conformance number for engine v1 and not a');
  lines.push('neutrality leg. A case that never entered the policy ran n8n\'s code only and is labelled, not counted.');
  lines.push('');
  lines.push(`Mode: ${r.mode ?? 'unknown'}. Named races decided: ${r.races}.`);
  if (r.mode !== null && r.mode !== 'primary') {
    lines.push(`Shadow verdicts: ${verdicts(r)}. \`stale\` is a reused \`isFinished\` that said false where the fresh side said true: counted, not an agreement.`);
    if (r.shadowUnaccounted !== 0) {
      lines.push('');
      lines.push(`**Unaccounted shadow calls: ${r.shadowUnaccounted}.** Policy calls and verdicts do not add up; a verdict went uncounted.`);
    }
  }
  if (r.registeredWithoutEntering) {
    lines.push('');
    lines.push('**Registered without entering.** The policy was set in some file and consulted in none.');
  }
  lines.push('');
  lines.push('| file | registered | cases | entering | entering passed | calls in cases | calls outside | errors | races |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const f of r.files) {
    const reg = f.registered === null ? 'no record' : f.registered ? 'yes' : `no (${cell(f.reason ?? '')})`;
    lines.push(`| ${cell(f.file)} | ${reg} | ${f.cases} | ${f.enteringCases} | ${f.enteringPassed} | ${f.callsInCases} | ${f.callsOutside} | ${f.errors} | ${f.races} |`);
  }
  const failedEntering = r.cases.filter((c) => c.counts !== null && entered(c.counts) > 0 && c.status === 'fail');
  if (failedEntering.length > 0) {
    lines.push('');
    lines.push('## Policy-entering cases that failed');
    lines.push('');
    for (const c of failedEntering) lines.push(`- ${cell(c.file)} :: ${cell(c.name)}`);
  }
  if (r.errors.length > 0) {
    lines.push('');
    lines.push('## Policy errors');
    lines.push('');
    for (const e of r.errors.slice(0, 50)) lines.push(`- ${cell(e.file)} :: ${cell(e.name ?? '(outside any case)')}: ${e.method} ${e.errorName}: ${cell(e.error.split('\n')[0] ?? '')}`);
    if (r.errors.length > 50) lines.push(`- … and ${r.errors.length - 50} more`);
  }
  if (r.shadowFindings.length > 0) {
    lines.push('');
    lines.push('## Shadow reports that are not agreements');
    lines.push('');
    for (const s of r.shadowFindings.slice(0, 50)) {
      lines.push(`- ${cell(s.file)} :: ${cell(s.name ?? '(outside any case)')}: ${s.report.method} ${s.report.verdict}` +
        `${s.report.race === null ? '' : ` (${s.report.race})`} primary ${cell(JSON.stringify(s.report.primary))}` +
        ` candidate ${cell(JSON.stringify(s.report.candidate))}${s.report.error === null ? '' : ` error ${cell(s.report.error)}`}`);
    }
  }
  const notEntering = r.cases.filter((c) => c.counts !== null && entered(c.counts) === 0);
  if (notEntering.length > 0) {
    lines.push('');
    lines.push(`## Cases that never entered the policy (${notEntering.length})`);
    lines.push('');
    lines.push('These ran with the policy registered and never reached it: their result is n8n\'s code.');
    lines.push('');
    for (const c of notEntering) lines.push(`- ${c.status} ${cell(c.file)} :: ${cell(c.name)}`);
  }
  if (r.unrecorded.total > 0) {
    lines.push('');
    lines.push(`## Cases with no ledger record (${r.unrecorded.total})`);
    lines.push('');
    for (const c of r.cases.filter((x) => x.counts === null)) lines.push(`- ${c.status} ${cell(c.file)} :: ${cell(c.name)}`);
  }
  if (r.orphanRecords.length > 0) {
    lines.push('');
    lines.push(`## Ledger records with no junit case (${r.orphanRecords.length})`);
    lines.push('');
    for (const k of r.orphanRecords) lines.push(`- ${cell(k)}`);
  }
  lines.push('');
  return lines.join('\n');
}
