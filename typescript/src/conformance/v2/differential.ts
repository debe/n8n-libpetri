/**
 * The three comparisons of the engine v2 differential (`tasks/v2-profile-plan.md` step 10, ADR
 * 0012 §2's stop condition). `tasks/v2-differential.mts` drives them over the corpus with n8n's
 * own settlement code injected; here they are pure functions of a reference, a compiled net and
 * the runs, so the suite can check them with no `.n8n`.
 *
 * - **(a) state**, {@link compareState}: at a row set S the reference reaches, the stateless
 *   planner's answer `planFromMarking(decodeStepRows(S))` equals n8n's R(S) (decision 13).
 * - **(b) lockstep**, {@link compareLockstep}: a net run and a reference run under one behaviour
 *   end alike. Failure-free, every step's fate is the same (status and, for a completed step,
 *   every connected slot) and the net settles exactly `countExpectedSettledSteps` rows. With a
 *   failure, both end failed and agree on every step both decided before planning stopped.
 * - **(c) firing**, {@link comparePoint}: at every row-set point of a net run, the rows decode to
 *   the executor's marking, and the planner's answer is the set of starts and skips libpetri's
 *   own state-class graph finds enabled at the executor's marking.
 * - **(a″) key-scoped decision**, {@link compareScoped} (`tasks/v2-seam-plan.md` decisions 6 and
 *   13): at a reached (S, settled s), the net's R(S) narrowed to s's candidates
 *   (`settlement/scope.ts`) is what `StepSettledHandler` decides for s — ∅ once a row has failed,
 *   `decideSuccessors(s)` otherwise — as **ordered** queue and skip sequences.
 * - **(a‴) completion**, {@link compareFinished} (decision 7 as amended after F3 fired at step 2):
 *   at a reached S without a failed row, the net's `isFinished` (every row settled, R(S) empty) is
 *   `finishExecutionIfDone`'s count test. An S with a failed row is F3's named race (a failure
 *   landing between the planning read and `hasFailedSteps`): counted, not compared.
 *
 * - **(f) frontier**, {@link compareFrontier} (`tasks/v2-seam-plan.md` step 14): at a reached S
 *   (and s), the frontier decode (`codec/v2/frontier.ts`) against the global decoder: the marking
 *   and row counts from S's frontier alone are `decodeStepRows(S)`'s, both refuse or neither does,
 *   and the policy's `decideFromRows` / `finishedFromRows` on the frontier (plus s's row) are their
 *   answers on S with the full snapshot.
 *
 * **Nothing is loosened to agree.** Legs (a), (b) and (c) compare answers as sets of
 * `(node, iteration)` in both lists, because the net answers in declaration order and
 * `decideSuccessors` in edge order; that is the only normalisation. Leg (a″) compares order as
 * well, because the scoped answer is in edge order. A `CodecError` is a disagreement, not a skip.
 */
import type { Place } from 'libpetri';
import { MarkingState, StateClassGraph } from 'libpetri/verification';
import { planFromMarking, type StepPlan } from '../../codec/v2/plan.js';
import { decodeStepRows, type StepKey, type StepRow, type V2StepStatus } from '../../codec/v2/step-rows.js';
import type { CompiledWorkflow } from '../../compiler/index.js';
import { messageOf } from '../../internal/errors.js';
import type { V2Graph } from './graph.js';
import type { NetPoint, NetRun, PlaceCounts } from './net-run.js';
import { candidateKeys, isFinished, scopePlan } from '../../settlement/scope.js';
import { decodeFrontier, frontierOf } from '../../codec/v2/frontier.js';
import { decideFromRows, finishedFromRows } from '../../settlement/policy.js';
import { handlerPlan, latestTerminal, referenceAnswer, settledCount } from './reference.js';
import type { ReferencePlan, ReferenceRow, RunResult, SettlementReference, V2Loop } from './reference.js';

/** A plan as two sorted lists of `nodeId@iteration`. */
export interface PlanKeys {
  readonly toQueue: readonly string[];
  readonly toSkip: readonly string[];
}

const keyOf = (k: StepKey): string => `${k.nodeId}@${k.iteration}`;

