/**
 * Spike 9 — the collapsed `X_run` outcome, and why `SPLIT_ROUTING_ABOVE` is 3.
 *
 * ADR 0004 originally routed the success outcome through `X/ok` because libpetri 4.1.0's
 * `validateOutSpec` threw on an inner `xor` with no written child *before* the enclosing
 * `xor` could select a sibling branch, so the natural single spec could never take its
 * retry or halt branch. libpetri 5.0.0 made [IO-015] an exact-explanation search (`And`
 * unordered, an inner `Xor` no longer pre-empting an enclosing one), pinned in
 * `out-spec.test.ts`. This spike is the evidence that the gadget's *real* spec — the
 * routing of every connected output nested inside the outcome `xor` — validates on **every**
 * branch, which is what let `X/ok` and `X_route` be deleted:
 *
 * ```
 * X_run: one(X/running)
 *     -> and( xor( and( per output o: xor(and(data edges_o), and(empty edges_o) | X/nil_o),
 *                       X/routed ),
 *                  [X/retry], [and(_halt, _budget)],
 *                  and(X/waiting, _pause, _budget), and(X/stopped, _pause, _budget) ),
 *             X/idle )
 * X_done: one(X/routed) -> and(_budget, X/done)
 * ```
 *
 * It also measures the one thing that *stops* the collapse from being universal: IO-016
 * flattening. `enumerateBranches` expands an `and` of `k` `xor`s into `2^k` virtual
 * transitions, so the outcome costs `2^k + 4` flat branches routed inside `X_run` against
 * `2k + 5` split across `X_run` and its `X_route_o`s (neither figure counts `X_done`, which
 * both shapes have). Collapsed wins at one and two outputs, loses by exactly one branch at
 * three — where it is still the better trade, because it also removes five places and three
 * transitions and 21 % of the state classes (`tests/compiler/routing.test.ts`) — and loses
 * outright from four. That is `SPLIT_ROUTING_ABOVE = 3`.
 */
import {
  PetriNet, PrecompiledNet, Transition, and, enumerateBranches, one, outPlace, place, tokenOf, xor,
  type Out, type Place,
} from 'libpetri';
import { failed, runNet } from './support.js';

type Variant = 'data' | 'empty' | 'nil';
type Branch =
  | { readonly kind: 'ok'; readonly per: readonly Variant[] }
  | { readonly kind: 'retry' } | { readonly kind: 'halt' }
  | { readonly kind: 'waiting' } | { readonly kind: 'stopped' };

interface Shape {
  /** Connected outputs. */
  readonly outputs: number;
  /** Consumer edges per output. */
  readonly edges: readonly number[];
  /** Producer inside a cycle: the no-data alternative is `X/nil_o`, not the empty edges. */
  readonly cyclic: boolean;
  readonly retry: boolean;
  /** `onError: stopWorkflow`, i.e. `X_run` carries a halt branch. */
  readonly halt: boolean;
  /** `'run'`: routing inside `X_run`. `'route'`: `X/ok_o` + `X_route_o` per output. */
  readonly form: 'run' | 'route';
}

const andOf = (c: readonly Out[]): Out => (c.length === 1 ? c[0]! : and(...c));
const xorOf = (c: readonly Out[]): Out => (c.length === 1 ? c[0]! : xor(...c));

