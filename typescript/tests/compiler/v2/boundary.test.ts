/**
 * The typing boundary between the two profiles (`tasks/v2-profile-plan.md` step 7, decision 14).
 *
 * An `engineV2` net has settlement gadgets, `_halt` and nothing else of a v1 net: no
 * `NodeGadget`, no `_budget`, no `_pause`, no `ready` / `in-data` place. Two layers keep the one
 * from being read as the other, and each has its own test here:
 * - the `NetMap` and `CompiledWorkflow` accessors serve one profile each and throw
 *   `InternalCompilerError` on the other's net, rather than answer "no gadgets", which a v1
 *   reader takes for an empty workflow;
 * - every v1 consumer — `PetriScheduler`, the marking codec, the deposit rule, the verifier and
 *   the action binders — refuses the other profile at entry with `ProfileMismatchError`, naming
 *   itself, before it reads anything.
 */
import { Marking } from 'libpetri';
import { flatten } from 'libpetri/verification';
import { decodeExecutionData, encodeMarking } from '../../../src/codec.js';
import {
  analyse, assertProfile, compile, forwardAllActions, InternalCompilerError, placeholderActions, ProfileMismatchError,
  routingActions, settlementActions, settlementPlaceholderActions, structuralHash,
} from '../../../src/compiler/index.js';
import type { CompileProfile, CompiledWorkflow } from '../../../src/compiler/index.js';
import { CompiledWorkflowCache, PetriScheduler, schedulerActions } from '../../../src/scheduler/index.js';
import { deposits } from '../../../src/scheduler/deposits.js';
import { budgetSemiflowOf } from '../../../src/verify/invariants.js';
import {
  alternativeEntryReach, decodeMarking, loopTransitions, markingStateOf, renderMarkedPlace, StateSpace, verify, verifyCompiled,
} from '../../../src/verify/index.js';
import { graphToDescription } from '../../../src/conformance/v2/graph.js';
import { unit } from '../../../src/internal/tokens.js';
import { loop } from '../../fixtures/v2-graphs.js';
import { diamond, linear, loopOverItems, twoTriggers } from '../../fixtures/workflows.js';
import { execute, fakeNodeHelpers, fakeWorkflow, newRunExecutionData, ranNodes } from '../../scheduler/support.js';

const v1Of = (): CompiledWorkflow => compile(diamond);
const v2Of = (): CompiledWorkflow => compile(diamond, { profile: 'engineV2' });

/** The pending state of a fresh execution of `linear`: one stack entry for its trigger. */
function freshState() {
  const workflow = fakeWorkflow(linear);
  const run = newRunExecutionData(workflow.nodes['Trigger']!);
  return run.executionData!;
}

/** `fn` throws the named refusal of `consumer`, with both profiles on it. */
function expectRefused(fn: () => unknown, consumer: string, expected: CompileProfile, actual: CompileProfile): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ProfileMismatchError);
  expect(caught).toMatchObject({ name: 'ProfileMismatchError', consumer, expected, actual });
  expect((caught as Error).message).toBe(
    `${consumer}: needs a net compiled for the '${expected}' profile, got one compiled for '${actual}'`);
}

describe('NetMap: the gadget accessors serve one profile each', () => {
  const v1 = v1Of();
  const v2 = v2Of();

  it.each([
    ['shared', (c: CompiledWorkflow) => c.netMap.shared],
    ['nodes', (c: CompiledWorkflow) => c.netMap.nodes],
    ['node', (c: CompiledWorkflow) => c.netMap.node('A')],
    ['hasNode', (c: CompiledWorkflow) => c.netMap.hasNode('A')],
    ['tryNode', (c: CompiledWorkflow) => c.netMap.tryNode('A')],
  ] as const)('v1 accessor %s throws InternalCompilerError on an engineV2 net, and answers on a v1 one', (name, read) => {
    expect(() => read(v2)).toThrow(InternalCompilerError);
    expect(() => read(v2)).toThrow(`NetMap.${name}:`);
    expect(() => read(v1)).not.toThrow();
  });

  it.each([
    ['settlements', (c: CompiledWorkflow) => c.netMap.settlements],
    ['settlement', (c: CompiledWorkflow) => c.netMap.settlement('A')],
  ] as const)('engineV2 accessor %s throws InternalCompilerError on a v1 net, and answers on an engineV2 one', (name, read) => {
    expect(() => read(v1)).toThrow(InternalCompilerError);
    expect(() => read(v1)).toThrow(`NetMap.${name}:`);
    expect(() => read(v2)).not.toThrow();
  });

  it('serves the transition and place lookups, the profile and _halt on both', () => {
    for (const [c, profile] of [[v1, 'v1'], [v2, 'engineV2']] as const) {
      const m = c.netMap;
      expect(m.profile).toBe(profile);
      expect(c.analysis.profile).toBe(profile);
      expect(m.halt.name).toBe('_halt');
      expect(m.transitionsOf('A').length).toBeGreaterThan(0);
      const start = m.transitionFor('A', 'start');
      expect(start).toBeDefined();
      expect(m.transition(start!.name)).toBe(start);
      expect(m.transitionObject(start!.name).name).toBe(start!.name);
      const running = m.placeFor('A', 'running');
      expect(running).toBeDefined();
      expect(m.place(running!.name)).toBe(running);
      expect(m.placesOf('A')).toContain(running);
    }
  });

  it('keeps the profile across rebinding (withActions)', () => {
    const rebound = v2.withActions(settlementPlaceholderActions());
    expect(rebound.netMap.profile).toBe('engineV2');
    expect(() => rebound.netMap.nodes).toThrow(InternalCompilerError);
    expect(rebound.netMap.settlements.map((g) => g.node)).toEqual(v2.netMap.settlements.map((g) => g.node));
    const v1Rebound = v1.withActions(placeholderActions());
    expect(() => v1Rebound.netMap.settlements).toThrow(InternalCompilerError);
  });
});

