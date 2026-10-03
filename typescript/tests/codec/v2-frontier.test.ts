/**
 * The local frontier decode (`src/codec/v2/frontier.ts`, `tasks/v2-seam-plan.md` step 14): on every
 * row set engine v2 produces, `decodeFrontier` gives `decodeStepRows`' marking and row counts, from S
 * itself and from S's frontier alone, and the facts the policy reads besides the marking (a failed,
 * cancelled or unsettled row; which keys exist; the settled row) read the same on the frontier.
 *
 * - **Golden**: every recorded state and every settlement's S and S′
 *   (`tests/fixtures/v2/settlement-golden.json`, row sets n8n's own loop reached).
 * - **Deep loops**: random walks of the net's own planner on the accepted loop shapes with up to 14
 *   passes, failures, suspends and cancels after a failure. Golden loops end by pass 2, where the
 *   frontier is every row; these reach the compression.
 * - **10,000 passes**: a Loop Over Items at batch size 1 with a 4-node body. The policy's scoped read
 *   (step 12's rerun) asks at most 4 keys per loop member, 5 for the batch node, 1 per other node
 *   and the settled row, in at most 2 reads, where the full snapshot asks 50,000.
 *
 * Settlement evidence, not conformance numbers (decision 12).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeFrontier, frontierKeys, frontierOf, latestIterations } from '../../src/codec/v2/frontier.js';
import { planFromMarking } from '../../src/codec/v2/plan.js';
import { decodeStepRows, V2_SETTLED_STEP_STATUSES } from '../../src/codec/v2/step-rows.js';
import type { StepKey, StepMarking, StepRow } from '../../src/codec/v2/step-rows.js';
import type { CompiledWorkflow } from '../../src/compiler/index.js';
import { asGolden, decodeRows, settlementRows } from '../../src/conformance/v2/golden.js';
import { rng } from '../../src/conformance/v2/reference.js';
import type { V2Graph } from '../../src/n8n/v2-graph.js';
import type { V2SettlementReader, V2StepKey } from '../../src/n8n/v2-host.js';
import { compileGraph } from '../../src/settlement/compile-cache.js';
import { createSettlementPolicy } from '../../src/settlement/policy.js';
import { namedRace } from '../../src/settlement/rows.js';
import { candidateKeys } from '../../src/settlement/scope.js';
import { backEdge, batch, diamondBody, edge, exitIntoMerge, loop, noExit, selfLoop, trigger, twoLoops, v1 } from '../fixtures/v2-graphs.js';
import { memoryReader } from '../support/settlement-reader.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = asGolden(JSON.parse(readFileSync(resolve(here, '../fixtures/v2/settlement-golden.json'), 'utf8')));
const SETTLED: ReadonlySet<string> = new Set(V2_SETTLED_STEP_STATUSES);

/** A decoded marking as text: place counts and row counts, sorted. */
function text(d: StepMarking): string {
  const places = [...d.marking].filter(([, t]) => t.length > 0).map(([p, t]) => `${p.name}=${t.length}`).sort();
  const counts = [...d.rowCounts].map(([id, n]) => `${id}:${n}`).sort();
  return `${places.join(' ')} | ${counts.join(' ')}`;
}

/** `decode`'s answer as text, or its error class and message. */
function attempt(decode: () => StepMarking): string {
  try {
    return text(decode());
  } catch (e) {
    return `THROW ${(e as Error).name}`;
  }
}

const keyText = (keys: readonly StepKey[]) => keys.map((k) => `${k.nodeId}@${k.iteration}`).join(' ');

