/**
 * Spike 2 — the join gadget (README "Join gadget"), two inputs.
 *
 * ```
 * per input i:  X/free_i (1 token)
 * arm_i_data:   one(e_i/data)  one(X/free_i) → and(X/ready_i, X/hasdata)
 * arm_i_empty:  one(e_i/empty) one(X/free_i) → X/ready_i
 * X_start:      one(X/ready_0) one(X/ready_1) all(X/hasdata) one(_budget) one(X/idle) inhibitor(_halt)
 *               → and(X/running, X/free_0, X/free_1)
 * X_skip:       one(X/ready_0) one(X/ready_1) inhibitor(X/hasdata) → and(out/empty, X/skipped, X/free_0, X/free_1)
 * ```
 *
 * Pins: with two arrivals per input the join fires once per slot and pairs FIFO (first
 * arrival on input 0 with first on input 1; EXEC-010 FIFO consumption); `free_i`
 * serialises the second slot so the second arm cannot fire before the first `X_start`
 * has fired; `hasdata` therefore counts one slot only (`all()` drains it, IO-003); an
 * all-empty slot takes `X_skip` (inhibitor, CORE-031); `all()` requiring >= 1 (IO-003
 * AC3) makes `X_start` and `X_skip` mutually exclusive with no priority involved.
 */
import {
  PetriNet, PrecompiledNet, Transition, place, one, all, and, outPlace, tokenOf,
  type Place, type Token,
} from 'libpetri';
import { isStartOf, nthIndex, runNet, started, units, type Initial } from './support.js';

type Arrival = string | null; // null = the explicit empty token

interface Slot { readonly a: Arrival; readonly b: Arrival; readonly hasdata: number }

