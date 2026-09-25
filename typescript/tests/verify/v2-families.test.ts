/**
 * The `engineV2` verification family (`tasks/v2-profile-plan.md` step 12, decision 18): the
 * `settlement` checks over the net's state-class graph, the profile routing of `verify()` /
 * `verifyCompiled()`, the not-applicable records, and the CLI's `--profile engineV2`.
 *
 * Nothing here needs z3: the `engineV2` report is decided by the state-class graph alone, so no
 * test is behind the z3 gate. The checks are shown to fail as well as to pass: each claim is
 * broken on purpose by starting the same compiled net from a doctored marking
 * (`exploreSettlement` takes the initial marking), and the start/skip exclusivity, which the
 * gadget's inhibitor makes structural, on a hand-built net.
 */
import { PetriNet, Transition, fork, one, outPlace, place } from 'libpetri';
import { MarkingState, StateClassGraph } from 'libpetri/verification';
import { CompileError, compile } from '../../src/compiler/index.js';
import type { CompiledWorkflow, NetMapView, PlaceInfo } from '../../src/compiler/index.js';
import { graphToDescription } from '../../src/conformance/v2/graph.js';
import type { V2Graph } from '../../src/conformance/v2/graph.js';
import { runCli } from '../../src/verify/cli.js';
import type { CliIo } from '../../src/verify/cli.js';
import { exitCodeOf } from '../../src/verify/cli/exit-code.js';
import { runSettlementFamily } from '../../src/verify/families/v2-settlement.js';
import { markingStateOf, renderReport, verify, verifyCompiled } from '../../src/verify/index.js';
import type { PropertyCheck, VerificationReport } from '../../src/verify/index.js';
import { exploreSettlement, type SettlementContext, type SettlementSpace } from '../../src/verify/settlement.js';
import { SettlementSurvey } from '../../src/verify/state-space/settlement-survey.js';
import {
  ACCEPTED, SETTLEMENT_SHAPES, branchDiamond, chain, loop, threeInputMerge,
} from '../fixtures/v2-graphs.js';
import { ALL, linear } from '../fixtures/workflows.js';

const compileV2 = (graph: V2Graph): CompiledWorkflow =>
  compile(graphToDescription(graph).description, { profile: 'engineV2' });

/**
 * The `ALL` fixtures the engineV2 analysis refuses (`tests/compiler/v2/refusals.test.ts` pins their
 * codes), and `switch20`, which it accepts but whose graph does not close (its own case below).
 */
const V2_REFUSED: ReadonlySet<string> = new Set([
  'multiProducer', 'loopOverItems', 'userCycle', 'twoTriggers', 'ifBothOutputs',
  'continueErrorOutput', 'switch20',
]);

/** Every engineV2 net the suite verifies: the hand-written v2 graphs and the v1 fixtures v2 accepts. */
const SUBJECTS: readonly (readonly [string, () => CompiledWorkflow])[] = [
  ...Object.entries({ ...SETTLEMENT_SHAPES, ...ACCEPTED }).map(([name, g]) => [`graph ${name}`, () => compileV2(g)] as const),
  ...Object.entries(ALL).filter(([name]) => !V2_REFUSED.has(name))
    .map(([name, wf]) => [`fixture ${name}`, () => compile(wf, { profile: 'engineV2' })] as const),
];

/** The family run over `space`, as `verifySettlement` runs it. */
function family(c: CompiledWorkflow, space: SettlementSpace): PropertyCheck[] {
  const ctx: SettlementContext = { compiled: c, space, checks: [], onCheck: undefined };
  runSettlementFamily(ctx);
  return ctx.checks;
}

/** `c`'s initial marking with `extra` tokens added on the named places. */
function doctored(c: CompiledWorkflow, extra: Readonly<Record<string, number>>): MarkingState {
  const builder = MarkingState.builder();
  const seen = new Set<string>();
  for (const [p, tokens] of c.initialMarking(null)) {
    builder.tokens(p, tokens.length + (extra[p.name] ?? 0));
    seen.add(p.name);
  }
  for (const [name, n] of Object.entries(extra)) {
    if (!seen.has(name)) builder.tokens(c.netMap.place(name)!.place, n);
  }
  return builder.build();
}

