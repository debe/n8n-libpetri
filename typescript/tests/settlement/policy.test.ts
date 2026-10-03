/**
 * The net-backed settlement policy (`src/settlement/policy.ts`, `tasks/v2-seam-plan.md` decisions
 * 6–10) with no `.n8n`, driven through an in-memory reader (`tests/support/settlement-reader.ts`).
 *
 * - **Against n8n's recorded answers.** On every state of the golden
 *   (`tests/fixtures/v2/settlement-golden.json`, n8n's own R(S) from the pinned `dist`) without a
 *   failed row, the policy's `decideSuccessors` over the completed and skipped rows covers R(S)
 *   exactly; on every recorded run's final rows, `isFinished` is the run's end.
 * - **Against the reference loop** on the loop-free shapes, with the stand-in for n8n's code
 *   (`tests/fixtures/v2-stub-reference.ts`): at every reached (S, s), the policy's answer is
 *   `planSuccessors`' answer in order, and on every failure-free S `isFinished` is the count test.
 * - The properties step 6 lists: cold equals warm; 20 reader permutations give one answer;
 *   interleaved executions do not see each other; ∅ and not finished on a failed row and on a
 *   cancelled row without one; at most 3 reader calls per call, `countSettledSteps` counted.
 * - Diagnostics (`entered`, `race`, `error`, `registered`, `snapshot`) and registration on a registry.
 * - Step 12's rerun: the scoped read (one statement for the rows, the probe and its overrun path),
 *   and the snapshot `decideSuccessors` keeps for the same settlement's `isFinished`.
 *
 * Calls that do not follow the handler's order — `isFinished` without the settlement's own
 * `decideSuccessors` and `createSteps` before it — use `reuseSnapshot: false`: there the kept
 * snapshot would answer for rows the test never wrote.
 *
 * These are settlement evidence, not conformance numbers (decision 12). Per-(S, s) equality with
 * n8n's own `decideSuccessors` is the differential's leg (a″) and, through this policy, step 7's
 * golden replay and step 8's leg (d).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StepKey, StepRow } from '../../src/codec/v2/step-rows.js';
import { asGolden, decodeRows } from '../../src/conformance/v2/golden.js';
import { handlerPlan, reachableOf, referenceFinished, simulate } from '../../src/conformance/v2/reference.js';
import type { ReferenceRow } from '../../src/conformance/v2/reference.js';
import type { V2Graph } from '../../src/n8n/v2-graph.js';
import type { V2SettlementPolicy, V2SettlementRegistry, V2StepKey } from '../../src/n8n/v2-host.js';
import { createCompileCache, SettlementCompileRefusal } from '../../src/settlement/compile-cache.js';
import { createSettlementPolicy, decideFromRows, finishedFromRows } from '../../src/settlement/policy.js';
import type { SettlementDiagnostic } from '../../src/settlement/policy.js';
import { registerSettlementPolicy } from '../../src/settlement/register.js';
import { SETTLEMENT_SHAPES, chain, edge, loop, trigger, v1 } from '../fixtures/v2-graphs.js';
import { stub } from '../fixtures/v2-stub-reference.js';
import { memoryReader } from '../support/settlement-reader.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = asGolden(JSON.parse(readFileSync(resolve(here, '../fixtures/v2/settlement-golden.json'), 'utf8')));

const row = (nodeId: string, iteration: number, status: string, filled: boolean[] = []): StepRow =>
  ({ nodeId, iteration, status, filledOutputSlots: filled });
const done = (nodeId: string, iteration = 0, filled = [true]) => row(nodeId, iteration, 'completed', filled);
const text = (d: { readonly toQueue: readonly V2StepKey[]; readonly toSkip: readonly V2StepKey[] }) => ({
  toQueue: d.toQueue.map((k) => `${k.nodeId}@${k.iteration}`),
  toSkip: d.toSkip.map((k) => `${k.nodeId}@${k.iteration}`),
});
const deciders = (rows: readonly StepRow[]) => rows.filter((r) => r.status === 'completed' || r.status === 'skipped');
const hasStatus = (rows: readonly StepRow[], status: string) => rows.some((r) => r.status === status);

/** Every golden state as (entry, rows), the failed and cancelled ones flagged. */
const goldenStates = golden.entries.flatMap((entry) =>
  entry.states.map((state, i) => ({ entry, i, rows: decodeRows(entry.graph, state.rows) as readonly StepRow[], plan: state.plan })));

