/**
 * The terminal rendering. Two rules it has to keep: a violation is printed as a node path,
 * and an `unknown` gets its own section so a run whose expensive property did not close is
 * never mistaken for a clean result.
 */
import { renderFinding, renderHeader, renderReport, renderSubject, renderTable } from '../../src/verify/index.js';
import type { PropertyCheck, VerificationReport } from '../../src/verify/index.js';

function check(partial: Partial<PropertyCheck>): PropertyCheck {
  return {
    property: 'budget',
    name: 'a check',
    subject: { kind: 'net' },
    verdict: 'proven',
    explanation: 'it holds',
    reason: null,
    counterexample: null,
    elapsedMs: 120,
    query: { property: 'place-bound', place: '_budget', verdict: 'proven', sinks: [], method: 'IC3/PDR' },
    ...partial,
  };
}

function report(partial: Partial<VerificationReport> = {}): VerificationReport {
  const checks = partial.checks ?? [check({})];
  const counts = { proven: 0, violated: 0, unknown: 0 };
  for (const c of checks) counts[c.verdict]++;
  return {
    workflow: 'demo',
    structuralHash: 'a'.repeat(64),
    requestedBudget: 1,
    budget: 1,
    budgetRestriction: null,
    solver: { available: true, program: '/usr/bin/z3', version: '4.13.0', reason: null },
    net: { places: 63, transitions: 28, flatTransitions: 53 },
    invariants: { basis: 8, semiflowsEncoded: 1, encoded: 9, budgetSemiflow: '_budget + A/running = 1' },
    timeoutMs: 60_000,
    properties: ['budget'],
    checks,
    counts,
    ok: counts.violated === 0,
    diagnostics: [],
    shapeWarnings: [],
    elapsedMs: 1234,
    ...partial,
  };
}

describe('verify report rendering', () => {
  it('names the subject in workflow terms', () => {
    expect(renderSubject({ kind: 'join-input', node: 'Merge', inputIndex: 1, place: 'p' })).toBe('Merge input 1');
    expect(renderSubject({ kind: 'edge', node: 'Merge', place: 'p', from: 'A', outputIndex: 0, inputIndex: 1 }))
      .toBe('A.0 -> Merge.1');
    expect(renderSubject({ kind: 'edge', node: 'Trigger', place: 'p' })).toBe('Trigger input');
    expect(renderSubject({ kind: 'node-pair', nodes: ['A', 'B'] })).toBe('A | B');
    expect(renderSubject({ kind: 'net' })).toBe('(whole net)');
  });

  it('the header states the net size, the budget, the solver and the invariants', () => {
    const lines = renderHeader(report()).join('\n');
    expect(lines).toContain('63 places, 28 transitions, 53 flat');
    expect(lines).toContain('z3 4.13.0');
    expect(lines).toContain('8 basis + 1 semiflow(s) encoded = 9');
    expect(lines).toContain('_budget + A/running = 1');
  });

  it('the header states what the verdicts are about: the fresh initial marking, not a resumed one', () => {
    // Every query starts from `compiled.initialMarking(...)`. A resumed or retried execution
    // starts from a codec-decoded marking that need not be reachable from it, so no verdict
    // here covers it — and the report has to say so, not only the docs.
    const lines = renderHeader(report()).join('\n');
    expect(lines).toContain('fresh initial marking');
    expect(lines).toContain('resumed or retried execution');
  });

  it('guessed node shapes are printed with the report, not only on stderr', () => {
    const text = renderReport(report({
      shapeWarnings: ['Weird (custom.thing): no node-type shape supplied, guessed 1 input(s) / 1 output(s)'],
    }));
    expect(text).toContain('Guessed node shapes (1)');
    expect(text).toContain('the compiled net may differ from the workflow');
    expect(text).toContain('Weird (custom.thing)');
    // Nothing to say when every shape was supplied.
    expect(renderReport(report())).not.toContain('Guessed node shapes');
  });

  it('the header explains a lowered budget', () => {
    const lines = renderHeader(report({
      requestedBudget: 4, budget: 1,
      budgetRestriction: { reason: 'multi-producer-input', detail: 'M.0 has 2 producers' },
    })).join('\n');
    expect(lines).toContain('k = 1 (requested 4, lowered: multi-producer-input — M.0 has 2 producers)');
  });

  it('the table has one row per check plus a header row, named by the check', () => {
    const rows = renderTable([check({ name: 'a check' }), check({ name: 'another', verdict: 'unknown' })]);
    expect(rows[0]).toMatch(/^PROPERTY\s+CHECK\s+VERDICT\s+TIME$/);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('a check');
    expect(rows[1]).toContain('PROVEN');
    expect(rows[2]).toContain('another');
    expect(rows[2]).toContain('unknown');
  });

  it('a finding prints the node path and the marking, never bare place names alone', () => {
    const lines = renderFinding(check({
      property: 'proper-completion',
      verdict: 'violated',
      explanation: 'Merge can be left with an arrival stranded on input 0',
      subject: { kind: 'join-input', node: 'Merge', inputIndex: 0, place: 'id:Merge/ready_0' },
      counterexample: {
        nodePath: ['Trigger', 'A', 'Merge'],
        steps: [],
        stuckMarking: [{ place: 'id:Merge/ready_0', tokens: 1, node: 'Merge', role: 'ready', port: 0 }],
        confirmed: true,
        ordered: true,
      },
    }), 1);
    expect(lines[0]).toContain('1. [proper-completion]');
    expect(lines[1]).toBe('     node path: Trigger -> A -> Merge');
    expect(lines[2]).toContain('Merge port 0 ready (id:Merge/ready_0)');
  });

  it('an unordered witness says so', () => {
    const lines = renderFinding(check({
      verdict: 'violated',
      counterexample: { nodePath: ['A', 'B'], steps: [], stuckMarking: [], confirmed: false, ordered: false },
    }), 2);
    expect(lines[1]).toContain('unordered');
    expect(lines[1]).toContain('A, B');
  });

  it('the whole report lists findings, unknowns and the counts', () => {
    const text = renderReport(report({
      checks: [
        check({}),
        check({ property: 'dead-nodes', verdict: 'violated', explanation: 'Orphan can never run', subject: { kind: 'node', node: 'Orphan' } }),
        check({ property: 'proper-completion', verdict: 'unknown', reason: 'Z3 answered unknown', subject: { kind: 'join-input', node: 'Merge', inputIndex: 0, place: 'p' } }),
      ],
      diagnostics: ['a compiler note'],
    }));
    expect(text).toContain('Compiler diagnostics');
    expect(text).toContain('- a compiler note');
    expect(text).toContain('Findings (1)');
    expect(text).toContain('Orphan can never run');
    expect(text).toContain('Unproven (1)');
    expect(text).toContain('a check: Z3 answered unknown');
    expect(text).toContain('1 proven, 1 violated, 1 unknown');
  });

  it('says when no check ran', () => {
    expect(renderReport(report({ checks: [] }))).toContain('No checks ran');
  });
});
