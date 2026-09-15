/**
 * The name vocabulary (`src/compiler/names.ts`). The net-identity baseline pins every name a
 * compile produces; this pins the vocabulary's own contract: a host place is named as the
 * consumer's instance qualifies the port bound to it (MOD-010, MOD-012), so `compile()` and the
 * gadget agree on it without either deriving the other's string.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import {
  PLACE, armOf, attemptRunOf, consumerPortOf, edgeInPortOf, emptyTwinOf, inPlaceOf, qualified, readyVariantOf,
  skipCombinationOf, skippedPlaceOf,
} from '../../src/compiler/names.js';
import {
  chooseBranch, diamond, expressionRef, loopOverItems, multiProducer, userCycle,
} from '../fixtures/workflows.js';

describe('names', () => {
  it('qualifies a local name under the instance prefix', () => {
    expect(qualified('n1', 'ready_0_data')).toBe('n1/ready_0_data');
    expect(inPlaceOf('n1')).toBe(qualified('n1', PLACE.in));
    expect(skippedPlaceOf('n1')).toBe('n1/skipped');
  });

  it('names an edge by the consumer port it binds to, in both forms', () => {
    expect(consumerPortOf(true, 1, 7)).toBe(PLACE.in);
    expect(consumerPortOf(false, 1, 7)).toBe(edgeInPortOf(1, 7));
    expect(qualified('c', emptyTwinOf(edgeInPortOf(1, 7)))).toBe('c/in1_e7_empty');
    expect(readyVariantOf(2, 'empty')).toBe('ready_2_empty');
  });

  it('keeps attempt 1 on `run` and spells combinations by variant initial', () => {
    expect(attemptRunOf(1)).toBe('run');
    expect(attemptRunOf(3)).toBe('run_3');
    expect(skipCombinationOf(['data', 'empty', 'data'])).toBe('skip_ded');
    expect(armOf(4, 'empty')).toBe('arm_e4_empty');
  });

  it('is the vocabulary every compiled fixture carries', () => {
    for (const workflow of [diamond, multiProducer, chooseBranch, userCycle, expressionRef, loopOverItems]) {
      const compiled = compile(workflow);
      for (const g of compiled.netMap.nodes) {
        if (g.form === 'direct') expect(g.in.name).toBe(inPlaceOf(g.id));
        if (g.skipped !== null) expect(g.skipped.name).toBe(skippedPlaceOf(g.id));
        for (const input of g.inputs) {
          for (const slot of input.edges) {
            const port = consumerPortOf(false, input.index, slot.edge.id);
            expect(slot.data.name).toBe(qualified(g.id, port));
            if (slot.empty !== null) expect(slot.empty.name).toBe(qualified(g.id, emptyTwinOf(port)));
          }
        }
        expect(g.transitions.run).toBe(qualified(g.id, attemptRunOf(1)));
      }
    }
  });
});