/**
 * Both answers of `policy` at `rows`: each completed or skipped row's decision, then `isFinished`.
 * The reader holds `stored` (the same rows, possibly in another order), shuffled by `order`.
 */
async function answers(policy: V2SettlementPolicy, graph: V2Graph, rows: readonly StepRow[], order?: number, stored: readonly StepRow[] = rows) {
  const decided: ReturnType<typeof text>[] = [];
  for (const s of deciders(rows)) decided.push(text(await policy.decideSuccessors(graph, s, memoryReader(stored, { order }))));
  return { decided, finished: await policy.isFinished(graph, memoryReader(stored, { order })) };
}

// ---- against n8n's recorded answers ----

describe('the policy on the golden (n8n\'s recorded R(S) and run ends)', () => {
  it('decides, over the completed and skipped rows of a failure-free state, exactly n8n\'s R(S)', async () => {
    const policy = createSettlementPolicy();
    let compared = 0;
    for (const { entry, i, rows, plan } of goldenStates) {
      if (hasStatus(rows, 'failed') || hasStatus(rows, 'cancelled')) continue;
      const { decided } = await answers(policy, entry.graph, rows);
      const union = (list: 'toQueue' | 'toSkip') => [...new Set(decided.flatMap((d) => d[list]))].sort();
      expect({ toQueue: union('toQueue'), toSkip: union('toSkip') }, `${entry.id} state ${i}`)
        .toEqual({ toQueue: [...plan.toQueue].sort(), toSkip: [...plan.toSkip].sort() });
      compared++;
    }
    expect(compared).toBeGreaterThan(500);
  });

  it('says finished on the final rows of every completed run, and not on a failed one', async () => {
    const policy = createSettlementPolicy();
    const ends = new Map<string, number>();
    for (const entry of golden.entries) {
      for (const run of entry.runs) {
        const rows = decodeRows(entry.graph, run.rows);
        const finished = await policy.isFinished(entry.graph, memoryReader(rows));
        expect(finished, `${entry.id} behaviour ${run.behaviour} order ${run.order}: ${run.end}`).toBe(run.end === 'completed');
        ends.set(run.end, (ends.get(run.end) ?? 0) + 1);
      }
    }
    expect(ends.get('completed')).toBeGreaterThan(0);
    expect(ends.get('failed')).toBeGreaterThan(0);
  });

  it('is decideFromRows and finishedFromRows over the snapshot: a pure function of the rows read', async () => {
    const cache = createCompileCache();
    const policy = createSettlementPolicy({ cache, reuseSnapshot: false });
    for (const { entry, rows } of goldenStates.filter((_, n) => n % 7 === 0)) {
      const compiled = cache.get(entry.graph);
      for (const s of deciders(rows)) {
        expect(text(await policy.decideSuccessors(entry.graph, s, memoryReader(rows)))).toEqual(text(decideFromRows(compiled, s, rows)));
      }
      expect(await policy.isFinished(entry.graph, memoryReader(rows))).toBe(finishedFromRows(compiled, rows));
    }
  });
});

// ---- against the reference loop, loop-free shapes ----

/**
 * The reference loop over `graph`: at every reached (S, s) the policy answers `planSuccessors` in
 * order, and on every failure-free S `isFinished` is the count test. Returns the (S, s) compared.
 */
