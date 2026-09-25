/**
 * The `engineV2` batch loop (`tasks/v2-profile-plan.md` step 6, decisions 5 and 6): the batch
 * node's gadget and the folded loop, run on libpetri's executors row by row.
 *
 * Every graph comes through the stage-1 input, so every batch node has n8n's real outputs
 * `['done', 'loop']` (`DONE_SLOT = 0`, `LOOP_SLOT = 1`, `execution/loop-ledger.ts`); the v1
 * fixture `SHAPES.loop` lists them the other way round and is never used here.
 *
 * The expected rows are written from engine v2's rules, not taken from its code (the
 * differential against n8n's own `decideSuccessors` is step 10):
 * - `runBatchStep` (`execution/batch-step.ts`): a pass fills the loop slot, the last step fills
 *   the done slot, or neither (`[null, null]`) when nothing was accumulated;
 * - `batchStepDecides` (`execution/settlement.ts`): a pass decides the body, the terminal step
 *   (`isTerminalStep`: settled, loop slot unfilled) decides the exits;
 * - `isPastLoopEnd`: no body row at the terminal pass;
 * - `sourceRow` (`execution/iteration-mapping.ts`): an exit reads the loop's terminal row, so its
 *   consumer is decided after the loop ends;
 * - `countExpectedSettledSteps` (`execution/completion.ts`): `terminal + 1` rows of the batch
 *   node, `terminal` of each other member, one of every other node.
 */
import { enumerateBranches } from 'libpetri';
import type { InMemoryEventStore, Marking, Transition } from 'libpetri';
import { BATCH_OUTPUT_NAMES, compile, settlementActions, settlementPlaceholderActions } from '../../../src/compiler/index.js';
import type { CompiledWorkflow, PlaceRole, SettlementGadget, SettlementPolicy } from '../../../src/compiler/index.js';
import { graphToDescription } from '../../../src/conformance/v2/graph.js';
import type { V2Graph } from '../../../src/conformance/v2/graph.js';
import { ACCEPTED, diamondBody, exitIntoMerge, loop, noExit, selfLoop, twoLoops } from '../../fixtures/v2-graphs.js';
import { failed, runCompiled, type Executor } from '../support.js';

const compileV2 = (graph: V2Graph): CompiledWorkflow =>
  compile(graphToDescription(graph).description, { profile: 'engineV2' });

const EXECUTORS: readonly Executor[] = ['precompiled', 'bitmap'];

/** Every accepted graph with a batch loop. */
const LOOP_GRAPHS = Object.entries(ACCEPTED).filter(([, g]) => g.nodes.some((n) => n.type === 'batch'));

// ---- behaviour: what each row does ----

/** How one batch node's list runs out: `passes` passes, then the done slot filled or not. */
interface BatchScript {
  readonly passes: number;
  readonly end: 'data' | 'empty';
}

/**
 * One execution's behaviour. Every other run completes and fills every connected slot, except the
 * `node.slot@iteration` keys in `empty`; the `node@iteration` keys in `failing` fail.
 */
interface Behaviour {
  readonly batches?: Readonly<Record<string, BatchScript>>;
  readonly empty?: readonly string[];
  readonly failing?: readonly string[];
}

function policyOf({ batches = {}, empty = [], failing = [] }: Behaviour): SettlementPolicy {
  const unfilled = new Set(empty);
  const fails = new Set(failing);
  return {
    fails: (g, it) => fails.has(`${g.node}@${it}`),
    filled: (g, o, it) => {
      const script = batches[g.node];
      if (script === undefined) return !unfilled.has(`${g.node}.${o}@${it}`);
      // `runBatchStep`: a slice while the list lasts, then what the passes returned, if anything.
      if (it < script.passes) return o === 1;
      return o === 0 && script.end === 'data';
    },
  };
}

type Fate = 'completed' | 'skipped' | 'failed' | 'running';

/**
 * The rows the net produced, per node in iteration order, read off the transitions it started: a
 * start or a skip opens a row, a run settles the node's latest one as the policy decided it.
 */
