/**
 * Spike 1 — the per-edge output spec of `X_run`.
 *
 * Pins: `and(xor(data, empty), xor(data, empty), …)` is a valid `Out` (IO-011, IO-012)
 * that compiles for the production executor; the action selects each `xor` branch by
 * which place it writes to (IO-015 walks the set of places that received tokens); writing
 * both places of one `xor` — or neither — is an IO-015 violation surfaced as a
 * `transition-failed` event (EVT-008) whose consumed tokens are lost (EXEC-030,
 * EXEC-031) while the run still quiesces (EXEC-040).
 *
* Also pins the corrected IO-015 exact-explanation semantics (libpetri main, ec10f79): an inner `xor`
 * with no written child makes `validateOutSpec` THROW rather than report its enclosing
 * branch unsatisfied, so `xor(and(xor(d, e), …), and(retry, …))` cannot take the
 * `retry` branch — unless a place that is unwritten on that branch happens to be
 * declared *before* the inner `xor` inside the `and`, because `and` short-circuits on
 * its first unsatisfied child. That escape is an evaluation-order artifact IO-015 does
 * not promise (it defines `And` as a predicate over all children), so the gadget does
 * not rely on it: `X_run` routes success through `X/ok` and `X_route` carries the
 * per-edge `xor`s (see `support.ts`). Both facts are pinned below.
 */
import {
  PetriNet, PrecompiledNet, Transition, place, one, and, xor, outPlace, tokenOf, enumerateBranches,
} from 'libpetri';
import { failed, runNet, started } from './support.js';

type Mode = 'split' | 'both-data' | 'both-empty' | 'violate-both' | 'violate-neither';

describe('spike: and-of-xor per-edge output spec', () => {
  const input = place<Mode>('if/in');
  const trueData = place<string>('e/if.0->a/data');
  const trueEmpty = place<null>('e/if.0->a/empty');
  const falseData = place<string>('e/if.1->b/data');
  const falseEmpty = place<null>('e/if.1->b/empty');

  const spec = and(
    xor(outPlace(trueData), outPlace(trueEmpty)),
    xor(outPlace(falseData), outPlace(falseEmpty)),
  );

  const ifRun = Transition.builder('if_run')
    .inputs(one(input))
    .outputs(spec)
    .action(async (ctx) => {
      switch (ctx.input(input)) {
        case 'split':
          ctx.output(trueData, 'yes');
          ctx.output(falseEmpty, null);
          break;
        case 'both-data':
          ctx.output(trueData, 'yes');
          ctx.output(falseData, 'no');
          break;
        case 'both-empty':
          ctx.output(trueEmpty, null);
          ctx.output(falseEmpty, null);
          break;
        case 'violate-both':
          // Both places of the first xor: two disjoint satisfied branches, no subsumption.
          ctx.output(trueData, 'yes');
          ctx.output(trueEmpty, null);
          ctx.output(falseEmpty, null);
          break;
        case 'violate-neither':
          // First xor unsatisfied.
          ctx.output(falseEmpty, null);
          break;
      }
    })
    .build();

  const net = PetriNet.builder('out-spec').transition(ifRun).build();
  const program = PrecompiledNet.compile(net);

  const run = (mode: Mode) => runNet(net, new Map([[input, [tokenOf(mode)]]]), program);

  it('is a valid spec: compiles, and enumerates one branch per data/empty combination', () => {
    expect(program.transitionCount).toBe(1);
    expect(enumerateBranches(spec)).toHaveLength(4);
  });

  it('the action selects each xor branch by which place it writes (IO-015)', async () => {
    const split = await run('split');
    expect(split.marking.tokenCount(trueData)).toBe(1);
    expect(split.marking.tokenCount(trueEmpty)).toBe(0);
    expect(split.marking.tokenCount(falseData)).toBe(0);
    expect(split.marking.tokenCount(falseEmpty)).toBe(1);
    expect(failed(split.store)).toHaveLength(0);

    const bothData = await run('both-data');
    expect(bothData.marking.tokenCount(trueData)).toBe(1);
    expect(bothData.marking.tokenCount(falseData)).toBe(1);
    expect(bothData.marking.tokenCount(trueEmpty) + bothData.marking.tokenCount(falseEmpty)).toBe(0);

    const bothEmpty = await run('both-empty');
    expect(bothEmpty.marking.tokenCount(trueEmpty)).toBe(1);
    expect(bothEmpty.marking.tokenCount(falseEmpty)).toBe(1);
    expect(bothEmpty.marking.tokenCount(trueData) + bothEmpty.marking.tokenCount(falseData)).toBe(0);
  });

  it('writing both places of one xor is an IO-015 violation: transition-failed, tokens lost, run quiesces', async () => {
    const r = await run('violate-both');
    const failures = failed(r.store);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.transitionName).toBe('if_run');
    expect(failures[0]!.exceptionType).toBe('OutViolationError');
    expect(failures[0]!.errorMessage).toContain("output does not match the declared spec");
    // EXEC-030 / EXEC-031: nothing deposited, input not restored.
    for (const p of [input, trueData, trueEmpty, falseData, falseEmpty]) {
      expect(r.marking.tokenCount(p)).toBe(0);
    }
    // EXEC-040: the executor still terminated normally.
    expect(r.store.events().some((e) => e.type === 'execution-completed')).toBe(true);
    expect(started(r.store)).toEqual(['if_run']);
  });

  it('writing neither place of one xor is the same violation', async () => {
    const r = await run('violate-neither');
    const failures = failed(r.store);
    expect(failures.map((f) => f.exceptionType)).toEqual(['OutViolationError']);
    expect(failures[0]!.errorMessage).toContain("output does not match the declared spec");
    expect(r.marking.tokenCount(falseEmpty)).toBe(0);
  });
});

