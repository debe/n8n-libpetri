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
 *   both decided (`compareRuns`);
 * - **(a″) and (a‴) through the seam** (`tasks/v2-seam-plan.md` step 7): at every recorded
 *   settlement (S, s), the net-backed `createSettlementPolicy`, asked through an in-memory reader
 *   as `StepSettledHandler` asks it, answers n8n's `decideSuccessors(s)` in keys, split and order,
 *   and on the rows the settlement leaves its `isFinished` is n8n's count test
 *   (`replaySettlement`). A failed S is F2's and F3's named race: counted, not compared, and there
 *   the policy must decide nothing and say not finished (decision 8, decision 7 as amended).
 *
 * A failure here is a finding about the net — the golden is n8n's, not ours — and is never fixed
 * by re-recording. Re-recording is for a new stamp (n8n, its dist, or libpetri), which the recorder
 * refuses to do silently. Results are settlement-level evidence, not conformance numbers.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import type { CompiledWorkflow } from '../../src/compiler/index.js';
import { v2Actions } from '../../src/conformance/v2/binder.js';
import { compareRuns, compareStateTo } from '../../src/conformance/v2/differential.js';
import {
  asGolden, decodeKey, decodeRows, GOLDEN_FORMAT, GOLDEN_SEAM_PATCHED_DIST, GOLDEN_STAMPED_DIST, replaySettlement, runResultOf,
  selectStates, settlementKey, settlementRows, stampDifferences, stateKey, unpatchedStamp,
} from '../../src/conformance/v2/golden.js';
import type { GoldenEntry, GoldenRow, GoldenSettlement, GoldenStamp } from '../../src/conformance/v2/golden.js';
import { graphToDescription } from '../../src/conformance/v2/graph.js';
import { runV2 } from '../../src/conformance/v2/net-run.js';
import type { ReferenceRow } from '../../src/conformance/v2/reference.js';
import type { V2SettlementPolicy } from '../../src/n8n/v2-host.js';
import { createSettlementPolicy } from '../../src/settlement/policy.js';
import { ACCEPTED, SETTLEMENT_SHAPES } from '../fixtures/v2-graphs.js';
import { memoryReader } from '../support/settlement-reader.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const golden = asGolden(JSON.parse(readFileSync(resolve(here, '../fixtures/v2/settlement-golden.json'), 'utf8')));
const entries: readonly (readonly [string, GoldenEntry])[] = golden.entries.map((e) => [e.id, e]);
const FIXTURES = { ...SETTLEMENT_SHAPES, ...ACCEPTED };
const n8nPkg = resolve(repo, '.n8n/packages/@n8n');
const haveDist = GOLDEN_STAMPED_DIST.every((f) => existsSync(resolve(n8nPkg, f)));

const compileV2 = (e: GoldenEntry): CompiledWorkflow => compile(graphToDescription(e.graph).description, { profile: 'engineV2' });
const text = (rows: readonly GoldenRow[]) => rows.map((r) => `${r[0]}@${r[1]}=${r[2]}[${r[3]}]`).join(' ');
const SETTLED = new Set(['completed', 'failed', 'skipped', 'cancelled']);
const failedS = (x: GoldenSettlement) => x.rows.some((r) => r[2] === 'failed');
const keysIn = (x: GoldenSettlement) => x.decided.toQueue.length + x.decided.toSkip.length;
/** A reader over `rows` whose records come back in a seeded order: a store promises none. */
const readerAt = (seed: number) => (rows: readonly ReferenceRow[]) => memoryReader(rows, { order: seed });

