/**
 * A skip forwards its empties only when a successor must hear of it (ADR 0002,
 * `analysis/skip-observers.ts`): a successor that reads skips — a join or OR slot, a `$('X')`
 * reference, a cycle or a loop — or feeds one. Otherwise the skip ends at the node that took it.
 */
import { describe, expect, it } from 'vitest';
import { analyse, compile } from '../../src/compiler/index.js';
import type { WorkflowDescription } from '../../src/compiler/index.js';
import { diamond, expressionRef, fanOut4, linear, loopOverItems } from '../fixtures/workflows.js';

const observable = (w: WorkflowDescription): string[] => [...analyse(w).skipObservable].sort();

describe('which nodes must hear of an upstream skip', () => {
  it('none, on a chain and on a fan-out with no join', () => {
    expect(observable(linear)).toEqual([]);
    expect(observable(fanOut4)).toEqual([]);
  });

  it('a join reads its inputs, so it and everything feeding it must; the node after it need not', () => {
    expect(observable(diamond)).toEqual(['A', 'B', 'IF', 'Merge', 'Trigger']);
  });

  it('a referenced node has its skipped marker read, so it and its producers must; the reader need not', () => {
    expect(observable(expressionRef)).toEqual(['A', 'IF', 'Trigger']);
  });

  it('a loop and its body are observers, and so is what feeds them; the exit is not', () => {
    expect(observable(loopOverItems)).toEqual(['Body', 'Loop', 'Trigger']);
  });
});

describe('the compiled skip', () => {
  const forwards = (w: WorkflowDescription, node: string): boolean => {
    const g = compile(w).netMap.nodes.find((n) => n.node === node);
    if (g === undefined) throw new Error(`no gadget for ${node}`);
    return g.skipForwards;
  };

  it('forwards on every node that feeds a join and ends at the join, since nothing past it reads a skip', () => {
    for (const node of ['IF', 'A', 'B']) expect(forwards(diamond, node), node).toBe(true);
    for (const node of ['Merge', 'End']) expect(forwards(diamond, node), node).toBe(false);
  });

  it('forwards toward a referenced node and ends at it', () => {
    expect(forwards(expressionRef, 'IF')).toBe(true);
    for (const node of ['A', 'B']) expect(forwards(expressionRef, node), node).toBe(false);
  });

  it('ends at the first node of a branch nothing downstream reads', () => {
    for (const node of ['A', 'B', 'C']) expect(forwards(linear, node), node).toBe(false);
  });
});
