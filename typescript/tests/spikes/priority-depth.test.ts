/**
 * Spike 5 — priority = DAG depth yields n8n's v1 depth-first completion at k = 1.
 *
 * Fan-out A, B from the trigger, with A2 downstream of A (depth 2). Under a budget of
 * one, `B_start` loses the first pass to `A_start` (declaration order, EXEC-002 AC3)
 * and is disabled; disabling resets its enablement timestamp
 * (`updateDirtyTransitions`), so when `A_route` deposits A's edge and refunds the budget
 * in one completion, `B_start` and `A2_start` re-enable in the same cycle with the same
 * timestamp. Only priority separates them: `priority = depth` fires A2 first (EXEC-002
 * AC1); equal priorities fall back to declaration order (EXEC-002 AC3 on the general
 * path, and the all-immediate fast path fires in declaration order outright).
 */
import { PetriNet, tokenOf } from 'libpetri';
import { marking, nodeGadget, runNet, shared, sleep, started, units } from './support.js';

describe('spike: priority = depth gives depth-first at k = 1', () => {
  async function order(priorities: { A: number; B: number; A2: number } | null): Promise<string[]> {
    const sh = shared();
    const act = async () => { await sleep(5); return { kind: 'ok' as const, value: 'v' }; };
    const p = (depth: number) => priorities === null
      ? {}
      : { startPriority: depth, runPriority: depth + 1 };
    // Declaration order is canvas order: A, B, then A2.
    const a = nodeGadget({ name: 'A', act, ...p(priorities?.A ?? 0) }, sh);
    const b = nodeGadget({ name: 'B', act, ...p(priorities?.B ?? 0) }, sh);
    const a2 = nodeGadget({ name: 'A2', act, input: a.output, ...p(priorities?.A2 ?? 0) }, sh);
    const net = PetriNet.builder('depth')
      .transitions(...a.transitions, ...b.transitions, ...a2.transitions)
      .build();
    const r = await runNet(net, marking(a.initial, b.initial, a2.initial, [
      [a.input, [tokenOf('in')]], [b.input, [tokenOf('in')]], [sh.budget, units(1)],
    ]));
    expect(r.marking.tokenCount(a2.done)).toBe(1);
    expect(r.marking.tokenCount(b.done)).toBe(1);
    return started(r.store, (n) => n.endsWith('_run')).map((n) => n.replace(/_run$/, ''));
  }

  it('priority = depth: A, A2, B (depth-first)', async () => {
    expect(await order({ A: 1, B: 1, A2: 2 })).toEqual(['A', 'A2', 'B']);
  });

  it('all priorities 0 (fast path): A, B, A2 — declaration order', async () => {
    expect(await order(null)).toEqual(['A', 'B', 'A2']);
  });

  it('equal non-zero priorities (sorted path, equal timestamps): still A, B, A2', async () => {
    expect(await order({ A: 1, B: 1, A2: 1 })).toEqual(['A', 'B', 'A2']);
  });
});
