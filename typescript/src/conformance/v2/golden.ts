/**
 * The engine v2 settlement golden (`tasks/v2-profile-plan.md` step 11): n8n's own answers,
 * recorded once from the pinned checkout by `tasks/record-v2-golden.mts`, so CI can replay the
 * differential's legs (a) and (b) with no `.n8n` (`tests/conformance/v2-planner-golden.test.ts`).
 *
 * A golden holds, per entry (a committed workflow with its fired trigger, or a fixture graph):
 * - the graph n8n's `V1WorkflowConverter` produced (a fixture graph as written), which is what the
 *   net is compiled from (stage 1, `graphToDescription`);
 * - the behaviours, each a {@link Behaviour} whose seed fixes every step's outcome;
 * - reference states: row sets n8n's loop reached, each with R(S), n8n's answer there
 *   (`referenceAnswer`, decision 13), capped per entry;
 * - reference runs: the end, the final rows (whose statuses are the fates) and n8n's
 *   `countExpectedSettledSteps` on them, with the delay seed the net run of that pair uses;
 * - settlements (`tasks/v2-seam-plan.md` step 7, format 2): reached (S, s) pairs, each with
 *   `decideSuccessors(s)` as `planSuccessors` loads it, **in n8n's order**, and
 *   `countExpectedSettledSteps` and the finish test on the rows the settlement leaves, capped per
 *   entry. The seam's two answers (patch 0003's `SettlementPolicy`), so a policy can be replayed
 *   against them through an in-memory reader ({@link replaySettlement});
 * - decision 16's stamp: the n8n version, the sha256 of the dist files that decide, and the
 *   libpetri the recording ran against.
 *
 * **What is recorded is n8n's, never the net's.** Every answer, fate and count comes from n8n's
 * code injected into the reference loop; the net is only ever the side being checked. A golden
 * therefore stays valid across compiler changes, and a replay that disagrees is a finding about
 * the net, not a golden to regenerate.
 *
 * Rows are stored as tuples `[node index, iteration, status, slots]`: the node is its index in the
 * entry's `graph.nodes`, and `slots` is `filledOutputSlots` as a string of `0` / `1`. A plan is
 * stored as {@link PlanKeys} (sorted `nodeId@iteration`), the form leg (a) compares. A
 * settlement's keys are {@link GoldenKey}s, `[node index, iteration]`, in the order n8n gave them.
 */
import type { StepKey, StepRow, V2StepStatus } from '../../codec/v2/step-rows.js';
import { V2_STEP_STATUSES } from '../../codec/v2/step-rows.js';
import { messageOf } from '../../internal/errors.js';
import type { V2SettlementPolicy, V2SettlementReader } from '../../n8n/v2-host.js';
import type { PlanKeys, PlanSequence } from './differential.js';
import type { V2Graph } from './graph.js';
import type { Behaviour, ReferenceRow, RunEnd, RunResult } from './reference.js';

/**
 * The golden's format; a reader refuses another. Format 2 (`tasks/v2-seam-plan.md` step 7) adds
 * {@link GoldenEntry.settlements} and {@link GoldenParameters.maxSettlementsPerEntry} to format 1
 * and changes nothing format 1 held.
 */
export const GOLDEN_FORMAT = 2;

/** A row: `[index into graph.nodes, iteration, status, filledOutputSlots as '0'/'1']`. */
export type GoldenRow = readonly [node: number, iteration: number, status: V2StepStatus, slots: string];

/**
 * The dist files decision 16's stamp hashes, by path under `packages/@n8n`. Two kinds:
 * - the decision core the reference loop calls: `decideSuccessors` and its helpers, the
 *   completion count, the loop ledger, `deriveLoops` and the converter;
 * - the handlers and the step store whose semantics `simulate` (`reference.ts`) ports rather than
 *   calls: the step statuses and liveness (`execution.types`), claim, suspend and `cancelStep`
 *   (`step-ready-handler`), `failExecution` and the liveness check (`step-settled-handler`),
 *   `claimStep`, `resumeStep` and `cancelPendingSteps` (`typeorm-step-store`), cancellation on
 *   request and the resume sweep. A change there does not change n8n's recorded answers, but can
 *   make the port, and so the recorded runs, stale; the stamp makes it a decision to re-record.
 */