function build(s: Shape) {
  const running = place<Branch>('x/running');
  const idle = place<null>('x/idle');
  const budget = place<null>('_budget');
  const halt = place<null>('_halt');
  const pause = place<null>('_pause');
  const waiting = place<null>('x/waiting');
  const stopped = place<null>('x/stopped');
  const retry = place<null>('x/retry');
  const done = place<null>('x/done');
  const routed = place<null>('x/routed');
  const data: Place<unknown>[][] = [];
  const empty: Place<unknown>[][] = [];
  const nils: (Place<unknown> | null)[] = [];
  const oks: Place<unknown>[] = [];
  const routeds: Place<unknown>[] = [];
  for (let o = 0; o < s.outputs; o++) {
    const n = s.edges[o]!;
    data.push(Array.from({ length: n }, (_, e) => place<unknown>(`e${o}_${e}/data`)));
    empty.push(s.cyclic ? [] : Array.from({ length: n }, (_, e) => place<unknown>(`e${o}_${e}/empty`)));
    nils.push(s.cyclic ? place<unknown>(`x/nil_${o}`) : null);
    oks.push(place<unknown>(`x/ok_${o}`));
    routeds.push(place<unknown>(`x/routed_${o}`));
  }
  const routingOf = (o: number): Out => xor(
    andOf(data[o]!.map(outPlace)),
    nils[o] !== null ? outPlace(nils[o]!) : andOf(empty[o]!.map(outPlace)),
  );
  const emit = (ctx: { output: (p: Place<unknown>, v: unknown) => void }, o: number, v: Variant): void => {
    if (v === 'data') for (const p of data[o]!) ctx.output(p, 'd');
    else if (v === 'empty') for (const p of empty[o]!) ctx.output(p, null);
    else ctx.output(nils[o]!, null);
  };

  const success: Out = s.form === 'route'
    ? andOf(oks.map(outPlace))
    : andOf([...Array.from({ length: s.outputs }, (_, o) => routingOf(o)), outPlace(routed)]);
  const outcome = xorOf([
    success,
    ...(s.retry ? [outPlace(retry)] : []),
    ...(s.halt ? [and(outPlace(halt), outPlace(budget))] : []),
    and(outPlace(waiting), outPlace(pause), outPlace(budget)),
    and(outPlace(stopped), outPlace(pause), outPlace(budget)),
  ]);
  const runSpec = and(outcome, outPlace(idle));

  const run = Transition.builder('x_run')
    .inputs(one(running))
    .outputs(runSpec)
    .action(async (ctx) => {
      const b = ctx.input(running);
      switch (b.kind) {
        case 'ok':
          if (s.form === 'route') for (let o = 0; o < s.outputs; o++) ctx.output(oks[o]!, b.per[o]!);
          else {
            for (let o = 0; o < s.outputs; o++) emit(ctx, o, b.per[o]!);
            ctx.output(routed, null);
          }
          break;
        case 'retry': ctx.output(retry, null); break;
        case 'halt': ctx.output(halt, null); ctx.output(budget, null); break;
        case 'waiting': ctx.output(waiting, null); ctx.output(pause, null); ctx.output(budget, null); break;
        case 'stopped': ctx.output(stopped, null); ctx.output(pause, null); ctx.output(budget, null); break;
      }
      ctx.output(idle, null);
    })
    .build();

  const transitions: Transition[] = [run];
  if (s.form === 'route') {
    for (let o = 0; o < s.outputs; o++) {
      transitions.push(Transition.builder(`x_route_${o}`)
        .inputs(one(oks[o]!))
        .outputs(and(routingOf(o), outPlace(routeds[o]!)))
        .action(async (ctx) => {
          emit(ctx, o, ctx.input(oks[o]!) as Variant);
          ctx.output(routeds[o]!, null);
        })
        .build());
    }
  }
  transitions.push(Transition.builder('x_done')
    .inputs(...(s.form === 'route' ? routeds.map((p) => one(p)) : [one(routed)]))
    .outputs(and(outPlace(budget), outPlace(done)))
    .action(async (ctx) => { ctx.output(budget, null); ctx.output(done, null); })
    .build());

  const net = PetriNet.builder(`outcome-${s.form}-${s.outputs}`).transitions(...transitions).build();
  return { net, running, runSpec, data, empty, nils, routed, done, budget, halt, pause, waiting, stopped, retry };
}

async function fire(s: Shape, b: Branch) {
  const g = build(s);
  const r = await runNet(g.net, new Map([[g.running, [tokenOf(b)]]]), PrecompiledNet.compile(g.net));
  return { ...r, g };
}

/** Every per-output assignment, `data` first. */
function combos(n: number, variants: readonly Variant[]): Variant[][] {
  let acc: Variant[][] = [[]];
  for (let i = 0; i < n; i++) {
    const next: Variant[][] = [];
    for (const c of acc) for (const v of variants) next.push([...c, v]);
    acc = next;
  }
  return acc;
}

const SHAPES: Shape[] = [];
for (const form of ['run', 'route'] as const) {
  for (const outputs of [0, 1, 2, 3]) {
    for (const cyclic of [false, true]) {
      for (const retry of [false, true]) {
        for (const halt of [false, true]) {
          if (form === 'route' && outputs === 0) continue; // a node with no output never splits
          SHAPES.push({ outputs, edges: [1, 2, 1].slice(0, outputs), cyclic, retry, halt, form });
        }
      }
    }
  }
}

