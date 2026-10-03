/**
 * Step 12's rerun (`tasks/v2-seam-plan.md`, "Step 12, rerun: the F4 fix"): the two changes to how the
 * net-backed policy reads rows.
 *
 * - **The scoped read** (`rows.ts`): the latest-row query asks for batch nodes only, and every row of
 *   the snapshot comes from one keyed statement: `(node, 0)` outside a loop, a window of passes in a
 *   loop, and a probe. A loop two passes on at the probe sends the call to the latest-row snapshot
 *   (`overrun`), which answers alike.
 * - **One snapshot per settlement** (`policy.ts`): `isFinished` on the graph object and execution of
 *   the `decideSuccessors` before it answers from that call's rows plus what it decided, reading
 *   nothing; any other call reads afresh.
 * - **The theorem, in the handler's order.** On every golden settlement (n8n's own runs, loops
 *   included) the reused answer at S ∪ D̂ is the fresh answer at S′; on sequential reference runs a
 *   reused true is only ever said on the run's final rows, and every completed run hears it.
 *
 * Settlement evidence, not conformance numbers (decision 12). The concurrent, stale-snapshot test of
 * the theorem is the handler leg (`tasks/v2-handler-leg.mts --stale`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StepKey, StepRow } from '../../src/codec/v2/step-rows.js';
import { asGolden, decodeKey, settlementRows } from '../../src/conformance/v2/golden.js';
import { reachableOf, referenceFinished, simulate } from '../../src/conformance/v2/reference.js';
import type { ReferenceRow } from '../../src/conformance/v2/reference.js';
import type { V2Graph } from '../../src/n8n/v2-graph.js';
import type { V2SettlementReader, V2StepKey } from '../../src/n8n/v2-host.js';
import { createCompileCache } from '../../src/settlement/compile-cache.js';
import { createSettlementPolicy, decideFromRows, finishedAfterDecision, finishedFromRows, withDecided } from '../../src/settlement/policy.js';
import type { SettlementDiagnostic } from '../../src/settlement/policy.js';
import { probePass, readLatestSnapshot, readSnapshot, scopedKeys, scopedPasses } from '../../src/settlement/rows.js';
import { SETTLEMENT_SHAPES, chain, loop } from '../fixtures/v2-graphs.js';
import { stub } from '../fixtures/v2-stub-reference.js';
import { memoryReader } from '../support/settlement-reader.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = asGolden(JSON.parse(readFileSync(resolve(here, '../fixtures/v2/settlement-golden.json'), 'utf8')));

const row = (nodeId: string, iteration: number, status: string, filled: boolean[] = []): StepRow =>
  ({ nodeId, iteration, status, filledOutputSlots: filled });
const done = (nodeId: string, iteration = 0, filled = [true]) => row(nodeId, iteration, 'completed', filled);
const keyText = (keys: readonly V2StepKey[]) => keys.map((k) => `${k.nodeId}@${k.iteration}`).join(' ');
const copyOf = (g: V2Graph): V2Graph => JSON.parse(JSON.stringify(g)) as V2Graph;

/** `loop`'s history through pass `last` (B looping), B's row at `last` with `filled`. */
function loopRows(last: number, filled = [false, true]): StepRow[] {
  const rows = [done('T')];
  for (let p = 0; p < last; p++) rows.push(done('B', p, [false, true]), done('Body', p));
  rows.push(done('B', last, filled));
  return rows;
}

