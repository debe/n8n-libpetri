/**
 * The step-row decoder and the stateless planner (`tasks/v2-profile-plan.md` step 8, decisions 12
 * and 13): engine v2's rows → a marking of the `engineV2` net by guided replay, and the enabled
 * starts and skips at that marking as the plan.
 *
 * - **Executor traces.** Each `engineV2` graph is run on libpetri's executors under seeded
 *   behaviours, with seeded delays in the actions so the firings interleave. At every point of the
 *   trace where no transition is in flight and no split route is pending — the points where the
 *   net's state is a row set — the rows the trace has written so far decode to exactly the
 *   executor's marking there.
 * - **Replay order.** Twenty seeded permutations of each row set decode to one marking.
 * - **Refusals.** Every `CodecError` case the plan lists, and the ones the decoder adds.
 * - **Enabledness.** The planner's hand-written enabledness (`net.ts`) equals libpetri's own:
 *   `StateClassGraph`'s initial class, built from the decoded marking, at every trace point.
 *
 * What this suite does not do is compare the plan with n8n's `decideSuccessors`: that is the
 * differential of step 10, which loads n8n's code. The plans asserted here are written from
 * engine v2's rules, as the step 5 and 6 suites write their fates.
 */
import { InMemoryEventStore, PrecompiledNetExecutor, BitmapNetExecutor } from 'libpetri';
import type { Place, Token, TransitionAction } from 'libpetri';
import { MarkingState, StateClassGraph } from 'libpetri/verification';
import { CodecError } from '../../src/codec/errors.js';
import { enabledTransitions, planFromMarking } from '../../src/codec/v2/plan.js';
import { decodeStepRows, type StepKey, type StepRow } from '../../src/codec/v2/step-rows.js';
import {
  compile, DONE_SLOT, LOOP_SLOT, ProfileMismatchError, settlementActions,
} from '../../src/compiler/index.js';
import type { ActionBinder, CompiledWorkflow, SettlementGadget, SettlementPolicy } from '../../src/compiler/index.js';
import { graphToDescription } from '../../src/conformance/v2/graph.js';
import { hash, rng } from '../../src/conformance/v2/reference.js';
import type { V2Graph } from '../../src/conformance/v2/graph.js';
import { ACCEPTED, SETTLEMENT_SHAPES, branchDiamond, chain, edge, loop, trigger, v1 } from '../fixtures/v2-graphs.js';
import { diamond } from '../fixtures/workflows.js';

const compileV2 = (graph: V2Graph): CompiledWorkflow =>
  compile(graphToDescription(graph).description, { profile: 'engineV2' });

// ---- seeded behaviour ----

/**
 * Behaviour `seed`: a slot is filled with probability 0.7 per (node, slot, iteration); a batch node
 * runs 0 to 3 passes and then ends with or without data (`runBatchStep`); with `pFail`, a run
 * fails with that probability per (node, iteration).
 */
function behaviour(seed: number, pFail: number): SettlementPolicy {
  return {
    fails: (g, it) => rng(hash(seed, g.id, it, 'fail'))() < pFail,
    filled: (g, o, it) => {
      if (g.batch !== null) {
        const passes = hash(seed, g.id, 'passes') % 4;
        if (it < passes) return o === LOOP_SLOT;
        return o === DONE_SLOT && hash(seed, g.id, 'end') % 2 === 0;
      }
      return rng(hash(seed, g.id, o, it))() < 0.7;
    },
  };
}

/** `binder`'s actions, each after a seeded number (0–3) of macrotask ticks: real interleavings. */
function delayed(binder: ActionBinder, seed: number): ActionBinder {
  const draw = rng(hash(seed, 'delay'));
  return (info, map) => {
    const action = binder(info, map);
    if (action === null) return null;
    const wrapped: TransitionAction = async (ctx) => {
      for (let n = Math.floor(draw() * 4); n > 0; n--) await new Promise<void>((r) => setImmediate(r));
      return action(ctx);
    };
    return wrapped;
  };
}

// ---- the trace, as rows and markings ----

type Counts = Record<string, number>;

/** A point of the trace where the net's state is a row set: the rows so far, and the executor's marking. */
interface TracePoint {
  readonly rows: StepRow[];
  readonly marking: Counts;
}

function countsOf(marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>): Counts {
  const out: Counts = {};
  for (const [p, tokens] of marking) if (tokens.length > 0) out[p.name] = tokens.length;
  return out;
}

/** What a completed run of `g` at `it` filled, as `filledOutputSlots` (the binder's own reading of the policy). */
function filledSlots(g: SettlementGadget, policy: SettlementPolicy, it: number): boolean[] {
  if (g.batch !== null) {
    const pass = policy.filled(g, LOOP_SLOT, it);
    return pass ? [false, true] : [policy.filled(g, DONE_SLOT, it), false];
  }
  const slots: boolean[] = [];
  for (const o of g.outputs) slots[o.index] = policy.filled(g, o.index, it);
  return Array.from(slots, Boolean);
}