function rowsOf(c: CompiledWorkflow, store: InMemoryEventStore, behaviour: Behaviour): Record<string, Fate[]> {
  const fails = new Set(behaviour.failing ?? []);
  const rows: Record<string, Fate[]> = Object.fromEntries(c.netMap.settlements.map((g) => [g.node, []]));
  for (const e of store.events()) {
    if (e.type !== 'transition-started') continue;
    const info = c.netMap.transition(e.transitionName)!;
    const own = rows[info.node]!;
    switch (info.role) {
      case 'start': own.push('running'); break;
      case 'skip': own.push('skipped'); break;
      case 'run': {
        const it = own.length - 1;
        const g = c.netMap.settlement(info.node);
        own[it] = g.failure === 'possible' && fails.has(`${info.node}@${it}`) ? 'failed' : 'completed';
        break;
      }
      default: break;
    }
  }
  return rows;
}

/** `countExpectedSettledSteps`, over the rows the net produced: each loop's terminal pass is its batch node's last row. */
function expectedSettled(c: CompiledWorkflow, rows: Record<string, Fate[]>): number {
  const loops = c.analysis.engineV2!.loops.filter((l) => c.analysis.reachable.has(l.batchNode));
  let expected = 0;
  const members = new Set<string>();
  for (const l of loops) {
    const terminal = rows[l.batchNode]!.length - 1;
    expected += terminal + 1 + terminal * (l.members.size - 1);
    for (const m of l.members) members.add(m);
  }
  for (const n of c.analysis.reachable) if (!members.has(n)) expected += 1;
  return expected;
}

/** Tokens on the places of `roles`, by place name, leaving out the empty ones. */
function tokensOn(c: CompiledWorkflow, m: Marking, roles: readonly PlaceRole[]): Record<string, number> {
  const held: Record<string, number> = {};
  for (const p of c.netMap.places) if (roles.includes(p.role) && m.tokenCount(p.place) > 0) held[p.name] = m.tokenCount(p.place);
  return held;
}

interface Outcome {
  readonly rows: Record<string, Fate[]>;
  readonly marking: Marking;
  readonly store: InMemoryEventStore;
}

async function run(c: CompiledWorkflow, behaviour: Behaviour, executor: Executor = 'precompiled'): Promise<Outcome> {
  const { marking, store } = await runCompiled(c.withActions(settlementActions(policyOf(behaviour))), c.initialMarking(null), executor);
  return { rows: rowsOf(c, store, behaviour), marking, store };
}

/**
 * A failure-free run's quiescent marking: nothing left to decide, one `B/ended` per loop, one
 * marker per node outside a loop, and as many settled rows as `countExpectedSettledSteps` owes.
 */
function expectSettledCleanly(c: CompiledWorkflow, { rows, marking, store }: Outcome, label: string): void {
  expect(failed(store), label).toEqual([]);
  expect(tokensOn(c, marking, ['arrived', 'live', 'running', 'ok', 'halt']), label).toEqual({});
  for (const g of c.netMap.settlements) {
    if (g.batch !== null) expect(marking.tokenCount(g.batch.ended), `${label}: ${g.node}/ended`).toBe(1);
    if (g.loop === null) expect(marking.tokenCount(g.done!) + (g.skipped === null ? 0 : marking.tokenCount(g.skipped)), `${label}: ${g.node}`).toBe(1);
  }
  const settled = Object.values(rows).flat();
  expect(settled.filter((f) => f === 'running' || f === 'failed'), label).toEqual([]);
  expect(settled.length, label).toBe(expectedSettled(c, rows));
}

/** `n` copies of `fate`. */
const times = (n: number, fate: Fate): Fate[] => Array.from({ length: n }, () => fate);

// ---- structure ----