/** `plan` as sorted keys, the form every comparison here uses. */
export function planKeys(plan: StepPlan | ReferencePlan): PlanKeys {
  return { toQueue: plan.toQueue.map(keyOf).sort(), toSkip: plan.toSkip.map(keyOf).sort() };
}

const sameKeys = (a: PlanKeys, b: PlanKeys): boolean =>
  a.toQueue.join(' ') === b.toQueue.join(' ') && a.toSkip.join(' ') === b.toSkip.join(' ');

/** The planner's answer at a row set, or the `CodecError` (any throw) the decoder raised. */
function netAnswer(compiled: CompiledWorkflow, rows: readonly StepRow[]): { plan: PlanKeys } | { error: string } {
  const net = netPlanAt(compiled, rows);
  return 'plan' in net ? { plan: planKeys(net.plan) } : net;
}

// ---- (a) state ----

/** Leg (a) at one reference state. */
export type StateVerdict =
  | { readonly agree: true }
  | {
    readonly agree: false;
    /** The row set, as the reference holds it. */
    readonly rows: readonly ReferenceRow[];
    readonly reference: PlanKeys;
    /** The planner's answer, or `null` when decoding threw. */
    readonly net: PlanKeys | null;
    readonly error: string | null;
  };

/** Leg (a): `planFromMarking(decodeStepRows(S))` against R(S) at the reference's row set `rows`. */
export function compareState(
  compiled: CompiledWorkflow,
  ref: SettlementReference,
  graph: V2Graph,
  loops: readonly V2Loop[],
  rows: readonly ReferenceRow[],
): StateVerdict {
  return compareStateTo(compiled, rows, planKeys(referenceAnswer(ref, graph, loops, rows)));
}

/**
 * Leg (a) against an R(S) already computed: `reference` is n8n's answer at `rows`, as
 * {@link compareState} computes it or as a golden recorded it (`golden.ts`). The comparison is the
 * same set equality.
 */
export function compareStateTo(compiled: CompiledWorkflow, rows: readonly ReferenceRow[], reference: PlanKeys): StateVerdict {
  const net = netAnswer(compiled, rows);
  if ('plan' in net && sameKeys(net.plan, reference)) return { agree: true };
  return 'plan' in net
    ? { agree: false, rows, reference, net: net.plan, error: null }
    : { agree: false, rows, reference, net: null, error: net.error };
}

// ---- (b) lockstep ----

const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'skipped', 'cancelled']);
/** A step v2 queued, whatever became of it: every status but `skipped`. */
const decidedQueued = (status: string): boolean => status !== 'skipped';

/** Leg (b) on one pair of runs. */
export interface LockstepVerdict {
  readonly agree: boolean;
  /** Each way the runs differ; empty when they agree. */
  readonly problems: readonly string[];
  /** Whether the pair ended failed (both, when they agree). */
  readonly failed: boolean;
  /** Steps compared: every row failure-free; the rows both runs have, with a failure. */
  readonly compared: number;
  /** With a failure, steps only the net decided and only the reference decided before planning stopped. */
  readonly onlyNet: number;
  readonly onlyReference: number;
}

/**
 * Leg (b): the net run `net` against the reference run `reference` under the same behaviour.
 *
 * - The ends agree: the net holds `_halt` exactly when the reference ended `failed`. A reference
 *   run that drained unfinished is a problem in its own right.
 * - Failure-free: the multiset of fates (`name#iteration=status`) is the same, every completed
 *   step filled the same connected slots, no step is left in flight, and the net settled exactly
 *   `countExpectedSettledSteps` rows (from the net's own rows), as many as the reference did.
 * - With a failure, the runs stop planning at different points, so only what both decided is
 *   compared: on every key with a row in both, queued in one exactly when queued in the other,
 *   and a step settled completed or failed in both with the same status and slots.
 */