describe('CompiledWorkflow: the v1 place collections', () => {
  it.each(['joinInputPlaces', 'joinReadyPlaces', 'edgeDataPlaces', 'runningPlaces'] as const)(
    '%s throws InternalCompilerError on an engineV2 net, and answers on a v1 one',
    (collection) => {
      expect(() => v2Of()[collection]).toThrow(InternalCompilerError);
      expect(() => v2Of()[collection]).toThrow(`CompiledWorkflow.${collection}:`);
      expect(v1Of()[collection].length).toBeGreaterThan(0);
    },
  );
});

describe('action binders refuse the other profile', () => {
  it.each([
    ['structuralActions', placeholderActions],
    ['structuralActions', forwardAllActions],
    ['structuralActions', () => routingActions(() => 'data')],
    ['schedulerActions', schedulerActions],
  ] as const)('%s (a v1 binder) refuses an engineV2 net', (consumer, binder) => {
    expectRefused(() => compile(diamond, { profile: 'engineV2', actions: binder() }), consumer, 'v1', 'engineV2');
    expectRefused(() => v2Of().withActions(binder()), consumer, 'v1', 'engineV2');
  });

  it('settlementActions (the engineV2 binder) refuses a v1 net', () => {
    expectRefused(() => compile(diamond, { actions: settlementPlaceholderActions() }), 'settlementActions', 'engineV2', 'v1');
    expectRefused(() => v1Of().withActions(settlementActions({ filled: () => true })), 'settlementActions', 'engineV2', 'v1');
  });
});

