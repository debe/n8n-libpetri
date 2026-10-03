/**
 * The settlement leg's setup session (`src/n8n-v2-vitest-setup.ts`, `tasks/v2-seam-plan.md`
 * step 10) and its report (`src/conformance/v2/entered.ts`), with no `.n8n`: a fake registry
 * stands in for `@n8n/engine`'s, and the policy is driven through an in-memory reader.
 *
 * - Inert unless `N8N_SETTLEMENT_POLICY=libpetri`; registers on the registry it is handed.
 * - Counts `entered` per case window, and outside every case per file; writes the ledger.
 * - A registry the shim could not import, or one that does not read back, is recorded, not thrown.
 * - The report joins junit and ledger: policy-entering cases passed, not-entering cases labelled,
 *   unrecorded and orphan cases listed, F5 as "registered, never entered".
 * - Every shadow verdict is counted, `stale` included, and the report says when policy calls and
 *   verdicts do not add up (a verdict the tally dropped).
 */
import { describe, expect, it } from 'vitest';
import type { StepRow } from '../../src/codec/v2/step-rows.js';
import { runEnteredCli } from '../../src/conformance/v2/entered-cli.js';
import { buildEnteredReport, enteredHeadline, LedgerParseError, parseLedger, renderEnteredReport } from '../../src/conformance/v2/entered.js';
import { parseJunit } from '../../src/conformance/junit.js';
import type { V2SettlementPolicy, V2SettlementRegistry } from '../../src/n8n/v2-host.js';
import { createSettlementVitestSession, junitNameOf } from '../../src/n8n-v2-vitest-setup.js';
import type { SettlementLedgerRecord, TaskLike } from '../../src/n8n-v2-vitest-setup.js';
import { chain } from '../fixtures/v2-graphs.js';
import { memoryReader } from '../support/settlement-reader.js';

const done = (nodeId: string): StepRow => ({ nodeId, iteration: 0, status: 'completed', filledOutputSlots: [true] });

function registry(): V2SettlementRegistry {
  const theirs: V2SettlementPolicy = { decideSuccessors: async () => ({ toQueue: [], toSkip: [] }), isFinished: async () => true };
  let current = theirs;
  return {
    defaultSettlementPolicy: theirs,
    setSettlementPolicy: (p) => { current = p; },
    getSettlementPolicy: () => current,
    resetSettlementPolicy: () => { current = theirs; },
  };
}

const fileTask: TaskLike = { name: 'src/a.test.ts', filepath: '/abs/src/a.test.ts' };
/** A case under `describes`; `rooted: false` leaves the top-level describe without a suite. */
const task = (name: string, describes: string[] = [], rooted = true): TaskLike => {
  let suite: TaskLike | undefined = rooted ? fileTask : undefined;
  for (const d of describes) suite = { name: d, suite };
  return { name, suite: suite ?? fileTask, file: fileTask };
};

function session(env: Record<string, string>) {
  const lines: string[] = [];
  const logs: string[] = [];
  const s = createSettlementVitestSession({ env, append: (l) => lines.push(l), log: (l) => logs.push(l) });
  return { s, logs, records: () => parseLedger(lines.join('')) };
}

describe('junitNameOf', () => {
  it('joins the describe path and the title as vitest\'s junit reporter does, without the file', () => {
    expect(junitNameOf(task('t'))).toBe('t');
    expect(junitNameOf(task('t', ['outer', 'inner']))).toBe('outer > inner > t');
    expect(junitNameOf(task('t', ['outer', 'inner'], false))).toBe('outer > inner > t');
    expect(junitNameOf(task('t', ['outer'], false))).toBe('outer > t');
  });
});