describe('the scoped read', () => {
  const cache = createCompileCache();

  it('asks (node, 0) outside a loop, a window of passes in it, the probe, and the settled row', () => {
    const entry = cache.get(loop);
    expect(scopedPasses(-1)).toEqual([0]);
    expect(scopedPasses(0)).toEqual([0, 1]);
    expect(scopedPasses(2)).toEqual([0, 1, 2, 3]);
    expect(scopedPasses(500)).toEqual([0, 499, 500, 501]);
    expect([probePass(-1), probePass(0), probePass(500)]).toEqual([1, 2, 502]);
    expect(keyText(scopedKeys(entry, new Map([['B', 500]])))).toBe('T@0 After@0 B@0 B@499 B@500 B@501 B@502 Body@0 Body@499 Body@500 Body@501');
    expect(keyText(scopedKeys(entry, new Map()))).toBe('T@0 After@0 B@0 B@1 Body@0');
    expect(keyText(scopedKeys(entry, new Map([['B', 500]]), { nodeId: 'Body', iteration: 17 }))).toMatch(/ Body@17$/);
    expect(keyText(scopedKeys(cache.get(chain), new Map()))).toBe('T@0 A@0 B@0');
  });

  it('reads the latest batch row, then every row in one keyed read, and answers as the latest-row snapshot', async () => {
    const entry = cache.get(loop);
    for (const last of [0, 1, 2, 3, 10, 400]) {
      for (const rows of [loopRows(last), loopRows(last, [true, false]), [...loopRows(last), row('Body', last, 'running')]]) {
        const scoped = memoryReader(rows);
        const latest = memoryReader(rows);
        const a = await readSnapshot(entry, scoped);
        const b = await readLatestSnapshot(entry, latest);
        expect(scoped.calls).toEqual({ loadLatestStepSummaries: 1, loadStepSummariesByKeys: 1, countSettledSteps: 0 });
        expect(a.overrun).toBe(false);
        expect(finishedFromRows(entry, a.rows)).toBe(finishedFromRows(entry, b.rows));
        for (const s of rows.filter((r) => r.status === 'completed')) {
          expect(decideFromRows(entry, s, a.rows), `pass ${last}, ${s.nodeId}@${s.iteration}`).toEqual(decideFromRows(entry, s, b.rows));
        }
      }
    }
  });

  it('keeps a batch node one pass on between its reads, and reads again when it is two passes on', async () => {
    const entry = cache.get(loop);
    // The batch node is at pass 3 when the first read runs; the keyed read sees the loop further on.
    const at3 = loopRows(3);
    // Its first latest-row read sees pass 3; every later read sees `later`.
    const moving = (later: StepRow[]): V2SettlementReader => {
      let first = true;
      return {
        executionId: 'e',
        loadLatestStepSummaries: (ids) => {
          const rows = first ? at3 : later;
          first = false;
          return memoryReader(rows).loadLatestStepSummaries(ids);
        },
        loadStepSummariesByKeys: (keys) => memoryReader(later).loadStepSummariesByKeys(keys),
        countSettledSteps: () => memoryReader(later).countSettledSteps(),
      };
    };
    const onePass = [...loopRows(3), done('Body', 3), row('B', 4, 'running')];
    const one = await readSnapshot(entry, moving(onePass));
    expect(one).toMatchObject({ overrun: false, reads: 2 });
    expect(finishedFromRows(entry, one.rows)).toBe(false);
    expect(one.rows.some((r) => r.nodeId === 'B' && r.iteration === 4)).toBe(true);

    const twoPasses = [...loopRows(4), done('Body', 4), row('B', 5, 'queued')];
    const two = await readSnapshot(entry, moving(twoPasses));
    expect(two).toMatchObject({ overrun: true, reads: 4 });
    // The overrun path's rows are the latest-row snapshot's of the later rows.
    expect(two.rows).toEqual((await readLatestSnapshot(entry, memoryReader(twoPasses))).rows);

    const seen: SettlementDiagnostic[] = [];
    const policy = createSettlementPolicy({ cache, onDiagnostic: (d) => seen.push(d) });
    await policy.isFinished(loop, moving(twoPasses));
    expect(seen.filter((d) => d.kind === 'snapshot').map((d) => d.kind === 'snapshot' && d.event)).toEqual(['overrun']);
  });

  it('does not see a row past iteration 0 outside a loop unless it is the settled row', async () => {
    // Rows engine v2 does not produce (targetKey gives such a node iteration 0 only).
    const stray = [done('T'), done('A'), done('B'), done('B', 1)];
    expect(await createSettlementPolicy({ reuseSnapshot: false }).isFinished(chain, memoryReader(stray))).toBe(true);
    await expect(createSettlementPolicy().decideSuccessors(chain, done('B', 1), memoryReader(stray))).rejects.toThrow(/outside every loop/);
  });
});