const byName = (checks: readonly PropertyCheck[], name: string): PropertyCheck => {
  const found = checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check '${name}' among ${checks.map((c) => c.name).join(', ')}`);
  return found;
};

describe.each(SUBJECTS)('%s under engineV2', (_name, build) => {
  const c = build();

  it('proves every settlement check over a complete graph, with halted terminals present', async () => {
    const report = await verifyCompiled(c);
    expect(report.profile).toBe('engineV2');
    expect(report.stateSpace.complete).toBe(true);
    expect(report.stateSpace.truncation).toBeNull();
    // A graph with no halted class would never have exercised the halt carve-out.
    expect(report.stateSpace.terminal).toBeGreaterThan(0);
    expect(report.stateSpace.quiescent).toBeGreaterThan(report.stateSpace.terminal);
    expect(report.stateSpace.strandedPlaces).toBe(0);
    expect(report.counts).toEqual({ proven: report.checks.length, violated: 0, bounded: 0, unknown: 0 });
    expect(report.ok).toBe(true);
    for (const check of report.checks) {
      expect(check.property).toBe('settlement');
      expect(check.query.route).toBe('state-class-graph');
    }
  });

  it('asks one question per structural subject', async () => {
    const report = await verifyCompiled(c);
    const map = c.netMap;
    const withSkip = map.settlements.filter((g) => g.transitions.skip !== null).length;
    const batches = map.settlements.filter((g) => g.batch !== null).length;
    const arrived = map.places.filter((p) => p.role === 'arrived').length;
    const decided = map.settlements.filter((g) => g.done !== null).length;
    const count = (q: string): number => report.checks.filter((k) => k.query.property === q).length;
    expect(count('settlement:start-skip-exclusive')).toBe(withSkip + batches);
    // Every arrived place and every running place is a bound.
    expect(count('place-bound')).toBe(arrived + map.settlements.length);
    expect(count('settlement:quiescent-without-halt-is-settled')).toBe(1);
    expect(count('settlement:decided-exactly-once')).toBe(decided);
    expect(count('settlement:loop-ends-exactly-once')).toBe(batches);
    expect(report.checks.length).toBe(withSkip + batches + arrived + map.settlements.length + 1 + decided + batches);
  });
});

describe('the state-class counts of the engineV2 nets (pinned; the ADR 0012 measurement is tests/verify/measure-v2.ts)', () => {
  it.each([
    ['chain', chain, 14],
    ['longChain', SETTLEMENT_SHAPES['longChain']!, 21],
    ['branchDiamond', branchDiamond, 92],
    ['threeInputMerge', threeInputMerge, 134],
    ['ifIntoMerge', SETTLEMENT_SHAPES['ifIntoMerge']!, 27],
    ['loop', loop, 17],
    ['selfLoop', ACCEPTED['selfLoop']!, 13],
    ['twoLoops', ACCEPTED['twoLoops']!, 25],
    ['diamondBody', ACCEPTED['diamondBody']!, 53],
  ] as const)('%s', async (_name, graph, classes) => {
    // A folded loop has finite markings, so a loop graph closes like an acyclic one.
    const report = await verifyCompiled(compileV2(graph));
    expect(report.stateSpace.classes).toBe(classes);
    expect(report.stateSpace.complete).toBe(true);
  });
});

describe('the halted terminal carries no completion claim', () => {
  it('a loop halts both with B/ended marked (a failed batch row) and without it (a failed body row)', () => {
    const c = compileV2(loop);
    const space = exploreSettlement(c.net, markingStateOf(c.initialMarking(null)), c.netMap);
    const ended = c.netMap.settlement('B').batch!.ended;
    const halted = space.graph!.stateClasses()
      .filter((sc) => sc.enabledTransitions.length === 0 && sc.marking.tokens(c.netMap.halt) > 0);
    expect(halted.some((sc) => sc.marking.tokens(ended) === 1)).toBe(true);
    expect(halted.some((sc) => sc.marking.tokens(ended) === 0)).toBe(true);
    // ... and still the loop-end check is proven: it quantifies over halt-free rest only.
    expect(byName(family(c, space), "B's loop ends exactly once").verdict).toBe('proven');
  });
});

describe('each check fails when its claim is broken', () => {
  it('two units on T/in: the trigger arrives, runs and is decided twice', () => {
    const c = compileV2(chain);
    const checks = family(c, exploreSettlement(c.net, doctored(c, { 'T/in': 1 }), c.netMap));
    for (const name of ['T input arrives at most once', 'T runs at most once at a time', 'T is decided exactly once']) {
      const check = byName(checks, name);
      expect(check.verdict, name).toBe('violated');
      expect(check.counterexample, name).not.toBeNull();
      expect(check.counterexample!.ordered).toBe(true);
    }
    const running = byName(checks, 'T runs at most once at a time').counterexample!;
    expect(running.nodePath).toEqual(['T']);
    expect(running.stuckMarking).toContainEqual(expect.objectContaining({ place: 'T/running', tokens: 2 }));
  });

  it('a stale arrival on a Merge input: a halt-free run comes to rest with work left behind', () => {
    const c = compileV2(threeInputMerge);
    const fromA = c.netMap.settlement('M').incoming.find((e) => e.edge.from === 'A')!.arrived;
    const checks = family(c, exploreSettlement(c.net, doctored(c, { [fromA.name]: 1 }), c.netMap));
    const rest = byName(checks, 'every halt-free run ends with nothing pending');
    expect(rest.verdict).toBe('violated');
    const marking = rest.counterexample!.stuckMarking;
    expect(marking.some((p) => p.place === fromA.name)).toBe(true);
    expect(marking.some((p) => p.place === '_halt')).toBe(false);
    // The path to the witness is a firing sequence from the doctored marking.
    expect(rest.counterexample!.steps.length).toBeGreaterThan(0);
  });

  it('a pre-marked B/ended: the loop ends twice', () => {
    const c = compileV2(loop);
    const ended = c.netMap.settlement('B').batch!.ended;
    const checks = family(c, exploreSettlement(c.net, doctored(c, { [ended.name]: 1 }), c.netMap));
    expect(byName(checks, "B's loop ends exactly once").verdict).toBe('violated');
  });

  it('a pre-marked X/done: the node is decided twice', () => {
    const c = compileV2(chain);
    const checks = family(c, exploreSettlement(c.net, doctored(c, { 'A/done': 1 }), c.netMap));
    expect(byName(checks, 'A is decided exactly once').verdict).toBe('violated');
    expect(byName(checks, 'B is decided exactly once').verdict).toBe('proven');
  });

  it('start and skip enabled together: a hand-built pair with no inhibitor between them', () => {
    const arrived = place<unknown>('e/arrived');
    const halt = place<unknown>('_halt');
    const running = place<unknown>('X/running');
    const skipped = place<unknown>('X/skipped');
    const net = PetriNet.builder('co-enabled')
      .transition(Transition.builder('X_start').inputs(one(arrived)).outputs(outPlace(running)).action(fork()).build())
      .transition(Transition.builder('X_skip').inputs(one(arrived)).outputs(outPlace(skipped)).action(fork()).build())
      .build();
    const roles: Record<string, PlaceInfo['role']> = { 'e/arrived': 'arrived', _halt: 'halt', 'X/running': 'running', 'X/skipped': 'skipped' };
    // Only what the survey reads: `halt` and each place's role.
    const map = {
      halt,
      place: (name: string) => (roles[name] === undefined ? undefined : { name, role: roles[name] }),
    } as unknown as NetMapView;
    const graph = StateClassGraph.build(net, MarkingState.builder().tokens(arrived, 1).build(), 100);
    const survey = new SettlementSurvey(graph, map, {
      pairs: [{ node: 'X', pair: 'node', start: 'X_start', skip: 'X_skip' }], decided: [], loops: [],
    });
    expect(survey.bothEnabled.get('X_start X_skip')).toBe(graph.initialClass);
  });
});

describe('verdicts the graph does not license', () => {
  it('a truncated graph proves nothing, and says why', () => {
    const c = compileV2(branchDiamond);
    const space = exploreSettlement(c.net, markingStateOf(c.initialMarking(null)), c.netMap, 5);
    expect(space.complete).toBe(false);
    expect(space.truncation).toBe('parallelism');
    const checks = family(c, space);
    expect(checks.every((k) => k.verdict === 'unknown')).toBe(true);
    expect(checks[0]!.reason).toMatch(/truncated at its 5-class cap.*no SMT fallback/);
  });

  it('switch20: twenty independent successors do not close under the cap, and nothing is proven', async () => {
    // Engine v2 has no budget, so every successor of the Switch settles concurrently and the
    // graph interleaves all of them (NU-053: no partial-order reduction). A small cap keeps the
    // case fast; the default cap truncates as well (measured: tests/verify/measure-v2.ts).
    const report = await verify(ALL.switch20, { profile: 'engineV2', maxClasses: 2_000 });
    expect(report.stateSpace.complete).toBe(false);
    expect(report.stateSpace.truncation).toBe('parallelism');
    expect(report.counts.proven).toBe(0);
    expect(report.counts.violated).toBe(0);
    expect(report.counts.unknown).toBe(report.checks.length);
  });

  it('maxClasses 0 turns the route off', async () => {
    const report = await verify(graphToDescription(chain).description, { profile: 'engineV2', maxClasses: 0 });
    expect(report.stateSpace.truncation).toBe('off');
    expect(report.counts.proven).toBe(0);
    expect(report.checks[0]!.reason).toMatch(/route is off/);
  });

  it('a claim about halt-free rest is vacuous when no halt-free rest is reached', () => {
    const c = compileV2(chain);
    const checks = family(c, exploreSettlement(c.net, doctored(c, { _halt: 1 }), c.netMap));
    const rest = byName(checks, 'every halt-free run ends with nothing pending');
    expect(rest.verdict).toBe('unknown');
    expect(rest.reason).toMatch(/vacuously/);
    expect(byName(checks, 'A is decided exactly once').verdict).toBe('unknown');
    // The bounds quantify over every class, halted or not, and hold.
    expect(byName(checks, 'T runs at most once at a time').verdict).toBe('proven');
  });
});

describe('profile routing', () => {
  it('verify() compiles v1 by default, and its report says so', async () => {
    const report = await verify(linear, { properties: ['no-double-activation'] });
    expect(report.profile).toBe('v1');
  });

  it('verify({ profile: engineV2 }) compiles for engine v2 and runs its family', async () => {
    const report = await verify(linear, { profile: 'engineV2' });
    expect(report.profile).toBe('engineV2');
    expect(report.properties).toEqual(['settlement']);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
    expect(renderReport(report)).toContain('(profile engineV2)');
  });

  it('refuses an explicit budget under engineV2, as the compiler does', async () => {
    await expect(verify(linear, { profile: 'engineV2', budget: 2 })).rejects.toThrow(CompileError);
  });

  it('budget and retry-bound are reported not applicable under engineV2, never passed', async () => {
    const report = await verify(linear, { profile: 'engineV2', properties: ['budget', 'retry-bound', 'settlement'] });
    for (const property of ['budget', 'retry-bound'] as const) {
      const checks = report.checks.filter((k) => k.property === property);
      expect(checks, property).toHaveLength(1);
      expect(checks[0]!.verdict).toBe('unknown');
      expect(checks[0]!.reason).toMatch(/^not applicable under engineV2: /);
      expect(checks[0]!.query.route).toBe('none');
    }
    expect(report.counts.unknown).toBe(2);
    expect(renderReport(report)).toContain('budget is not applicable under engineV2');
  });

  it('every other v1 family, and mutual exclusion by pair, is not applicable either', async () => {
    const report = await verify(linear, {
      profile: 'engineV2', properties: ['proper-completion', 'dead-nodes', 'no-double-activation'], mutualExclusion: 'all-pairs',
    });
    expect(report.checks.map((k) => [k.property, k.verdict])).toEqual([
      ['proper-completion', 'unknown'], ['dead-nodes', 'unknown'], ['no-double-activation', 'unknown'],
    ]);
    const withPairs = await verify(linear, { profile: 'engineV2', mutualExclusion: 'all-pairs' });
    expect(withPairs.properties).toEqual(['settlement', 'mutual-exclusion']);
    expect(withPairs.checks.filter((k) => k.property === 'mutual-exclusion').map((k) => k.verdict)).toEqual(['unknown']);
  });

  it('the settlement family asked of a v1 net is not applicable under v1', async () => {
    const report = await verify(linear, { properties: ['settlement'], smtFallback: 'off' });
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]!.reason).toMatch(/^not applicable under v1: /);
  });

  it('an engineV2 report does not exit 3 without a solver: nothing in it is solver-backed', async () => {
    const report = await verify(linear, { profile: 'engineV2' });
    const noSolver: VerificationReport = { ...report, solver: { available: false, program: null, version: null, reason: 'none' } };
    const sink = { stdout: () => {}, stderr: () => {}, writeFile: () => {} };
    expect(exitCodeOf(noSolver, false, sink)).toBe(0);
    expect(exitCodeOf({ ...noSolver, profile: 'v1' }, false, sink)).toBe(3);
  });
});

/** Manual trigger → Set → NoOp, as n8n exports it. */
const CHAIN_JSON = JSON.stringify({
  name: 'cli-v2-chain',
  nodes: [
    { id: 'n1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3, position: [200, 0], parameters: {} },
    { id: 'n3', name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 0], parameters: {} },
  ],
  connections: {
    Trigger: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
    Set: { main: [[{ node: 'End', type: 'main', index: 0 }]] },
  },
});

/**
 * Two triggers into one node's one slot. n8n's converter needs the fired one named
 * (`AmbiguousTriggerError`), roots the graph at it (`rootAt`) and accepts either; so does the
 * CLI, through the compiler's port of the converter (plan step 13) and `--trigger`.
 */
const TWO_TRIGGERS_JSON = JSON.stringify({
  name: 'cli-v2-two-triggers',
  nodes: [
    { id: 'n1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'Cron', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [0, 200], parameters: {} },
    { id: 'n3', name: 'End', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, 0], parameters: {} },
  ],
  connections: {
    Trigger: { main: [[{ node: 'End', type: 'main', index: 0 }]] },
    Cron: { main: [[{ node: 'End', type: 'main', index: 0 }]] },
  },
});

function io(files: Readonly<Record<string, string>>): CliIo & { out: string; err: string } {
  const captured = {
    out: '',
    err: '',
    readFile: (p: string) => {
      const content = files[p];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFile: () => {},
    stdout: (t: string) => { captured.out += t; },
    stderr: (t: string) => { captured.err += t; },
  };
  return captured;
}

describe('verify CLI --profile engineV2', () => {
  it('compiles the workflow JSON for engine v2 and reports the settlement family', async () => {
    const cli = io({ 'wf.json': CHAIN_JSON });
    expect(await runCli(['verify', 'wf.json', '--profile', 'engineV2', '--json', '--quiet'], cli)).toBe(0);
    const report = JSON.parse(cli.out) as VerificationReport;
    expect(report.profile).toBe('engineV2');
    expect(report.counts.violated).toBe(0);
    expect(report.counts.proven).toBe(report.checks.length);
  });

  it('a run that decided nothing exits 3, as a v1 run without a solver does', async () => {
    // Only a not-applicable v1 family asked: every check unknown, nothing verified.
    const cli = io({ 'wf.json': CHAIN_JSON });
    expect(await runCli(['wf.json', '--profile', 'engineV2', '--property', 'budget', '--strict', '--quiet'], cli)).toBe(3);
    expect(cli.out).toContain('not applicable under engineV2');
    // The graph disabled: the one engineV2 route never ran, with or without --strict.
    const off = io({ 'wf.json': CHAIN_JSON });
    expect(await runCli(['wf.json', '--profile', 'engineV2', '--max-classes', '0', '--json', '--quiet'], off)).toBe(3);
    expect(off.err).toMatch(/no check was decided/);
  });

  it('a v1 family alongside a decided one still fails --strict (exit 1), not 3', async () => {
    const cli = io({ 'wf.json': CHAIN_JSON });
    expect(await runCli(['wf.json', '--profile', 'engineV2', '--property', 'settlement', '--property', 'budget', '--strict', '--quiet'], cli)).toBe(1);
  });

  it('refuses --budget under engineV2 with the compiler\'s refusal (exit 2)', async () => {
    const cli = io({ 'wf.json': CHAIN_JSON });
    expect(await runCli(['wf.json', '--profile', 'engineV2', '--budget', '2', '--quiet'], cli)).toBe(2);
    expect(cli.err).toMatch(/budget/);
  });

  it('needs --trigger for a workflow with two triggers, as n8n\'s converter needs the name (exit 2 without)', async () => {
    const cli = io({ 'wf.json': TWO_TRIGGERS_JSON });
    expect(await runCli(['wf.json', '--profile', 'engineV2', '--quiet'], cli)).toBe(2);
    expect(cli.err).toMatch(/the workflow has 2 triggers \('Trigger', 'Cron'\), so the trigger that fired must be named \(AmbiguousTriggerError/);
    expect(cli.out).toBe('');
    for (const fired of ['Trigger', 'Cron']) {
      const named = io({ 'wf.json': TWO_TRIGGERS_JSON });
      expect(await runCli(['wf.json', '--profile', 'engineV2', '--trigger', fired, '--json', '--quiet'], named), fired).toBe(0);
      const report = JSON.parse(named.out) as VerificationReport;
      // Rooted at the fired trigger: the other is not compiled, so End has one way in.
      expect(report.counts.violated, fired).toBe(0);
      expect(report.counts.proven, fired).toBe(report.checks.length);
    }
    const unknown = io({ 'wf.json': TWO_TRIGGERS_JSON });
    expect(await runCli(['wf.json', '--profile', 'engineV2', '--trigger', 'End', '--quiet'], unknown)).toBe(2);
    expect(unknown.err).toMatch(/node 'End' \(n8n-nodes-base\.noOp\) is not a trigger/);
  });

  it('splices a disabled node out rather than refusing the workflow', async () => {
    const wf = JSON.parse(CHAIN_JSON) as { nodes: { name: string; disabled?: boolean }[] };
    wf.nodes.find((n) => n.name === 'Set')!.disabled = true;
    const cli = io({ 'wf.json': JSON.stringify(wf) });
    expect(await runCli(['wf.json', '--profile', 'engineV2', '--json', '--quiet'], cli)).toBe(0);
    expect((JSON.parse(cli.out) as VerificationReport).counts.violated).toBe(0);
  });

  it('takes --trigger under engineV2 only, and --start under v1 only (usage, exit 2)', async () => {
    const v1 = io({ 'wf.json': CHAIN_JSON });
    expect(await runCli(['wf.json', '--trigger', 'Trigger', '--quiet'], v1)).toBe(2);
    expect(v1.err).toContain('--trigger names the fired trigger of --profile engineV2');
    const v2 = io({ 'wf.json': CHAIN_JSON });
    expect(await runCli(['wf.json', '--profile', 'engineV2', '--start', 'Trigger', '--quiet'], v2)).toBe(2);
    expect(v2.err).toContain('under --profile engineV2 name the fired trigger with --trigger');
  });

  it('takes only the two profile names', async () => {
    const cli = io({ 'wf.json': CHAIN_JSON });
    expect(await runCli(['wf.json', '--profile', 'v3'], cli)).toBe(2);
    expect(cli.err).toContain('--profile must be one of v1, engineV2');
  });
});