describe.each(LOOP_GRAPHS)('the loop graph %s', (_name, graph) => {
  const c = compileV2(graph);

  it('gives every transition a real Out spec at priority 0, and maps each once', () => {
    for (const t of c.net.transitions) {
      expect(t.outputSpec, t.name).not.toBeNull();
      expect(t.priority, t.name).toBe(0);
    }
    expect(c.netMap.transitions.map((t) => t.name).sort()).toEqual([...c.net.transitions].map((t) => t.name).sort());
    expect(c.netMap.places.map((p) => p.name).sort()).toEqual([...c.net.places].map((p) => p.name).sort());
  });

  it('compiles every batch node with the real outputs [done, loop] and every loop member without markers', () => {
    const description = graphToDescription(graph).description;
    for (const l of c.analysis.engineV2!.loops) {
      const b = description.nodes.find((n) => n.name === l.batchNode)!;
      expect(description.nodeTypes(b).outputNames).toEqual(['done', 'loop']);
      for (const m of l.members) {
        const g = c.netMap.settlement(m);
        expect([g.loop, g.done, g.skipped], m).toEqual([l.batchNode, null, null]);
        expect(g.batch === null, m).toBe(m !== l.batchNode);
      }
    }
    expect(BATCH_OUTPUT_NAMES).toEqual(['done', 'loop']);
  });

  it('settles cleanly under the placeholder binder: every batch node ends at pass 0 with [null, null]', async () => {
    const { marking } = await runCompiled(c.withActions(settlementPlaceholderActions()), c.initialMarking(null));
    expect(tokensOn(c, marking, ['arrived', 'live', 'running', 'halt'])).toEqual({});
    for (const g of c.netMap.settlements) if (g.batch !== null) expect(marking.tokenCount(g.batch.ended), g.node).toBe(1);
  });
});

/** The flat branches of a transition's `Out` spec (IO-016), each a sorted list of place names. */
function branchesOf(t: Transition): string[][] {
  return enumerateBranches(t.outputSpec!).map((b) => [...b].map((p) => p.name).sort()).sort();
}

const arcs = (t: Transition): { inputs: string[]; inhibitors: string[] } => ({
  inputs: t.inputSpecs.map((s) => `${s.type}(${s.place.name})`).sort(),
  inhibitors: t.inhibitors.map((a) => a.place.name).sort(),
});