export function compareLockstep(
  ref: SettlementReference,
  graph: V2Graph,
  loops: readonly V2Loop[],
  compiled: CompiledWorkflow,
  reference: RunResult,
  net: NetRun,
): LockstepVerdict {
  const trigger = ref.findTriggerNode(graph);
  const reachable = new Set(trigger === undefined ? [] : [trigger.id, ...ref.getDescendantNodeIds(graph, trigger.id)]);
  const batchIds = loops.filter((l) => reachable.has(l.batchNodeId)).map((l) => l.batchNodeId);
  return compareRuns(graph, compiled, reference, net, (rows) => {
    const asReference: ReferenceRow[] = rows.map((r, i) => ({ ...r, id: String(i), status: r.status as V2StepStatus }));
    return ref.countExpectedSettledSteps(loops, reachable, latestTerminal(ref, asReference, batchIds));
  });
}

/**
 * Leg (b) with the settled count supplied: `expectedOf(rows)` is `countExpectedSettledSteps` for
 * the net's final `rows`, read only on a failure-free pair. {@link compareLockstep} asks n8n's
 * function; a golden replay (`golden.ts`) supplies the count n8n gave on the reference run's final
 * rows, which is the same number whenever the fates and connected slots agree — the function reads
 * the loops, the reachable set and each batch node's latest row, and a batch row is terminal by its
 * status and loop slot, both compared first.
 */
export function compareRuns(
  graph: V2Graph,
  compiled: CompiledWorkflow,
  reference: RunResult,
  net: NetRun,
  expectedOf: (rows: readonly StepRow[]) => number | undefined,
): LockstepVerdict {
  const problems: string[] = [];
  const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const connected = new Map(compiled.netMap.settlements.map((g) => [g.id, g.outputs.map((o) => o.index)]));
  const fateOf = (r: StepRow): string => `${nameOf.get(r.nodeId) ?? r.nodeId}#${r.iteration}=${r.status}`;
  const slotsDiffer = (a: StepRow, b: StepRow): boolean =>
    (connected.get(a.nodeId) ?? []).some((o) => Boolean(a.filledOutputSlots[o]) !== Boolean(b.filledOutputSlots[o]));

  if (reference.end === 'drained-unfinished') problems.push('the reference run drained unfinished');
  const refFailed = reference.end === 'failed';
  if (net.halted !== refFailed) {
    problems.push(`ends differ: the net ${net.halted ? 'halted' : 'did not halt'}, the reference ended ${reference.end}`);
  }
  const refByKey = new Map(reference.rows.map((r) => [keyOf(r), r]));
  const netByKey = new Map(net.rows.map((r) => [keyOf(r), r]));
  const stillRunning = net.rows.filter((r) => r.status === 'running');
  if (stillRunning.length > 0) problems.push(`the net quiesced with steps in flight: ${stillRunning.map(fateOf).join(' ')}`);

  if (!net.halted && !refFailed) {
    const fates = net.rows.map(fateOf).sort().join(' ');
    if (fates !== reference.fates) problems.push(`fates differ\n      net:       ${fates}\n      reference: ${reference.fates}`);
    for (const [k, r] of netByKey) {
      const other = refByKey.get(k);
      if (other !== undefined && r.status === 'completed' && other.status === 'completed' && slotsDiffer(r, other)) {
        problems.push(`${fateOf(r)} filled slots [${r.filledOutputSlots.map(Number).join('')}], the reference [${other.filledOutputSlots.map(Number).join('')}]`);
      }
    }
    const settled = net.rows.filter((r) => SETTLED.has(r.status)).length;
    const expected = expectedOf(net.rows);
    if (expected !== settled) problems.push(`the net settled ${settled} rows, countExpectedSettledSteps says ${String(expected)}`);
    if (reference.settled !== settled) problems.push(`the net settled ${settled} rows, the reference ${reference.settled}`);
    return { agree: problems.length === 0, problems, failed: false, compared: net.rows.length, onlyNet: 0, onlyReference: 0 };
  }

  let compared = 0;
  for (const [k, r] of netByKey) {
    const other = refByKey.get(k);
    if (other === undefined) continue;
    compared++;
    if (decidedQueued(r.status) !== decidedQueued(other.status)) {
      problems.push(`${k} is ${r.status} in the net and ${other.status} in the reference`);
      continue;
    }
    const settledBoth = (s: string): boolean => s === 'completed' || s === 'failed';
    if (settledBoth(r.status) && settledBoth(other.status)) {
      if (r.status !== other.status) problems.push(`${k} is ${r.status} in the net and ${other.status} in the reference`);
      else if (r.status === 'completed' && slotsDiffer(r, other)) problems.push(`${k} filled other slots in the net than in the reference`);
    }
  }
  return {
    agree: problems.length === 0,
    problems,
    failed: true,
    compared,
    onlyNet: [...netByKey.keys()].filter((k) => !refByKey.has(k)).length,
    onlyReference: [...refByKey.keys()].filter((k) => !netByKey.has(k)).length,
  };
}

