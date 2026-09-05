/**
 * Spike 9 — the emission rule on a cycle (README "Emission rule").
 *
 * Loop-Over-Items shape: `L` has a `done` output (tree edge to `C`; `L` is in a cycle,
 * so it carries `data | nil`) and a `loop` output (cycle edge to `B`: `data | nil`);
 * `B` feeds back to `L` (cycle edge). `nil` is a per-output local place consumed by a
 * genuine sink transition (no output spec, CORE-043 AC4). The entry edge into `L` is a
 * tree edge from a producer outside the cycle (`data | empty`), so `L_skip` exists and
 * emits `empty` on the tree edge and nothing on the cycle edge.
 *
 * Pins: the cycle terminates (EXEC-040) with no empty storm; `nil` never accumulates
 * (each one is drained by its sink before the next is produced); skipping the whole
 * loop lets `empty` flow past it on the exit edge. The control case shows the storm the
 * rule prevents: `empty` on the cycle edges plus forwarding skips never quiesces.
 */
import {
  PetriNet, PrecompiledNet, PrecompiledNetExecutor, InMemoryEventStore, Transition,
  and, one, outPlace, place, tokenOf, xor,
} from 'libpetri';
import { maxSimultaneous, runNet, sleep, started, units } from './support.js';

interface Items { readonly remaining: number }