describe('the settlement golden', () => {
  it('is stamped as decision 16 asks', () => {
    expect(golden.format).toBe(GOLDEN_FORMAT);
    expect(golden.stamp.n8n).toMatch(/^n8n@\d+\.\d+\.\d+$/);
    expect(Object.keys(golden.stamp.dist).sort()).toEqual([...GOLDEN_STAMPED_DIST].sort());
    for (const h of Object.values(golden.stamp.dist)) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(golden.stamp.libpetri.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  // Review finding: the stamp hashed only the decision core, not the handlers and the store whose
  // waiting and cancellation semantics `simulate` ports.
  it('stamps the handlers and the step store the reference loop ports, not only the decision core', () => {
    expect(GOLDEN_STAMPED_DIST).toEqual(expect.arrayContaining([
      'engine/dist/execution/settlement.js', 'engine/dist/execution/completion.js',
      'engine/dist/execution/execution.types.js', 'engine/dist/execution/step-ready-handler.js',
      'engine/dist/execution/step-settled-handler.js', 'engine/dist/database/typeorm-step-store.js',
      'engine/dist/execution/cancel-execution.service.js', 'engine/dist/execution/wait-sweeper.js',
    ]));
  });

  // A seam patch may change a stamped file, but only to the hash pinned beside the stamp: the
  // allowance names a stamped file, and never the stamp's own hash, so it cannot hide drift.
  it('allows a seam-patched hash only for a stamped file, and never the stamp\'s own', () => {
    for (const [f, h] of Object.entries(GOLDEN_SEAM_PATCHED_DIST)) {
      expect(GOLDEN_STAMPED_DIST).toContain(f);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(h).not.toBe(golden.stamp.dist[f]);
    }
  });

  // Where the pinned checkout is built, a drifted dist file fails here, not only at the next
  // re-record. CI has no `.n8n` and skips it; `scripts/check-n8n-drift.sh` covers a resync there.
  // A file a seam patch changes matches either n8n's stamp (the unpatched pin) or the hash it
  // has with the committed patch (`GOLDEN_SEAM_PATCHED_DIST`); any other hash is drift.
  it.skipIf(!haveDist)('matches the pinned checkout\'s dist, file by file', () => {
    const local: Record<string, string> = Object.fromEntries(GOLDEN_STAMPED_DIST.map((f) =>
      [f, createHash('sha256').update(readFileSync(resolve(n8nPkg, f))).digest('hex')]));
    expect(unpatchedStamp({ ...golden.stamp, dist: local }, golden.stamp).dist).toEqual(golden.stamp.dist);
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

  it('holds every kind of settlement: a race, order in one list, a skip, nothing decided, a later pass, a running loop, finished', () => {
    const kinds = { race: 0, order: 0, skip: 0, nothing: 0, laterPass: 0, loopRunning: 0, finished: 0, notFinished: 0, compared: 0 };
    for (const e of golden.entries) {
      for (const x of e.settlements) {
        if (failedS(x)) kinds.race++; else kinds.compared++;
        if (x.decided.toQueue.length >= 2 || x.decided.toSkip.length >= 2) kinds.order++;
        if (x.decided.toSkip.length > 0) kinds.skip++;
        if (keysIn(x) === 0) kinds.nothing++;
        if (x.settled[1] > 0) kinds.laterPass++;
        if (x.expected === null) kinds.loopRunning++;
        if (x.finished) kinds.finished++; else kinds.notFinished++;
      }
    }
    for (const [k, n] of Object.entries(kinds)) expect(n, k).toBeGreaterThan(0);
    expect(kinds.compared).toBeGreaterThan(400);
  });

  it('keeps its settlements consistent: s is a decided row of S, and finished is the count test on S′', () => {
    for (const e of golden.entries) {
      for (const x of e.settlements) {
        const at = `${e.id} ${text(x.rows)} s=${x.settled.join('@')}`;
        const s = x.rows.find((r) => r[0] === x.settled[0] && r[1] === x.settled[1]);
        expect(s?.[2], at).toMatch(/^(completed|skipped)$/);
        const { after } = settlementRows(e.graph, x);
        const settled = after.filter((r) => SETTLED.has(r.status)).length;
        expect(x.finished, at).toBe(x.expected !== null && settled >= x.expected);
        // decideSuccessors leaves out every key S has a row for.
        const have = new Set(x.rows.map((r) => `${r[0]}@${r[1]}`));
        for (const k of [...x.decided.toQueue, ...x.decided.toSkip]) expect(have.has(`${k[0]}@${k[1]}`), at).toBe(false);
      }
    }
  });

  it('keeps its counts: distinct states, as many as it says, with the drop logged', () => {
    for (const e of golden.entries) {
      expect(new Set(e.states.map((s) => stateKey(s.rows))).size, e.id).toBe(e.states.length);
      expect(e.stateCounts.kept, e.id).toBe(e.states.length);
      expect(e.stateCounts.kept + e.stateCounts.dropped, e.id).toBe(e.stateCounts.distinct);
      expect(e.states.length, e.id).toBeLessThanOrEqual(golden.parameters.maxStatesPerEntry);
      expect(e.runs.length, e.id).toBe(golden.parameters.behaviours * golden.parameters.runOrders);
      expect(new Set(e.settlements.map(settlementKey)).size, e.id).toBe(e.settlements.length);
      expect(e.settlementCounts.kept, e.id).toBe(e.settlements.length);
      expect(e.settlementCounts.kept + e.settlementCounts.dropped, e.id).toBe(e.settlementCounts.distinct);
      expect(e.settlements.length, e.id).toBeLessThanOrEqual(golden.parameters.maxSettlementsPerEntry);
      expect(e.settlements.length, e.id).toBeGreaterThan(0);
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

  it('(a″, a‴) the net-backed policy answers n8n\'s decideSuccessors in order and its finish test at every recorded settlement', async () => {
    const policy = createSettlementPolicy();
    const disagreements: string[] = [];
    for (const [i, x] of entry.settlements.entries()) {
      const v = await replaySettlement(policy, entry.graph, x, readerAt(i));
      const at = `rows ${text(x.rows)} s=${x.settled.join('@')}`;
      if (v.decided === false || v.finished === false) disagreements.push(`${at}: ${v.problems.join('; ')}`);
      // The named race: the handler would have failed the execution; the policy decides ∅ and is not finished.
      if (v.race && (v.ours.decided?.toQueue.length !== 0 || v.ours.decided.toSkip.length !== 0 || v.ours.finished !== false)) {
        disagreements.push(`${at}: on a failed S the policy decided ${JSON.stringify(v.ours.decided)}, finished ${v.ours.finished}`);
      }
      expect(v.race, at).toBe(failedS(x));
    }
    expect(disagreements).toEqual([]);
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

describe('the settlement replay catches a disagreement', () => {
  const all = golden.entries.flatMap((e) => e.settlements.map((x) => ({ e, x })));
  const policy = createSettlementPolicy();
  const reader = readerAt(0);
  const swap = <T>(list: readonly T[]): T[] => [list[1]!, list[0]!, ...list.slice(2)];

  it('in the order of one list, in the queue/skip split, and in the finish test', async () => {
    const { e, x } = all.find(({ x }) => !failedS(x) && x.decided.toQueue.length >= 2)!;
    expect(await replaySettlement(policy, e.graph, x, reader)).toMatchObject({ decided: true, finished: true, race: false });

    const reordered = { ...x, decided: { ...x.decided, toQueue: swap(x.decided.toQueue) } };
    const v = await replaySettlement(policy, e.graph, reordered, reader);
    expect(v.decided).toBe(false);
    expect(v.problems.some((p) => p.startsWith('decideSuccessors queue'))).toBe(true);

    const split = { ...x, decided: { toQueue: x.decided.toQueue.slice(1), toSkip: [x.decided.toQueue[0]!, ...x.decided.toSkip] } };
    expect((await replaySettlement(policy, e.graph, split, reader)).decided).toBe(false);

    const { e: e2, x: done } = all.find(({ x }) => !failedS(x) && x.finished)!;
    const flipped = await replaySettlement(policy, e2.graph, { ...done, finished: false }, reader);
    expect(flipped).toMatchObject({ decided: true, finished: false });
    expect(flipped.problems).toEqual(['isFinished true, n8n\'s count test false']);
  });

  it('counts a failed S as the race and compares nothing there, but a throw is a disagreement, race or not', async () => {
    const { e, x } = all.find(({ x }) => failedS(x) && keysIn(x) > 0)!;
    const v = await replaySettlement(policy, e.graph, x, reader);
    expect(v).toMatchObject({ race: true, decided: null, finished: null, ours: { decided: { toQueue: [], toSkip: [] }, finished: false } });

    const throwing: V2SettlementPolicy = {
      decideSuccessors: () => Promise.reject(new Error('boom')),
      isFinished: () => Promise.reject(new Error('bang')),
    };
    for (const { e: g, x: y } of [{ e, x }, all.find(({ x }) => !failedS(x))!]) {
      const t = await replaySettlement(throwing, g.graph, y, reader);
      expect(t).toMatchObject({ decided: false, finished: false });
      expect(t.problems).toEqual(['decideSuccessors threw: boom', 'isFinished threw: bang']);
    }
  });

  it('compares a race too when asked, which only n8n\'s own policy passes', async () => {
    const { e, x } = all.find(({ x }) => failedS(x) && keysIn(x) > 0)!;
    const v = await replaySettlement(policy, e.graph, x, reader, { races: 'compare' });
    expect(v.race).toBe(false);
    expect(v.decided).toBe(false);
  });

  it('asks decideSuccessors for s over S and isFinished over S′', async () => {
    const { e, x } = all.find(({ x }) => !failedS(x) && x.decided.toQueue.length > 0 && x.decided.toSkip.length > 0)
      ?? all.find(({ x }) => !failedS(x) && keysIn(x) > 0)!;
    const seen: { method: string; rows: number; settled?: string }[] = [];
    const spy: V2SettlementPolicy = {
      decideSuccessors: async (_g, settled, r) => {
        const latest = await r.loadLatestStepSummaries(e.graph.nodes.map((n) => n.id));
        seen.push({ method: 'decide', rows: Object.keys(latest).length, settled: `${settled.nodeId}@${settled.iteration}` });
        return { toQueue: [], toSkip: [] };
      },
      isFinished: async (_g, r) => {
        seen.push({ method: 'finish', rows: await r.countSettledSteps() });
        return false;
      },
    };
    await replaySettlement(spy, e.graph, x, reader);
    const { before, after } = settlementRows(e.graph, x);
    const s = decodeKey(e.graph, x.settled);
    expect(seen).toEqual([
      { method: 'decide', rows: new Set(before.map((r) => r.nodeId)).size, settled: `${s.nodeId}@${s.iteration}` },
      { method: 'finish', rows: after.filter((r) => SETTLED.has(r.status)).length },
    ]);
    expect(after.length).toBe(before.length + keysIn(x));
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
    expect(() => asGolden({ ...golden, format: GOLDEN_FORMAT + 1 })).toThrow(new RegExp(`format ${GOLDEN_FORMAT}`));
    expect(() => asGolden({ ...golden, entries: [{ ...golden.entries[0]!, settlements: undefined }] })).toThrow(/has no settlements/);
    const g = golden.entries[0]!.graph;
    expect(() => decodeRows(g, [[99, 0, 'completed', '1']])).toThrow(/node index 99/);
    expect(() => decodeRows(g, [[0, 0, 'paused' as never, '']])).toThrow(/unknown status 'paused'/);
  });

  it('settlementRows: S′ is S plus queued then skipped rows for new keys, and S itself once a row has failed', () => {
    const g = golden.entries.find((e) => e.id === 'fixture/branchDiamond')!.graph;
    const rows: GoldenRow[] = [[0, 0, 'completed', '1'], [1, 0, 'completed', '10']];
    const { before, after } = settlementRows(g, { rows, decided: { toQueue: [[2, 0], [1, 0]], toSkip: [[3, 0]] } });
    expect(before).toEqual(decodeRows(g, rows));
    expect(after.slice(2).map((r) => [r.nodeId, r.iteration, r.status, r.id])).toEqual([
      [g.nodes[2]!.id, 0, 'queued', '2'], [g.nodes[3]!.id, 0, 'skipped', '3'],
    ]);
    const failed: GoldenRow[] = [[0, 0, 'completed', '1'], [1, 0, 'failed', '']];
    expect(settlementRows(g, { rows: failed, decided: { toQueue: [[2, 0]], toSkip: [] } }).after).toEqual(decodeRows(g, failed));
  });

  it('unpatchedStamp reads only a file\'s exact seam-patched hash as the recorded one', () => {
    const [f, patched] = Object.entries(GOLDEN_SEAM_PATCHED_DIST)[0]!;
    const recorded: GoldenStamp = { n8n: 'n8n@1.0.0', dist: { [f]: 'aa', 'other.js': 'bb' }, libpetri: { version: '7.0.0', linked: false } };
    expect(unpatchedStamp({ ...recorded, dist: { [f]: patched, 'other.js': 'bb' } }, recorded)).toEqual(recorded);
    expect(stampDifferences(recorded, unpatchedStamp({ ...recorded, dist: { [f]: 'cc', 'other.js': patched } }, recorded)))
      .toEqual([`${f}: aa → cc`, `other.js: bb → ${patched}`]);
  });

  it('reads master\'s waiting status (ADR 0013 (a))', () => {
    const g = golden.entries[0]!.graph;
    expect(decodeRows(g, [[0, 0, 'waiting', '']])[0]!.status).toBe('waiting');
  });
});