// ---- (c) firing ----

/** Leg (c) at one row-set point of a net run. */
export type PointVerdict =
  | { readonly agree: true }
  | {
    readonly agree: false;
    readonly rows: readonly StepRow[];
    /** libpetri's enabled starts and skips at the executor's marking. */
    readonly executor: PlanKeys;
    readonly net: PlanKeys | null;
    readonly error: string | null;
    /** Places whose decoded count differs from the executor's: `name: decoded ≠ executor`. */
    readonly markingDiff: readonly string[];
  };

/** The starts and skips libpetri finds enabled at `marking`, keyed `(node, rowCount(node))` from `rows`. */
export function executorPlan(compiled: CompiledWorkflow, marking: PlaceCounts, rows: readonly StepRow[]): PlanKeys {
  const byName = new Map<string, Place<unknown>>([...compiled.net.places].map((p) => [p.name, p as Place<unknown>]));
  const b = MarkingState.builder();
  for (const [name, n] of Object.entries(marking)) {
    const p = byName.get(name);
    if (p === undefined) throw new Error(`executorPlan: the net has no place '${name}'`);
    b.tokens(p, n);
  }
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.nodeId, (counts.get(r.nodeId) ?? 0) + 1);
  const toQueue: StepKey[] = [];
  const toSkip: StepKey[] = [];
  for (const t of StateClassGraph.build(compiled.net, b.build(), 1).initialClass.enabledTransitions) {
    const info = compiled.netMap.transition(t.name);
    if (info === undefined || (info.role !== 'start' && info.role !== 'skip')) continue;
    const id = compiled.netMap.settlement(info.node).id;
    (info.role === 'start' ? toQueue : toSkip).push({ nodeId: id, iteration: counts.get(id) ?? 0 });
  }
  return planKeys({ toQueue, toSkip });
}

/** Leg (c): the planner on the point's rows against libpetri at the executor's marking, and the decoded marking against it. */
export function comparePoint(compiled: CompiledWorkflow, point: NetPoint): PointVerdict {
  const executor = executorPlan(compiled, point.marking, point.rows);
  let decoded: PlaceCounts | null = null;
  let error: string | null = null;
  let net: PlanKeys | null = null;
  try {
    const d = decodeStepRows(compiled, point.rows);
    decoded = {};
    for (const [p, tokens] of d.marking) if (tokens.length > 0) decoded[p.name] = tokens.length;
    net = planKeys(planFromMarking(compiled, d));
  } catch (e) {
    error = messageOf(e);
  }
  const markingDiff: string[] = [];
  if (decoded !== null) {
    for (const name of new Set([...Object.keys(decoded), ...Object.keys(point.marking)])) {
      const a = decoded[name] ?? 0;
      const b = point.marking[name] ?? 0;
      if (a !== b) markingDiff.push(`${name}: ${a} ≠ ${b}`);
    }
  }
  if (net !== null && markingDiff.length === 0 && sameKeys(net, executor)) return { agree: true };
  return { agree: false, rows: point.rows, executor, net, error, markingDiff: markingDiff.sort() };
}

// ---- (a″) key-scoped decision and (a‴) completion ----

/** A plan as two lists of `nodeId@iteration` in the plan's own order: order is compared too. */
export interface PlanSequence {
  readonly toQueue: readonly string[];
  readonly toSkip: readonly string[];
}