describe('the v1 consumers refuse an engineV2 compiled workflow at entry', () => {
  it('encodeMarking', () => {
    const v2 = v2Of();
    expectRefused(() => encodeMarking(v2, Marking.from(v2.initialMarking(null)), freshState()), 'encodeMarking', 'v1', 'engineV2');
  });

  it('decodeExecutionData', () => {
    expectRefused(() => decodeExecutionData(compile(linear, { profile: 'engineV2' }), freshState()), 'decodeExecutionData', 'v1', 'engineV2');
    // The same state decodes on the v1 net of the same workflow.
    expect(() => decodeExecutionData(compile(linear), freshState())).not.toThrow();
  });

  it('deposits', () => {
    const g = v1Of().netMap.node('A');
    expectRefused(() => deposits(g, v2Of().netMap, { kind: 'halt' }), 'deposits', 'v1', 'engineV2');
    expect(deposits(g, v1Of().netMap, { kind: 'halt' }).map((d) => d.place.name)).toEqual(['_halt', '_budget']);
  });

  it('budgetSemiflowOf (the budget family)', () => {
    const v2 = v2Of();
    expectRefused(() => budgetSemiflowOf([], flatten(v2.net), v2.netMap, 1), 'budgetSemiflowOf', 'v1', 'engineV2');
    const v1 = v1Of();
    expect(budgetSemiflowOf([], flatten(v1.net), v1.netMap, 1)).toBeNull();
  });

  // Step 12: an engineV2 net now goes to its own report (`verify/settlement.ts`) and never
  // reaches a v1 family; asking for the v1 profile explicitly is still refused at entry.
  it('verifyCompiled: an engineV2 net gets its own report, never the v1 families', async () => {
    await expect(verifyCompiled(v2Of(), { profile: 'v1' })).rejects.toThrow(ProfileMismatchError);
    await expect(verifyCompiled(v2Of(), { profile: 'v1' })).rejects.toMatchObject({ consumer: 'verifyCompiled', expected: 'v1', actual: 'engineV2' });
    await expect(verifyCompiled(v1Of(), { profile: 'engineV2' })).rejects.toMatchObject({ consumer: 'verifyCompiled', expected: 'engineV2', actual: 'v1' });
    const report = await verifyCompiled(v2Of());
    expect(report.profile).toBe('engineV2');
    expect(new Set(report.checks.map((c) => c.property))).toEqual(new Set(['settlement']));
  });

  // The public verify exports that read a v1 net's roles, besides `verifyCompiled`: each answered
  // on an engineV2 net before, e.g. `strandedPlaces()` listed its `arrived` / `live` places.
  it('StateSpace.explore, before it builds anything', () => {
    const v2 = v2Of();
    expectRefused(() => StateSpace.explore(v2.net, markingStateOf(v2.initialMarking(null)), v2.netMap, 100),
      'StateSpace.explore', 'v1', 'engineV2');
    const v1 = v1Of();
    expect(StateSpace.explore(v1.net, markingStateOf(v1.initialMarking(null)), v1.netMap, 100_000).complete).toBe(true);
  });

  it('loopTransitions, on a batch loop too', () => {
    const v2 = compile(graphToDescription(loop).description, { profile: 'engineV2' });
    expectRefused(() => loopTransitions(v2), 'loopTransitions', 'v1', 'engineV2');
    expect(loopTransitions(compile(loopOverItems)).size).toBeGreaterThan(0);
  });

  it('alternativeEntryReach', () => {
    expectRefused(() => alternativeEntryReach(compile(linear, { profile: 'engineV2' })), 'alternativeEntryReach', 'v1', 'engineV2');
    expect([...alternativeEntryReach(compile(twoTriggers))]).toEqual([['TrigB', 'TrigB']]);
  });

  it('the counterexample decoders stay profile-neutral, and render an arrived place by its input slot', () => {
    const v2 = v2Of();
    const [, fromB] = v2.netMap.settlement('Merge').incoming;
    const [marked] = decodeMarking(markingStateOf(new Map([[fromB!.arrived, [unit()]]])), v2.netMap);
    expect(renderMarkedPlace(marked!)).toBe(`Merge input 1 arrived (${fromB!.arrived.name})`);
  });

  it('verify(workflow) compiles v1, whatever the workflow', async () => {
    const report = await verify(linear, { properties: ['no-double-activation'] });
    expect(report.checks.length).toBeGreaterThan(0);
  });

  describe('PetriScheduler', () => {
    /** A caller's cache holding an engineV2 net under the key the scheduler computes for `linear`. */
    function poisonedCache(): CompiledWorkflowCache {
      const cache = new CompiledWorkflowCache();
      cache.set(CompiledWorkflowCache.key(structuralHash(analyse(linear)), 1), compile(linear, { profile: 'engineV2' }));
      return cache;
    }

    it('compileDescription refuses an engineV2 net out of its cache', () => {
      const scheduler = new PetriScheduler({
        nodeHelpers: fakeNodeHelpers,
        legacy: () => { throw new Error('the legacy scheduler is not part of this test'); },
        cache: poisonedCache(),
      });
      expectRefused(() => scheduler.compileDescription(linear), 'PetriScheduler', 'v1', 'engineV2');
    });

    it('run() rejects before it decodes, pops or runs anything', async () => {
      const e = await execute(linear, {}, { scheduler: { cache: poisonedCache() } });
      expect(e.error).toBeInstanceOf(ProfileMismatchError);
      expect(e.error).toMatchObject({ consumer: 'PetriScheduler', expected: 'v1', actual: 'engineV2' });
      expect(ranNodes(e.calls)).toEqual([]);
      expect(e.runExecutionData.executionData!.nodeExecutionStack.map((x) => x.node.name)).toEqual(['Trigger']);
    });

    it('its own compiles stay v1', () => {
      const scheduler = new PetriScheduler({
        nodeHelpers: fakeNodeHelpers,
        legacy: () => { throw new Error('the legacy scheduler is not part of this test'); },
      });
      expect(scheduler.compileDescription(linear).netMap.profile).toBe('v1');
    });
  });
});

describe('assertProfile', () => {
  it('passes a matching profile and names the consumer on a mismatch', () => {
    expect(() => assertProfile('x', 'v1', 'v1')).not.toThrow();
    expect(() => assertProfile('x', 'engineV2', 'engineV2')).not.toThrow();
    expectRefused(() => assertProfile('x', 'engineV2', 'v1'), 'x', 'engineV2', 'v1');
  });
});