describe('createSettlementVitestSession', () => {
  it('is inert unless N8N_SETTLEMENT_POLICY is libpetri', () => {
    const { s, records } = session({});
    const engine = registry();
    const before = engine.getSettlementPolicy();
    expect(s.engine).toBe('default');
    expect(s.registerFile('src/a.test.ts', engine)).toBe(false);
    expect(engine.getSettlementPolicy()).toBe(before);
    s.beginCase(task('t'));
    s.endCase(task('t'));
    s.endFile('src/a.test.ts');
    expect(records()).toEqual([]);
  });

  it('refuses an unknown mode', () => {
    expect(() => session({ N8N_SETTLEMENT_POLICY: 'libpetri', N8N_SETTLEMENT_MODE: 'off' })).toThrow(/not one of/);
  });

  it('registers, counts entered per case and outside every case, and writes the ledger', async () => {
    const { s, records } = session({ N8N_SETTLEMENT_POLICY: 'libpetri' });
    const engine = registry();
    expect(s.registerFile('src/a.test.ts', engine)).toBe(true);
    const policy = engine.getSettlementPolicy();
    expect(policy).not.toBe(engine.defaultSettlementPolicy);

    await policy.isFinished(chain, memoryReader([done('T')])); // beforeAll: outside
    s.beginCase(task('settles', ['d']));
    const d = await policy.decideSuccessors(chain, done('T'), memoryReader([done('T')]));
    expect(d.toQueue.map((k) => k.nodeId)).toEqual(['A']);
    await policy.isFinished(chain, memoryReader([done('T')]));
    s.endCase(task('settles', ['d']));
    s.beginCase(task('idle'));
    s.endCase(task('idle'));
    s.endFile('src/a.test.ts');

    const zero = { decideSuccessors: 0, isFinished: 0, races: 0, errors: 0, agree: 0, disagree: 0, shadowRace: 0, candidateThrew: 0, stale: 0 };
    expect(records()).toEqual([
      { kind: 'case', file: 'src/a.test.ts', name: 'd > settles', state: 'unknown', counts: { ...zero, decideSuccessors: 1, isFinished: 1 } },
      { kind: 'case', file: 'src/a.test.ts', name: 'idle', state: 'unknown', counts: zero },
      { kind: 'file', file: 'src/a.test.ts', registered: true, reason: null, mode: 'primary', outside: { ...zero, isFinished: 1 } },
    ]);
  });

  it('records a registry the shim could not import, and one that does not read back, without throwing', () => {
    const { s, records, logs } = session({ N8N_SETTLEMENT_POLICY: 'libpetri' });
    expect(s.registerFile('src/a.test.ts', null, 'mocked away')).toBe(false);
    s.endFile('src/a.test.ts');
    const deaf: V2SettlementRegistry = { ...registry(), setSettlementPolicy: () => {} };
    expect(s.registerFile('src/b.test.ts', deaf)).toBe(false);
    s.endFile('src/b.test.ts');
    const files = records().filter((r) => r.kind === 'file');
    expect(files.map((r) => [r.file, r.registered, r.reason !== null])).toEqual([['src/a.test.ts', false, true], ['src/b.test.ts', false, true]]);
    expect(logs.filter((l) => l.includes('NOT registered'))).toHaveLength(2);
  });

  it('writes an error record with the case it fell in', async () => {
    const { s, records } = session({ N8N_SETTLEMENT_POLICY: 'libpetri' });
    const engine = registry();
    s.registerFile('src/a.test.ts', engine);
    s.beginCase(task('throws'));
    // A status engine v2 does not have: the decoder refuses it.
    const paused: StepRow = { nodeId: 'A', iteration: 0, status: 'paused', filledOutputSlots: [] };
    await expect(engine.getSettlementPolicy().decideSuccessors(chain, done('T'), memoryReader([done('T'), paused]))).rejects.toThrow(/not an engine v2 step status/);
    s.endCase(task('throws'));
    s.endFile('src/a.test.ts');
    const errors = records().filter((r) => r.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: 'src/a.test.ts', name: 'throws', method: 'decideSuccessors' });
    expect(records().find((r) => r.kind === 'case')).toMatchObject({ counts: { decideSuccessors: 1, errors: 1 } });
  });

  it('writes the shadow reports that are not agreements, in the shadow modes', async () => {
    const { s, records } = session({ N8N_SETTLEMENT_POLICY: 'libpetri', N8N_SETTLEMENT_MODE: 'primary-shadowed' });
    const engine = registry();
    s.registerFile('src/a.test.ts', engine);
    s.beginCase(task('shadowed'));
    await engine.getSettlementPolicy().decideSuccessors(chain, done('T'), memoryReader([done('T')]));
    s.endCase(task('shadowed'));
    s.endFile('src/a.test.ts');
    const shadow = records().filter((r) => r.kind === 'shadow');
    // The stand-in default plans nothing where ours plans A.
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toMatchObject({ name: 'shadowed', report: { method: 'decideSuccessors', verdict: 'disagree' } });
    expect(records().find((r) => r.kind === 'case')).toMatchObject({ counts: { disagree: 1 } });
  });

  it('counts a stale verdict, and the report accounts for every shadowed call', async () => {
    const { s, records } = session({ N8N_SETTLEMENT_POLICY: 'libpetri', N8N_SETTLEMENT_MODE: 'primary-shadowed' });
    const engine = registry();
    s.registerFile('src/a.test.ts', engine);
    s.beginCase(task('d > settles'));
    const policy = engine.getSettlementPolicy();
    // T -> A -> B: B is running when ours reads, and completes before isFinished. Ours answers
    // isFinished from the snapshot it read (false); the stand-in default says true: stale.
    await policy.decideSuccessors(chain, done('A'), memoryReader([done('T'), done('A'), { nodeId: 'B', iteration: 0, status: 'running', filledOutputSlots: [] }]));
    expect(await policy.isFinished(chain, memoryReader([done('T'), done('A'), done('B')]))).toBe(false);
    s.endCase(task('d > settles'));
    s.endFile('src/a.test.ts');

    const shadow = records().filter((r) => r.kind === 'shadow');
    expect(shadow.map((r) => r.kind === 'shadow' && r.report.verdict)).toContain('stale');
    const counts = records().find((r) => r.kind === 'case');
    expect(counts).toMatchObject({ counts: { decideSuccessors: 1, isFinished: 1, stale: 1 } });

    const r = buildEnteredReport(junit(`<testsuite name="src/a.test.ts"><testcase classname="src/a.test.ts" name="d &gt; settles"/></testsuite>`), records());
    expect(r.totalCalls).toBe(2);
    expect(r.shadow.stale).toBe(1);
    expect(r.shadow.agree + r.shadow.disagree + r.shadow.race + r.shadow.candidateThrew + r.shadow.stale).toBe(2);
    expect(r.shadowUnaccounted).toBe(0);
    expect(enteredHeadline(r)).toMatch(/^primary-shadowed \(agree \d+, disagree \d+, stale 1, race 0, candidate threw 0\); /);
  });
});