async function inReferenceLoop(graph: V2Graph): Promise<number> {
  const policy = createSettlementPolicy({ reuseSnapshot: false });
  const loops = stub.deriveLoops(graph);
  const reachable = reachableOf(stub, graph);
  const settledAt: { rows: readonly ReferenceRow[]; settled: StepKey }[] = [];
  const states: (readonly ReferenceRow[])[] = [];
  for (let b = 0; b < 6; b++) {
    for (let o = 0; o < 6; o++) {
      simulate(stub, graph, { seed: 1000 + b, pFail: b % 2 === 0 ? 0.2 : 0, emptyTerminal: 0 }, o, {
        onSettled: (rows, settled) => settledAt.push({ rows, settled }),
        onState: (rows) => states.push(rows),
      });
    }
  }
  let compared = 0;
  for (const { rows, settled } of settledAt) {
    const ours = text(await policy.decideSuccessors(graph, settled, memoryReader(rows)));
    // The handler checks hasFailedSteps before it plans: on a failed S it decides nothing.
    const theirs = hasStatus(rows, 'failed') ? { toQueue: [], toSkip: [] } : text(handlerPlan(stub, graph, loops, rows, settled));
    expect(ours, JSON.stringify(rows)).toEqual(theirs);
    compared++;
  }
  for (const rows of states) {
    if (hasStatus(rows, 'failed')) continue;
    expect(await policy.isFinished(graph, memoryReader(rows)), JSON.stringify(rows)).toBe(referenceFinished(stub, loops, reachable, rows));
  }
  expect(compared).toBeGreaterThan(0);
  return compared;
}

describe.each(Object.entries(SETTLEMENT_SHAPES))('the policy in the reference loop on %s', (_name, graph) => {
  it('answers planSuccessors at every reached (S, s), in order, and the count test on every failure-free S', async () => {
    expect(await inReferenceLoop(graph)).toBeGreaterThan(0);
  });
});

// ---- configless v1 nodes: opaque steps (`tasks/v2-seam-plan.md`, "F7 at step 10") ----

/** `graph` with the config of every `v1-node` removed, as `@n8n/engine`'s own tests write them. */
const configless = (graph: V2Graph): V2Graph => ({
  nodes: graph.nodes.map((n) => (n.type === 'v1-node' ? { id: n.id, name: n.name, type: n.type } : n)),
  edges: graph.edges,
});

describe('a v1 node with no config is an opaque step', () => {
  it('the golden\'s graphs, all converter-produced, carry config on every v1 node: none is opaque', () => {
    for (const entry of golden.entries) {
      const v1Nodes = entry.graph.nodes.filter((n) => n.type === 'v1-node');
      expect(v1Nodes.filter((n) => n.config === undefined), entry.id).toEqual([]);
    }
  });

  it('gives, on every golden state, the same answers with every v1 node\'s config removed', async () => {
    const policy = createSettlementPolicy();
    let compared = 0;
    for (const { entry, i, rows } of goldenStates) {
      expect(await answers(policy, configless(entry.graph), rows), `${entry.id} state ${i}`)
        .toEqual(await answers(policy, entry.graph, rows));
      compared++;
    }
    expect(compared).toBe(goldenStates.length);
  });

  it.each(Object.entries(SETTLEMENT_SHAPES))('%s, configless: answers planSuccessors in the reference loop', async (_name, graph) => {
    expect(await inReferenceLoop(configless(graph))).toBeGreaterThan(0);
  });
});

// ---- the properties of step 6 ----