export const GOLDEN_STAMPED_DIST: readonly string[] = [
  'engine/dist/execution/settlement.js', 'engine/dist/execution/iteration-mapping.js', 'engine/dist/execution/completion.js',
  'engine/dist/execution/loop-ledger.js', 'engine/dist/graph/loops.js', 'node-engine-compatibility/dist/v1-workflow-converter.js',
  'engine/dist/execution/execution.types.js', 'engine/dist/execution/step-ready-handler.js',
  'engine/dist/execution/step-settled-handler.js', 'engine/dist/database/typeorm-step-store.js',
  'engine/dist/execution/cancel-execution.service.js', 'engine/dist/execution/wait-sweeper.js',
];

/**
 * The stamped dist files that a seam patch in `patches/n8n/` changes, each with the sha256 it has
 * when built from the pin with the patches applied. The stamp is n8n's; this is n8n's plus the
 * committed seam, so a checkout that carries the patches matches here and not there.
 *
 * Patch 0003 (`tasks/v2-seam-plan.md` step 4) moves the two settlement decisions of
 * `step-settled-handler.ts` behind a `SettlementPolicy`, whose default is the code that was there.
 * `failExecution` and the liveness check, which `simulate` ports, are left as they are. Patch 0004
 * (step 5) changes no stamped file: the handler's hash is the same with it applied. A stamped
 * file must match its stamp or the hash here; any other hash is drift. A change to the patch moves
 * this hash, and that is a decision, as a new stamp is.
 */
export const GOLDEN_SEAM_PATCHED_DIST: Readonly<Record<string, string>> = {
  'engine/dist/execution/step-settled-handler.js': '28762f9eafae0eaa1eebdc6aca2fa399a9e983adb65c2f1de291b1d4a6a44a92',
};

/** Decision 16's stamp. */
export interface GoldenStamp {
  /** `n8n@<version>` of the checkout the answers came from. */
  readonly n8n: string;
  /** sha256 (hex) of each of {@link GOLDEN_STAMPED_DIST}, by path under `packages/@n8n`. */
  readonly dist: Readonly<Record<string, string>>;
  /** The libpetri the recording's net ran on, and whether it was a linked checkout. */
  readonly libpetri: { readonly version: string; readonly linked: boolean };
}

/** How the golden was drawn. */
export interface GoldenParameters {
  readonly behaviours: number;
  /** Reference orders per behaviour: every state of these runs is a candidate state. */
  readonly orders: number;
  /** Orders per behaviour whose runs are recorded for the net to reproduce. */
  readonly runOrders: number;
  readonly emptyTerminal: number;
  readonly pFail: number;
  /** `pFail` applies to every behaviour whose index is a multiple of this. */
  readonly pFailEvery: number;
  /** At most this many distinct states per entry are kept. */
  readonly maxStatesPerEntry: number;
  /** At most this many distinct settlements (S, s) per entry are kept (format 2). */
  readonly maxSettlementsPerEntry: number;
}

/** One reference state: a row set and n8n's R(S) there. */
export interface GoldenState {
  readonly rows: readonly GoldenRow[];
  readonly plan: PlanKeys;
}

/** One reference run, for the net to reproduce under the same behaviour. */
export interface GoldenRun {
  /** Index into the entry's `behaviours`. */
  readonly behaviour: number;
  readonly order: number;
  /** The delay seed of the net run paired with this one: `hash(seed, 'net-order', order)`. */
  readonly netDelaySeed: number;
  readonly end: RunEnd;
  /** `countExpectedSettledSteps` on the final rows; `null` while a loop had not ended. */
  readonly expected: number | null;
  readonly settled: number;
  readonly leftQueued: number;
  readonly events: number;
  /**
   * The final rows, in creation order. The fates `simulate` reports are {@link fatesOf} these
   * rows (the recorder checks it), so they are not stored twice.
   */
  readonly rows: readonly GoldenRow[];
}

/** A step key: `[index into graph.nodes, iteration]`. */
export type GoldenKey = readonly [node: number, iteration: number];

