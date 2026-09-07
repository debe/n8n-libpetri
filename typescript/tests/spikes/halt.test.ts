/**
 * Spike 7 — halt: `_halt` inhibits every start, and a reap can clear the net.
 *
 * A fatal node error is an `xor` branch of `X_run` that deposits `_halt` (never a throw).
 * Every `X_start` carries `inhibitor(_halt)` and `inhibitor(_halted)` (CORE-031), so
 * nothing new starts; `_halt_reap: one(_halt) reset(edge and ready places) →
 * outPlace(_halted)` clears the remaining tokens in one firing (CORE-034, EXEC-013).
 * An action already in flight when the halt lands still completes (EXEC-040 waits for
 * it) and its output IS deposited — after the reap, so it stays in the final marking.
 * That token is the reported consequence of "in-flight actions finish".
 *
 * **This is not the shipped shape.** What the spike pins is libpetri's semantics — that
 * reset arcs apply at firing time, and that an in-flight action's output lands after the
 * firing that reaped the places it would have used. The compiler has **no reap**: `_halt`
 * is written once and never consumed, so it is the halted run's terminal marker and every
 * start / retry-wait / exhausted / skip / arm / clear transition inhibits on it. The reap
 * was deleted in M6 precisely because of the race this spike's last assertion measures —
 * once `X_run` routed its own outcome, a sibling resolving in the same executor cycle
 * deposited its arrivals later than the halt snapshot and earlier than the reap, and the
 * activation was lost outright (README "Retries, halt, cancellation"; ADR 0004, "The reap
 * is gone"; `tests/scheduler/control.test.ts`).
 */
import { PetriNet, Transition, one, outPlace, tokenOf } from 'libpetri';
import {
  isCompletionOf, isStartOf, marking, nodeGadget, nthIndex, runNet, shared, sleep, started, units,
} from './support.js';

describe('spike: halt and reap', () => {
  it('_halt inhibits starts, the reap clears pending inputs and deposits _halted; the in-flight output lands after the reap', async () => {
    const sh = shared();
    const a = nodeGadget({ name: 'A', act: async () => ({ kind: 'halt' }) }, sh);
    const c = nodeGadget({
      name: 'C',
      act: async () => { await sleep(100); return { kind: 'ok', value: 'c-result' }; },
    }, sh);
    const b = nodeGadget({ name: 'B', act: async () => ({ kind: 'ok', value: 'b' }) }, sh);
    const d = nodeGadget({ name: 'D', input: c.output, act: async () => ({ kind: 'ok', value: 'd' }) }, sh);

    const reap = Transition.builder('_halt_reap')
      .inputs(one(sh.halt))
      .resets(a.input, b.input, c.input, d.input, a.output, b.output, c.output, d.output)
      .outputs(outPlace(sh.halted))
      .action(async (ctx) => { ctx.output(sh.halted, null); })
      .build();

    // Declaration order A, C, B, D: at k = 2, A and C take the budget and B waits.
    const net = PetriNet.builder('halt')
      .transitions(...a.transitions, ...c.transitions, ...b.transitions, ...d.transitions, reap)
      .build();

    const r = await runNet(net, marking(a.initial, b.initial, c.initial, d.initial, [
      [a.input, [tokenOf('a')]], [b.input, [tokenOf('b')]], [c.input, [tokenOf('c')]], [sh.budget, units(2)],
    ]));

    // A halted while C was in flight; B (pending) and D (C's successor) never started.
    expect(started(r.store, (n) => n.endsWith('_start'))).toEqual(['A_start', 'C_start']);
    expect(started(r.store, (n) => n === '_halt_reap')).toHaveLength(1);

    // The reap fired before C's action completed; C's output was routed afterwards.
    const reapAt = nthIndex(r.store, isStartOf('_halt_reap'), 1);
    const cDoneAt = nthIndex(r.store, isCompletionOf('C_run'), 1);
    const cRoutedAt = nthIndex(r.store, isStartOf('C_route'), 1);
    expect(reapAt).toBeGreaterThan(-1);
    expect(cDoneAt).toBeGreaterThan(reapAt);
    expect(cRoutedAt).toBeGreaterThan(cDoneAt);

    // Final marking: halted, quiescent, B's input reaped, C's output stranded (reported).
    expect(r.marking.tokenCount(sh.halted)).toBe(1);
    expect(r.marking.tokenCount(sh.halt)).toBe(0);
    expect(r.marking.tokenCount(b.input)).toBe(0);
    expect(r.marking.tokenCount(c.output)).toBe(1);
    expect(r.marking.tokenCount(c.done)).toBe(1);
    expect(r.marking.tokenCount(d.running)).toBe(0);
    expect(r.marking.tokenCount(sh.budget)).toBe(2);
    expect(r.marking.tokenCount(a.running) + r.marking.tokenCount(c.running)).toBe(0);
  });

  it('_halted keeps inhibiting after the reap consumed _halt (a late arrival cannot restart the net)', async () => {
    const sh = shared();
    const a = nodeGadget({ name: 'A', act: async () => ({ kind: 'halt' }) }, sh);
    const reap = Transition.builder('_halt_reap')
      .inputs(one(sh.halt))
      .resets(a.input)
      .outputs(outPlace(sh.halted))
      .action(async (ctx) => { ctx.output(sh.halted, null); })
      .build();
    const net = PetriNet.builder('halted').transitions(...a.transitions, reap).build();

    // Two tokens on A/in: the first halts; the reap clears the second before it starts.
    const r = await runNet(net, marking(a.initial, [
      [a.input, [tokenOf('first'), tokenOf('second')]], [sh.budget, units(1)],
    ]));
    expect(started(r.store)).toEqual(['A_start', 'A_run', '_halt_reap']);
    expect(r.marking.tokenCount(a.input)).toBe(0);
    expect(r.marking.tokenCount(sh.halted)).toBe(1);
  });
});