describe('spike: emission rule on a cycle', () => {
  const lIn = place<Items>('e/T->L/data');          // tree edge, producer outside the cycle
  const lInEmpty = place<null>('e/T->L/empty');
  const loopData = place<Items>('e/L.loop->B/data');  // cycle edge
  const loopNil = place<null>('L/loop/nil');
  const backData = place<Items>('e/B->L/data');       // cycle edge
  const backNil = place<null>('B/nil');
  const doneData = place<Items>('e/L.done->C/data');  // tree edge, producer in a cycle
  const doneNil = place<null>('L/done/nil');
  const doneEmpty = place<null>('e/L.done->C/empty');
  const lRunning = place<Items>('L/running');
  const bRunning = place<Items>('B/running');
  const lSkipped = place<null>('L/skipped');
  const cOut = place<Items>('C/out');
  const cOutEmpty = place<null>('C/out_empty');

  // Input-side OR on L (two producers, entry and back edge) as two start transitions.
  const lStartEntry = Transition.builder('L_start_entry').inputs(one(lIn))
    .outputs(outPlace(lRunning)).action(async (ctx) => { ctx.output(lRunning, ctx.input(lIn)); }).build();
  const lStartBack = Transition.builder('L_start_back').inputs(one(backData))
    .outputs(outPlace(lRunning)).action(async (ctx) => { ctx.output(lRunning, ctx.input(backData)); }).build();
  const lRun = Transition.builder('L_run').inputs(one(lRunning))
    .outputs(and(xor(outPlace(doneData), outPlace(doneNil)), xor(outPlace(loopData), outPlace(loopNil))))
    .action(async (ctx) => {
      const { remaining } = ctx.input(lRunning);
      if (remaining > 0) { ctx.output(loopData, { remaining: remaining - 1 }); ctx.output(doneNil, null); }
      else { ctx.output(doneData, { remaining }); ctx.output(loopNil, null); }
    }).build();
  // Skipped: empty on the tree edge, nothing on the cycle edge.
  const lSkip = Transition.builder('L_skip').inputs(one(lInEmpty))
    .outputs(and(outPlace(doneEmpty), outPlace(lSkipped)))
    .action(async (ctx) => { ctx.output(doneEmpty, null); ctx.output(lSkipped, null); }).build();
  const bStart = Transition.builder('B_start').inputs(one(loopData))
    .outputs(outPlace(bRunning)).action(async (ctx) => { ctx.output(bRunning, ctx.input(loopData)); }).build();
  const bRun = Transition.builder('B_run').inputs(one(bRunning))
    .outputs(xor(outPlace(backData), outPlace(backNil)))
    .action(async (ctx) => { ctx.output(backData, ctx.input(bRunning)); }).build();
  const cTake = Transition.builder('C_take').inputs(one(doneData))
    .outputs(outPlace(cOut)).action(async (ctx) => { ctx.output(cOut, ctx.input(doneData)); }).build();
  const cTakeEmpty = Transition.builder('C_take_empty').inputs(one(doneEmpty))
    .outputs(outPlace(cOutEmpty)).action(async (ctx) => { ctx.output(cOutEmpty, null); }).build();
  // Genuine sinks: no output spec (CORE-043 AC4).
  const sinkLoopNil = Transition.builder('sink_L_loop_nil').inputs(one(loopNil)).build();
  const sinkDoneNil = Transition.builder('sink_L_done_nil').inputs(one(doneNil)).build();
  const sinkBackNil = Transition.builder('sink_B_nil').inputs(one(backNil)).build();

  const net = PetriNet.builder('cycle').transitions(
    lStartEntry, lStartBack, lRun, lSkip, bStart, bRun, cTake, cTakeEmpty, sinkLoopNil, sinkDoneNil, sinkBackNil,
  ).build();
  const program = PrecompiledNet.compile(net);

  it('a three-iteration loop terminates; nil never accumulates', async () => {
    const r = await runNet(net, new Map([[lIn, [tokenOf({ remaining: 3 })]]]), program);

    expect(started(r.store, (n) => n === 'L_run')).toHaveLength(4);
    expect(started(r.store, (n) => n === 'B_run')).toHaveLength(3);
    expect(started(r.store, (n) => n === 'sink_L_done_nil')).toHaveLength(3);
    expect(started(r.store, (n) => n === 'sink_L_loop_nil')).toHaveLength(1);
    expect(started(r.store, (n) => n === 'sink_B_nil')).toHaveLength(0);
    expect(started(r.store, (n) => n === 'L_skip')).toHaveLength(0);

    for (const nil of [loopNil, doneNil, backNil]) {
      expect(r.marking.tokenCount(nil)).toBe(0);
      expect(maxSimultaneous(r.store, nil.name)).toBeLessThanOrEqual(1);
    }
    expect(r.marking.tokenCount(cOut)).toBe(1);
    expect(r.marking.tokenCount(loopData) + r.marking.tokenCount(backData) + r.marking.tokenCount(doneData)).toBe(0);
  });

  it('skipping the whole loop: empty flows past it on the exit edge, the cycle stays silent', async () => {
    const r = await runNet(net, new Map([[lInEmpty, units()]]), program);
    expect(started(r.store)).toEqual(['L_skip', 'C_take_empty']);
    expect(r.marking.tokenCount(cOutEmpty)).toBe(1);
    expect(r.marking.tokenCount(lSkipped)).toBe(1);
  });

  it('control: empty on a cycle edge with forwarding skips is an empty storm (never quiesces)', async () => {
    // Two-node cycle where each node's skip forwards `empty` around the cycle.
    const aInEmpty = place<null>('storm/A/in_empty');
    const bInEmpty = place<null>('storm/B/in_empty');
    const aSkip = Transition.builder('A_skip').inputs(one(aInEmpty)).outputs(outPlace(bInEmpty))
      .action(async (ctx) => { await sleep(1); ctx.output(bInEmpty, null); }).build();
    const bSkip = Transition.builder('B_skip').inputs(one(bInEmpty)).outputs(outPlace(aInEmpty))
      .action(async (ctx) => { await sleep(1); ctx.output(aInEmpty, null); }).build();
    const storm = PetriNet.builder('storm').transitions(aSkip, bSkip).build();

    const store = new InMemoryEventStore();
    const executor = new PrecompiledNetExecutor(storm, new Map([[aInEmpty, units()]]), { eventStore: store });
    const run = executor.run();
    await sleep(60);
    executor.close(); // ENV-013: the only way this run ends
    const m = await run;

    const skips = started(store).length;
    expect(skips).toBeGreaterThan(8);
    // The empty token is still circulating when we stop it.
    expect(m.tokenCount(aInEmpty) + m.tokenCount(bInEmpty)).toBe(1);
  });
});