/** `SuccessorDecisions` as n8n returned it: both lists in its own (edge) order. */
export interface GoldenDecision {
  readonly toQueue: readonly GoldenKey[];
  readonly toSkip: readonly GoldenKey[];
}

/**
 * One settlement (S, s): what n8n's `StepSettledHandler` takes from the rows when it handles the
 * `step:settled` of a completed or skipped step s, as the seam (patch 0003) asks it.
 *
 * - `rows` is S, as the handler finds it, before its `hasFailedSteps` check. A failed S is
 *   `tasks/v2-seam-plan.md` F2's and F3's named race: the handler fails the execution there and
 *   asks neither question, unless the failure lands after `hasFailedSteps`.
 * - `decided` is `decideSuccessors(s)` loaded as `planSuccessors` loads it (`exitSourcesInto`,
 *   the latest batch rows, `decisionKeys`), with no failure check, in n8n's order.
 * - `expected` and `finished` are `countExpectedSettledSteps` and `finishExecutionIfDone`'s test
 *   (`countSettledSteps ≥ expected`) on the rows the settlement leaves, S′
 *   ({@link settlementRows}): S plus the rows `createSteps` inserts for `decided`, queued then
 *   skipped, each key once. On a failed S, S′ is S: `createSteps` refuses after a failure. The
 *   handler asks `isFinished` only when nothing was queued; the test is recorded on every S′,
 *   since each is a reached row set.
 */
export interface GoldenSettlement {
  readonly rows: readonly GoldenRow[];
  /** s: a completed or skipped row of `rows`. */
  readonly settled: GoldenKey;
  readonly decided: GoldenDecision;
  /** `countExpectedSettledSteps` on S′; `null` while a reachable loop had not ended. */
  readonly expected: number | null;
  /** `countSettledSteps ≥ countExpectedSettledSteps` on S′, false while `expected` is `null`. */
  readonly finished: boolean;
}

/** What happened to the states the runs reported. */
export interface GoldenStateCounts {
  /** `onState` calls over every run of the entry. */
  readonly reported: number;
  /** Distinct row sets among them (rows compared as a set). */
  readonly distinct: number;
  readonly kept: number;
  readonly dropped: number;
}

/** One entry: a graph and what n8n did on it. */
export interface GoldenEntry {
  readonly id: string;
  /** Where the graph came from, relative to the repository root. */
  readonly source: string;
  /** The fired trigger's name, when the workflow has several; else `null`. */
  readonly trigger: string | null;
  readonly graph: V2Graph;
  readonly behaviours: readonly Behaviour[];
  readonly runs: readonly GoldenRun[];
  readonly states: readonly GoldenState[];
  readonly stateCounts: GoldenStateCounts;
  /** Settlements, at most `maxSettlementsPerEntry` (format 2). */
  readonly settlements: readonly GoldenSettlement[];
  /** As {@link stateCounts}, over the (S, s) pairs the runs reached; distinct by (row set, s). */
  readonly settlementCounts: GoldenStateCounts;
}

/** The golden file. */
export interface SettlementGolden {
  readonly format: typeof GOLDEN_FORMAT;
  readonly stamp: GoldenStamp;
  readonly parameters: GoldenParameters;
  /** Committed sources the recorder looked for and did not use, with the reason. */
  readonly skipped: readonly { readonly source: string; readonly reason: string }[];
  readonly entries: readonly GoldenEntry[];
}

/** A row as the golden stores it. Throws for a node the graph does not have. */
export function encodeRow(graph: V2Graph, row: StepRow | ReferenceRow): GoldenRow {
  const i = graph.nodes.findIndex((n) => n.id === row.nodeId);
  if (i < 0) throw new Error(`encodeRow: node '${row.nodeId}' is not in the graph`);
  return [i, row.iteration, row.status as V2StepStatus, row.filledOutputSlots.map((x) => (x ? '1' : '0')).join('')];
}

/** A stored row back as a reference row; `id` is its position, which keeps creation order. */
export function decodeRow(graph: V2Graph, row: GoldenRow, position: number): ReferenceRow {
  const [i, iteration, status, slots] = row;
  const node = graph.nodes[i];
  if (node === undefined) throw new Error(`decodeRow: node index ${i} is not in the graph`);
  if (!(V2_STEP_STATUSES as readonly string[]).includes(status)) throw new Error(`decodeRow: unknown status '${status}'`);
  if (!/^[01]*$/.test(slots)) throw new Error(`decodeRow: slots '${slots}' are not 0/1`);
  return { nodeId: node.id, iteration, id: String(position), status, filledOutputSlots: [...slots].map((c) => c === '1') };
}