const junit = (cases: string) => parseJunit(`<?xml version="1.0"?><testsuites>${cases}</testsuites>`);
const xml = `
  <testsuite name="src/a.test.ts" tests="4">
    <testcase classname="src/a.test.ts" name="d &gt; settles" time="0"/>
    <testcase classname="src/a.test.ts" name="idle" time="0"/>
    <testcase classname="src/a.test.ts" name="broken" time="0"><failure message="x">x</failure></testcase>
    <testcase classname="src/a.test.ts" name="todo" time="0"><skipped/></testcase>
  </testsuite>`;
const zero = { decideSuccessors: 0, isFinished: 0, races: 0, errors: 0, agree: 0, disagree: 0, shadowRace: 0, candidateThrew: 0, stale: 0 };
const ledger: SettlementLedgerRecord[] = [
  { kind: 'case', file: 'src/a.test.ts', name: 'd > settles', state: 'pass', counts: { ...zero, decideSuccessors: 2, isFinished: 1 } },
  { kind: 'case', file: 'src/a.test.ts', name: 'idle', state: 'pass', counts: zero },
  { kind: 'case', file: 'src/a.test.ts', name: 'broken', state: 'fail', counts: { ...zero, isFinished: 1 } },
  { kind: 'case', file: 'src/a.test.ts', name: 'gone', state: 'pass', counts: zero },
  { kind: 'file', file: 'src/a.test.ts', registered: true, reason: null, mode: 'primary', outside: { ...zero, isFinished: 2 } },
];