describe('cold equals warm', () => {
  it('gives every answer alike from a fresh cache and from one that has every graph', async () => {
    const cache = createCompileCache();
    const warm = createSettlementPolicy({ cache });
    for (const { entry, rows } of goldenStates.filter((_, n) => n % 3 === 0)) {
      const cold = await answers(createSettlementPolicy(), entry.graph, rows);
      expect(await answers(warm, entry.graph, rows)).toEqual(cold);
      expect(await answers(warm, entry.graph, rows)).toEqual(cold);
    }
    const stats = cache.stats();
    expect(stats.misses).toBe(golden.entries.length);
    expect(stats.hits).toBeGreaterThan(stats.misses);
  });

  it('gives the same answers to a graph object it has not seen, equal as JSON', async () => {
    const policy = createSettlementPolicy();
    const rows = [done('T'), done('B', 0, [false, true]), done('Body', 0)];
    const first = text(await policy.decideSuccessors(loop, done('Body', 0), memoryReader(rows)));
    const copy: V2Graph = JSON.parse(JSON.stringify(loop));
    expect(text(await policy.decideSuccessors(copy, done('Body', 0), memoryReader(rows)))).toEqual(first);
    expect(first).toEqual({ toQueue: ['B@1'], toSkip: [] });
  });
});

describe('20 reader permutations give one answer', () => {
  it('whatever order the store returns its records in', async () => {
    const policy = createSettlementPolicy();
    const sample = goldenStates.filter((s) => s.rows.length > 3).filter((_, n) => n % 9 === 0);
    expect(sample.length).toBeGreaterThan(20);
    for (const { entry, i, rows } of sample) {
      const base = await answers(policy, entry.graph, rows);
      // The row set itself in reverse as well: the snapshot's input order is not the store's either.
      for (let order = 0; order < 20; order++) {
        expect(await answers(policy, entry.graph, rows, order, order % 2 === 0 ? rows : [...rows].reverse()), `${entry.id} state ${i}, permutation ${order}`).toEqual(base);
      }
    }
  });
});

describe('interleaved executions', () => {
  it('answer each execution from its own rows, whatever the calls interleave with', async () => {
    const policy = createSettlementPolicy({ reuseSnapshot: false });
    const sample = goldenStates.filter((_, n) => n % 5 === 0);
    // Alone first, one call at a time.
    const alone = [];
    for (const { entry, rows } of sample) alone.push(await answers(policy, entry.graph, rows));
    // Then every call at once, each reader yielding a pseudo-random number of ticks per read.
    let seed = 7;
    const delay = () => (seed = (seed * 48271) % 2147483647) % 4;
    const together = await Promise.all(sample.map(async ({ entry, i, rows }) => {
      const executionId = `execution-${entry.id}-${i}`;
      const decided = await Promise.all(deciders(rows).map(async (s) =>
        text(await policy.decideSuccessors(entry.graph, s, memoryReader(rows, { executionId, delay })))));
      const finished = await policy.isFinished(entry.graph, memoryReader(rows, { executionId, delay }));
      return { decided, finished };
    }));
    expect(together).toEqual(alone);
  });
});

