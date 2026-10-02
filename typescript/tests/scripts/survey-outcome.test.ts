/**
 * The template survey's outcome rule (`scripts/templates/survey-outcome.mjs`): a run that printed
 * a report but decided no check is `undecided`, never `verified` (review finding: the engineV2
 * survey counted 6 such runs among its 91 "verified"). The survey itself needs the corpus; the
 * rule does not.
 */
import { describe, expect, it } from 'vitest';

interface Run { killed: boolean; exitCode: number; stdout: string; stderr: string; errorMessage?: string }
interface Outcome { outcome: string; why?: string; exitCode?: number; report?: unknown }
interface SurveyOutcome {
  decidedCount(report: unknown): number;
  outcomeOf(run: Run): Outcome;
}

// A computed specifier: the module is plain JavaScript outside the TypeScript project.
const specifier = new URL('../../../scripts/templates/survey-outcome.mjs', import.meta.url).href;
const { decidedCount, outcomeOf } = (await import(specifier)) as SurveyOutcome;

const report = (counts: Record<string, number>) => JSON.stringify({ profile: 'engineV2', counts, checks: [] });
const run = (stdout: string, exitCode = 0, stderr = ''): Run => ({ killed: false, exitCode, stdout, stderr });

describe('the survey outcome', () => {
  it('counts proven, violated and bounded as decided, and unknown as not', () => {
    expect(decidedCount({ counts: { proven: 0, violated: 0, bounded: 0, unknown: 96 } })).toBe(0);
    expect(decidedCount({ counts: { proven: 2, violated: 1, bounded: 1, unknown: 5 } })).toBe(4);
    expect(decidedCount({})).toBe(0);
  });

  it('calls a report that decided nothing undecided, whatever the exit code', () => {
    // engineV2: the CLI exits 3 for it. v1 with the SMT route off: the CLI exits 0 for it.
    for (const exitCode of [3, 0]) {
      const o = outcomeOf(run(report({ proven: 0, violated: 0, bounded: 0, unknown: 96 }), exitCode));
      expect(o.outcome, `exit ${exitCode}`).toBe('undecided');
      expect(o.exitCode).toBe(exitCode);
      expect(o.report).toBeDefined();
    }
  });

  it('calls a report with a decided check verified, a violation included (exit 1)', () => {
    expect(outcomeOf(run(report({ proven: 3, violated: 0, bounded: 0, unknown: 1 }))).outcome).toBe('verified');
    expect(outcomeOf(run(report({ proven: 0, violated: 1, bounded: 0, unknown: 0 }), 1)).outcome).toBe('verified');
    expect(outcomeOf(run(report({ proven: 0, violated: 0, bounded: 2, unknown: 0 }))).outcome).toBe('verified');
  });

  it('keeps refusals, timeouts and unparsable output apart', () => {
    expect(outcomeOf(run('', 2, 'wf.json: refused (AmbiguousTriggerError)\n'))).toEqual({
      outcome: 'refused', why: 'wf.json: refused (AmbiguousTriggerError)', exitCode: 2,
    });
    expect(outcomeOf({ killed: true, exitCode: 0, stdout: '', stderr: '' }).outcome).toBe('timeout');
    expect(outcomeOf(run('{not json', 0)).outcome).toBe('unparsable');
  });
});