describe('buildEnteredReport', () => {
  it('counts policy-entering cases, labels the rest, and lists unrecorded cases and orphan records', () => {
    const r = buildEnteredReport(junit(xml), ledger, 'libpetri-x');
    expect(r.entering).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(r.notEntering).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(r.unrecorded).toEqual({ total: 1, passed: 0, failed: 0, skipped: 1 });
    expect(r.orphanRecords).toEqual(['src/a.test.ts::gone']);
    expect(r.totalCalls).toBe(6);
    expect(r.registeredWithoutEntering).toBe(false);
    expect(r.files).toEqual([{
      file: 'src/a.test.ts', registered: true, reason: null, cases: 4, enteringCases: 2, enteringPassed: 1,
      callsInCases: 4, callsOutside: 2, errors: 0, races: 0,
    }]);
    expect(enteredHeadline(r)).toMatch(/^policy-entering cases passed: 1 of 2 \(1 failed\); not entering: 1/);
    const md = renderEnteredReport(r);
    expect(md).toContain('## Policy-entering cases that failed');
    expect(md).toContain('- pass src/a.test.ts :: idle');
  });

  it('pairs repeated names positionally', () => {
    const twice = `<testsuite name="f"><testcase classname="f" name="same"/><testcase classname="f" name="same"/></testsuite>`;
    const r = buildEnteredReport(junit(twice), [
      { kind: 'case', file: 'f', name: 'same', state: 'pass', counts: zero },
      { kind: 'case', file: 'f', name: 'same', state: 'pass', counts: { ...zero, isFinished: 1 } },
    ]);
    expect(r.cases.map((c) => c.counts?.isFinished)).toEqual([0, 1]);
  });

  it('says in shadow mode that n8n answered, and gives the shadow verdicts', () => {
    const shadowLedger = ledger.map((r) => (r.kind === 'file' ? { ...r, mode: 'shadow' as const, outside: { ...r.outside, agree: 3, candidateThrew: 1 } } : r));
    const h = enteredHeadline(buildEnteredReport(junit(xml), shadowLedger));
    // 6 calls, 4 verdicts: 2 are unaccounted, and the headline says so.
    expect(h).toMatch(/^shadow mode, n8n's default answered \(agree 3, disagree 0, stale 0, race 0, candidate threw 1, UNACCOUNTED 2\); cases that entered the shadowed policy, passed under n8n's answers: 1 of 2/);
    const primaryShadowed = ledger.map((r) => (r.kind === 'file' ? { ...r, mode: 'primary-shadowed' as const } : r));
    expect(enteredHeadline(buildEnteredReport(junit(xml), primaryShadowed))).toMatch(/^primary-shadowed \(agree 0, .*\); policy-entering cases passed: 1 of 2/);
  });

  it('balances calls against verdicts, errors of a primary-shadowed primary included, and reads a ledger without stale', () => {
    // 6 calls: 4 agree, 1 stale, and in primary-shadowed one call whose primary (ours) threw.
    const balanced: SettlementLedgerRecord[] = [
      ...ledger.map((r) => (r.kind === 'file' ? { ...r, mode: 'primary-shadowed' as const, outside: { ...r.outside, agree: 2 } } : r.kind === 'case' && r.name === 'd > settles' ? { ...r, counts: { ...r.counts, agree: 2, stale: 1 } } : r)),
      { kind: 'error', file: 'src/a.test.ts', name: 'broken', method: 'isFinished', errorName: 'Error', error: 'x' },
    ];
    const r = buildEnteredReport(junit(xml), balanced);
    expect(r.shadow).toEqual({ agree: 4, disagree: 0, race: 0, candidateThrew: 0, stale: 1 });
    expect(r.shadowUnaccounted).toBe(0);
    expect(enteredHeadline(r)).not.toContain('UNACCOUNTED');
    // The same ledger as a pre-fix shim wrote it: no stale field. The stale call is not lost.
    const old = balanced.map((x) => (x.kind === 'case' ? { ...x, counts: (({ stale: _s, ...c }) => c)(x.counts) as typeof x.counts } : x));
    const o = buildEnteredReport(junit(xml), old);
    expect(o.shadow.stale).toBe(0);
    expect(o.shadowUnaccounted).toBe(1);
    expect(renderEnteredReport(o)).toContain('**Unaccounted shadow calls: 1.**');
    // primary mode has no verdicts to balance.
    expect(buildEnteredReport(junit(xml), ledger).shadowUnaccounted).toBe(0);
  });

  it('flags a policy registered and never entered', () => {
    const r = buildEnteredReport(junit(xml), [
      { kind: 'case', file: 'src/a.test.ts', name: 'idle', state: 'pass', counts: zero },
      { kind: 'file', file: 'src/a.test.ts', registered: true, reason: null, mode: 'primary', outside: zero },
    ]);
    expect(r.registeredWithoutEntering).toBe(true);
    expect(renderEnteredReport(r)).toContain('Registered without entering');
  });
});