/** Every equality the policy relies on, at one row set; returns how many settled rows were checked. */
function checkLocalEqualsGlobal(compiled: CompiledWorkflow, graph: V2Graph, rows: readonly StepRow[], where: string): number {
  const global = attempt(() => decodeStepRows(compiled, rows));
  const frontier = frontierOf(compiled, rows);
  expect(attempt(() => decodeFrontier(compiled, rows)), `${where}: decodeFrontier(S)`).toBe(global);
  expect(attempt(() => decodeFrontier(compiled, frontier)), `${where}: decodeFrontier(frontier(S))`).toBe(global);
  expect(namedRace(frontier), `${where}: named race`).toBe(namedRace(rows));
  expect(frontier.every((r) => SETTLED.has(r.status)), `${where}: every row settled`).toBe(rows.every((r) => SETTLED.has(r.status)));
  if (!global.startsWith('THROW')) {
    const plan = planFromMarking(compiled, decodeStepRows(compiled, rows));
    expect(planFromMarking(compiled, decodeFrontier(compiled, frontier)), `${where}: R(S)`).toEqual(plan);
  }
  let checked = 0;
  for (const s of rows) {
    if (s.status !== 'completed' && s.status !== 'skipped') continue;
    const read = frontier.some((r) => r.nodeId === s.nodeId && r.iteration === s.iteration) ? frontier : [...frontier, s];
    expect(keyText(candidateKeys(graph, s, read)), `${where}: candidates of ${s.nodeId}@${s.iteration}`).toBe(keyText(candidateKeys(graph, s, rows)));
    checked++;
  }
  return checked;
}

describe('the frontier on the golden (row sets n8n\'s loop reached)', () => {
  it('decodes every recorded state and every settlement\'s S and S′ as the global decoder does', () => {
    let states = 0;
    let settled = 0;
    for (const entry of golden.entries) {
      const compiled = compileGraph(entry.graph);
      for (const [i, state] of entry.states.entries()) {
        settled += checkLocalEqualsGlobal(compiled, entry.graph, decodeRows(entry.graph, state.rows), `${entry.id} state ${i}`);
        states++;
      }
      for (const [i, s] of entry.settlements.entries()) {
        const { before, after } = settlementRows(entry.graph, s);
        settled += checkLocalEqualsGlobal(compiled, entry.graph, before, `${entry.id} settlement ${i} S`);
        settled += checkLocalEqualsGlobal(compiled, entry.graph, after, `${entry.id} settlement ${i} S′`);
        states += 2;
      }
    }
    expect(states).toBeGreaterThan(1500);
    expect(settled).toBeGreaterThan(5000);
  });
});

// ---- deep loops: random walks of the net's own planner ----

/** A loop with a 4-node chain body beside a branch outside the loop: the frontier's two kinds of node. */
const besideBranch: V2Graph = {
  nodes: [trigger('T'), batch('B'), v1('A1'), v1('A2', 'n8n-nodes-base.if'), v1('A3'), v1('A4'), v1('X'), v1('Y'), v1('After')],
  edges: [
    edge('T', 'B'), edge('T', 'X'), edge('X', 'Y'), edge('B', 'A1', 1), edge('A1', 'A2'), edge('A2', 'A3', 0),
    edge('A2', 'A4', 1), edge('A3', 'A4', 0, 1), backEdge('A4', 'B'), edge('B', 'After', 0),
  ],
};

const DEEP: Readonly<Record<string, V2Graph>> = { loop, diamondBody, selfLoop, twoLoops, exitIntoMerge, noExit, besideBranch };

const arityOf = (graph: V2Graph, id: string): number =>
  Math.max(1, ...graph.edges.filter((e) => e.from === id).map((e) => e.outputIndex + 1));

/**
 * Row sets one random run of the net's planner passes through: the planner (global decoder) queues
 * and skips a random part of R(S), in-flight steps run, suspend, resume, fail or complete with random
 * slots, a batch node loops for its drawn number of passes, and a failure cancels what is queued or
 * waiting. The row sets are the net's; n8n's own reached sets are the golden's and the differential's.
 */
