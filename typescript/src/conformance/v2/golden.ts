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
 * stored as {@link PlanKeys} (sorted `nodeId@iteration`), the form leg (a) compares.
 */
import type { StepRow, V2StepStatus } from '../../codec/v2/step-rows.js';
import { V2_STEP_STATUSES } from '../../codec/v2/step-rows.js';
import type { PlanKeys } from './differential.js';
import type { V2Graph } from './graph.js';
import type { Behaviour, ReferenceRow, RunEnd, RunResult } from './reference.js';

/** The golden's format; a reader refuses another. */
export const GOLDEN_FORMAT = 1;

/** A row: `[index into graph.nodes, iteration, status, filledOutputSlots as '0'/'1']`. */
export type GoldenRow = readonly [node: number, iteration: number, status: V2StepStatus, slots: string];

/** Decision 16's stamp. */
export interface GoldenStamp {
  /** `n8n@<version>` of the checkout the answers came from. */
  readonly n8n: string;
  /** sha256 (hex) of each dist file that decides, by path under `packages/@n8n`. */
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
  return g as SettlementGolden;
}