/** `plan` as ordered keys. */
export function planSequence(plan: StepPlan | ReferencePlan): PlanSequence {
  return { toQueue: plan.toQueue.map(keyOf), toSkip: plan.toSkip.map(keyOf) };
}

const sameSequence = (a: PlanSequence, b: PlanSequence): boolean =>
  a.toQueue.join(' ') === b.toQueue.join(' ') && a.toSkip.join(' ') === b.toSkip.join(' ');

/** R(S) from the net at `rows`, or the decoder's refusal. Shared by the legs at one S. */
export type NetPlanAt = { readonly plan: StepPlan } | { readonly error: string };

/** `planFromMarking(decodeStepRows(rows))`, or the error it threw. */
export function netPlanAt(compiled: CompiledWorkflow, rows: readonly StepRow[]): NetPlanAt {
  try {
    return { plan: planFromMarking(compiled, decodeStepRows(compiled, rows)) };
  } catch (e) {
    return { error: messageOf(e) };
  }
}

/** Leg (a″) at one (S, s). */
export interface ScopedVerdict {
  readonly agree: boolean;
  /**
   * S has a failed row. `StepSettledHandler` then fails the execution (`hasFailedSteps`) and plans
   * nothing, so n8n's answer is ∅; the net's is ∅ too, `_halt` inhibiting every start and skip.
   */
  readonly halted: boolean;
  /** What the handler decides for s at S: ∅ when halted, `decideSuccessors(s)` otherwise. */
  readonly reference: PlanSequence;
  /**
   * `decideSuccessors(s)` with no failure check. On a halted S a non-empty answer is
   * `tasks/v2-seam-plan.md` F2's named race (a failure landing after `hasFailedSteps`, where
   * `createSteps` refuses n8n's rows): counted, never compared.
   */
  readonly unguarded: PlanSequence;
  /** `scopePlan(R(S), candidateKeys(s))`, or `null` when decoding threw. */
  readonly net: PlanSequence | null;
  readonly error: string | null;
}

/**
 * Leg (a″): at the rows `rows` and the settled step `settled` (completed or skipped), the net's
 * R(S) scoped to `settled`'s candidates against `StepSettledHandler`'s decision, keys and order
 * both. `net` is R(S) when the caller has it already.
 */
export function compareScoped(
  compiled: CompiledWorkflow,
  ref: SettlementReference,
  graph: V2Graph,
  loops: readonly V2Loop[],
  rows: readonly ReferenceRow[],
  settled: StepKey,
  net: NetPlanAt = netPlanAt(compiled, rows),
): ScopedVerdict {
  const halted = rows.some((r) => r.status === 'failed');
  const unguarded = planSequence(handlerPlan(ref, graph, loops, rows, settled));
  const reference = halted ? { toQueue: [], toSkip: [] } : unguarded;
  if ('error' in net) return { agree: false, halted, reference, unguarded, net: null, error: net.error };
  const scoped = planSequence(scopePlan(net.plan, candidateKeys(graph, settled, rows)));
  return { agree: sameSequence(scoped, reference), halted, reference, unguarded, net: scoped, error: null };
}

/** Leg (a‴) at one S. */
export interface FinishedVerdict {
  /**
   * `isFinished` equals the count test; `null` when S has a failed row and decoded, because that
   * S is F3's named race and is not compared. A decoder throw is `false`, failed S or not.
   */
  readonly agree: boolean | null;
  /**
   * S has a failed row. n8n reaches `finishExecutionIfDone` on it only in F3's named race, and
   * `isFinished` is false on it by decision 7 as amended, leaving the end to the failure's own
   * settlement (`failExecution`).
   */
  readonly failed: boolean;
  /** `finishExecutionIfDone`'s test: `countSettledSteps ≥ countExpectedSettledSteps`, false while a loop runs. */
  readonly reference: boolean;
  /** The two numbers the test compares. */
  readonly settled: number;
  readonly expected: number | undefined;
  /** Decision 7's `isFinished` (false on a failed S); `null` when decoding threw. */
  readonly net: boolean | null;
  readonly error: string | null;
}

