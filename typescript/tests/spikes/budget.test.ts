/**
 * Spikes 3 and 4 — the concurrency budget and the two-phase start/run with `X/idle`.
 *
 * Pins: `_budget` with k unit tokens gates concurrency because the firing pass re-checks
 * enablement after every firing (EXEC-003 AC3) — two 200 ms actions take ~400 ms at
 * k = 1 and ~200 ms at k = 2; the budget comes back on every outcome (success via
 * `X_route`, exhausted retry via `X_exhausted` → `X_route`, halt via the halt branch),
 * written by an action since `forwardInput` is timeout-only (IO-014) and a rejected
 * action loses its tokens (EXEC-030); and the explicit `X/idle` mutex is what keeps two
 * tokens on `X/in` from producing two `X/running` at once.
 *
 * Observed, and worth knowing: without `X/idle` the executor still serialises the two
 * activations, because a transition is at most once in flight (`inFlightFlags[tid]` in
 * `PrecompiledNetExecutor`). That is an implementation detail no requirement guarantees
 * and the verifier cannot see it — `placeBound(X/running, 1)` is provable only with the
 * idle place (`verification.test.ts`). The idle place makes the executor's behaviour a
 * structural fact.
 */
import { PetriNet, PrecompiledNet, tokenOf } from 'libpetri';
import {
  isCompletionOf, isStartOf, marking, maxSimultaneous, nodeGadget, nthIndex, runNet, shared, sleep, started, units,
  type Branch, type Shared,
} from './support.js';

describe('spike: budget gating', () => {
  function twoNodes(sh: Shared, actionMs: number, inFlight: { now: number; max: number }) {
    const act = async (): Promise<Branch> => {
      inFlight.now++;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      await sleep(actionMs);
      inFlight.now--;
      return { kind: 'ok', value: 'x' };
    };
    const a = nodeGadget({ name: 'A', act }, sh);
    const b = nodeGadget({ name: 'B', act }, sh);
    const net = PetriNet.builder('budget').transitions(...a.transitions, ...b.transitions).build();
    return { a, b, net, program: PrecompiledNet.compile(net) };
  }

  async function timed(k: number) {
    const sh = shared();
    const inFlight = { now: 0, max: 0 };
    const { a, b, net, program } = twoNodes(sh, 200, inFlight);
    const r = await runNet(net, marking(a.initial, b.initial, [
      [a.input, [tokenOf('in')]], [b.input, [tokenOf('in')]], [sh.budget, units(k)],
    ]), program);
    expect(r.marking.tokenCount(sh.budget)).toBe(k);
    expect(r.marking.tokenCount(a.done)).toBe(1);
    expect(r.marking.tokenCount(b.done)).toBe(1);
    return { elapsedMs: r.elapsedMs, maxInFlight: inFlight.max };
  }

  it('k = 1: two 200 ms actions run one after the other (~400 ms)', { timeout: 10_000 }, async () => {
    const { elapsedMs, maxInFlight } = await timed(1);
    expect(maxInFlight).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(380);
    expect(elapsedMs).toBeLessThan(800);
  });

  it('k = 2: the same two actions overlap (~200 ms)', { timeout: 10_000 }, async () => {
    const { elapsedMs, maxInFlight } = await timed(2);
    expect(maxInFlight).toBe(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(180);
    expect(elapsedMs).toBeLessThan(380);
  });

  it.each<[Branch['kind'], string[]]>([
    ['ok', ['A_start', 'A_run', 'A_route']],
    ['retry', ['A_start', 'A_run', 'A_exhausted', 'A_route']],
    ['halt', ['A_start', 'A_run']],
  ])('the budget and idle come back on the %s outcome', async (kind, expected) => {
    const sh = shared();
    const branch: Branch = kind === 'ok' ? { kind, value: 'v' } : { kind };
    // maxTries = 1: a retry outcome exhausts immediately and continues with an empty output.
    const a = nodeGadget({ name: 'A', retry: { maxTries: 1, waitMs: 1 }, act: async () => branch }, sh);
    const net = PetriNet.builder(`refund-${kind}`).transitions(...a.transitions).build();
    const r = await runNet(net, marking(a.initial, [[a.input, [tokenOf('in')]], [sh.budget, units(1)]]));

    expect(started(r.store)).toEqual(expected);
    expect(r.marking.tokenCount(sh.budget)).toBe(1);
    expect(r.marking.tokenCount(a.idle)).toBe(1);
    expect(r.marking.tokenCount(a.running)).toBe(0);
    expect(r.marking.tokenCount(a.ok)).toBe(0);
    expect(r.marking.tokenCount(a.retry)).toBe(0);
    expect(r.marking.tokenCount(a.output)).toBe(kind === 'ok' ? 1 : 0);
    expect(r.marking.tokenCount(a.outputEmpty)).toBe(kind === 'retry' ? 1 : 0);
    expect(r.marking.tokenCount(sh.halt)).toBe(kind === 'halt' ? 1 : 0);
    expect(r.marking.tokenCount(a.done)).toBe(kind === 'halt' ? 0 : 1);
  });
});

describe('spike: two-phase start/run with X/idle', () => {
  async function twoTokensOnIn(withIdle: boolean) {
    const sh = shared();
    const inFlight = { now: 0, max: 0 };
    const a = nodeGadget({
      name: 'A', withIdle,
      act: async () => {
        inFlight.now++;
        inFlight.max = Math.max(inFlight.max, inFlight.now);
        await sleep(30);
        inFlight.now--;
        return { kind: 'ok', value: 'v' };
      },
    }, sh);
    const net = PetriNet.builder(withIdle ? 'idle' : 'no-idle').transitions(...a.transitions).build();
    const r = await runNet(net, marking(a.initial, [
      [a.input, [tokenOf('t1'), tokenOf('t2')]], [sh.budget, units(2)],
    ]));
    expect(r.marking.tokenCount(a.output)).toBe(2);
    expect(r.marking.tokenCount(sh.budget)).toBe(2);
    return {
      inFlight,
      runningAtOnce: maxSimultaneous(r.store, a.running.name),
      // Did the second activation start before the first one had finished running?
      secondStartBeforeFirstRunDone:
        nthIndex(r.store, isStartOf('A_start'), 2) < nthIndex(r.store, isCompletionOf('A_run'), 1),
    };
  }

  it('two tokens on X/in never produce two X/running at once (k = 2 would allow it)', async () => {
    const { inFlight, runningAtOnce, secondStartBeforeFirstRunDone } = await twoTokensOnIn(true);
    expect(runningAtOnce).toBe(1);
    expect(inFlight.max).toBe(1);
    // The idle token is only refunded by X_run, so the second X_start waits for it.
    expect(secondStartBeforeFirstRunDone).toBe(false);
  });

  it('observed: without the idle place the executor still serialises via its per-transition in-flight flag', async () => {
    // With no idle place the second X_start fires while the first X_run is still in
    // flight; the second activation then waits only because a transition is at most
    // once in flight (and X_run drains X/running in the same pass X_start refills it,
    // so the place never shows two tokens either). Executor mechanics, not structure.
    const { inFlight, runningAtOnce, secondStartBeforeFirstRunDone } = await twoTokensOnIn(false);
    expect(secondStartBeforeFirstRunDone).toBe(true);
    expect(runningAtOnce).toBe(1);
    expect(inFlight.max).toBe(1);
  });
});