describe('spike: join gadget', () => {
  const e0data = place<string>('e0/data');
  const e0empty = place<null>('e0/empty');
  const e1data = place<string>('e1/data');
  const e1empty = place<null>('e1/empty');
  const free0 = place<null>('X/free_0');
  const free1 = place<null>('X/free_1');
  const ready0 = place<Arrival>('X/ready_0');
  const ready1 = place<Arrival>('X/ready_1');
  const hasdata = place<null>('X/hasdata');
  const budget = place<null>('_budget');
  const idle = place<null>('X/idle');
  const halt = place<null>('_halt');
  const running = place<Slot>('X/running');
  const out = place<Slot>('X/out');
  const outEmpty = place<null>('X/out_empty');
  const skipped = place<null>('X/skipped');
  const done = place<null>('X/done');

  let slots: Slot[] = [];

  const arm = (name: string, edge: Place<Arrival>, free: Place<null>, ready: Place<Arrival>, data: boolean) =>
    Transition.builder(name)
      .inputs(one(edge), one(free))
      .outputs(data ? and(outPlace(ready), outPlace(hasdata)) : outPlace(ready))
      .action(async (ctx) => {
        ctx.output(ready, ctx.input(edge));
        if (data) ctx.output(hasdata, null);
      })
      .build();

  const xStart = Transition.builder('X_start')
    .inputs(one(ready0), one(ready1), all(hasdata), one(budget), one(idle))
    .inhibitor(halt)
    .outputs(and(outPlace(running), outPlace(free0), outPlace(free1)))
    .action(async (ctx) => {
      ctx.output(running, { a: ctx.input(ready0), b: ctx.input(ready1), hasdata: ctx.inputs(hasdata).length });
      ctx.output(free0, null);
      ctx.output(free1, null);
    })
    .build();

  const xSkip = Transition.builder('X_skip')
    .inputs(one(ready0), one(ready1))
    .inhibitor(hasdata)
    .outputs(and(outPlace(outEmpty), outPlace(skipped), outPlace(free0), outPlace(free1)))
    .action(async (ctx) => {
      ctx.output(outEmpty, null);
      ctx.output(skipped, null);
      ctx.output(free0, null);
      ctx.output(free1, null);
    })
    .build();

  const xRun = Transition.builder('X_run')
    .inputs(one(running))
    .outputs(and(outPlace(out), outPlace(budget), outPlace(idle), outPlace(done)))
    .action(async (ctx) => {
      const slot = ctx.input(running);
      slots.push(slot);
      ctx.output(out, slot);
      ctx.output(budget, null);
      ctx.output(idle, null);
      ctx.output(done, null);
    })
    .build();

  const net = PetriNet.builder('join').transitions(
    arm('arm_0_data', e0data, free0, ready0, true),
    arm('arm_0_empty', e0empty, free0, ready0, false),
    arm('arm_1_data', e1data, free1, ready1, true),
    arm('arm_1_empty', e1empty, free1, ready1, false),
    xStart, xSkip, xRun,
  ).build();
  const program = PrecompiledNet.compile(net);

  const base = (): Initial => new Map<Place<any>, Token<any>[]>([
    [free0, units()], [free1, units()], [budget, units()], [idle, units()],
  ]);

  beforeEach(() => { slots = []; });

  it('two arrivals per input: fires once per slot, pairs FIFO, serialised by free_i, hasdata counts one slot', async () => {
    const initial = base();
    initial.set(e0data, ['a1', 'a2'].map(tokenOf));
    initial.set(e1data, ['b1', 'b2'].map(tokenOf));
    const r = await runNet(net, initial, program);

    // Once per slot, never the skip.
    expect(started(r.store, (n) => n === 'X_start')).toHaveLength(2);
    expect(started(r.store, (n) => n === 'X_skip')).toHaveLength(0);
    expect(started(r.store, (n) => n === 'X_run')).toHaveLength(2);

    // FIFO pairing (EXEC-010) and hasdata drained per slot (IO-003): 2 per slot, never 3 or 4.
    expect(slots).toEqual([
      { a: 'a1', b: 'b1', hasdata: 2 },
      { a: 'a2', b: 'b2', hasdata: 2 },
    ]);

    // free_i serialises: the second arm on each input fires only after the first X_start.
    const firstStart = nthIndex(r.store, isStartOf('X_start'), 1);
    expect(nthIndex(r.store, isStartOf('arm_0_data'), 2)).toBeGreaterThan(firstStart);
    expect(nthIndex(r.store, isStartOf('arm_1_data'), 2)).toBeGreaterThan(firstStart);

    // Everything structural is back where it started; the two results are out.
    expect(r.marking.tokenCount(free0)).toBe(1);
    expect(r.marking.tokenCount(free1)).toBe(1);
    expect(r.marking.tokenCount(ready0)).toBe(0);
    expect(r.marking.tokenCount(ready1)).toBe(0);
    expect(r.marking.tokenCount(hasdata)).toBe(0);
    expect(r.marking.tokenCount(budget)).toBe(1);
    expect(r.marking.tokenCount(idle)).toBe(1);
    expect(r.marking.tokenCount(out)).toBe(2);
    expect(r.marking.tokenCount(done)).toBe(2);
  });

  it('an all-empty slot takes X_skip, and X_start never fires', async () => {
    const initial = base();
    initial.set(e0empty, units());
    initial.set(e1empty, units());
    const r = await runNet(net, initial, program);

    expect(started(r.store, (n) => n.startsWith('X_'))).toEqual(['X_skip']);
    expect(slots).toEqual([]);
    expect(r.marking.tokenCount(outEmpty)).toBe(1);
    expect(r.marking.tokenCount(skipped)).toBe(1);
    expect(r.marking.tokenCount(free0)).toBe(1);
    expect(r.marking.tokenCount(free1)).toBe(1);
    expect(r.marking.tokenCount(budget)).toBe(1);
  });

  it('one data and one empty arrival: X_start with hasdata = 1, X_skip never fires (all() >= 1 is the exclusion)', async () => {
    const initial = base();
    initial.set(e0data, [tokenOf('a1')]);
    initial.set(e1empty, units());
    const r = await runNet(net, initial, program);

    expect(started(r.store, (n) => n === 'X_start' || n === 'X_skip')).toEqual(['X_start']);
    expect(slots).toEqual([{ a: 'a1', b: null, hasdata: 1 }]);
  });

  it('mixed slots in sequence: exactly one of X_start / X_skip per slot', async () => {
    // Slot 1 pairs the data arrivals, slot 2 pairs the empties (each input's second
    // arrival is empty and waits on free_i behind the data arrival, which was consumed
    // first because arm_i_data is declared before arm_i_empty: EXEC-002 declaration order).
    const initial = base();
    initial.set(e0data, [tokenOf('a1')]);
    initial.set(e0empty, units());
    initial.set(e1data, [tokenOf('b1')]);
    initial.set(e1empty, units());
    const r = await runNet(net, initial, program);

    const decisions = started(r.store, (n) => n === 'X_start' || n === 'X_skip');
    expect(decisions).toEqual(['X_start', 'X_skip']);
    expect(slots).toEqual([{ a: 'a1', b: 'b1', hasdata: 2 }]);
    expect(r.marking.tokenCount(out)).toBe(1);
    expect(r.marking.tokenCount(outEmpty)).toBe(1);
    expect(r.marking.tokenCount(hasdata)).toBe(0);
  });
});