describe('spike: the collapsed outcome validates on every branch (IO-015 exact explanation)', () => {
  it.each(SHAPES.map((s) => [
    `${s.form} outputs=${s.outputs}${s.cyclic ? ' cyclic' : ''}${s.retry ? ' retry' : ''}${s.halt ? ' halt' : ''}`,
    s,
  ] as const))('%s: every branch fires with no transition-failed and the right marking', async (_label, s) => {
    const variants: Variant[] = s.cyclic ? ['data', 'nil'] : ['data', 'empty'];
    const branches: Branch[] = [
      ...combos(s.outputs, variants).map((per): Branch => ({ kind: 'ok', per })),
      ...(s.retry ? [{ kind: 'retry' } as const] : []),
      ...(s.halt ? [{ kind: 'halt' } as const] : []),
      { kind: 'waiting' }, { kind: 'stopped' },
    ];
    for (const b of branches) {
      const { marking, store, g } = await fire(s, b);
      expect(failed(store).map((f) => `${b.kind}: ${f.errorMessage}`), `${_label} / ${b.kind}`).toEqual([]);
      if (b.kind === 'ok') {
        // The success branch ran to `X_done`: the budget is back and `X/done` is marked.
        expect(marking.tokenCount(g.done)).toBe(1);
        expect(marking.tokenCount(g.budget)).toBe(1);
        for (let o = 0; o < s.outputs; o++) {
          const want = b.per[o]!;
          for (const p of g.data[o]!) expect(marking.tokenCount(p), p.name).toBe(want === 'data' ? 1 : 0);
          for (const p of g.empty[o]!) expect(marking.tokenCount(p), p.name).toBe(want === 'empty' ? 1 : 0);
          if (g.nils[o] !== null) expect(marking.tokenCount(g.nils[o]!)).toBe(want === 'nil' ? 1 : 0);
        }
      } else if (b.kind === 'retry') {
        // The retry branch holds the budget and routes nothing — the branch the old
        // validator could not reach at all through a nested `xor`.
        expect(marking.tokenCount(g.retry)).toBe(1);
        expect(marking.tokenCount(g.budget)).toBe(0);
        expect(marking.tokenCount(g.done)).toBe(0);
      } else {
        expect(marking.tokenCount(g.budget)).toBe(1);
        expect(marking.tokenCount(g.done)).toBe(0);
      }
    }
  });
});

describe('spike: IO-016 flattening is what fixes SPLIT_ROUTING_ABOVE at 3', () => {
  const flat = (form: 'run' | 'route', outputs: number): number => {
    const s: Shape = { outputs, edges: Array.from({ length: outputs }, () => 1), cyclic: false, retry: true, halt: true, form };
    const run = enumerateBranches(build(s).runSpec).length;
    // The split shape's cost is `X_run` plus one two-branch `X_route_o` per output.
    return form === 'run' ? run : run + 2 * outputs;
  };

  it('collapsed is 2^k + 4, split is 2k + 5: collapsed wins at 1-2, loses by one at 3, runs away from 4', () => {
    const table = [1, 2, 3, 4, 5, 6, 8, 10].map((k) => [k, flat('run', k), flat('route', k)]);
    expect(table).toEqual([
      [1, 6, 7], [2, 8, 9], [3, 12, 11], [4, 20, 13], [5, 36, 15], [6, 68, 17], [8, 260, 21], [10, 1028, 25],
    ]);
    for (const k of [1, 2]) expect(flat('run', k), `k=${k}`).toBeLessThan(flat('route', k));
    // At three the split is cheaper by exactly one branch — small enough that the places and
    // transitions the collapse saves win the whole-net comparison (`routing.test.ts`).
    expect(flat('run', 3) - flat('route', 3)).toBe(1);
    // From four it is not a trade any more.
    for (const k of [4, 6, 10]) expect(flat('run', k) - flat('route', k), `k=${k}`).toBeGreaterThan(5);
  });

  it('at twenty outputs the collapsed spec cannot even be enumerated: the flattener overflows the stack', () => {
    const s: Shape = {
      outputs: 20, edges: Array.from({ length: 20 }, () => 1), cyclic: false, retry: true, halt: true, form: 'run',
    };
    expect(() => enumerateBranches(build(s).runSpec)).toThrow(RangeError);
    expect(flat('route', 20)).toBe(45);
  });
});