/**
 * Runs `c` under `policy` and reads the trace back: the executor's marking from its token events,
 * and the rows from its firings — a start opens a row `running`, a skip one `skipped`, a run
 * settles the node's latest row as the policy decided. A point is kept after every completed
 * firing that leaves nothing in flight and no split route pending.
 */
async function trace(c: CompiledWorkflow, policy: SettlementPolicy, seed: number, bitmap: boolean): Promise<TracePoint[]> {
  const store = new InMemoryEventStore();
  const bound = c.withActions(delayed(settlementActions(policy), seed));
  const initial = c.initialMarking(null);
  const ex = bitmap
    ? new BitmapNetExecutor(bound.net, initial, { eventStore: store })
    : new PrecompiledNetExecutor(bound.net, initial, { eventStore: store, program: bound.program });
  await ex.run();

  const marking = countsOf(initial);
  const rows = new Map<string, StepRow[]>();
  const routesPending = new Map<string, number>();
  let inFlight = 0;
  const points: TracePoint[] = [{ rows: [], marking: { ...marking } }];
  for (const e of store.events()) {
    if (e.type === 'token-added') marking[e.placeName] = (marking[e.placeName] ?? 0) + 1;
    if (e.type === 'token-removed') {
      marking[e.placeName] = marking[e.placeName]! - 1;
      if (marking[e.placeName] === 0) delete marking[e.placeName];
    }
    if (e.type === 'transition-started') inFlight++;
    if (e.type !== 'transition-completed') continue;
    inFlight--;
    const info = c.netMap.transition(e.transitionName)!;
    const g = c.netMap.settlement(info.node);
    const own = rows.get(g.id) ?? [];
    rows.set(g.id, own);
    const it = own.length - 1;
    switch (info.role) {
      case 'start': own.push({ nodeId: g.id, iteration: own.length, status: 'running', filledOutputSlots: [] }); break;
      case 'skip': own.push({ nodeId: g.id, iteration: own.length, status: 'skipped', filledOutputSlots: [] }); break;
      case 'run': {
        const fails = g.failure === 'possible' && policy.fails!(g, it);
        own[it] = { nodeId: g.id, iteration: it, status: fails ? 'failed' : 'completed', filledOutputSlots: fails ? [] : filledSlots(g, policy, it) };
        if (!fails && g.routing === 'split') routesPending.set(g.id, g.outputs.length);
        break;
      }
      case 'route': routesPending.set(g.id, routesPending.get(g.id)! - 1); break;
      default: throw new Error(`unexpected role ${info.role}`);
    }
    if (inFlight === 0 && [...routesPending.values()].every((n) => n === 0)) {
      points.push({ rows: [...rows.values()].flat(), marking: { ...marking } });
    }
  }
  return points;
}

/** Seeded Fisher–Yates. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** libpetri's enabled set at `marking`: the initial class of a one-class state-class graph. */
function stateClassEnabled(c: CompiledWorkflow, marking: ReadonlyMap<Place<unknown>, readonly Token<unknown>[]>): string[] {
  const b = MarkingState.builder();
  for (const [p, tokens] of marking) b.tokens(p, tokens.length);
  return StateClassGraph.build(c.net, b.build(), 1).initialClass.enabledTransitions.map((t) => t.name).sort();
}

const keys = (ks: readonly StepKey[]): string[] => ks.map((k) => `${k.nodeId}@${k.iteration}`).sort();

// ---- subjects ----

/** Every accepted graph the fixtures have, each once: the six shapes outside a loop and the six loop graphs. */
const SUBJECTS: readonly (readonly [string, V2Graph])[] = Object.entries({ ...SETTLEMENT_SHAPES, ...ACCEPTED });
const SEEDS = Array.from({ length: 12 }, (_, i) => i);
/** A third of the behaviours let a run fail. */
const pFailOf = (seed: number): number => (seed % 3 === 2 ? 0.3 : 0);