/** Every row of `rows`, decoded in order. */
export function decodeRows(graph: V2Graph, rows: readonly GoldenRow[]): ReferenceRow[] {
  return rows.map((r, i) => decodeRow(graph, r, i));
}

/** A recorded run as the {@link RunResult} leg (b) compares against. */
export function runResultOf(graph: V2Graph, run: GoldenRun): RunResult {
  const rows = decodeRows(graph, run.rows);
  return {
    end: run.end,
    fates: fatesOf(graph, rows),
    expected: run.expected ?? undefined,
    settled: run.settled,
    leftQueued: run.leftQueued,
    events: run.events,
    rows,
  };
}

/** `name#iteration=status` per row, sorted: the fates as `simulate` writes them. */
export function fatesOf(graph: V2Graph, rows: readonly ReferenceRow[]): string {
  const name = new Map(graph.nodes.map((n) => [n.id, n.name]));
  return rows.map((r) => `${name.get(r.nodeId) ?? r.nodeId}#${r.iteration}=${r.status}`).sort().join(' ');
}

/** A row set's identity with rows compared as a set: two orders of one set are one state. */
export function stateKey(rows: readonly GoldenRow[]): string {
  return rows.map((r) => r.join(',')).sort().join(' ');
}

/**
 * Up to `cap` of `candidates`, chosen deterministically so that rare kinds of state survive the
 * cap. States are grouped by `kindOf`; each kind gets an equal share (a kind with fewer states
 * leaves its remainder to the others), and within a kind the kept states are spread evenly over
 * the order they were reported in, so late states of long runs are kept as well as early ones.
 * The result keeps the candidates' order.
 */
export function selectStates<T>(candidates: readonly T[], cap: number, kindOf: (s: T) => string): T[] {
  if (candidates.length <= cap) return [...candidates];
  const kinds = new Map<string, number[]>();
  candidates.forEach((s, i) => {
    const k = kindOf(s);
    const list = kinds.get(k) ?? [];
    list.push(i);
    kinds.set(k, list);
  });
  const groups = [...kinds.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, list]) => list);
  const quota = groups.map(() => 0);
  for (let left = cap; left > 0;) {
    let gave = false;
    for (let g = 0; g < groups.length && left > 0; g++) {
      if (quota[g]! < groups[g]!.length) { quota[g]!++; left--; gave = true; }
    }
    if (!gave) break;
  }
  const kept: number[] = [];
  groups.forEach((list, g) => {
    const q = quota[g]!;
    for (let j = 0; j < q; j++) kept.push(list[Math.floor((j * list.length) / q)]!);
  });
  return kept.sort((a, b) => a - b).map((i) => candidates[i]!);
}

// ---- settlements (format 2) ----

/** A key as the golden stores it. Throws for a node the graph does not have. */
export function encodeKey(graph: V2Graph, key: StepKey): GoldenKey {
  const i = graph.nodes.findIndex((n) => n.id === key.nodeId);
  if (i < 0) throw new Error(`encodeKey: node '${key.nodeId}' is not in the graph`);
  return [i, key.iteration];
}

/** A stored key back as a step key. Throws for a node index the graph does not have. */
export function decodeKey(graph: V2Graph, key: GoldenKey): StepKey {
  const node = graph.nodes[key[0]];
  if (node === undefined) throw new Error(`decodeKey: node index ${key[0]} is not in the graph`);
  return { nodeId: node.id, iteration: key[1] };
}

/** A decision as the golden stores it, both lists in their own order. */
export function encodeDecision(
  graph: V2Graph,
  plan: { readonly toQueue: readonly StepKey[]; readonly toSkip: readonly StepKey[] },
): GoldenDecision {
  return { toQueue: plan.toQueue.map((k) => encodeKey(graph, k)), toSkip: plan.toSkip.map((k) => encodeKey(graph, k)) };
}

