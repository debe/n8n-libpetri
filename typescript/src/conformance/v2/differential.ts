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
 *
 * **Nothing is loosened to agree.** Answers are compared as sets of `(node, iteration)` in both
 * lists, because the net answers in declaration order and `decideSuccessors` in edge order; that
 * is the only normalisation. A `CodecError` is a disagreement, not a skip.
 */
import type { Place } from 'libpetri';
import { MarkingState, StateClassGraph } from 'libpetri/verification';
import { planFromMarking, type StepPlan } from '../../codec/v2/plan.js';
import { decodeStepRows, type StepKey, type StepRow, type V2StepStatus } from '../../codec/v2/step-rows.js';
import type { CompiledWorkflow } from '../../compiler/index.js';
import { messageOf } from '../../internal/errors.js';
import type { V2Graph } from './graph.js';
import type { NetPoint, NetRun, PlaceCounts } from './net-run.js';
import { latestTerminal, referenceAnswer } from './reference.js';
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
  try {
    return { plan: planKeys(planFromMarking(compiled, decodeStepRows(compiled, rows))) };
  } catch (e) {
    return { error: messageOf(e) };
  }
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