describe.each(SUBJECTS)('%s', (_name, graph) => {
  const c = compileV2(graph);

  it('decodes every row-set point of every executor trace to the executor marking, and libpetri agrees on what is enabled', async () => {
    let points = 0;
    for (const seed of SEEDS) {
      for (const bitmap of [false, true]) {
        const policy = behaviour(seed, pFailOf(seed));
        for (const point of await trace(c, policy, seed, bitmap)) {
          const label = `seed ${seed}${bitmap ? ' bitmap' : ''}, rows ${point.rows.map((r) => `${r.nodeId}@${r.iteration}=${r.status}`).join(' ')}`;
          const decoded = decodeStepRows(c, point.rows);
          expect(countsOf(decoded.marking), label).toEqual(point.marking);
          expect(enabledTransitions(c, decoded.marking).map((t) => t.name).sort(), label).toEqual(stateClassEnabled(c, decoded.marking));
          points++;
        }
      }
    }
    expect(points).toBeGreaterThan(SEEDS.length * 2);
  });

  it('decodes 20 random replay orders of each trace\'s rows to one marking', async () => {
    for (const seed of SEEDS) {
      const points = await trace(c, behaviour(seed, pFailOf(seed)), seed, false);
      // The last point is the whole trace; a middle one has steps in flight.
      for (const point of [points[points.length - 1]!, points[Math.floor(points.length / 2)]!]) {
        const want = countsOf(decodeStepRows(c, point.rows).marking);
        for (let order = 0; order < 20; order++) {
          expect(countsOf(decodeStepRows(c, shuffled(point.rows, hash(seed, order))).marking), `seed ${seed} order ${order}`).toEqual(want);
        }
      }
    }
  });

  it('plans nothing once the trace has quiesced', async () => {
    for (const seed of SEEDS) {
      const points = await trace(c, behaviour(seed, pFailOf(seed)), seed, false);
      expect(planFromMarking(c, decodeStepRows(c, points[points.length - 1]!.rows)), `seed ${seed}`).toEqual({ toQueue: [], toSkip: [] });
    }
  });
});

// ---- plans written from engine v2's rules ----

const row = (nodeId: string, iteration: number, status: StepRow['status'], filledOutputSlots: boolean[] = []): StepRow =>
  ({ nodeId, iteration, status, filledOutputSlots });

describe('planFromMarking', () => {
  it('plans the trigger alone from no rows, and after the trigger the successors its slots decide', () => {
    const c = compileV2(branchDiamond);
    expect(planFromMarking(c, decodeStepRows(c, []))).toEqual({ toQueue: [{ nodeId: 'T', iteration: 0 }], toSkip: [] });
    const plan = (ifSlots: boolean[]) => planFromMarking(c, decodeStepRows(c, [
      row('T', 0, 'completed', [true]), row('If', 0, 'completed', ifSlots),
    ]));
    // Rule 3: a live input queues, a settled dead one skips.
    expect(plan([true, false])).toEqual({ toQueue: [{ nodeId: 'P', iteration: 0 }], toSkip: [{ nodeId: 'Q', iteration: 0 }] });
    expect(plan([false, false])).toEqual({ toQueue: [], toSkip: [{ nodeId: 'P', iteration: 0 }, { nodeId: 'Q', iteration: 0 }] });
  });

  it('holds a Merge until every input has settled, then queues it on one live input', () => {
    const c = compileV2(branchDiamond);
    const base = [row('T', 0, 'completed', [true]), row('If', 0, 'completed', [true, true]), row('P', 0, 'completed', [true])];
    expect(keys(planFromMarking(c, decodeStepRows(c, [...base, row('Q', 0, 'running')])).toQueue)).toEqual([]);
    expect(planFromMarking(c, decodeStepRows(c, [...base, row('Q', 0, 'completed', [false])])))
      .toEqual({ toQueue: [{ nodeId: 'M', iteration: 0 }], toSkip: [] });
  });

  it('keys a loop step by its pass: the body at the pass, the batch node at the next one, the exit at 0', () => {
    const c = compileV2(loop);
    const pass0 = [row('T', 0, 'completed', [true]), row('B', 0, 'completed', [false, true])];
    expect(planFromMarking(c, decodeStepRows(c, pass0))).toEqual({ toQueue: [{ nodeId: 'Body', iteration: 0 }], toSkip: [] });
    const body0 = [...pass0, row('Body', 0, 'completed', [true])];
    expect(planFromMarking(c, decodeStepRows(c, body0))).toEqual({ toQueue: [{ nodeId: 'B', iteration: 1 }], toSkip: [] });
    // The terminal pass decides the exit, and no body row (`isPastLoopEnd`).
    const ended = [...body0, row('B', 1, 'completed', [true, false])];
    expect(planFromMarking(c, decodeStepRows(c, ended))).toEqual({ toQueue: [{ nodeId: 'After', iteration: 0 }], toSkip: [] });
    const skippedBody = [...pass0, row('Body', 0, 'completed', [false])];
    expect(planFromMarking(c, decodeStepRows(c, skippedBody))).toEqual({ toQueue: [], toSkip: [{ nodeId: 'B', iteration: 1 }] });
  });

  it('plans nothing after a failure, with no special case: _halt inhibits every start and skip', () => {
    const c = compileV2(branchDiamond);
    const rows = [row('T', 0, 'completed', [true]), row('If', 0, 'completed', [true, true]), row('P', 0, 'failed'), row('Q', 0, 'cancelled')];
    const decoded = decodeStepRows(c, rows);
    expect(countsOf(decoded.marking)).toMatchObject({ _halt: 1, 'Q/running': 1, 'P/done': 1 });
    expect(planFromMarking(c, decoded)).toEqual({ toQueue: [], toSkip: [] });
  });

  it('replays a row v2 created before it saw a failure: the halt is deposited last', () => {
    // T -> A, T -> B -> C: A failed while B completed, and B's planner queued C before A's row was failed.
    const c = compileV2({ nodes: [trigger('T'), v1('A'), v1('B'), v1('C')], edges: [edge('T', 'A'), edge('T', 'B'), edge('B', 'C')] });
    const decoded = decodeStepRows(c, [
      row('C', 0, 'queued'), row('A', 0, 'failed'), row('B', 0, 'completed', [true]), row('T', 0, 'completed', [true]),
    ]);
    expect(countsOf(decoded.marking)).toEqual({ _halt: 1, 'T/done': 1, 'A/done': 1, 'B/done': 1, 'C/running': 1 });
    expect(planFromMarking(c, decoded)).toEqual({ toQueue: [], toSkip: [] });
  });
});