/** A stored decision as ordered `nodeId@iteration` lists, the form {@link replaySettlement} compares. */
export function decisionSequence(graph: V2Graph, decision: GoldenDecision): PlanSequence {
  const text = (k: GoldenKey) => { const d = decodeKey(graph, k); return `${d.nodeId}@${d.iteration}`; };
  return { toQueue: decision.toQueue.map(text), toSkip: decision.toSkip.map(text) };
}

/** A settlement's identity: its row set (as a set) and s. */
export function settlementKey(s: Pick<GoldenSettlement, 'rows' | 'settled'>): string {
  return `${stateKey(s.rows)} | ${s.settled.join(',')}`;
}

/**
 * S and S′ of a settlement (see {@link GoldenSettlement}): `before` is the stored rows; `after`
 * adds, unless a row of S has failed, a `queued` row per `toQueue` key and then a `skipped` row
 * per `toSkip` key that S has no row for, as `createSteps` inserts them. Ids are positions, so
 * creation order is kept.
 */
export function settlementRows(
  graph: V2Graph,
  s: Pick<GoldenSettlement, 'rows' | 'decided'>,
): { readonly before: ReferenceRow[]; readonly after: ReferenceRow[] } {
  const before = decodeRows(graph, s.rows);
  if (before.some((r) => r.status === 'failed')) return { before, after: before };
  const after = [...before];
  const have = new Set(before.map((r) => `${r.nodeId}@${r.iteration}`));
  const add = (keys: readonly GoldenKey[], status: 'queued' | 'skipped') => {
    for (const k of keys) {
      const { nodeId, iteration } = decodeKey(graph, k);
      if (have.has(`${nodeId}@${iteration}`)) continue;
      have.add(`${nodeId}@${iteration}`);
      after.push({ nodeId, iteration, id: String(after.length), status, filledOutputSlots: [] });
    }
  };
  add(s.decided.toQueue, 'queued');
  add(s.decided.toSkip, 'skipped');
  return { before, after };
}

/** One settlement replayed through a policy. */
export interface SettlementVerdict {
  /**
   * S has a failed row: F2's and F3's named race (`tasks/v2-seam-plan.md`, decision 7 as amended).
   * Neither answer is compared, unless the replay was asked to compare races.
   */
  readonly race: boolean;
  /** `decideSuccessors(s)` equal in keys, queue/skip split and order; `null` on a race; `false` on a throw. */
  readonly decided: boolean | null;
  /** `isFinished` on S′ equal to the recorded finish test; `null` on a race; `false` on a throw. */
  readonly finished: boolean | null;
  /** The policy's answers; `null` where it threw. */
  readonly ours: { readonly decided: PlanSequence | null; readonly finished: boolean | null };
  /** The recorded answers. */
  readonly theirs: { readonly decided: PlanSequence; readonly finished: boolean };
  /** Each disagreement and throw, in words. */
  readonly problems: readonly string[];
}

/** Options of {@link replaySettlement}. */
export interface ReplayOptions {
  /**
   * `count` (default): a failed S is the named race, counted and not compared. `compare`: it is
   * compared like any other, which is right for n8n's own `defaultSettlementPolicy` only, since it
   * answers the recorded raw `decideSuccessors` and count test there.
   */
  readonly races?: 'count' | 'compare';
}

const sameSequence = (a: PlanSequence, b: PlanSequence): boolean =>
  a.toQueue.join(' ') === b.toQueue.join(' ') && a.toSkip.join(' ') === b.toSkip.join(' ');

/**
 * Replays one recorded settlement through `policy`, as `StepSettledHandler` asks it:
 * `decideSuccessors(graph, s, reader)` over a reader holding S, and `isFinished(graph, reader)`
 * over a reader holding S′. `readerOf` builds the reader; a fresh one is asked for each call. The
 * answers are compared with the recorded ones, `decideSuccessors` as ordered sequences. A throw is
 * a disagreement, race or not: nothing is loosened.
 */