describe('one snapshot per settlement', () => {
  /** A policy with its snapshot diagnostics, as `[event, token]`. */
  function withEvents() {
    const events: [string, number][] = [];
    const policy = createSettlementPolicy({ onDiagnostic: (d) => { if (d.kind === 'snapshot') events.push([d.event, d.token]); } });
    return { policy, events };
  }

  it('isFinished after decideSuccessors on the same graph object reads nothing and pairs the tokens', async () => {
    const { policy, events } = withEvents();
    const graph = copyOf(chain);
    const final = [done('T'), done('A'), done('B')];
    expect(await policy.decideSuccessors(graph, done('B'), memoryReader(final))).toEqual({ toQueue: [], toSkip: [] });
    const reader = memoryReader(final);
    expect(await policy.isFinished(graph, reader)).toBe(true);
    expect(reader.total()).toBe(0);
    expect(events).toEqual([['stored', 1], ['reused', 1]]);
  });

  it('is taken once, and never by another graph object, another execution or another policy', async () => {
    const { policy, events } = withEvents();
    const graph = copyOf(chain);
    const final = [done('T'), done('A'), done('B')];
    await policy.decideSuccessors(graph, done('B'), memoryReader(final));
    const other = memoryReader(final);
    expect(await policy.isFinished(copyOf(chain), other)).toBe(true);
    expect(other.total()).toBe(1);
    // The other graph object's call dropped nothing of this one's.
    const elsewhere = memoryReader(final, { executionId: 'execution-2' });
    expect(await policy.isFinished(graph, elsewhere)).toBe(true);
    expect(elsewhere.total()).toBe(1);
    // A mismatched execution consumed it: the next call on the graph reads too.
    const again = memoryReader(final);
    expect(await policy.isFinished(graph, again)).toBe(true);
    expect(again.total()).toBe(1);
    expect(events).toEqual([['stored', 1]]);
    await createSettlementPolicy().decideSuccessors(graph, done('B'), memoryReader(final));
    const second = memoryReader(final);
    await policy.isFinished(graph, second);
    expect(second.total()).toBe(1);
  });

  it('adds what it decided: a queued key is not finished, a skip that settles the run is', async () => {
    const policy = createSettlementPolicy();
    // T -> A -> B: A's settlement queues B, so the run is not finished, whatever S says.
    const g1 = copyOf(chain);
    expect(await policy.decideSuccessors(g1, done('A'), memoryReader([done('T'), done('A')]))).toEqual({ toQueue: [{ nodeId: 'B', iteration: 0 }], toSkip: [] });
    expect(await policy.isFinished(g1, memoryReader([]))).toBe(false);
    // T -> A -> B with A's slot empty: B is skipped, and with B skipped every row has settled.
    const g2 = copyOf(chain);
    const rows = [done('T'), done('A', 0, [false])];
    expect(await policy.decideSuccessors(g2, done('A', 0, [false]), memoryReader(rows))).toEqual({ toQueue: [], toSkip: [{ nodeId: 'B', iteration: 0 }] });
    expect(await policy.isFinished(g2, memoryReader([]))).toBe(true);
    const entry = createCompileCache().get(chain);
    expect(finishedFromRows(entry, rows)).toBe(false);
    expect(finishedAfterDecision(entry, rows, { toQueue: [], toSkip: [{ nodeId: 'B', iteration: 0 }] })).toBe(true);
    expect(withDecided(rows, { toQueue: [{ nodeId: 'B', iteration: 0 }], toSkip: [] }).at(-1)).toEqual(row('B', 0, 'queued'));
  });

  it('keeps nothing when decideSuccessors throws, and nothing with reuseSnapshot false', async () => {
    const policy = createSettlementPolicy();
    const graph = copyOf(chain);
    await policy.decideSuccessors(graph, done('B'), memoryReader([done('T'), done('A'), done('B')]));
    await expect(policy.decideSuccessors(graph, done('B'), memoryReader([done('T'), done('B')]))).rejects.toThrow(/never found/);
    const after = memoryReader([done('T'), done('A'), done('B')]);
    expect(await policy.isFinished(graph, after)).toBe(true);
    expect(after.total()).toBe(1);

    const fresh = createSettlementPolicy({ reuseSnapshot: false });
    await fresh.decideSuccessors(graph, done('B'), memoryReader([done('T'), done('A'), done('B')]));
    const reader = memoryReader([done('T'), done('A'), done('B')]);
    await fresh.isFinished(graph, reader);
    expect(reader.total()).toBe(1);
  });
});

