/**
 * Toolchain smoke test, and the first pinned fact of the model: a per-edge
 * `and(xor(data, empty), …)` output spec is valid under IO-011/IO-012, the action selects
 * each `xor` branch by which place it writes to (IO-015), and `PrecompiledNetExecutor`
 * runs it to quiescence (EXEC-040) with the program reused across executions.
 */
import {
  PetriNet, Transition, PrecompiledNet, PrecompiledNetExecutor,
  place, one, and, xor, outPlace, tokenOf,
} from 'libpetri';

interface Items { readonly items: readonly number[] }

describe('n8n-libpetri scaffold', () => {
  const input = place<Items>('if/in');
  const trueData = place<Items>('e/if.0->a/data');
  const trueEmpty = place<null>('e/if.0->a/empty');
  const falseData = place<Items>('e/if.1->b/data');
  const falseEmpty = place<null>('e/if.1->b/empty');

  // IF routes items: each output independently carries data or is explicitly empty.
  const ifRun = Transition.builder('if_run')
    .inputs(one(input))
    .outputs(and(
      xor(outPlace(trueData), outPlace(trueEmpty)),
      xor(outPlace(falseData), outPlace(falseEmpty)),
    ))
    .action(async (ctx) => {
      const { items } = ctx.input(input);
      const yes = items.filter((n) => n % 2 === 0);
      const no = items.filter((n) => n % 2 !== 0);
      if (yes.length > 0) ctx.output(trueData, { items: yes }); else ctx.output(trueEmpty, null);
      if (no.length > 0) ctx.output(falseData, { items: no }); else ctx.output(falseEmpty, null);
    })
    .build();

  const net = PetriNet.builder('smoke').transition(ifRun).build();
  const program = PrecompiledNet.compile(net);

  async function run(items: number[]) {
    const executor = new PrecompiledNetExecutor(
      net, new Map([[input, [tokenOf({ items })]]]), { program },
    );
    return executor.run();
  }

  it('routes mixed items to both outputs (both branches non-empty)', async () => {
    const m = await run([1, 2, 3, 4]);
    expect(m.tokenCount(trueData)).toBe(1);
    expect(m.tokenCount(falseData)).toBe(1);
    expect(m.tokenCount(trueEmpty)).toBe(0);
    expect(m.tokenCount(falseEmpty)).toBe(0);
  });

  it('emits an explicit empty token on the starved output', async () => {
    const m = await run([2, 4]);
    expect(m.tokenCount(trueData)).toBe(1);
    expect(m.tokenCount(falseEmpty)).toBe(1);
    expect(m.tokenCount(falseData)).toBe(0);
  });
});
