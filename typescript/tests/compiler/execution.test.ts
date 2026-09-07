/**
 * End to end: trivial actions that route everything as data run the linear and diamond
 * fixtures to quiescence (EXEC-040) with `X/done` for every node and the budget back at k.
 * The required runs use `PrecompiledNetExecutor` (the production executor, program reused
 * from the `CompiledWorkflow`); the same runs on `BitmapNetExecutor` (the reference the
 * production executor must match) pin the compiled semantics independently.
 *
 * The diamond on the production executor depends on the libpetri fix for the bit-31 sign
 * defect in `PrecompiledNet.canEnableSparse` (see `libpetri-bit31.test.ts`).
 */
import { compile, forwardAllActions, placeholderActions, type CompiledWorkflow } from '../../src/compiler/index.js';
import { ALL, diamond, fanOut, linear } from '../fixtures/workflows.js';
import { failed, runCompiled, started, tokenCounts, type Executor } from './support.js';

const ITEMS = { items: [{ json: { n: 1 } }] };

function doneCounts(c: CompiledWorkflow, m: Awaited<ReturnType<typeof runCompiled>>['marking']): Record<string, number> {
  return Object.fromEntries(c.netMap.nodes.map((g) => [g.node, m.tokenCount(g.done)]));
}

/** Places that must be empty at quiescence: edges, ins, ready, hasdata, ran, running, ok, routed, retry. */
function transientPlaces(c: CompiledWorkflow) {
  return c.netMap.places
    .filter((p) => ['in-data', 'in-empty', 'edge-data', 'edge-empty', 'ready', 'hasdata', 'ran', 'running', 'ok', 'routed', 'retry', 'nil'].includes(p.role))
    .map((p) => p.place);
}

describe.each<Executor>(['precompiled', 'bitmap'])('forward-all actions on %s', (executor) => {
  it('linear: every node done once, in order, budget back at k = 1', async () => {
    const c = compile(linear).withActions(forwardAllActions());
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(doneCounts(c, marking)).toEqual({ Trigger: 1, A: 1, B: 1, C: 1 });
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
    expect(started(store, (n) => n.endsWith('/run'))).toEqual(['id:Trigger/run', 'id:A/run', 'id:B/run', 'id:C/run']);
    expect(tokenCounts(marking, transientPlaces(c)).every((n) => n === 0)).toBe(true);
    for (const g of c.netMap.nodes) expect(marking.tokenCount(g.idle)).toBe(1);
  });

  it('linear at k = 2: budget back at 2', async () => {
    const c = compile(linear, { budget: 2 }).withActions(forwardAllActions());
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(doneCounts(c, marking)).toEqual({ Trigger: 1, A: 1, B: 1, C: 1 });
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(2);
  });

  it('diamond: the join fires once with both inputs, every node done, budget back', async () => {
    const c = compile(diamond).withActions(forwardAllActions());
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(doneCounts(c, marking)).toEqual({ Trigger: 1, IF: 1, A: 1, B: 1, Merge: 1, End: 1 });
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
    expect(started(store, (n) => n.startsWith('id:Merge/'))).toEqual([
      // No `route`: Merge has one connected output, so `X_run` routes it (ADR 0004).
      'id:Merge/arm_e0_data', 'id:Merge/arm_e5_data', 'id:Merge/start', 'id:Merge/run', 'id:Merge/done',
    ]);
    const merge = c.netMap.node('Merge');
    expect(tokenCounts(marking, merge.inputs.map((i) => i.free!))).toEqual([1, 1]);
    expect(tokenCounts(marking, transientPlaces(c)).every((n) => n === 0)).toBe(true);
    expect(marking.tokenCount(merge.skipped!)).toBe(0);
  });

  it('fan-out at k = 1 runs the siblings in canvas order (declaration-order tiebreak, EXEC-002 AC3)', async () => {
    const c = compile(fanOut).withActions(forwardAllActions());
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), executor);
    expect(failed(store)).toEqual([]);
    expect(started(store, (n) => n.endsWith('/run'))).toEqual(['id:Trigger/run', 'id:A/run', 'id:B/run', 'id:C/run']);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(1);
  });
});

