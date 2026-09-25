/**
 * The engine v2 settlement golden, replayed with no `.n8n` (`tasks/v2-profile-plan.md` step 11).
 *
 * `tests/fixtures/v2/settlement-golden.json` holds n8n's own answers, recorded from the pinned
 * checkout by `tasks/record-v2-golden.mts` (format: `src/conformance/v2/golden.ts`). This suite
 * checks the net against them, the differential's legs (a) and (b) on committed graphs:
 * - **(a)** at every recorded row set S, `planFromMarking(decodeStepRows(S))` is the recorded R(S)
 *   (`compareStateTo`, the same set comparison `tasks/v2-differential.mts` makes);
 * - **(b)** the compiled net, run under each recorded run's behaviour and delay seed, ends as n8n's
 *   run did: failure-free with the same fates, connected slots and settled count
 *   (= the recorded `countExpectedSettledSteps`); with a failure, halted and agreeing on every step
 *   both decided (`compareRuns`).
 *
 * A failure here is a finding about the net — the golden is n8n's, not ours — and is never fixed
 * by re-recording. Re-recording is for a new stamp (n8n, its dist, or libpetri), which the recorder
 * refuses to do silently. Results are settlement-level evidence, not conformance numbers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import type { CompiledWorkflow } from '../../src/compiler/index.js';
import { v2Actions } from '../../src/conformance/v2/binder.js';
import { compareRuns, compareStateTo } from '../../src/conformance/v2/differential.js';
import {
  asGolden, decodeRows, GOLDEN_FORMAT, runResultOf, selectStates, stampDifferences, stateKey,
} from '../../src/conformance/v2/golden.js';
import type { GoldenEntry, GoldenRow, GoldenStamp } from '../../src/conformance/v2/golden.js';
import { graphToDescription } from '../../src/conformance/v2/graph.js';
import { runV2 } from '../../src/conformance/v2/net-run.js';
import { ACCEPTED, SETTLEMENT_SHAPES } from '../fixtures/v2-graphs.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const golden = asGolden(JSON.parse(readFileSync(resolve(here, '../fixtures/v2/settlement-golden.json'), 'utf8')));
const entries: readonly (readonly [string, GoldenEntry])[] = golden.entries.map((e) => [e.id, e]);
const FIXTURES = { ...SETTLEMENT_SHAPES, ...ACCEPTED };

const compileV2 = (e: GoldenEntry): CompiledWorkflow => compile(graphToDescription(e.graph).description, { profile: 'engineV2' });
const text = (rows: readonly GoldenRow[]) => rows.map((r) => `${r[0]}@${r[1]}=${r[2]}[${r[3]}]`).join(' ');

describe('the settlement golden', () => {
  it('is stamped as decision 16 asks', () => {
    expect(golden.format).toBe(GOLDEN_FORMAT);
    expect(golden.stamp.n8n).toMatch(/^n8n@\d+\.\d+\.\d+$/);
    expect(Object.keys(golden.stamp.dist).sort()).toEqual([
      'engine/dist/execution/completion.js', 'engine/dist/execution/iteration-mapping.js', 'engine/dist/execution/loop-ledger.js',
      'engine/dist/execution/settlement.js', 'engine/dist/graph/loops.js', 'node-engine-compatibility/dist/v1-workflow-converter.js',
    ]);
    for (const h of Object.values(golden.stamp.dist)) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(golden.stamp.libpetri.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('covers every fixture graph as it is now, and only committed workflows', () => {
    const recorded = new Map(golden.entries.filter((e) => e.id.startsWith('fixture/')).map((e) => [e.id.slice('fixture/'.length), e]));
    expect([...recorded.keys()].sort()).toEqual(Object.keys(FIXTURES).sort());
    for (const [name, graph] of Object.entries(FIXTURES)) expect(recorded.get(name)!.graph, name).toEqual(graph);
    for (const e of golden.entries.filter((x) => !x.id.startsWith('fixture/'))) {
      expect(e.source).toMatch(/^scripts\/testbed\/workflows\/[^/]+\.json$/);
      expect(existsSync(resolve(repo, e.source)), e.source).toBe(true);
    }
  });

  it('holds every kind of row set the reference produces: running, failed, cancelled and an empty loop terminal', () => {
    const kinds = { running: 0, failed: 0, cancelled: 0, emptyTerminal: 0 };
    for (const e of golden.entries) {
      const batch = new Set(e.graph.nodes.flatMap((n, i) => (n.type === 'batch' ? [i] : [])));
      for (const s of e.states) {
        if (s.rows.some((r) => r[2] === 'running')) kinds.running++;
        if (s.rows.some((r) => r[2] === 'failed')) kinds.failed++;
        if (s.rows.some((r) => r[2] === 'cancelled')) kinds.cancelled++;
        if (s.rows.some((r) => batch.has(r[0]) && r[2] === 'completed' && !r[3].includes('1'))) kinds.emptyTerminal++;
      }
    }
    for (const [k, n] of Object.entries(kinds)) expect(n, k).toBeGreaterThan(0);
    expect(golden.entries.some((e) => e.runs.some((r) => r.end === 'failed'))).toBe(true);
  });

  it('keeps its counts: distinct states, as many as it says, with the drop logged', () => {
    for (const e of golden.entries) {
      expect(new Set(e.states.map((s) => stateKey(s.rows))).size, e.id).toBe(e.states.length);
      expect(e.stateCounts.kept, e.id).toBe(e.states.length);
      expect(e.stateCounts.kept + e.stateCounts.dropped, e.id).toBe(e.stateCounts.distinct);
      expect(e.states.length, e.id).toBeLessThanOrEqual(golden.parameters.maxStatesPerEntry);
      expect(e.runs.length, e.id).toBe(golden.parameters.behaviours * golden.parameters.runOrders);
    }
  });
});

// ---- (a) and (b), per entry ----

describe.each(entries)('%s', (_id, entry) => {
  const c = compileV2(entry);

  it('(a) the planner answers the recorded R(S) at every recorded row set', () => {
    const disagreements: string[] = [];
    for (const s of entry.states) {
      const v = compareStateTo(c, decodeRows(entry.graph, s.rows), s.plan);
      if (v.agree) continue;
      disagreements.push(v.error !== null
        ? `rows ${text(s.rows)}: decode threw ${v.error}`
        : `rows ${text(s.rows)}: planner ${JSON.stringify(v.net)}, R(S) ${JSON.stringify(s.plan)}`);
    }
    expect(disagreements).toEqual([]);
    expect(entry.states.length).toBeGreaterThan(0);
  });

  it('(b) the net reproduces every recorded run under its behaviour', async () => {
    for (const run of entry.runs) {
      const behaviour = entry.behaviours[run.behaviour]!;
      const net = await runV2(c, v2Actions(entry.graph, behaviour, run.netDelaySeed));
      const v = compareRuns(entry.graph, c, runResultOf(entry.graph, run), net, () => run.expected ?? undefined);
      expect(v.problems, `behaviour ${run.behaviour} order ${run.order}`).toEqual([]);
      expect(v.failed).toBe(run.end === 'failed');
    }
  });
});

// ---- the replay catches a disagreement ----

describe('the replay catches a disagreement', () => {
  const entry = golden.entries.find((e) => e.id === 'fixture/branchDiamond')!;
  const c = compileV2(entry);

  it('in a recorded R(S)', () => {
    const s = entry.states.find((x) => x.plan.toQueue.length > 0)!;
    const doctored = { toQueue: s.plan.toQueue.slice(1), toSkip: [...s.plan.toSkip, s.plan.toQueue[0]!].sort() };
    expect(compareStateTo(c, decodeRows(entry.graph, s.rows), s.plan)).toEqual({ agree: true });
    expect(compareStateTo(c, decodeRows(entry.graph, s.rows), doctored).agree).toBe(false);
  });

  it('in a recorded run: a fate, a slot and the settled count', async () => {
    const run = entry.runs.find((r) => r.end === 'completed' && r.rows.some((x) => x[2] === 'skipped'))!;
    const net = await runV2(c, v2Actions(entry.graph, entry.behaviours[run.behaviour]!, run.netDelaySeed));
    const expected = () => run.expected ?? undefined;
    expect(compareRuns(entry.graph, c, runResultOf(entry.graph, run), net, expected).agree).toBe(true);

    const i = run.rows.findIndex((x) => x[2] === 'skipped');
    const unskipped = { ...run, rows: run.rows.map((x, j): GoldenRow => (j === i ? [x[0], x[1], 'completed', '1'] : x)) };
    expect(compareRuns(entry.graph, c, runResultOf(entry.graph, unskipped), net, expected).problems.some((p) => p.startsWith('fates differ'))).toBe(true);

    // A completed step with a connected output: only connected slots are compared.
    const k = run.rows.findIndex((x) => x[2] === 'completed' && entry.graph.nodes[x[0]]!.type !== 'trigger'
      && entry.graph.edges.some((e) => e.from === entry.graph.nodes[x[0]]!.id));
    expect(k).toBeGreaterThanOrEqual(0);
    const flipped = { ...run, rows: run.rows.map((x, j): GoldenRow => (j === k ? [x[0], x[1], x[2], [...x[3]].map((b) => (b === '1' ? '0' : '1')).join('')] : x)) };
    expect(compareRuns(entry.graph, c, runResultOf(entry.graph, flipped), net, expected).problems.some((p) => p.includes('filled slots'))).toBe(true);

    const miscounted = compareRuns(entry.graph, c, runResultOf(entry.graph, run), net, () => (run.expected ?? 0) + 1);
    expect(miscounted.problems.some((p) => p.includes('countExpectedSettledSteps'))).toBe(true);
  });
});

// ---- the golden module ----

describe('golden.ts', () => {
  it('selectStates keeps every kind, spreads the kept states, and is the identity under the cap', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const kind = (i: number) => (i % 50 === 7 ? 'rare' : 'common');
    expect(selectStates(items, 200, kind)).toEqual(items);
    const kept = selectStates(items, 10, kind);
    expect(kept).toHaveLength(10);
    expect(kept.filter((i) => kind(i) === 'rare')).toEqual([7, 57]);
    expect(kept[kept.length - 1]).toBeGreaterThan(80);
    expect(selectStates(items, 10, kind)).toEqual(kept);
  });

  it('stampDifferences names each field that moved', () => {
    const a: GoldenStamp = { n8n: 'n8n@2.41.3', dist: { 'x.js': 'aa', 'y.js': 'bb' }, libpetri: { version: '7.0.0', linked: false } };
    expect(stampDifferences(a, a)).toEqual([]);
    expect(stampDifferences(a, { n8n: 'n8n@2.42.0', dist: { 'x.js': 'cc' }, libpetri: { version: '7.0.0', linked: true } })).toEqual([
      'n8n: n8n@2.41.3 → n8n@2.42.0', 'x.js: aa → cc', 'y.js: bb → (absent)', 'libpetri: 7.0.0 (registry) → 7.0.0 (linked)',
    ]);
  });

  it('refuses another format and a row it cannot read', () => {
    expect(() => asGolden({ ...golden, format: 2 })).toThrow(/format 1/);
    const g = golden.entries[0]!.graph;
    expect(() => decodeRows(g, [[99, 0, 'completed', '1']])).toThrow(/node index 99/);
    expect(() => decodeRows(g, [[0, 0, 'waiting' as never, '']])).toThrow(/unknown status 'waiting'/);
  });
});
