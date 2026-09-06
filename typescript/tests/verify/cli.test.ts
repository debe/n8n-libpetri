/**
 * `n8n-libpetri verify <workflow.json>`.
 *
 * Argument parsing is pure and is tested without a solver; the two end-to-end runs are
 * z3-gated. The exit code is the contract a CI job would use: 0 when nothing came back
 * `violated`, 1 when something did, 2 on a usage or input error.
 */
import { parseArgs, runCli, USAGE } from '../../src/verify/index.js';
import type { CliIo } from '../../src/verify/index.js';
import { CASE_TIMEOUT_MS, describeZ3 } from './support.js';

/** A trigger, an If, two branches and a Merge — the export shape n8n writes. */
const DIAMOND_JSON = JSON.stringify({
  name: 'cli-diamond',
  nodes: [
    { id: 'n1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 2, position: [200, 0], parameters: {} },
    { id: 'n3', name: 'Left', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, -100], parameters: {} },
    { id: 'n4', name: 'Right', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 100], parameters: {} },
    { id: 'n5', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [600, 0], parameters: {} },
  ],
  connections: {
    Trigger: { main: [[{ node: 'If', type: 'main', index: 0 }]] },
    If: { main: [[{ node: 'Left', type: 'main', index: 0 }], [{ node: 'Right', type: 'main', index: 0 }]] },
    Left: { main: [[{ node: 'Merge', type: 'main', index: 0 }]] },
    Right: { main: [[{ node: 'Merge', type: 'main', index: 1 }]] },
  },
});

/**
 * The stranding shape of divergence #2: both `If` outputs feed `C`, so `C` runs twice and
 * delivers twice to `Merge` input 0, while input 1 gets one arrival from the trigger. The
 * second arrival strands on `Merge/ready_0`.
 */
const STRANDING_JSON = JSON.stringify({
  name: 'cli-stranding',
  nodes: [
    { id: 'n1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 2, position: [200, 0], parameters: {} },
    { id: 'n3', name: 'C', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 0], parameters: {} },
    { id: 'n4', name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [600, 0], parameters: {} },
    { id: 'n5', name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [800, 0], parameters: {} },
  ],
  connections: {
    Trigger: { main: [[{ node: 'If', type: 'main', index: 0 }, { node: 'Merge', type: 'main', index: 1 }]] },
    If: { main: [[{ node: 'C', type: 'main', index: 0 }], [{ node: 'C', type: 'main', index: 0 }]] },
    C: { main: [[{ node: 'Merge', type: 'main', index: 0 }]] },
    Merge: { main: [[{ node: 'End', type: 'main', index: 0 }]] },
  },
});

/**
 * A cycle: `A -> B -> A`, with `B` also going on to `Exit`. Its reachable state space is
 * unbounded, so the state-class graph truncates at any cap and the report comes back
 * `bounded` — a verdict the plain run passes and `--strict` fails.
 */
const CYCLE_JSON = JSON.stringify({
  name: 'cli-cycle',
  nodes: [
    { id: 'n1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'A', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} },
    { id: 'n3', name: 'B', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 0], parameters: {} },
    { id: 'n4', name: 'Exit', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [600, 0], parameters: {} },
  ],
  connections: {
    Trigger: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
    A: { main: [[{ node: 'B', type: 'main', index: 0 }]] },
    B: { main: [[{ node: 'A', type: 'main', index: 0 }, { node: 'Exit', type: 'main', index: 0 }]] },
  },
});

/** A trigger plus a disconnected pair: `Orphan` and `OrphanChild` can never run. */
const ORPHAN_JSON = JSON.stringify({
  name: 'cli-orphan',
  nodes: [
    { id: 'n1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'A', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} },
    { id: 'n3', name: 'Orphan', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 200], parameters: {} },
    { id: 'n4', name: 'OrphanChild', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 200], parameters: {} },
  ],
  connections: {
    Trigger: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
    Orphan: { main: [[{ node: 'OrphanChild', type: 'main', index: 0 }]] },
  },
});

interface Captured extends CliIo {
  out: string;
  err: string;
  readonly written: Map<string, string>;
}