/**
 * Leg (a‴): at the rows `rows`, the net's `isFinished` against n8n's count test, compared only
 * where no row has failed. `reachable` is the trigger and its descendants (`reachableOf`); `net`
 * is R(S) when the caller has it already.
 */
export function compareFinished(
  compiled: CompiledWorkflow,
  ref: SettlementReference,
  loops: readonly V2Loop[],
  reachable: ReadonlySet<string>,
  rows: readonly ReferenceRow[],
  net: NetPlanAt = netPlanAt(compiled, rows),
): FinishedVerdict {
  const failed = rows.some((r) => r.status === 'failed');
  const { settled, expected } = settledCount(ref, loops, reachable, rows);
  const reference = expected !== undefined && settled >= expected;
  if ('error' in net) return { agree: false, failed, reference, settled, expected, net: null, error: net.error };
  const finished = isFinished(rows, net.plan);
  return { agree: failed ? null : finished === reference, failed, reference, settled, expected, net: finished, error: null };
}

// ---- (f) frontier ----

/** Leg (f) at one S, and at one (S, s) when `settled` is given. */
export interface FrontierVerdict {
  readonly agree: boolean;
  /** Each way the frontier and the global decoder differ; empty when they agree. */
  readonly problems: readonly string[];
  /** Rows in S, and in its frontier (the settled row not counted). */
  readonly rows: number;
  readonly frontierRows: number;
}

/** A decode's marking and row counts as text, or `THROW <class>`. */
function decodedText(decode: () => { marking: ReadonlyMap<Place<unknown>, readonly unknown[]>; rowCounts: ReadonlyMap<string, number> }): string {
  try {
    const d = decode();
    const places = [...d.marking].filter(([, t]) => t.length > 0).map(([p, t]) => `${p.name}=${t.length}`).sort();
    return `${places.join(' ')} | ${[...d.rowCounts].map(([id, n]) => `${id}:${n}`).sort().join(' ')}`;
  } catch (e) {
    return `THROW ${e instanceof Error ? e.name : typeof e}`;
  }
}

/** `answer()` as text, or `THROW <class>`. */
function answerText(answer: () => unknown): string {
  try {
    const a = answer();
    return typeof a === 'boolean' ? String(a) : JSON.stringify(planSequence(a as StepPlan));
  } catch (e) {
    return `THROW ${e instanceof Error ? e.name : typeof e}`;
  }
}

/**
 * Leg (f): at the rows `rows` (and the settled step `settled`), the frontier decode against the
 * global decoder, and the policy's two pure decisions on S's frontier against the same decisions on
 * S with the full snapshot. A refusal on both sides agrees; a refusal on one side does not.
 */
export function compareFrontier(compiled: CompiledWorkflow, graph: V2Graph, rows: readonly StepRow[], settled?: StepKey): FrontierVerdict {
  const problems: string[] = [];
  const frontier = frontierOf(compiled, rows);
  const global = decodedText(() => decodeStepRows(compiled, rows));
  const local = decodedText(() => decodeFrontier(compiled, frontier));
  if (local !== global) problems.push(`decode: frontier ${local}\n      global   ${global}`);
  const entry = { graph, compiled };
  const finishedLocal = answerText(() => finishedFromRows(entry, frontier));
  const finishedGlobal = answerText(() => finishedFromRows(entry, rows, 'full'));
  if (finishedLocal !== finishedGlobal) problems.push(`isFinished: frontier ${finishedLocal}, full ${finishedGlobal}`);
  if (settled !== undefined) {
    const own = rows.find((r) => r.nodeId === settled.nodeId && r.iteration === settled.iteration);
    const read = own === undefined || frontier.includes(own) ? frontier : [...frontier, own];
    const decideLocal = answerText(() => decideFromRows(entry, settled, read));
    const decideGlobal = answerText(() => decideFromRows(entry, settled, rows, 'full'));
    if (decideLocal !== decideGlobal) problems.push(`decideSuccessors(${keyOf(settled)}): frontier ${decideLocal}, full ${decideGlobal}`);
  }
  return { agree: problems.length === 0, problems, rows: rows.length, frontierRows: frontier.length };
}