describe('the named races of decision 8', () => {
  const graph = chain; // T -> A -> B

  it('decides nothing and is not finished once a row has failed', async () => {
    const diagnostics: SettlementDiagnostic[] = [];
    const policy = createSettlementPolicy({ onDiagnostic: (d) => diagnostics.push(d) });
    // T completed, A failed: the smallest case of the amended decision 7.
    const failed = [done('T'), row('A', 0, 'failed')];
    expect(text(await policy.decideSuccessors(graph, done('T'), memoryReader(failed)))).toEqual({ toQueue: [], toSkip: [] });
    expect(await policy.isFinished(graph, memoryReader(failed))).toBe(false);
    // The failed step was the last one owed: n8n's count says finished; the failure's settlement ends it.
    const last = [done('T'), done('A'), row('B', 0, 'failed')];
    expect(await policy.isFinished(graph, memoryReader(last))).toBe(false);
    expect(text(await policy.decideSuccessors(graph, done('A'), memoryReader(last)))).toEqual({ toQueue: [], toSkip: [] });
    expect(diagnostics.filter((d) => d.kind === 'race').map((d) => d.kind === 'race' && d.race)).toEqual(['failure', 'failure', 'failure', 'failure']);
  });

  it('decides nothing and is not finished on a cancelled row without a failed one, where the decoder refuses', async () => {
    const diagnostics: SettlementDiagnostic[] = [];
    const policy = createSettlementPolicy({ onDiagnostic: (d) => diagnostics.push(d) });
    // A cancel on request: A was queued, the cancel cancelled it. n8n would still plan here.
    const cancelled = [done('T'), row('A', 0, 'cancelled')];
    expect(text(await policy.decideSuccessors(graph, done('T'), memoryReader(cancelled)))).toEqual({ toQueue: [], toSkip: [] });
    expect(await policy.isFinished(graph, memoryReader(cancelled))).toBe(false);
    const looped = [done('T'), done('B', 0, [false, true]), row('Body', 0, 'cancelled')];
    expect(text(await policy.decideSuccessors(loop, done('B', 0, [false, true]), memoryReader(looped)))).toEqual({ toQueue: [], toSkip: [] });
    expect(await policy.isFinished(loop, memoryReader(looped))).toBe(false);
    expect(diagnostics.filter((d) => d.kind === 'race').map((d) => d.kind === 'race' && d.race)).toEqual(['cancel', 'cancel', 'cancel', 'cancel']);
    expect(diagnostics.some((d) => d.kind === 'error')).toBe(false);
  });

  it('has a divergence row for each named race it decides (no silent skips)', async () => {
    // Review finding: both races change what n8n would do (rows planned then cancelled; the
    // `ended` response's `lastStep`), and neither had a row in `docs/divergences.md`.
    const diagnostics: SettlementDiagnostic[] = [];
    const policy = createSettlementPolicy({ onDiagnostic: (d) => diagnostics.push(d) });
    await policy.isFinished(graph, memoryReader([done('T'), row('A', 0, 'failed')]));
    await policy.isFinished(graph, memoryReader([done('T'), row('A', 0, 'cancelled')]));
    const races = [...new Set(diagnostics.flatMap((d) => (d.kind === 'race' ? [d.race] : [])))].sort();
    expect(races).toEqual(['cancel', 'failure']);
    const register = readFileSync(resolve(here, '../../../docs/divergences.md'), 'utf8');
    const rows = register.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    for (const race of races) {
      const named = rows.filter((l) => l.includes('`settlement policy race`') && l.includes(`\`race: '${race}'\``));
      expect(named, `a divergence row for the ${race} race`).toHaveLength(1);
      expect(named[0]).toMatch(/\| (designed|proposed) \|$/);
    }
  });

  it('is n8n\'s ∅ on every golden state with a failed row', async () => {
    const policy = createSettlementPolicy();
    let seen = 0;
    for (const { entry, rows } of goldenStates) {
      if (!hasStatus(rows, 'failed')) continue;
      const { decided, finished } = await answers(policy, entry.graph, rows);
      for (const d of decided) expect(d).toEqual({ toQueue: [], toSkip: [] });
      expect(finished).toBe(false);
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('the reader call budget', () => {
  it('is at most 2 calls per policy call, never countSettledSteps, on every golden state', async () => {
    const policy = createSettlementPolicy({ reuseSnapshot: false });
    let most = 0;
    let twoReads = 0;
    for (const { entry, rows } of goldenStates) {
      const hasLoop = entry.graph.edges.some((e) => e.isBackEdge === true);
      const readers = [];
      for (const s of deciders(rows)) {
        const reader = memoryReader(rows);
        await policy.decideSuccessors(entry.graph, s, reader);
        readers.push(reader);
      }
      const reader = memoryReader(rows);
      await policy.isFinished(entry.graph, reader);
      readers.push(reader);
      for (const r of readers) {
        expect(r.total()).toBeLessThanOrEqual(2);
        expect(r.calls.countSettledSteps).toBe(0);
        // The latest-row read asks for batch nodes only, so a graph without a loop skips it.
        expect(r.calls.loadLatestStepSummaries).toBe(hasLoop ? 1 : 0);
        expect(r.calls.loadStepSummariesByKeys).toBe(1);
        most = Math.max(most, r.total());
        if (r.total() === 2) twoReads++;
      }
    }
    expect(most).toBe(2);
    expect(twoReads).toBeGreaterThan(0);
  });

  it('reads once on a graph without a loop, and twice on one with a loop, whatever the pass', async () => {
    const policy = createSettlementPolicy({ reuseSnapshot: false });
    const flat = memoryReader([done('T'), done('A')]);
    await policy.decideSuccessors(chain, done('A'), flat);
    expect(flat.calls).toEqual({ loadLatestStepSummaries: 0, loadStepSummariesByKeys: 1, countSettledSteps: 0 });
    const firstPass = memoryReader([done('T'), done('B', 0, [false, true])]);
    await policy.isFinished(loop, firstPass);
    expect(firstPass.calls).toEqual({ loadLatestStepSummaries: 1, loadStepSummariesByKeys: 1, countSettledSteps: 0 });
    const secondPass = memoryReader([done('T'), done('B', 0, [false, true]), done('Body', 0), done('B', 1, [false, true])]);
    await policy.isFinished(loop, secondPass);
    expect(secondPass.calls).toEqual({ loadLatestStepSummaries: 1, loadStepSummariesByKeys: 1, countSettledSteps: 0 });
  });
});

// ---- diagnostics, errors and registration ----

describe('diagnostics and errors', () => {
  it('reports entered on every call, before the first read', async () => {
    const seen: string[] = [];
    const reader = memoryReader([done('T')], { executionId: 'x-1' });
    const policy = createSettlementPolicy({
      onDiagnostic: (d) => {
        if (d.kind !== 'snapshot') seen.push(`${d.message}${d.kind === 'entered' ? ` ${d.method} ${d.executionId} reads ${reader.total()}` : ''}`);
      },
    });
    await policy.decideSuccessors(chain, done('T'), reader);
    await policy.isFinished(chain, reader);
    expect(seen).toEqual(['settlement policy entered decideSuccessors x-1 reads 0', 'settlement policy entered isFinished x-1 reads 1']);
  });

  it('throws a CodecError with an error diagnostic, and does not fall back', async () => {
    const seen: SettlementDiagnostic[] = [];
    const policy = createSettlementPolicy({ onDiagnostic: (d) => seen.push(d) });
    // Two rows of a node outside every loop: rows the net cannot have produced. The scoped read asks
    // for A@0 and for the settled row A@1, and the decoder refuses the second row outside a loop; the
    // full snapshot reads both rows and refuses the same.
    const bad = [done('T'), done('A', 0), done('A', 1)];
    await expect(policy.decideSuccessors(chain, done('A', 1), memoryReader(bad))).rejects.toThrow(/outside every loop/);
    await expect(createSettlementPolicy({ snapshot: 'full' }).decideSuccessors(chain, done('A', 1), memoryReader(bad))).rejects.toThrow(/outside every loop/);
    await expect(policy.isFinished(chain, memoryReader([done('T'), row('A', 0, 'paused')]))).rejects.toThrow(/not an engine v2 step status/);
    expect(seen.filter((d) => d.kind === 'error').map((d) => d.kind === 'error' && d.name)).toEqual(['CodecError', 'CodecError']);
  });

  it('refuses a graph that does not compile on every call, compiling it once', async () => {
    let compiles = 0;
    const cache = createCompileCache({ compileGraph: () => { compiles++; throw new Error('no'); } });
    const policy = createSettlementPolicy({ cache });
    const twoTriggers: V2Graph = { nodes: [trigger('T'), trigger('U'), v1('A')], edges: [edge('T', 'A'), edge('U', 'A')] };
    for (let i = 0; i < 3; i++) {
      await expect(policy.isFinished(twoTriggers, memoryReader([done('T')]))).rejects.toBeInstanceOf(SettlementCompileRefusal);
    }
    expect(compiles).toBe(1);
    // With the real compiler: stage 1 refuses two triggers.
    await expect(createSettlementPolicy().isFinished(twoTriggers, memoryReader([done('T')]))).rejects.toThrow(/2 trigger nodes/);
  });

  it('refuses a store answer that is not the question asked', async () => {
    const policy = createSettlementPolicy();
    const reader = memoryReader([done('T'), done('B', 0, [false, true]), done('Body'), done('B', 1, [false, true])]);
    const lying = { ...reader, loadLatestStepSummaries: async () => ({ B: { id: '1', nodeId: 'Body', iteration: 0, status: 'completed', filledOutputSlots: [true] } }) };
    await expect(policy.isFinished(loop, lying)).rejects.toThrow(/under node 'B'/);
    const extra = { ...reader, loadStepSummariesByKeys: async () => ({ 'After@1': { id: '9', nodeId: 'After', iteration: 1, status: 'completed', filledOutputSlots: [true] } }) };
    await expect(policy.isFinished(loop, extra)).rejects.toThrow(/not asked for/);
  });

  it('ignores a diagnostic listener that throws', async () => {
    const policy = createSettlementPolicy({ onDiagnostic: () => { throw new Error('listener'); } });
    expect(await policy.isFinished(chain, memoryReader([done('T'), done('A'), done('B')]))).toBe(true);
  });
});

describe('registerSettlementPolicy', () => {
  const registry = (): V2SettlementRegistry & { sets: number } => {
    const theirs: V2SettlementPolicy = {
      decideSuccessors: async () => ({ toQueue: [], toSkip: [] }),
      isFinished: async () => true,
    };
    let current = theirs;
    const r = {
      sets: 0,
      defaultSettlementPolicy: theirs,
      setSettlementPolicy(p: V2SettlementPolicy) { r.sets++; current = p; },
      getSettlementPolicy: () => current,
      resetSettlementPolicy() { current = theirs; },
    };
    return r;
  };

  it('sets the net-backed policy and reports registered once it reads back', async () => {
    const engine = registry();
    const seen: SettlementDiagnostic[] = [];
    const policy = registerSettlementPolicy(engine, { onDiagnostic: (d) => seen.push(d) });
    expect(engine.getSettlementPolicy()).toBe(policy);
    expect(seen).toEqual([{ kind: 'registered', message: 'settlement policy registered', mode: 'primary' }]);
    // The registered policy is ours: it plans A after T, where the stand-in default plans nothing.
    expect(text(await engine.getSettlementPolicy().decideSuccessors(chain, done('T'), memoryReader([done('T')])))).toEqual({ toQueue: ['A@0'], toSkip: [] });
    expect(seen.map((d) => d.message)).toEqual(['settlement policy registered', 'settlement policy entered', 'settlement policy snapshot']);
  });

  it('wires both shadow directions, the answering side first', async () => {
    for (const [mode, answer] of [['shadow', []], ['primary-shadowed', ['A@0']]] as const) {
      const engine = registry();
      const reports: string[] = [];
      registerSettlementPolicy(engine, { mode, onShadowReport: (r) => reports.push(r.verdict) });
      const d = await engine.getSettlementPolicy().decideSuccessors(chain, done('T'), memoryReader([done('T')]));
      expect(text(d).toQueue, mode).toEqual(answer);
      expect(reports, mode).toEqual(['disagree']);
    }
  });

  it('refuses a shadow mode without a report listener, an unknown mode, and a registry that does not read back', () => {
    expect(() => registerSettlementPolicy(registry(), { mode: 'shadow' })).toThrow(/onShadowReport/);
    expect(() => registerSettlementPolicy(registry(), { mode: 'off' as never })).toThrow(/not one of/);
    const deaf = { ...registry(), setSettlementPolicy: () => {} };
    expect(() => registerSettlementPolicy(deaf)).toThrow(/does not return the policy/);
  });
});