describe('the batch gadget (decision 5)', () => {
  const c = compileV2(loop);
  const b = c.netMap.settlement('B');
  const t = (name: string): Transition => c.netMap.transitionObject(name);
  const [exit] = b.outputs.find((o) => o.index === 0)!.edges;
  const [pass] = b.outputs.find((o) => o.index === 1)!.edges;
  const { entry, back, ended } = b.batch!;

  it('is the batch routing over its done and loop slots, with an entry and a back pair', () => {
    expect([b.routing, b.loop, b.done, b.skipped, b.failure]).toEqual(['batch', 'B', null, null, 'possible']);
    expect(b.outputs.map((o) => o.index)).toEqual([0, 1]);
    expect([entry.edge.from, back.edge.from, ended.name]).toEqual(['T', 'Body', 'B/ended']);
    expect(b.transitions).toEqual({ start: 'B/start_entry', skip: 'B/skip_entry', run: 'B/run', routes: [] });
    expect(b.batch!.transitions).toEqual({ startBack: 'B/start_back', skipBack: 'B/skip_back' });
    expect(c.netMap.transitionsOf('B').map((x) => [x.name, x.role])).toEqual([
      ['B/start_entry', 'start'], ['B/skip_entry', 'skip'], ['B/start_back', 'start'], ['B/skip_back', 'skip'], ['B/run', 'run'],
    ]);
    expect(c.netMap.place('B/ended')).toMatchObject({ role: 'ended', node: 'B' });
  });

  it('starts or skips each slot-0 edge on its own arrival, both over B/live', () => {
    for (const [start, skip, e] of [['B/start_entry', 'B/skip_entry', entry], ['B/start_back', 'B/skip_back', back]] as const) {
      expect(arcs(t(start))).toEqual({ inputs: [`all(B/live)`, `one(${e.arrived.name})`], inhibitors: ['_halt'] });
      expect(arcs(t(skip))).toEqual({ inputs: [`one(${e.arrived.name})`], inhibitors: ['B/live', '_halt'] });
      // A skip is terminal: it decides the exits, dead, and ends the loop.
      expect(branchesOf(t(skip))).toEqual([[exit!.arrived.name, 'B/ended'].sort()]);
    }
  });

  it('runs one side of the loop: a pass, done with data, done empty, or the halt', () => {
    expect(arcs(t('B/run'))).toEqual({ inputs: ['one(B/running)'], inhibitors: [] });
    expect(branchesOf(t('B/run'))).toEqual([
      [pass!.arrived.name, 'Body/live'].sort(),
      [exit!.arrived.name, 'After/live', 'B/ended'].sort(),
      [exit!.arrived.name, 'B/ended'].sort(),
      ['B/ended', '_halt'],
    ].sort());
  });

  it('has one done branch when the loop has no exit', () => {
    const n = compileV2(noExit);
    const [p] = n.netMap.settlement('B').outputs.map((o) => o.edges[0]!);
    expect(branchesOf(n.netMap.transitionObject('B/run'))).toEqual([
      [p!.arrived.name, 'Body/live'].sort(), ['B/ended'], ['B/ended', '_halt'],
    ].sort());
  });

  it('closes a self loop through one inout port per place: its pass writes its own return and live', () => {
    const s = compileV2(selfLoop);
    const sb = s.netMap.settlement('B');
    const k = sb.batch!.back;
    expect(k.edge.to).toBe('B');
    expect(branchesOf(s.netMap.transitionObject('B/run'))).toContainEqual([k.arrived.name, 'B/live'].sort());
    expect(arcs(s.netMap.transitionObject('B/start_back')).inputs).toEqual(['all(B/live)', `one(${k.arrived.name})`]);
  });

  it('gives a loop member the node gadget without markers: its skip only forwards dead arrivals', () => {
    const body = c.netMap.settlement('Body');
    expect(branchesOf(t(body.transitions.skip!))).toEqual([[back.arrived.name]]);
    expect(branchesOf(t(body.transitions.run))).toEqual([[back.arrived.name], [back.arrived.name, 'B/live'].sort(), ['_halt']].sort());
  });
});

// ---- behaviour ----

describe.each(EXECUTORS)('the loop, run on the %s executor', (executor) => {
  const c = compileV2(loop);

  it.each([1, 2, 3])('runs %i passes, then fills the done slot', async (passes) => {
    const out = await run(c, { batches: { B: { passes, end: 'data' } } }, executor);
    expect(out.rows).toEqual({ T: ['completed'], B: times(passes + 1, 'completed'), Body: times(passes, 'completed'), After: ['completed'] });
    expectSettledCleanly(c, out, `${passes} passes`);
  });

  it('ends at pass 0 with [null, null] on an empty list: no body row, the exit dead', async () => {
    const out = await run(c, { batches: { B: { passes: 0, end: 'empty' } } }, executor);
    expect(out.rows).toEqual({ T: ['completed'], B: ['completed'], Body: [], After: ['skipped'] });
    expectSettledCleanly(c, out, '0 passes');
  });

  it('ends with [null, null] after passes that returned nothing: the exit is dead', async () => {
    const out = await run(c, { batches: { B: { passes: 2, end: 'empty' } } }, executor);
    expect(out.rows).toEqual({ T: ['completed'], B: times(3, 'completed'), Body: times(2, 'completed'), After: ['skipped'] });
    expectSettledCleanly(c, out, '[null, null] after 2 passes');
  });

  it('skips the batch node on a dead entry: the loop ends at pass 0 and the body is never decided', async () => {
    const out = await run(c, { batches: { B: { passes: 3, end: 'data' } }, empty: ['T.0@0'] }, executor);
    expect(out.rows).toEqual({ T: ['completed'], B: ['skipped'], Body: [], After: ['skipped'] });
    expectSettledCleanly(c, out, 'dead entry');
  });

  it('ends the loop mid-list on a dead back edge: a terminal skip, the exit dead', async () => {
    // The list has three passes' worth, but the body fills nothing at pass 1.
    const out = await run(c, { batches: { B: { passes: 3, end: 'data' } }, empty: ['Body.0@1'] }, executor);
    expect(out.rows).toEqual({ T: ['completed'], B: ['completed', 'completed', 'skipped'], Body: times(2, 'completed'), After: ['skipped'] });
    expectSettledCleanly(c, out, 'dead back edge');
  });
});

