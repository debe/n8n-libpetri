/**
 * Regression guard for the sparse-enablement fix libpetri 5.0.0 shipped. Before it,
 * `PrecompiledNet.canEnableSparse` evaluated `(snapshot[w] & m) !== m` where `m` comes from
 * a `Uint32Array` (unsigned) and the AND result is a signed int32, so a mask with bit 31 set
 * never matched: a transition consuming a place whose id is 31 mod 32 was never enabled on
 * the production executor while the Bitmap reference fired it, and any compiled workflow
 * with 32 or more places was affected — the diamond fixture among them.
 *
 * 5.0.0 coerces the AND to unsigned (`>>> 0`) on the sparse path, as `containsAll` already
 * did. This file keeps the two executors pinned to each other at that boundary so a
 * regression in either is caught here rather than in a fixture.
 */
import {
  BitmapNetExecutor, PetriNet, PrecompiledNet, PrecompiledNetExecutor, Transition, containsAll, one, outPlace, place,
  setBit, tokenOf,
} from 'libpetri';

describe('libpetri PrecompiledNet.canEnableSparse at bit 31 (fixed in 5.0.0)', () => {
  // A sink with 31 inputs takes place ids 0..30, so `p31` is place 31 and `out` is 32.
  const fillers = Array.from({ length: 31 }, (_, i) => place<null>(`f${i}`));
  const p31 = place<null>('p31');
  const out = place<null>('out');
  const sink = Transition.builder('sink').inputs(...fillers.map((p) => one(p))).build();
  const t = Transition.builder('needs_p31')
    .inputs(one(p31))
    .outputs(outPlace(out))
    .action(async (ctx) => { ctx.output(out, null); })
    .build();
  const net = PetriNet.builder('bit31').transitions(sink, t).build();
  const program = PrecompiledNet.compile(net);

  it('place ids are as assumed', () => {
    expect(program.compiled.placeId(p31)).toBe(31);
    expect(program.compiled.placeId(out)).toBe(32);
  });

  it('containsAll (fixed) and canEnableSparse agree that the transition is enabled', () => {
    const tid = program.compiled.transitionId(t);
    const snapshot = new Uint32Array(program.wordCount);
    setBit(snapshot, 31);
    expect(containsAll(snapshot, program.needsMask[tid]!)).toBe(true);
    expect(program.canEnableSparse(tid, snapshot)).toBe(true);
  });

  it('the Bitmap reference executor fires it', async () => {
    const m = await new BitmapNetExecutor(net, new Map([[p31, [tokenOf(null)]]])).run();
    expect(m.tokenCount(out)).toBe(1);
  });

  it('the production executor fires it too', async () => {
    const m = await new PrecompiledNetExecutor(net, new Map([[p31, [tokenOf(null)]]]), { program }).run();
    expect(m.tokenCount(p31)).toBe(0);
    expect(m.tokenCount(out)).toBe(1);
  });
});