// ---- refusals ----

describe('decodeStepRows refuses a row set the net cannot have produced', () => {
  const c = compileV2(chain);
  const cl = compileV2(loop);
  const t = row('T', 0, 'completed', [true]);
  const refuses = (compiled: CompiledWorkflow, rows: StepRow[], message: RegExp): void => {
    expect(() => decodeStepRows(compiled, rows)).toThrow(CodecError);
    expect(() => decodeStepRows(compiled, rows)).toThrow(message);
  };

  it('an unknown status, waiting included', () => {
    refuses(c, [t, row('A', 0, 'waiting')], /status 'waiting' is not an engine v2 step status/);
    refuses(c, [t, row('A', 0, 'paused')], /status 'paused'/);
  });

  it('a gap in a node\'s iterations', () => {
    refuses(cl, [t, row('B', 0, 'completed', [false, true]), row('Body', 0, 'completed', [true]), row('B', 2, 'running')],
      /'B' has 2 rows but none at iteration 1/);
  });

  it('a row whose start or skip is not enabled', () => {
    // T left its slot empty, so A is skipped, never run; and T filled it, so A cannot be skipped.
    refuses(c, [row('T', 0, 'completed', [false]), row('A', 0, 'completed', [true])], /cannot have produced.*\(A, 0\) 'A' completed/);
    refuses(c, [t, row('A', 0, 'skipped')], /\(A, 0\) 'A' skipped/);
    // A successor decided before its predecessor settled.
    refuses(c, [t, row('A', 0, 'running'), row('B', 0, 'skipped')], /\(B, 0\) 'B' skipped/);
  });

  it('a batch row filling both its done and its loop slot', () => {
    refuses(cl, [t, row('B', 0, 'completed', [true, true])], /fills both its done and its loop slot/);
  });

  it('a loop member row at the pass where its loop ended', () => {
    refuses(cl, [t, row('B', 0, 'completed', [true, false]), row('Body', 0, 'running')],
      /loop member 'Body' is at pass 0, where batch node 'B' ended its loop/);
    refuses(cl, [t, row('B', 0, 'skipped'), row('Body', 0, 'skipped')], /where batch node 'B' ended its loop/);
  });

  it('a cancelled row without a failed one', () => {
    refuses(c, [t, row('A', 0, 'cancelled')], /cancelled but no row failed/);
  });

  it('a node the net does not compile, a repeated row, a second row outside a loop', () => {
    refuses(c, [t, row('X', 0, 'running')], /node 'X' is not compiled/);
    refuses(c, [t, t], /appears twice/);
    refuses(c, [t, row('A', 0, 'completed', [true]), row('A', 1, 'running')], /outside every loop and has 2 rows/);
    refuses(c, [t, row('A', -1, 'running')], /not a non-negative integer/);
  });

  it('a trigger row that failed or was skipped, and filled slots on a row that did not complete', () => {
    refuses(c, [row('T', 0, 'failed')], /trigger 'T' is failed/);
    refuses(c, [row('T', 0, 'skipped')], /trigger 'T' is skipped/);
    refuses(c, [t, row('A', 0, 'failed', [true])], /a failed row fills output slots/);
  });

  it('a v1 net, by profile', () => {
    const v1Compiled = compile(diamond);
    expect(() => decodeStepRows(v1Compiled, [])).toThrow(ProfileMismatchError);
    expect(() => planFromMarking(v1Compiled, { marking: new Map(), rowCounts: new Map() })).toThrow(ProfileMismatchError);
    expect(() => enabledTransitions(v1Compiled, new Map())).toThrow(ProfileMismatchError);
  });
});