describe('placeholder actions (no-data routing) quiesce cleanly on every fixture (reference executor)', () => {
  it.each(Object.keys(ALL) as (keyof typeof ALL)[])('%s', async (name) => {
    const c = compile(ALL[name]);
    const { marking, store } = await runCompiled(c, c.initialMarking(ITEMS), 'bitmap');
    expect(failed(store)).toEqual([]);
    expect(marking.tokenCount(c.netMap.shared.budget)).toBe(c.effectiveBudget);
    expect(tokenCounts(marking, transientPlaces(c)).every((n) => n === 0)).toBe(true);
    // The start node ran; no node is activated (run or skipped) more than once under no-data
    // routing — an OR input aggregates its all-empty round into one skip — and on an acyclic
    // fixture every reachable, non-dead node is activated exactly once. Inside a cycle a
    // skipped entry node emits nothing on its cycle edges (README emission rule), so cycle
    // mates and the exits they own stay untouched; emission.test.ts pins that shape.
    const start = c.netMap.node(c.startNode);
    expect(marking.tokenCount(start.done)).toBe(1);
    for (const g of c.netMap.nodes) {
      const done = marking.tokenCount(g.done);
      const skipped = g.skipped === null ? 0 : marking.tokenCount(g.skipped);
      const dead = g.inputs.some((i) => !i.wired);
      expect(done + skipped, g.node).toBeLessThanOrEqual(1);
      if (!c.analysis.hasCycle) expect(done + skipped, g.node).toBe(g.reachable && !dead ? 1 : 0);
      expect(marking.tokenCount(g.idle), g.node).toBe(1);
    }
  });

  it('a skipped Loop Over Items emits empty on its exit edge so After is skipped too (Body never runs)', async () => {
    const c = compile(ALL.loopOverItems);
    const { marking } = await runCompiled(c, c.initialMarking(ITEMS), 'bitmap');
    expect(marking.tokenCount(c.netMap.node('Loop').skipped!)).toBe(1);
    expect(marking.tokenCount(c.netMap.node('After').skipped!)).toBe(1);
    expect(marking.tokenCount(c.netMap.node('Body').done)).toBe(0);
  });
});

describe('action binding', () => {
  it('compile() binds placeholders; a binder returning null keeps them; withActions re-binds without touching the original', () => {
    const seen: string[] = [];
    const c = compile(linear, { actions: (info) => { seen.push(info.role); return null; } });
    // `linear` has no node above SPLIT_ROUTING_ABOVE, so no `route` transition exists.
    expect(new Set(seen)).toEqual(new Set(['start', 'run', 'done', 'skip']));
    const program = c.program;
    const rebound = c.withActions(forwardAllActions());
    expect(rebound.net).not.toBe(c.net);
    expect(rebound.program).not.toBe(program);
    expect(c.program).toBe(program);
    expect(rebound.netMap.nodes).toBe(c.netMap.nodes);
    expect(rebound.structuralHash).toBe(c.structuralHash);
    expect(rebound.netMap.transitionObject('id:A/run')).toBe([...rebound.net.transitions].find((t) => t.name === 'id:A/run'));
  });

  it('the binder sees every transition with its role and owner, and sinks stay passthrough', () => {
    const roles = new Map<string, string[]>();
    compile(ALL.loopOverItems, {
      actions: (info) => {
        roles.set(info.role, [...(roles.get(info.role) ?? []), info.name]);
        return null;
      },
    });
    expect(roles.get('sink')).toEqual(['id:Loop/sink_0', 'id:Loop/sink_1', 'id:Body/sink_0']);
    expect(roles.get('arm')).toHaveLength(3);
    const c = compile(ALL.loopOverItems, { actions: placeholderActions() });
    expect(c.program.transitionCount).toBe(c.net.transitions.size);
  });
});