function walk(graph: V2Graph, compiled: CompiledWorkflow, seed: number, maxPasses: number): StepRow[][] {
  const next = rng(seed);
  const passes = new Map(graph.nodes.filter((n) => n.type === 'batch').map((n) => [n.id, 1 + Math.floor(next() * maxPasses)]));
  const triggerId = graph.nodes.find((n) => n.type === 'trigger')!.id;
  type Mutable = { nodeId: string; iteration: number; status: string; filledOutputSlots: boolean[] };
  const rows: Mutable[] = [{ nodeId: triggerId, iteration: 0, status: 'completed', filledOutputSlots: Array.from({ length: arityOf(graph, triggerId) }, () => true) }];
  const states: StepRow[][] = [];
  const pFail = next() < 0.3 ? 0.03 : 0;
  for (let step = 0; step < 2000; step++) {
    states.push(rows.map((r) => ({ ...r, filledOutputSlots: [...r.filledOutputSlots] })));
    const failed = rows.some((r) => r.status === 'failed');
    if (failed && rows.some((r) => r.status === 'queued' || r.status === 'waiting') && next() < 0.5) {
      for (const r of rows) if (r.status === 'queued' || r.status === 'waiting') r.status = 'cancelled';
      continue;
    }
    const inFlight = rows.filter((r) => r.status === 'queued' || r.status === 'running' || r.status === 'waiting');
    const plan = failed ? { toQueue: [], toSkip: [] } : planFromMarking(compiled, decodeStepRows(compiled, rows));
    const decidable = [...plan.toQueue.map((k) => ({ k, status: 'queued' })), ...plan.toSkip.map((k) => ({ k, status: 'skipped' }))];
    if (inFlight.length === 0 && decidable.length === 0) break;
    if (decidable.length > 0 && (inFlight.length === 0 || next() < 0.4)) {
      for (const d of decidable) if (next() < 0.6 || d === decidable[0]) rows.push({ ...d.k, status: d.status, filledOutputSlots: [] });
      continue;
    }
    const r = inFlight[Math.floor(next() * inFlight.length)]!;
    const isBatch = passes.has(r.nodeId);
    if (r.status === 'queued') { r.status = 'running'; continue; }
    if (r.status === 'running' && !isBatch && r.nodeId !== triggerId && next() < 0.1) { r.status = 'waiting'; continue; }
    if (r.status === 'waiting') { r.status = 'queued'; continue; }
    if (!isBatch && next() < pFail) { r.status = 'failed'; continue; }
    r.status = 'completed';
    if (isBatch) {
      const last = r.iteration >= passes.get(r.nodeId)! - 1;
      r.filledOutputSlots = last ? [next() < 0.75, false] : [false, true];
    } else {
      r.filledOutputSlots = Array.from({ length: arityOf(graph, r.nodeId) }, () => next() < 0.7);
    }
  }
  return states;
}