describe('parseLedger', () => {
  it('refuses a line that is not a record', () => {
    expect(() => parseLedger('{"kind":"case"}\nnope\n')).toThrow(LedgerParseError);
    expect(() => parseLedger('{"kind":"other"}')).toThrow(/unknown record kind/);
    expect(parseLedger('\n\n')).toEqual([]);
  });
});

describe('runEnteredCli', () => {
  const io = (files: Record<string, string>) => {
    const out: Record<string, string> = {};
    const err: string[] = [];
    return {
      io: {
        readFile: (p: string) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]!; },
        writeFile: (p: string, c: string) => { out[p] = c; },
        stdout: (t: string) => { out['-'] = (out['-'] ?? '') + t; },
        stderr: (t: string) => { err.push(t); },
      },
      out,
      err,
    };
  };
  const ledgerText = ledger.map((r) => JSON.stringify(r)).join('\n');
  const junitText = `<?xml version="1.0"?><testsuites>${xml}</testsuites>`;

  it('writes the report and exits 0', () => {
    const t = io({ 'j.xml': junitText, 'l.jsonl': ledgerText });
    expect(runEnteredCli(['j.xml', 'l.jsonl', '--label', 'L', '--out', 'r.md', '--expect-entering'], t.io)).toBe(0);
    expect(t.out['r.md']).toContain('# Settlement leg L');
    expect(t.err.join('')).toContain('policy-entering cases passed: 1 of 2');
  });

  it('exits 1 under --expect-entering when nothing entered (F5), 0 without it', () => {
    const quiet = JSON.stringify({ kind: 'file', file: 'src/a.test.ts', registered: true, reason: null, mode: 'primary', outside: zero });
    expect(runEnteredCli(['j.xml', 'l.jsonl', '--expect-entering'], io({ 'j.xml': junitText, 'l.jsonl': quiet }).io)).toBe(1);
    expect(runEnteredCli(['j.xml', 'l.jsonl'], io({ 'j.xml': junitText, 'l.jsonl': quiet }).io)).toBe(0);
  });

  it('exits 2 on a usage or input error', () => {
    expect(runEnteredCli(['j.xml'], io({}).io)).toBe(2);
    expect(runEnteredCli(['j.xml', 'l.jsonl', '--nope'], io({}).io)).toBe(2);
    expect(runEnteredCli(['j.xml', 'l.jsonl'], io({ 'j.xml': junitText }).io)).toBe(2);
    expect(runEnteredCli(['j.xml', 'l.jsonl'], io({ 'j.xml': junitText, 'l.jsonl': 'nope' }).io)).toBe(2);
  });
});