describe.each(EXECUTORS)('loops with more around them, on the %s executor', (executor) => {
  it('decides a branch inside the body per pass, and ends on a skip cascading to the back edge', async () => {
    const c = compileV2(diamondBody);
    // Pass 0 takes both branches, pass 1 only Q's; at pass 2 If fills nothing, so P, Q and the
    // Merge are skipped, the back edge arrives dead and the batch node's pass 3 is a terminal skip.
    const out = await run(c, { batches: { B: { passes: 4, end: 'data' } }, empty: ['If.0@1', 'If.0@2', 'If.1@2'] }, executor);
    expect(out.rows).toEqual({
      T: ['completed'], B: ['completed', 'completed', 'completed', 'skipped'], If: times(3, 'completed'),
      P: ['completed', 'skipped', 'skipped'], Q: ['completed', 'completed', 'skipped'], M: ['completed', 'completed', 'skipped'],
      After: ['skipped'],
    });
    expectSettledCleanly(c, out, 'diamond body');
  });

  it('holds a Merge fed by an exit and a plain edge until the loop has ended', async () => {
    const c = compileV2(exitIntoMerge);
    const out = await run(c, { batches: { B: { passes: 2, end: 'data' } } }, executor);
    expect(out.rows).toEqual({
      T: ['completed'], If: ['completed'], B: times(3, 'completed'), Body: times(2, 'completed'), Other: ['completed'],
      M: ['completed'],
    });
    expectSettledCleanly(c, out, 'exit into a Merge');
    // `sourceRow`'s `pending`: Other settled long before, but M starts only after B's last run.
    const started = out.store.events().flatMap((e) => (e.type === 'transition-started' ? [e.transitionName] : []));
    expect(started.indexOf('M/start')).toBeGreaterThan(started.lastIndexOf('B/run'));
  });

  it('runs the Merge on its plain edge when the loop is skipped at its entry', async () => {
    const c = compileV2(exitIntoMerge);
    const out = await run(c, { batches: { B: { passes: 2, end: 'data' } }, empty: ['If.0@0'] }, executor);
    expect(out.rows).toEqual({ T: ['completed'], If: ['completed'], B: ['skipped'], Body: [], Other: ['completed'], M: ['completed'] });
    expectSettledCleanly(c, out, 'dead entry into a Merge');
  });

  it('skips the Merge when the loop ends empty and the plain edge is dead', async () => {
    const c = compileV2(exitIntoMerge);
    const out = await run(c, { batches: { B: { passes: 1, end: 'empty' } }, empty: ['If.1@0'] }, executor);
    expect(out.rows).toEqual({ T: ['completed'], If: ['completed'], B: times(2, 'completed'), Body: ['completed'], Other: ['skipped'], M: ['skipped'] });
    expectSettledCleanly(c, out, 'both inputs of the Merge dead');
  });

  it('runs two loops in sequence: the first loop\'s exit is the second\'s entry', async () => {
    const c = compileV2(twoLoops);
    expect(c.netMap.settlement('B2').batch!.entry.edge.from).toBe('B1');
    const out = await run(c, { batches: { B1: { passes: 2, end: 'data' }, B2: { passes: 1, end: 'data' } } }, executor);
    expect(out.rows).toEqual({
      T: ['completed'], B1: times(3, 'completed'), Body1: times(2, 'completed'), B2: times(2, 'completed'), Body2: ['completed'],
      End: ['completed'],
    });
    expectSettledCleanly(c, out, 'two loops');
  });

  it('skips the second loop at its entry when the first ends empty', async () => {
    const c = compileV2(twoLoops);
    const out = await run(c, { batches: { B1: { passes: 1, end: 'empty' }, B2: { passes: 1, end: 'data' } } }, executor);
    expect(out.rows).toEqual({
      T: ['completed'], B1: times(2, 'completed'), Body1: ['completed'], B2: ['skipped'], Body2: [], End: ['skipped'],
    });
    expectSettledCleanly(c, out, 'second loop skipped');
  });

  it('runs a self loop, whose pass is its own return', async () => {
    const c = compileV2(selfLoop);
    const out = await run(c, { batches: { B: { passes: 3, end: 'data' } } }, executor);
    expect(out.rows).toEqual({ T: ['completed'], B: times(4, 'completed'), After: ['completed'] });
    expectSettledCleanly(c, out, 'self loop');
  });

  it('ends a loop with no exit on its B/ended alone', async () => {
    const c = compileV2(noExit);
    const out = await run(c, { batches: { B: { passes: 2, end: 'data' } } }, executor);
    expect(out.rows).toEqual({ T: ['completed'], B: times(3, 'completed'), Body: times(2, 'completed') });
    expectSettledCleanly(c, out, 'no exit');
  });
});