describe('the frontier on deep loops', () => {
  it('decodes every row set of 40 runs per loop shape, up to 14 passes, as the global decoder does', () => {
    let states = 0;
    let compressed = 0;
    let deepest = 0;
    for (const [name, graph] of Object.entries(DEEP)) {
      const compiled = compileGraph(graph);
      for (let seed = 0; seed < 40; seed++) {
        const seen = new Set<string>();
        for (const rows of walk(graph, compiled, seed * 7919 + name.length, 14)) {
          const key = rows.map((r) => `${r.nodeId}@${r.iteration}=${r.status}${r.filledOutputSlots.map(Number).join('')}`).join(' ');
          if (seen.has(key)) continue;
          seen.add(key);
          checkLocalEqualsGlobal(compiled, graph, rows, `${name} seed ${seed}`);
          states++;
          const most = Math.max(...rows.map((r) => r.iteration));
          deepest = Math.max(deepest, most);
          if (frontierOf(compiled, rows).length < rows.length) compressed++;
        }
      }
    }
    expect(states).toBeGreaterThan(5000);
    expect(compressed).toBeGreaterThan(1000);
    expect(deepest).toBeGreaterThanOrEqual(12);
  });

  it('refuses, as the global decoder does, a pass missing below the frontier\'s kept passes', () => {
    const compiled = compileGraph(loop);
    const full = [
      { nodeId: 'T', iteration: 0, status: 'completed', filledOutputSlots: [true] },
      ...[0, 1, 2, 3].flatMap((p) => [
        { nodeId: 'B', iteration: p, status: 'completed', filledOutputSlots: [false, true] },
        { nodeId: 'Body', iteration: p, status: 'completed', filledOutputSlots: [true] },
      ]),
      { nodeId: 'B', iteration: 4, status: 'running', filledOutputSlots: [] },
    ];
    expect(attempt(() => decodeFrontier(compiled, full))).toBe(text(decodeStepRows(compiled, full)));
    // Body@3, the pass before B's latest, is in the frontier: without it neither decoder accepts.
    const gap = full.filter((r) => !(r.nodeId === 'Body' && r.iteration === 3));
    expect(attempt(() => decodeStepRows(compiled, gap))).toBe('THROW CodecError');
    expect(() => decodeFrontier(compiled, gap)).toThrow(/frontier decode: loop passes 0, 3, 4 as 0, 1, 2/);
  });

  it('names at most 2 keys per loop node beyond the latest rows, and none outside a loop', () => {
    const compiled = compileGraph(besideBranch);
    const latest = new Map([['T', 0], ['X', 0], ['Y', 0], ['B', 500], ['A1', 499], ['A2', 499], ['A3', 499], ['A4', 499]]);
    expect(keyText(frontierKeys(compiled, latest))).toBe('B@0 B@499 A1@0 A2@0 A3@0 A4@0');
    expect(keyText(frontierKeys(compiled, new Map([['T', 0], ['B', 0]])))).toBe('');
    expect(keyText(frontierKeys(compiled, new Map([['T', 0], ['B', 2], ['A1', 2]])))).toBe('B@0 B@1 A1@0 A1@1');
    expect(latestIterations([{ nodeId: 'B', iteration: 3 }, { nodeId: 'B', iteration: 1 }])).toEqual(new Map([['B', 3]]));
  });
});

// ---- 10,000 passes ----

/** Loop Over Items at batch size 1, a 4-node body: T → B, B loop → A1 → A2 → A3 → A4 → B, B done → After. */
const longLoop: V2Graph = {
  nodes: [trigger('T'), batch('B'), v1('A1'), v1('A2'), v1('A3'), v1('A4'), v1('After')],
  edges: [edge('T', 'B'), edge('B', 'A1', 1), edge('A1', 'A2'), edge('A2', 'A3'), edge('A3', 'A4'), backEdge('A4', 'B'), edge('B', 'After', 0)],
};

const PASSES = 10_000;
const done = (nodeId: string, iteration: number, filled: boolean[] = [true]): StepRow => ({ nodeId, iteration, status: 'completed', filledOutputSlots: filled });

/** Every pass 0 .. PASSES − 1 run, B looping: 50,001 rows. */
function passes(): StepRow[] {
  const rows: StepRow[] = [done('T', 0)];
  for (let p = 0; p < PASSES; p++) rows.push(done('B', p, [false, true]), done('A1', p), done('A2', p), done('A3', p), done('A4', p));
  return rows;
}

/** A reader that also records the keys each keyed read asked for. */
function keyCounting(rows: readonly StepRow[]): { reader: V2SettlementReader; keys: number[]; total: () => number } {
  const inner = memoryReader(rows);
  const keys: number[] = [];
  return {
    keys,
    total: () => inner.total(),
    reader: {
      executionId: inner.executionId,
      loadLatestStepSummaries: (ids) => inner.loadLatestStepSummaries(ids),
      loadStepSummariesByKeys: (asked: V2StepKey[]) => { keys.push(asked.length); return inner.loadStepSummariesByKeys(asked); },
      countSettledSteps: () => inner.countSettledSteps(),
    },
  };
}

const plan = (d: { readonly toQueue: readonly V2StepKey[]; readonly toSkip: readonly V2StepKey[] }) =>
  `queue [${keyText(d.toQueue)}] skip [${keyText(d.toSkip)}]`;

