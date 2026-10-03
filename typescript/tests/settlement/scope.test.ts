/**
 * Key-scoped successors (`src/settlement/scope.ts`, `tasks/v2-seam-plan.md` decisions 6 and 7)
 * with no `.n8n`.
 *
 * - `candidateKeys` on hand-written graphs, against what `decideSuccessors` (`settlement.ts`)
 *   walks: out-edges in graph order, `targetKey` per edge class, `batchStepDecides`, the dedupe of
 *   two edges into one key and the skip of a key with a row.
 * - `scopePlan` and `isFinished` on hand-written plans; `isFinished` is decision 7 as amended after
 *   F3 fired at step 2, false on any row set with a failed row.
 * - The recorded golden (`tests/fixtures/v2/settlement-golden.json`, n8n's own R(S) at every
 *   kept state): narrowing R(S) to each settled row's candidates loses nothing and adds nothing.
 *   R(S) is the union of `decideSuccessors` over the completed and skipped rows, less the keys with
 *   a row (`referenceAnswer`), so if the candidates are right, the scoped plans cover R(S) exactly.
 *   The same holds for the net's own R(S) on those rows.
 *
 * The comparison against n8n's `decideSuccessors` per (S, s) is decision 13's leg (a″), run by
 * `tasks/v2-differential.mts` and `tasks/spike-v2-exhaustive.mts` against the pinned `dist`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planFromMarking } from '../../src/codec/v2/plan.js';
import type { StepPlan } from '../../src/codec/v2/plan.js';
import { decodeStepRows } from '../../src/codec/v2/step-rows.js';
import type { StepKey, StepRow } from '../../src/codec/v2/step-rows.js';
import { compile } from '../../src/compiler/index.js';
import { asGolden, decodeRows } from '../../src/conformance/v2/golden.js';
import { graphToDescription } from '../../src/conformance/v2/graph.js';
import type { V2Graph } from '../../src/conformance/v2/graph.js';
import { candidateKeys, isFinished, scopePlan } from '../../src/settlement/scope.js';
import {
  backEdge, batch, branchDiamond, chain, diamondBody, edge, exitIntoMerge, ifIntoMerge, loop, selfLoop, trigger, twoLoops, v1,
} from '../fixtures/v2-graphs.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = asGolden(JSON.parse(readFileSync(resolve(here, '../fixtures/v2/settlement-golden.json'), 'utf8')));

const key = (nodeId: string, iteration = 0): StepKey => ({ nodeId, iteration });
const row = (nodeId: string, iteration: number, status: string, filled: boolean[] = []): StepRow =>
  ({ nodeId, iteration, status, filledOutputSlots: filled });
const done = (nodeId: string, iteration = 0, filled = [true]) => row(nodeId, iteration, 'completed', filled);
const text = (keys: readonly StepKey[]) => keys.map((k) => `${k.nodeId}@${k.iteration}`);

// ---- candidateKeys ----

describe('candidateKeys', () => {
  it('names the targets of the settled node\'s out-edges at its iteration, outside a loop', () => {
    expect(text(candidateKeys(chain, key('T'), [done('T')]))).toEqual(['A@0']);
    expect(text(candidateKeys(chain, key('A'), [done('T'), done('A')]))).toEqual(['B@0']);
    expect(text(candidateKeys(chain, key('B'), [done('T'), done('A'), done('B')]))).toEqual([]);
  });

  it('keeps graph edge order, not node order', () => {
    expect(text(candidateKeys(branchDiamond, key('If'), [done('T'), done('If', 0, [true, false])]))).toEqual(['P@0', 'Q@0']);
    const reversed: V2Graph = { ...branchDiamond, edges: [...branchDiamond.edges].reverse() };
    expect(text(candidateKeys(reversed, key('If'), [done('T'), done('If', 0, [true, false])]))).toEqual(['Q@0', 'P@0']);
  });

  it('names a target reached by two edges once', () => {
    expect(text(candidateKeys(ifIntoMerge, key('If'), [done('T'), done('If', 0, [true, true])]))).toEqual(['M@0']);
  });

  it('skips a key that already has a row, whatever its status, and only that key', () => {
    const rows = [done('T'), done('If', 0, [true, false]), row('P', 0, 'queued')];
    expect(text(candidateKeys(branchDiamond, key('If'), rows))).toEqual(['Q@0']);
    expect(text(candidateKeys(branchDiamond, key('If'), [...rows, row('Q', 0, 'skipped')]))).toEqual([]);
  });

  it('decides the body from a running loop\'s batch row, and only what follows from its terminal row', () => {
    const passing = [done('T'), done('B', 0, [false, true])];
    expect(text(candidateKeys(loop, key('B', 0), passing))).toEqual(['Body@0']);
    const terminal = [done('T'), done('B', 0, [false, true]), done('Body', 0), done('B', 1, [true, false])];
    expect(text(candidateKeys(loop, key('B', 1), terminal))).toEqual(['After@0']);
    // A terminal row that filled nothing ([null, null]) and one that never ran end the loop alike.
    const empty = [done('T'), done('B', 0, [false, false])];
    expect(text(candidateKeys(loop, key('B', 0), empty))).toEqual(['After@0']);
    expect(text(candidateKeys(loop, key('B', 0), [done('T'), row('B', 0, 'skipped')]))).toEqual(['After@0']);
  });

  it('walks every edge of a batch node whose row the rows do not hold, as decideSuccessors does', () => {
    expect(text(candidateKeys(loop, key('B', 0), [done('T')]))).toEqual(['Body@0', 'After@0']);
  });

  it('takes a back edge to the next pass, an intra edge to the same pass', () => {
    const rows = [done('T'), done('B', 0, [false, true]), done('Body', 0)];
    expect(text(candidateKeys(loop, key('Body', 0), rows))).toEqual(['B@1']);
    const body = [done('T'), done('B', 0, [false, true]), done('B', 1, [false, true]), done('B', 2, [false, true]), done('If', 2, [true, true])];
    expect(text(candidateKeys(diamondBody, key('If', 2), body))).toEqual(['P@2', 'Q@2']);
  });

  it('on a batch node that returns to itself: the next pass while it loops, the exit at its end', () => {
    expect(text(candidateKeys(selfLoop, key('B', 0), [done('T'), done('B', 0, [false, true])]))).toEqual(['B@1']);
    expect(text(candidateKeys(selfLoop, key('B', 1), [done('T'), done('B', 0, [false, true]), done('B', 1, [true, false])]))).toEqual(['After@0']);
  });

  it('takes an exit and an entry edge to iteration 0, an exit into another loop included', () => {
    const rows = [done('T'), done('B1', 0, [false, true]), done('Body1', 0), done('B1', 1, [true, false])];
    expect(text(candidateKeys(twoLoops, key('B1', 1), rows))).toEqual(['B2@0']);
    expect(text(candidateKeys(exitIntoMerge, key('If'), [done('T'), done('If', 0, [true, true])]))).toEqual(['B@0', 'Other@0']);
  });

  it('reads the converter\'s isBackEdge, not a derivation: an unmarked return is an intra edge', () => {
    const unmarked: V2Graph = {
      nodes: [trigger('T'), batch('B'), v1('Body')],
      edges: [edge('T', 'B'), edge('B', 'Body', 1), edge('Body', 'B')],
    };
    const rows = [done('T'), done('B', 0, [false, true]), done('Body', 0)];
    expect(text(candidateKeys(unmarked, key('Body', 0), rows))).toEqual([]); // B@0 has a row: same pass
    const marked: V2Graph = { ...unmarked, edges: [edge('T', 'B'), edge('B', 'Body', 1), backEdge('Body', 'B')] };
    expect(text(candidateKeys(marked, key('Body', 0), rows))).toEqual(['B@1']);
  });
});

// ---- scopePlan and isFinished ----

describe('scopePlan', () => {
  const plan: StepPlan = { toQueue: [key('Z'), key('P')], toSkip: [key('Q'), key('Y')] };

  it('keeps the planned candidates in candidate order, each in its own list', () => {
    expect(scopePlan(plan, [key('Q'), key('P')])).toEqual({ toQueue: [key('P')], toSkip: [key('Q')] });
    expect(scopePlan(plan, [key('Y'), key('Q'), key('Z'), key('P')])).toEqual({ toQueue: [key('Z'), key('P')], toSkip: [key('Y'), key('Q')] });
  });

  it('drops what the net plans for other settlements, and a candidate the net leaves undecided', () => {
    expect(scopePlan(plan, [key('P', 1), key('X')])).toEqual({ toQueue: [], toSkip: [] });
    expect(scopePlan(plan, [])).toEqual({ toQueue: [], toSkip: [] });
  });

  it('keeps a key the net put in both lists in both, so a comparison sees it', () => {
    expect(scopePlan({ toQueue: [key('P')], toSkip: [key('P')] }, [key('P')])).toEqual({ toQueue: [key('P')], toSkip: [key('P')] });
  });
});

describe('isFinished', () => {
  const none: StepPlan = { toQueue: [], toSkip: [] };

  it('holds when every row has settled, none failed, and nothing is planned', () => {
    expect(isFinished([done('T'), row('A', 0, 'skipped'), done('B')], none)).toBe(true);
  });

  it('never holds once a row has failed (decision 7 as amended), every row settled or not', () => {
    // The smallest case: T -> A -> B with A failed. The halted net plans nothing and every row has
    // settled; n8n's count owes B. That S is F3's named race, and isFinished leaves it unfinished.
    expect(isFinished([done('T'), row('A', 0, 'failed')], none)).toBe(false);
    // The failed step was the last one owed: n8n's count test is true here, isFinished still false.
    expect(isFinished([done('T'), done('A'), row('B', 0, 'failed')], none)).toBe(false);
    expect(isFinished([done('T'), row('A', 0, 'skipped'), row('B', 0, 'failed'), row('C', 0, 'cancelled')], none)).toBe(false);
  });

  it('fails on a row in flight, waiting included, and on anything planned', () => {
    for (const status of ['queued', 'running', 'waiting']) expect(isFinished([done('T'), row('A', 0, status)], none), status).toBe(false);
    expect(isFinished([done('T')], { toQueue: [key('A')], toSkip: [] })).toBe(false);
    expect(isFinished([done('T')], { toQueue: [], toSkip: [key('A')] })).toBe(false);
  });
});

// ---- the golden: scoped plans cover R(S) exactly ----

const parse = (k: string): StepKey => {
  const at = k.lastIndexOf('@');
  return { nodeId: k.slice(0, at), iteration: Number(k.slice(at + 1)) };
};
const sorted = (plans: readonly StepPlan[]) => ({
  toQueue: plans.flatMap((p) => text(p.toQueue)).sort(),
  toSkip: plans.flatMap((p) => text(p.toSkip)).sort(),
});

describe.each(golden.entries.map((e) => [e.id, e] as const))('the golden\'s R(S), scoped per settled row, on %s', (_id, entry) => {
  const compiled = compile(graphToDescription(entry.graph).description, { profile: 'engineV2' });

  it('is partitioned by the completed and skipped rows\' candidates: nothing lost, nothing added', () => {
    for (const state of entry.states) {
      const rows = decodeRows(entry.graph, state.rows);
      const R: StepPlan = { toQueue: state.plan.toQueue.map(parse), toSkip: state.plan.toSkip.map(parse) };
      const deciders = rows.filter((r) => r.status === 'completed' || r.status === 'skipped');
      const scoped = deciders.map((s) => scopePlan(R, candidateKeys(entry.graph, s, rows)));
      // Two settled rows may share a candidate (a Merge fed by both); each names it once.
      const union = { toQueue: [...new Set(sorted(scoped).toQueue)], toSkip: [...new Set(sorted(scoped).toSkip)] };
      expect(union, `rows ${JSON.stringify(state.rows)}`).toEqual({ toQueue: [...state.plan.toQueue].sort(), toSkip: [...state.plan.toSkip].sort() });
      // The net's R(S) on the same rows, scoped the same way, gives the same plans.
      const net = planFromMarking(compiled, decodeStepRows(compiled, rows));
      const scopedNet = deciders.map((s) => scopePlan(net, candidateKeys(entry.graph, s, rows)));
      expect(scopedNet.map((p) => sorted([p])), `rows ${JSON.stringify(state.rows)}`).toEqual(scoped.map((p) => sorted([p])));
    }
  });

  it('is empty for every settled row once a row has failed', () => {
    for (const state of entry.states) {
      const rows = decodeRows(entry.graph, state.rows);
      if (!rows.some((r) => r.status === 'failed')) continue;
      const net = planFromMarking(compiled, decodeStepRows(compiled, rows));
      for (const s of rows) expect(scopePlan(net, candidateKeys(entry.graph, s, rows))).toEqual({ toQueue: [], toSkip: [] });
    }
  });
});

describe('the golden covers what the scoped comparison needs', () => {
  it('has states where one settlement decides two or more keys, so order is exercised, and loop states', () => {
    let ordered = 0;
    let loopStates = 0;
    for (const entry of golden.entries) {
      const batchIds = new Set(entry.graph.nodes.filter((n) => n.type === 'batch').map((n) => n.id));
      for (const state of entry.states) {
        const rows = decodeRows(entry.graph, state.rows);
        if (rows.some((r) => batchIds.has(r.nodeId))) loopStates++;
        const R: StepPlan = { toQueue: state.plan.toQueue.map(parse), toSkip: state.plan.toSkip.map(parse) };
        for (const s of rows) {
          const p = scopePlan(R, candidateKeys(entry.graph, s, rows));
          if (p.toQueue.length > 1 || p.toSkip.length > 1) ordered++;
        }
      }
    }
    expect(ordered).toBeGreaterThan(0);
    expect(loopStates).toBeGreaterThan(0);
  });
});
