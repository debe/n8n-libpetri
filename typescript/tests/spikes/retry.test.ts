/**
 * Spike 8 — the retry gadget (README "Retries, halt, cancellation").
 *
 * ```
 * X/tries seeded with maxTries − 1
 * X_retry_wait: one(X/retry) one(X/tries) one(X/idle) inhibitor(_halt) inhibitor(_halted)
 *               timing delayed(waitBetweenTries) → outPlace(X/running)
 * X_exhausted:  one(X/retry) inhibitor(X/tries) → xor( X/ok, and(_halt, _budget) )
 * ```
 *
 * Pins: with `maxTries = 3` (`tries` seeded 2) and an action that fails every time,
 * exactly 3 attempts are observed, then `X_exhausted` fires once; the net, not the
 * host, decides retry-vs-exhaust (`one(tries)` vs `inhibitor(tries)`, CORE-031); and
 * `delayed(50)` is honoured (TIME-004): >= 100 ms between the first and third attempt.
 * The budget is held across the wait and comes back through `X_route`.
 */
import { PetriNet, tokenOf } from 'libpetri';
import { marking, nodeGadget, runNet, shared, started, units } from './support.js';

describe('spike: retry gadget', () => {
  it('fails every time: 3 attempts, then X_exhausted; delayed(50) respected', { timeout: 10_000 }, async () => {
    const sh = shared();
    const attemptAt: number[] = [];
    const x = nodeGadget({
      name: 'X',
      retry: { maxTries: 3, waitMs: 50 },
      act: async () => { attemptAt.push(performance.now()); return { kind: 'retry' }; },
    }, sh);
    const net = PetriNet.builder('retry').transitions(...x.transitions).build();
    const r = await runNet(net, marking(x.initial, [[x.input, [tokenOf('in')]], [sh.budget, units(1)]]));

    expect(started(r.store)).toEqual([
      'X_start', 'X_run', 'X_retry_wait', 'X_run', 'X_retry_wait', 'X_run', 'X_exhausted', 'X_route',
    ]);
    expect(attemptAt).toHaveLength(3);
    expect(attemptAt[2]! - attemptAt[0]!).toBeGreaterThanOrEqual(100);

    expect(r.marking.tokenCount(x.tries!)).toBe(0);
    expect(r.marking.tokenCount(x.retry)).toBe(0);
    expect(r.marking.tokenCount(x.running)).toBe(0);
    expect(r.marking.tokenCount(x.ok)).toBe(0);
    expect(r.marking.tokenCount(sh.budget)).toBe(1);
    expect(r.marking.tokenCount(x.idle)).toBe(1);
    expect(r.marking.tokenCount(x.outputEmpty)).toBe(1);
    expect(r.marking.tokenCount(x.done)).toBe(1);
  });

  it('succeeds on the second attempt: one retry, no exhaustion, a try left over', async () => {
    const sh = shared();
    let attempts = 0;
    const x = nodeGadget({
      name: 'X',
      retry: { maxTries: 3, waitMs: 10 },
      act: async () => (++attempts === 2 ? { kind: 'ok', value: 'v' } : { kind: 'retry' }),
    }, sh);
    const net = PetriNet.builder('retry-ok').transitions(...x.transitions).build();
    const r = await runNet(net, marking(x.initial, [[x.input, [tokenOf('in')]], [sh.budget, units(1)]]));

    expect(started(r.store)).toEqual(['X_start', 'X_run', 'X_retry_wait', 'X_run', 'X_route']);
    expect(r.marking.tokenCount(x.tries!)).toBe(1);
    expect(r.marking.tokenCount(x.output)).toBe(1);
    expect(r.marking.tokenCount(x.done)).toBe(1);
    expect(r.marking.tokenCount(sh.budget)).toBe(1);
  });

  it('exhausted with onExhausted: halt deposits _halt and refunds the budget', async () => {
    const sh = shared();
    const x = nodeGadget({
      name: 'X',
      retry: { maxTries: 2, waitMs: 5, onExhausted: 'halt' },
      act: async () => ({ kind: 'retry' }),
    }, sh);
    const net = PetriNet.builder('retry-halt').transitions(...x.transitions).build();
    const r = await runNet(net, marking(x.initial, [[x.input, [tokenOf('in')]], [sh.budget, units(1)]]));

    expect(started(r.store)).toEqual(['X_start', 'X_run', 'X_retry_wait', 'X_run', 'X_exhausted']);
    expect(r.marking.tokenCount(sh.halt)).toBe(1);
    expect(r.marking.tokenCount(sh.budget)).toBe(1);
    expect(r.marking.tokenCount(x.done)).toBe(0);
  });
});