describe(`the frontier on a ${PASSES.toLocaleString('en')}-pass loop`, () => {
  // T and After outside the loop, the batch node B, the four members, and the settled row.
  const bound = 2 + 5 + 4 * 4 + 1;
  // Both calls measured: isFinished does not take decideSuccessors' snapshot here.
  const frontier = createSettlementPolicy({ reuseSnapshot: false });
  const full = createSettlementPolicy({ snapshot: 'full' });

  it(`asks at most ${bound} keys in at most 2 reads per call, and answers as the full snapshot does`, async () => {
    const history = passes();
    const cases: { name: string; rows: StepRow[]; settled: StepRow; decided: string; finished: boolean }[] = [
      // A4's last pass settles: the return queues B's next pass.
      { name: 'A4 returns', rows: history, settled: done('A4', PASSES - 1), decided: `queue [B@${PASSES}] skip []`, finished: false },
      // B's terminal pass settles on its done slot: After is queued.
      {
        name: 'B ends', rows: [...history, done('B', PASSES, [true, false])], settled: done('B', PASSES, [true, false]),
        decided: 'queue [After@0] skip []', finished: false,
      },
      // A2 is running in the last pass: A1's settlement decides nothing new, the run is not finished.
      {
        name: 'mid-pass', rows: [...history.filter((r) => !(r.iteration === PASSES - 1 && ['A2', 'A3', 'A4'].includes(r.nodeId))),
          { nodeId: 'A2', iteration: PASSES - 1, status: 'running', filledOutputSlots: [] }],
        settled: done('A1', PASSES - 1), decided: 'queue [] skip []', finished: false,
      },
      // An old pass's settlement arrives late (a redelivered event): it reads that row by key.
      { name: 'late settlement', rows: history, settled: done('A2', 17), decided: 'queue [] skip []', finished: false },
      // Everything ran: finished.
      {
        name: 'finished', rows: [...history, done('B', PASSES, [true, false]), done('After', 0)], settled: done('After', 0),
        decided: 'queue [] skip []', finished: true,
      },
    ];
    for (const c of cases) {
      const decide = keyCounting(c.rows);
      expect(plan(await frontier.decideSuccessors(longLoop, c.settled, decide.reader)), c.name).toBe(c.decided);
      const finish = keyCounting(c.rows);
      expect(await frontier.isFinished(longLoop, finish.reader), c.name).toBe(c.finished);
      for (const counted of [decide, finish]) {
        expect(counted.total(), c.name).toBeLessThanOrEqual(2);
        expect(Math.max(0, ...counted.keys), c.name).toBeLessThanOrEqual(bound);
      }
      // The full snapshot (the global decoder) gives the same answers from every row.
      const fullDecide = keyCounting(c.rows);
      expect(plan(await full.decideSuccessors(longLoop, c.settled, fullDecide.reader)), `${c.name} (full)`).toBe(c.decided);
      expect(await full.isFinished(longLoop, memoryReader(c.rows)), `${c.name} (full)`).toBe(c.finished);
      expect(Math.max(...fullDecide.keys), `${c.name} (full)`).toBeGreaterThan(4 * PASSES);
    }
  }, 60_000);

  it('keeps the frontier\'s keys flat from 10 to 10,000 passes, and decodes the same marking at each', () => {
    const compiled = compileGraph(longLoop);
    const history = passes();
    const sizes: number[] = [];
    for (const n of [10, 100, 1000, PASSES]) {
      const rows = history.filter((r) => r.iteration < n);
      const latest = latestIterations(rows);
      sizes.push(frontierKeys(compiled, latest).length);
      expect(text(decodeFrontier(compiled, frontierOf(compiled, rows))), `${n} passes`).toBe(text(decodeStepRows(compiled, rows)));
    }
    // B and the four body nodes, each at pass 0 and at the pass before B's latest.
    expect(sizes).toEqual([10, 10, 10, 10]);
  }, 60_000);
});