describe('the theorem in the handler\'s order', () => {
  it('on every golden settlement, the reused answer at S ∪ D̂ is the fresh answer at S′', async () => {
    const reusing = createSettlementPolicy();
    const fresh = createSettlementPolicy({ reuseSnapshot: false });
    let compared = 0;
    let loops = 0;
    for (const entry of golden.entries) {
      for (const settlement of entry.settlements) {
        const { before, after } = settlementRows(entry.graph, settlement);
        const graph = copyOf(entry.graph);
        const settled = decodeKey(entry.graph, settlement.settled);
        await reusing.decideSuccessors(graph, settled, memoryReader(before));
        const reader = memoryReader(after);
        const reused = await reusing.isFinished(graph, reader);
        expect(reader.total()).toBe(0);
        expect(reused, `${entry.id}`).toBe(await fresh.isFinished(entry.graph, memoryReader(after)));
        compared++;
        if (after.some((r) => r.iteration > 0)) loops++;
      }
    }
    expect(compared).toBeGreaterThan(500);
    expect(loops).toBeGreaterThan(0);
  });

  it.each(Object.entries(SETTLEMENT_SHAPES))('on %s: a reused true only on the final rows, and every completed run hears one', (_name, graph) => {
    const entry = createCompileCache().get(graph);
    const loops = stub.deriveLoops(graph);
    const reachable = reachableOf(stub, graph);
    let runs = 0;
    let saidTrue = 0;
    for (let b = 0; b < 8; b++) {
      for (let o = 0; o < 8; o++) {
        const heard: { rows: readonly ReferenceRow[]; settled: StepKey }[] = [];
        let last: readonly ReferenceRow[] = [];
        simulate(stub, graph, { seed: 2000 + b, pFail: b % 2 === 0 ? 0.2 : 0, emptyTerminal: 0 }, o, {
          onSettled: (rows, settled) => heard.push({ rows, settled }),
          onState: (rows) => { last = rows; },
        });
        const finalText = JSON.stringify([...last].map((r) => `${r.nodeId}@${r.iteration} ${r.status}`).sort());
        let any = false;
        for (const { rows, settled } of heard) {
          if (rows.some((r) => r.status === 'failed')) continue;
          const decided = decideFromRows(entry, settled, rows);
          if (!finishedAfterDecision(entry, rows, decided)) continue;
          any = true;
          saidTrue++;
          const v = withDecided(rows, decided);
          expect(JSON.stringify(v.map((r) => `${r.nodeId}@${r.iteration} ${r.status}`).sort())).toBe(finalText);
        }
        if (!last.some((r) => r.status === 'failed')) {
          expect(referenceFinished(stub, loops, reachable, last)).toBe(true);
          expect(any).toBe(true);
        }
        runs++;
      }
    }
    expect(runs).toBe(64);
    expect(saidTrue).toBeGreaterThan(0);
  });
});