describe('spike: a xor nested under a xor branch may be left unwritten (IO-015 exact explanation)', () => {
  // The README's X_run shape: xor( and(per-edge xor…, budget), and(retry, budget) ).
  const input = place<'ok' | 'retry'>('x/in');
  const data = place<string>('e/data');
  const empty = place<null>('e/empty');
  const budget = place<null>('_budget');
  const retry = place<null>('x/retry');
  const readmeShape = xor(
    and(xor(outPlace(data), outPlace(empty)), outPlace(budget)),
    and(outPlace(retry), outPlace(budget)),
  );
  const t = Transition.builder('x_run')
    .inputs(one(input))
    .outputs(readmeShape)
    .action(async (ctx) => {
      if (ctx.input(input) === 'ok') ctx.output(data, 'd');
      else ctx.output(retry, null);
      ctx.output(budget, null);
    })
    .build();
  const net = PetriNet.builder('nested-xor').transition(t).build();

  it('the success branch (inner xor written) validates', async () => {
    const r = await runNet(net, new Map([[input, [tokenOf('ok' as const)]]]));
    expect(failed(r.store)).toHaveLength(0);
    expect(r.marking.tokenCount(data)).toBe(1);
    expect(r.marking.tokenCount(budget)).toBe(1);
  });

  it('the retry branch validates: the enclosing xor selects it and the unwritten inner xor is not required', async () => {
    const r = await runNet(net, new Map([[input, [tokenOf('retry' as const)]]]));
    const failures = failed(r.store);
    expect(failures).toHaveLength(0);
    // The branch is selected, so what the action wrote lands in the marking.
    expect(r.marking.tokenCount(retry)).toBe(1);
    expect(r.marking.tokenCount(budget)).toBe(1);
  });
});

describe('spike: validation is independent of child order inside the enclosing and (IO-015)', () => {
  // The same README shape, but `X/done` — written only on the success branch — is declared
  // BEFORE the inner xor inside the success `and`. `validateOutSpec` walks `and` children
  // in order and returns "unsatisfied" at the first unwritten one, so on the retry branch it
  // never reaches the inner xor, and the outer xor selects `retry`. Not relied on: IO-015
  // defines `And` as "satisfied iff all children are satisfied", with no order.
  const input = place<'ok' | 'retry'>('y/in');
  const data = place<string>('f/data');
  const empty = place<null>('f/empty');
  const budget = place<null>('_budget');
  const done = place<null>('y/done');
  const retry = place<null>('y/retry');
  const doneFirst = xor(
    and(outPlace(done), xor(outPlace(data), outPlace(empty)), outPlace(budget)),
    and(outPlace(retry), outPlace(budget)),
  );
  const xorFirst = xor(
    and(xor(outPlace(data), outPlace(empty)), outPlace(done), outPlace(budget)),
    and(outPlace(retry), outPlace(budget)),
  );
  const build = (name: string, spec: ReturnType<typeof xor>) => Transition.builder(name)
    .inputs(one(input))
    .outputs(spec)
    .action(async (ctx) => {
      if (ctx.input(input) === 'ok') { ctx.output(data, 'd'); ctx.output(done, null); }
      else ctx.output(retry, null);
      ctx.output(budget, null);
    })
    .build();

  it('done declared first: the retry branch validates (and short-circuits before the inner xor)', async () => {
    const net = PetriNet.builder('done-first').transition(build('y_run', doneFirst)).build();
    const r = await runNet(net, new Map([[input, [tokenOf('retry' as const)]]]));
    expect(failed(r.store)).toHaveLength(0);
    expect(r.marking.tokenCount(retry)).toBe(1);
    expect(r.marking.tokenCount(budget)).toBe(1);
    expect(r.marking.tokenCount(done)).toBe(0);
  });

  it('done declared first: the success branch still validates', async () => {
    const net = PetriNet.builder('done-first-ok').transition(build('y_run', doneFirst)).build();
    const r = await runNet(net, new Map([[input, [tokenOf('ok' as const)]]]));
    expect(failed(r.store)).toHaveLength(0);
    expect(r.marking.tokenCount(data)).toBe(1);
    expect(r.marking.tokenCount(done)).toBe(1);
    expect(r.marking.tokenCount(budget)).toBe(1);
  });

  it('inner xor declared first: the identical write set validates, as it does with done first', async () => {
    const net = PetriNet.builder('xor-first').transition(build('y_run', xorFirst)).build();
    const r = await runNet(net, new Map([[input, [tokenOf('retry' as const)]]]));
    const failures = failed(r.store);
    expect(failures).toHaveLength(0);
    expect(r.marking.tokenCount(retry)).toBe(1);
    expect(r.marking.tokenCount(budget)).toBe(1);
  });
});