function io(files: Readonly<Record<string, string>>): Captured {
  const captured: Captured = {
    out: '',
    err: '',
    written: new Map(),
    readFile: (p) => {
      const content = files[p];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFile: (p, c) => { captured.written.set(p, c); },
    stdout: (t) => { captured.out += t; },
    stderr: (t) => { captured.err += t; },
  };
  return captured;
}

describe('verify CLI arguments', () => {
  it('accepts the leading `verify` word and reads the file name', () => {
    expect(parseArgs(['verify', 'wf.json']).file).toBe('wf.json');
    expect(parseArgs(['wf.json']).file).toBe('wf.json');
  });

  it('maps the flags onto VerifyOptions', () => {
    const parsed = parseArgs([
      'verify', 'wf.json', '--budget', '4', '--timeout', '5000', '--property', 'budget',
      '--property', 'dead-nodes', '--mutex', 'A, B', '--no-semiflows', '--json', '--out', 'o.txt',
      '--start', 'T', '--node-types', 'types.json', '--quiet', '--strict',
    ]);
    expect(parsed.options).toEqual({
      budget: 4,
      timeoutMs: 5000,
      properties: ['budget', 'dead-nodes'],
      mutualExclusion: [['A', 'B']],
      semiflowInvariants: false,
    });
    expect(parsed).toMatchObject({
      json: true, out: 'o.txt', startNode: 'T', nodeTypesFile: 'types.json', quiet: true, strict: true,
    });
    expect(parseArgs(['wf.json']).strict).toBe(false);
  });

  it('--smt-fallback picks the mode, and only the three names are modes', () => {
    // The escape hatch for the size ceiling: above it no SmtVerifier is constructed, because
    // the pipeline's heap exhaustion aborts the process instead of returning a verdict.
    expect(parseArgs(['wf.json', '--smt-fallback', 'force']).options.smtFallback).toBe('force');
    expect(parseArgs(['wf.json', '--smt-fallback', 'off']).options.smtFallback).toBe('off');
    expect(parseArgs(['wf.json']).options.smtFallback).toBeUndefined();
    expect(USAGE).toContain('--smt-fallback');
  });

  it('--all-pairs beats individual pairs', () => {
    expect(parseArgs(['wf.json', '--all-pairs', '--mutex', 'A,B']).options.mutualExclusion).toBe('all-pairs');
  });

  it('rejects bad input with a message and the usage line', async () => {
    for (const argv of [
      [], ['a.json', 'b.json'], ['wf.json', '--nope'], ['wf.json', '--budget'], ['wf.json', '--budget', '0'],
      ['wf.json', '--timeout', 'soon'], ['wf.json', '--property', 'liveness'], ['wf.json', '--mutex', 'A'],
      ['wf.json', '--smt-fallback'], ['wf.json', '--smt-fallback', 'sometimes'],
    ]) {
      const captured = io({});
      expect(await runCli(argv, captured), argv.join(' ')).toBe(2);
      expect(captured.err).toContain(USAGE.split('\n')[0]!);
      expect(captured.out).toBe('');
    }
  });

  it('reports an unreadable workflow or node-types file as a usage error', async () => {
    const missing = io({});
    expect(await runCli(['verify', 'gone.json'], missing)).toBe(2);
    expect(missing.err).toContain('ENOENT');

    const badTypes = io({ 'wf.json': DIAMOND_JSON, 'types.json': '{' });
    expect(await runCli(['verify', 'wf.json', '--node-types', 'types.json'], badTypes)).toBe(2);
    expect(badTypes.err).toContain('--node-types');

    const badJson = io({ 'wf.json': 'not json' });
    expect(await runCli(['verify', 'wf.json'], badJson)).toBe(2);
    expect(badJson.err).toContain('not valid JSON');
  });
});

describeZ3('verify CLI runs', () => {
  it('prints the table and exits 0 on a workflow with no finding', { timeout: CASE_TIMEOUT_MS }, async () => {
    const captured = io({ 'wf.json': DIAMOND_JSON });
    const code = await runCli(
      ['verify', 'wf.json', '--property', 'budget', '--property', 'no-double-activation', '--timeout', '5000'],
      captured);
    expect(code, captured.out + captured.err).toBe(0);
    expect(captured.out).toContain('n8n-libpetri verify — cli-diamond');
    expect(captured.out).toContain('PROPERTY');
    expect(captured.out).toContain('no-double-activation');
    expect(captured.out).toContain('proven');
    // The guessed node shapes are reported, not swallowed.
    expect(captured.err).toContain('warning:');
    // Progress is streamed to stderr unless --quiet.
    expect(captured.err).toContain('budget /');
  });

  it('reports a dead node as a finding and exits 1, naming the node', { timeout: CASE_TIMEOUT_MS }, async () => {
    const captured = io({ 'wf.json': ORPHAN_JSON });
    const code = await runCli(['verify', 'wf.json', '--property', 'dead-nodes', '--timeout', '5000', '--quiet'], captured);
    expect(code, captured.out).toBe(1);
    expect(captured.out).toContain('Findings');
    expect(captured.out).toContain('Orphan can never run');
    expect(captured.out).toContain('OrphanChild can never run');
    // --quiet suppresses the per-check stream.
    expect(captured.err).not.toContain('dead-nodes /');
  });

  it('--json writes the machine-readable report, --out writes to a file, and it names the guessed shapes', { timeout: CASE_TIMEOUT_MS }, async () => {
    const captured = io({ 'wf.json': DIAMOND_JSON });
    const code = await runCli(
      ['verify', 'wf.json', '--property', 'budget', '--timeout', '5000', '--json', '--out', 'report.json', '--quiet'],
      captured);
    expect(code).toBe(0);
    expect(captured.out).toBe('');
    const written = captured.written.get('report.json')!;
    const parsed = JSON.parse(written) as {
      workflow: string; checks: unknown[]; ok: boolean; shapeWarnings: string[];
    };
    expect(parsed.workflow).toBe('cli-diamond');
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
    // A guessed shape changes the compiled net (join vs direct form, how routing splits), so
    // a stored report has to carry it: stderr is not part of the artefact (ADR 0007 §8).
    expect(parsed.shapeWarnings.length).toBeGreaterThan(0);
    expect(parsed.shapeWarnings.some((w) => w.includes('guessed'))).toBe(true);
    expect(captured.err).toContain('guessed');
  });

  it('--strict fails a run that proved nothing, and the plain run does not', { timeout: CASE_TIMEOUT_MS }, async () => {
    // `dead-nodes` on the diamond: every live node's witness search exceeds the timeout, so
    // the family comes back `unknown` (docs/verification.md). Not a finding — but a gate that
    // wants proofs to stay proofs must be able to fail on it.
    const argv = ['verify', 'wf.json', '--property', 'dead-nodes', '--timeout', '1000', '--quiet'];
    const lenient = io({ 'wf.json': DIAMOND_JSON });
    expect(await runCli(argv, lenient), lenient.out).toBe(0);

    const strict = io({ 'wf.json': DIAMOND_JSON });
    expect(await runCli([...argv, '--strict'], strict), strict.out).toBe(1);
    expect(strict.err).toContain('--strict');
    expect(strict.err).toMatch(/are not proven/);
  });

  it('a cyclic workflow reports BOUNDED: exit 0 plain, exit 1 under --strict', { timeout: CASE_TIMEOUT_MS }, async () => {
    // The verdict item D exists for. It is not a finding — the plain run passes — and it is
    // not a proof either, so the gate that wants proofs fails on it and says which counts
    // are not proven.
    const argv = ['verify', 'wf.json', '--property', 'proper-completion', '--max-classes', '2000',
      '--timeout', '1000', '--quiet', '--json'];
    const lenient = io({ 'wf.json': CYCLE_JSON });
    expect(await runCli(argv, lenient), lenient.err).toBe(0);
    const report = JSON.parse(lenient.out) as {
      counts: Record<string, number>;
      stateSpace: { complete: boolean; truncation: string | null; boundedCyclicRuns: number | null };
      checks: Array<{ verdict: string; reason: string | null; subject: { kind: string }; query: { route: string } }>;
    };
    expect(report.stateSpace.complete).toBe(false);
    expect(report.stateSpace.truncation).toBe('cycle');
    expect(report.stateSpace.boundedCyclicRuns).toBeGreaterThanOrEqual(1);
    expect(report.counts.bounded).toBeGreaterThan(0);
    // The headline row is the bounded one, and nothing the *graph* answered is a proof.
    const whole = report.checks.find((c) => c.subject.kind === 'net')!;
    expect(whole.verdict).toBe('bounded');
    expect(whole.reason).toMatch(/not a proof/);
    expect(report.checks.some((c) => c.verdict === 'proven' && c.query.route === 'state-class-graph')).toBe(false);

    const strict = io({ 'wf.json': CYCLE_JSON });
    expect(await runCli([...argv, '--strict'], strict), strict.out).toBe(1);
    expect(strict.err).toMatch(/are not proven/);
    expect(strict.err).toMatch(/bounded/);
  });

  it('--node-types removes the guessing warnings', { timeout: CASE_TIMEOUT_MS }, async () => {
    const types = JSON.stringify({
      types: {
        'n8n-nodes-base.manualTrigger': { inputCount: 0, outputCount: 1 },
        'n8n-nodes-base.noOp': { inputCount: 1, outputCount: 1 },
      },
    });
    const captured = io({ 'wf.json': DIAMOND_JSON, 'types.json': types });
    const code = await runCli(
      ['verify', 'wf.json', '--node-types', 'types.json', '--property', 'budget', '--timeout', '5000', '--quiet'],
      captured);
    expect(code).toBe(0);
    expect(captured.err).toBe('');
  });
});

/**
 * VER-013 at the process boundary: a run whose solver-backed families were all skipped must
 * not be indistinguishable from a clean one at the exit code, which is the only thing CI
 * reads. Since M5 exit 3 ranks **below** a finding, because the solver-free route decides
 * the reachability-safety families with no solver at all — a stranding it found must not be
 * masked by a missing tool.
 *
 * Not z3-gated — `LIBPETRI_Z3` pointed at a path that does not exist is exactly what
 * `resolveZ3` reads, so this holds on a machine that has a solver, which is the only place
 * the regression could hide.
 */
describe('verify CLI without a solver (VER-013)', () => {
  const MISSING = '/nonexistent/definitely-not-a-z3-binary';

  async function withoutZ3<T>(fn: () => Promise<T>): Promise<T> {
    const before = process.env['LIBPETRI_Z3'];
    process.env['LIBPETRI_Z3'] = MISSING;
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env['LIBPETRI_Z3'];
      else process.env['LIBPETRI_Z3'] = before;
    }
  }

  it('exits 3, prints the reason, and still writes the report', { timeout: CASE_TIMEOUT_MS }, async () => {
    await withoutZ3(async () => {
      const captured = io({ 'wf.json': DIAMOND_JSON });
      const code = await runCli(
        ['verify', 'wf.json', '--property', 'budget', '--timeout', '1000', '--quiet'], captured);
      expect(code, captured.out + captured.err).toBe(3);
      expect(captured.err).toContain('the SMT fallback did not run');
      expect(captured.err).toContain('LIBPETRI_Z3');
      // The table is still printed, and the solver-free route still filled it in.
      expect(captured.out).toContain('the SMT fallback cannot run');
      expect(captured.out).not.toContain('every verdict is unknown');
      expect(captured.out).toContain('complete (VER-010)');
      expect(captured.out).toContain('PROVEN');
    });
  });

  it('a finding outranks the missing solver: exit 1, not 3', { timeout: CASE_TIMEOUT_MS }, async () => {
    await withoutZ3(async () => {
      const captured = io({ 'wf.json': STRANDING_JSON });
      const code = await runCli(
        ['verify', 'wf.json', '--property', 'proper-completion', '--timeout', '1000', '--quiet'], captured);
      expect(code, captured.out + captured.err).toBe(1);
      expect(captured.out).toContain('VIOLATED');
      expect(captured.out).toContain('Findings');
    });
  });
});
