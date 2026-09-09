/**
 * Counterexample decoding: flat transition names and marking states back into node terms.
 *
 * The decoder is exercised against a real solver result in `properties.test.ts` (mutual
 * exclusion at k = 2). This file pins the mapping itself — including the `_b<k>` branch
 * suffix the flattener appends when it expands an XOR (IO-016), which is the part that
 * would silently produce `null` nodes if it were dropped.
 */
import { compile } from '../../src/compiler/index.js';
import { diamond } from '../fixtures/workflows.js';
import { MarkingState } from 'libpetri/verification';
import type { SmtVerificationResult } from 'libpetri/verification';
import {
  decodeCounterexample, decodeMarking, decodeStep, renderMarkedPlace, renderNodePath, stripBranch,
} from '../../src/verify/index.js';

const compiled = compile(diamond);
const map = compiled.netMap;

function fakeResult(partial: Partial<SmtVerificationResult>): SmtVerificationResult {
  return {
    verdict: { type: 'violated' },
    // The decoder's subject is a solver counterexample; `route` names which route produced
    // the result (libpetri VER-003) and only `smt` computes invariants.
    route: 'smt',
    report: '',
    invariants: [],
    discoveredInvariants: [],
    counterexampleTrace: [],
    counterexampleTransitions: [],
    counterexampleConfirmed: null,
    elapsedMs: 0,
    statistics: { places: 0, transitions: 0, invariantsFound: 0, structuralResult: '' },
    ...partial,
  };
}

describe('counterexample decoding', () => {
  it('strips the flattener branch suffix', () => {
    expect(stripBranch('id:A/run_b0')).toBe('id:A/run');
    expect(stripBranch('id:A/run_b12')).toBe('id:A/run');
    expect(stripBranch('id:A/skip')).toBe('id:A/skip');
    // Only a trailing `_b<digits>` is a branch; a place-like suffix is left alone.
    expect(stripBranch('id:A/route_b')).toBe('id:A/route_b');
  });

  it('maps a flat transition to its node, role and port', () => {
    const run = decodeStep(`${map.node('IF').transitions.run}_b0`, map);
    expect(run.node).toBe('IF');
    expect(run.role).toBe('run');
    expect(run.source).toBe(map.node('IF').transitions.run);
    expect(run.transition.endsWith('_b0')).toBe(true);

    const unknown = decodeStep('not/a/transition', map);
    expect(unknown.node).toBeNull();
    expect(unknown.role).toBeNull();
  });

  it('carries the arm variant and the route port', () => {
    const arm = map.transitionsOf('Merge').find((t) => t.role === 'arm' && t.variant === 'empty')!;
    expect(decodeStep(arm.name, map)).toMatchObject({ node: 'Merge', role: 'arm', variant: 'empty' });
  });

  it('builds a node path in first-occurrence order, skipping what it cannot decode', () => {
    const g = (name: string) => map.node(name).transitions;
    const cex = decodeCounterexample(fakeResult({
      counterexampleTransitions: [
        g('Trigger').run, `${g('Trigger').routes[0]!}_b0`, g('IF').start, `${g('IF').run}_b0`,
        g('IF').start, 'not/a/transition',
      ],
      counterexampleConfirmed: true,
    }), map)!;
    expect(cex.nodePath).toEqual(['Trigger', 'IF']);
    expect(cex.ordered).toBe(true);
    expect(renderNodePath(cex)).toBe('Trigger -> IF');
  });

  it('says so when the replay did not confirm a firing order', () => {
    const cex = decodeCounterexample(fakeResult({
      counterexampleTransitions: [map.node('A').transitions.run],
      counterexampleConfirmed: false,
    }), map)!;
    expect(cex.ordered).toBe(false);
    expect(renderNodePath(cex)).toBe('A');
    expect(cex.confirmed).toBe(false);
  });

  it('decodes the violating marking into node, role and port', () => {
    const merge = map.node('Merge');
    const state = MarkingState.builder()
      .tokens(merge.inputs[0]!.ready!, 1)
      .tokens(map.shared.budget, 2)
      .build();
    const decoded = decodeMarking(state, map);
    const ready = decoded.find((p) => p.role === 'ready')!;
    expect(ready.node).toBe('Merge');
    expect(ready.port).toBe(0);
    expect(renderMarkedPlace(ready)).toContain('Merge port 0 ready');
    const budget = decoded.find((p) => p.place === '_budget')!;
    expect(budget.node).toBeNull();
    expect(renderMarkedPlace(budget)).toBe('_budget x2');
  });

  it('returns null when there is nothing to decode', () => {
    expect(decodeCounterexample(fakeResult({}), map)).toBeNull();
    expect(renderNodePath({ nodePath: [], steps: [], stuckMarking: [], confirmed: null, ordered: false }))
      .toBe('(no node transitions in the witness)');
  });
});