export async function replaySettlement(
  policy: V2SettlementPolicy,
  graph: V2Graph,
  settlement: GoldenSettlement,
  readerOf: (rows: readonly ReferenceRow[]) => V2SettlementReader,
  options: ReplayOptions = {},
): Promise<SettlementVerdict> {
  const { before, after } = settlementRows(graph, settlement);
  const race = (options.races ?? 'count') === 'count' && before.some((r) => r.status === 'failed');
  const theirs = { decided: decisionSequence(graph, settlement.decided), finished: settlement.finished };
  const problems: string[] = [];
  let decided: PlanSequence | null = null;
  let finished: boolean | null = null;
  try {
    const d = await policy.decideSuccessors(graph, decodeKey(graph, settlement.settled), readerOf(before));
    decided = { toQueue: d.toQueue.map((k) => `${k.nodeId}@${k.iteration}`), toSkip: d.toSkip.map((k) => `${k.nodeId}@${k.iteration}`) };
  } catch (e) {
    problems.push(`decideSuccessors threw: ${messageOf(e)}`);
  }
  try {
    finished = await policy.isFinished(graph, readerOf(after));
  } catch (e) {
    problems.push(`isFinished threw: ${messageOf(e)}`);
  }
  const decidedAgree = decided === null ? false : race ? null : sameSequence(decided, theirs.decided);
  const finishedAgree = finished === null ? false : race ? null : finished === theirs.finished;
  if (decidedAgree === false && decided !== null) {
    problems.push(`decideSuccessors queue [${decided.toQueue.join(', ')}] skip [${decided.toSkip.join(', ')}], n8n queue [${theirs.decided.toQueue.join(', ')}] skip [${theirs.decided.toSkip.join(', ')}]`);
  }
  if (finishedAgree === false && finished !== null) problems.push(`isFinished ${finished}, n8n's count test ${theirs.finished}`);
  return { race, decided: decidedAgree, finished: finishedAgree, ours: { decided, finished }, theirs, problems };
}

/**
 * `local` read against the stamp `recorded`: each stamped file whose local hash is exactly its
 * seam-patched hash ({@link GOLDEN_SEAM_PATCHED_DIST}) takes `recorded`'s hash, because that
 * checkout is the pin plus the committed seam. Every other hash is left as it is, so any other
 * difference still shows in {@link stampDifferences}.
 */
export function unpatchedStamp(local: GoldenStamp, recorded: GoldenStamp): GoldenStamp {
  const dist: Record<string, string> = { ...local.dist };
  for (const [f, patched] of Object.entries(GOLDEN_SEAM_PATCHED_DIST)) {
    const was = recorded.dist[f];
    if (dist[f] === patched && was !== undefined) dist[f] = was;
  }
  return { ...local, dist };
}

/** Each way two stamps differ, as `field: old → new`; empty when they are equal. */
export function stampDifferences(a: GoldenStamp, b: GoldenStamp): string[] {
  const out: string[] = [];
  if (a.n8n !== b.n8n) out.push(`n8n: ${a.n8n} → ${b.n8n}`);
  for (const f of new Set([...Object.keys(a.dist), ...Object.keys(b.dist)])) {
    if (a.dist[f] !== b.dist[f]) out.push(`${f}: ${a.dist[f] ?? '(absent)'} → ${b.dist[f] ?? '(absent)'}`);
  }
  if (a.libpetri.version !== b.libpetri.version || a.libpetri.linked !== b.libpetri.linked) {
    const lp = (x: GoldenStamp['libpetri']) => `${x.version}${x.linked ? ' (linked)' : ' (registry)'}`;
    out.push(`libpetri: ${lp(a.libpetri)} → ${lp(b.libpetri)}`);
  }
  return out;
}

/** Reads a parsed golden, refusing another format. */
export function asGolden(value: unknown): SettlementGolden {
  const g = value as Partial<SettlementGolden> | null;
  if (g === null || typeof g !== 'object' || g.format !== GOLDEN_FORMAT) {
    throw new Error(`not a settlement golden of format ${GOLDEN_FORMAT}`);
  }
  if (!Array.isArray(g.entries) || g.stamp === undefined || g.parameters === undefined) {
    throw new Error('settlement golden: missing entries, stamp or parameters');
  }
  for (const e of g.entries) {
    if (!Array.isArray(e.settlements)) throw new Error(`settlement golden: entry '${e.id}' has no settlements`);
  }
  return g as SettlementGolden;
}