describe('failure inside a loop (decision 8)', () => {
  const c = compileV2(loop);
  const b = (): SettlementGadget => c.netMap.settlement('B');

  it('halts on a failed body row: the next pass is never decided and the loop does not end', async () => {
    const out = await run(c, { batches: { B: { passes: 3, end: 'data' } }, failing: ['Body@1'] });
    expect(out.rows).toEqual({ T: ['completed'], B: times(2, 'completed'), Body: ['completed', 'failed'], After: [] });
    expect(tokensOn(c, out.marking, ['arrived', 'live', 'running', 'ended', 'halt'])).toEqual({ _halt: 1 });
  });

  it('ends the loop on a failed batch row, which is terminal, and decides nothing after it', async () => {
    const out = await run(c, { batches: { B: { passes: 3, end: 'data' } }, failing: ['B@1'] });
    expect(out.rows).toEqual({ T: ['completed'], B: ['completed', 'failed'], Body: ['completed'], After: [] });
    expect(tokensOn(c, out.marking, ['arrived', 'live', 'running', 'ended', 'halt'])).toEqual({ _halt: 1, [b().batch!.ended.name]: 1 });
  });

  it('refuses a batch row that fills both slots, which runBatchStep never returns', async () => {
    const both: SettlementPolicy = { filled: (g, o) => g.node !== 'B' || o === 0 || o === 1 };
    const { store } = await runCompiled(c.withActions(settlementActions(both)), c.initialMarking(null));
    expect(failed(store).map((e) => [e.transitionName, e.errorMessage])).toEqual([
      ['B/run', expect.stringContaining('filled both its done and its loop slot at pass 0')],
    ]);
  });
});

describe('the row count the binder keeps', () => {
  it('restarts with the trigger, so a bound net runs again from pass 0', async () => {
    const c = compileV2(loop);
    const bound = c.withActions(settlementActions(policyOf({ batches: { B: { passes: 2, end: 'data' } } })));
    for (const round of [1, 2]) {
      const { store } = await runCompiled(bound, c.initialMarking(null));
      expect(rowsOf(c, store, {}).B, `run ${round}`).toEqual(times(3, 'completed'));
    }
  });

  it('asks the policy about each row of a member by its pass', async () => {
    const asked: string[] = [];
    const c = compileV2(loop);
    const policy = policyOf({ batches: { B: { passes: 2, end: 'data' } } });
    await runCompiled(c.withActions(settlementActions({
      filled: (g, o, it) => { asked.push(`${g.node}.${o}@${it}`); return policy.filled(g, o, it); },
    })), c.initialMarking(null));
    expect(asked.filter((a) => a.startsWith('Body'))).toEqual(['Body.0@0', 'Body.0@1']);
  });
});
