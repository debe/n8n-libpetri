/**
 * The differ's second and third comparisons. **Happens-before**, a gate: every data
 * dependency the run realised is respected inside each engine, and every one n8n ordered is
 * ordered the same way under the net — the net's partial order is a *weakening* of n8n's
 * total order, never a reordering of it. The **ordering report**, not a gate: the
 * `executionIndex` sequences side by side, every move attributed by the register's rules
 * (`attribution.ts`).
 */
import type { IRunData } from 'n8n-workflow';
import { attribute, attributeLastNodeExecuted, type Attribution, type AttributionContext } from './attribution.js';
import type { EngineName, EngineRun } from './engines.js';
import type { DataComparison } from './gate-data.js';
import { activationKey, type Activation, type DependencyEdge } from './trace.js';

// ==================== happens-before ====================

export interface HappensBeforeViolation {
  readonly engine: EngineName | 'weakening';
  readonly edge: DependencyEdge;
  readonly detail: string;
}

export interface HappensBefore {
  readonly respected: boolean;
  readonly violations: readonly HappensBeforeViolation[];
  readonly checkedEdges: number;
  /**
   * n8n edges the net never realised. Zero whenever the data gate passes (equal `source`
   * fields mean equal dependency graphs); non-zero only under a data difference, where the
   * pairing of producer run to consumer run itself moved and comparing the orders of two
   * different graphs would say nothing.
   */
  readonly unmatchedEdges: number;
  /**
   * Edges whose producer or consumer activation left **no `runNode` observation**, so the
   * order could not be checked at all — the activation is in `runData` but not in the trace,
   * which happens when the run was short-circuited (a pinned output) — or whose producer
   * started and **never finished**, so there is no instant to order the consumer after.
   * These used to be counted as checked and then silently skipped (the never-finished case
   * was reported as an inversion at `Infinity`); they are violations now, because an edge
   * the harness cannot observe is an edge the harness cannot clear.
   */
  readonly absentEdges: number;
}

/**
 * How one edge stands in one engine. `unfinished`: the producer has a start and no finish
 * (its `runNode` never returned), which is a non-terminating activation and not an
 * inversion — `finish = Infinity` is not an instant the consumer started before.
 */
function ordered(activations: Map<string, Activation>, edge: DependencyEdge): 'ok' | 'inverted' | 'absent' | 'unfinished' {
  const from = activations.get(edge.from);
  const to = activations.get(edge.to);
  if (from === undefined || to === undefined) return 'absent';
  if (!Number.isFinite(from.finish)) return 'unfinished';
  return from.finish < to.start ? 'ok' : 'inverted';
}

/**
 * Every realised dependency is respected inside each engine, and every dependency n8n
 * ordered is ordered the same way under the net. Independent activations are free to be
 * unordered under the net — that is the concurrency, and it is not checked here.
 */
export function checkHappensBefore(reference: EngineRun, candidate: EngineRun): HappensBefore {
  const violations: HappensBeforeViolation[] = [];
  let checked = 0;
  let absent = 0;
  for (const run of [reference, candidate]) {
    for (const edge of run.edges) {
      checked++;
      const verdict = ordered(run.activations, edge);
      if (verdict === 'inverted') {
        const from = run.activations.get(edge.from)!;
        const to = run.activations.get(edge.to)!;
        violations.push({
          engine: run.engine,
          edge,
          detail: `finish(${edge.from})=${from.finish} is not before start(${edge.to})=${to.start}`,
        });
      } else if (verdict === 'unfinished') {
        absent++;
        violations.push({
          engine: run.engine,
          edge,
          detail: `${edge.from} never finished (its runNode has a start and no finish observation), so ${edge.from} → ${edge.to} could not be ordered`,
        });
      } else if (verdict === 'absent') {
        absent++;
        const missing = [edge.from, edge.to].filter((k) => run.activations.get(k) === undefined);
        violations.push({
          engine: run.engine,
          edge,
          detail: `${missing.join(' and ')} left no runNode observation, so ${edge.from} → ${edge.to} could not be ordered`,
        });
      }
    }
  }
  const edgeId = (e: DependencyEdge): string => `${e.from}->${e.to}@${e.inputIndex}`;
  const candidateEdges = new Set(candidate.edges.map(edgeId));
  let unmatched = 0;
  for (const edge of reference.edges) {
    if (!candidateEdges.has(edgeId(edge))) {
      unmatched++;
      continue;
    }
    if (ordered(candidate.activations, edge) === 'inverted') {
      violations.push({
        engine: 'weakening',
        edge,
        detail: `n8n orders ${edge.from} before ${edge.to} by a real dependency; the net does not`,
      });
    }
  }
  return { respected: violations.length === 0, violations, checkedEdges: checked, unmatchedEdges: unmatched, absentEdges: absent };
}

// ==================== the ordering report ====================

export interface OrderDifference {
  readonly activation: string;
  readonly n8nRank: number | null;
  readonly libpetriRank: number | null;
  readonly attribution: Attribution;
}

/**
 * `resultData.lastNodeExecuted`: the name n8n's error reporting and "Retry execution" read.
 * It is a function of the execution order alone, so a difference is attributed to row #5 —
 * but only when both engines name a node that actually ran in both. A name that belongs to
 * a node one engine never ran is a real defect and stays unattributed
 * ({@link attributeLastNodeExecuted}).
 */
export interface LastNodeExecuted {
  readonly n8n: string | undefined;
  readonly libpetri: string | undefined;
  readonly equal: boolean;
  readonly attribution: Attribution | null;
}

export interface OrderingReport {
  readonly n8n: readonly string[];
  readonly libpetri: readonly string[];
  readonly equal: boolean;
  readonly differences: readonly OrderDifference[];
  readonly unattributed: number;
  /** Mechanisms observed that no `docs/divergences.md` row names yet. */
  readonly novelMechanisms: readonly string[];
  readonly lastNodeExecuted: LastNodeExecuted;
}

/** The activations in `executionIndex` order — n8n's own `nodeExecutionOrder`. */
export function executionOrder(runData: IRunData): string[] {
  const rows: Array<{ key: string; index: number }> = [];
  for (const [node, runs] of Object.entries(runData)) {
    runs.forEach((task, runIndex) => {
      rows.push({ key: activationKey(node, runIndex), index: (task as { executionIndex?: number }).executionIndex ?? 0 });
    });
  }
  rows.sort((a, b) => a.index - b.index);
  return rows.map((r) => r.key);
}

/**
 * Transitive reachability over the realised dependency edges: for every producer, every
 * activation downstream of it (itself included when the edges cycle back). One iterative
 * walk per producer — the earlier recursive version memoised a set *before* filling it, so
 * a walk that re-entered an activation still on its stack read a partial closure and the
 * concurrency rule then called two dependent activations independent; and its recursion was
 * unbounded in the chain length.
 */
export function reachableOf(edges: readonly DependencyEdge[]): ReadonlyMap<string, ReadonlySet<string>> {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const list = next.get(e.from);
    if (list === undefined) next.set(e.from, [e.to]);
    else list.push(e.to);
  }
  const closure = new Map<string, ReadonlySet<string>>();
  for (const from of next.keys()) {
    const seen = new Set<string>();
    const stack = [...next.get(from)!];
    while (stack.length > 0) {
      const to = stack.pop()!;
      if (seen.has(to)) continue;
      seen.add(to);
      const onward = next.get(to);
      if (onward !== undefined) stack.push(...onward);
    }
    closure.set(from, seen);
  }
  return closure;
}

/** Build the ordering report and attribute every rank difference. */
export function compareOrdering(
  reference: EngineRun,
  candidate: EngineRun,
  data: DataComparison,
  orInputNodes: ReadonlySet<string> = new Set(),
): OrderingReport {
  const left = executionOrder(reference.runData);
  const right = executionOrder(candidate.runData);
  const rankOf = (seq: readonly string[]): Map<string, number> => new Map(seq.map((k, i) => [k, i]));
  const leftRank = rankOf(left);
  const rightRank = rankOf(right);
  const joins = new Set<string>();
  for (const run of [reference, candidate]) {
    for (const [node, runs] of Object.entries(run.runData)) {
      runs.forEach((task, runIndex) => {
        if (((task.source ?? []) as unknown[]).length > 1) joins.add(activationKey(node, runIndex));
      });
    }
  }
  const oneSided = new Map<string, EngineName>();
  for (const key of left) if (!rightRank.has(key)) oneSided.set(key, 'n8n');
  for (const key of right) if (!leftRank.has(key)) oneSided.set(key, 'libpetri');
  const ctx: AttributionContext = {
    effectiveBudget: candidate.effectiveBudget,
    permutedNodes: data.permutedNodes,
    strandedNodes: data.strandedNodes,
    starvedNodes: data.starvedNodes,
    joinActivations: joins,
    reachable: reachableOf([...reference.edges, ...candidate.edges]),
    oneSided,
    candidateOutcome: candidate.outcome,
    destinationNode: reference.runExecutionData.startData?.destinationNode?.nodeName,
    orInputNodes,
  };
  /** The activations both engines ran, with both ranks, in n8n's order: what a move is measured against. */
  const both: Array<{ readonly key: string; readonly a: number; readonly b: number }> = [];
  for (const [a, key] of left.entries()) {
    const b = rightRank.get(key);
    if (b !== undefined) both.push({ key, a, b });
  }
  const differences: OrderDifference[] = [];
  for (const key of [...new Set([...left, ...right])]) {
    const a = leftRank.get(key);
    const b = rightRank.get(key);
    if (a === b) continue;
    const movedAgainst = a === undefined || b === undefined
      ? []
      : both.filter((o) => o.key !== key && (o.a < a) !== (o.b < b)).map((o) => o.key);
    differences.push({
      activation: key,
      n8nRank: a ?? null,
      libpetriRank: b ?? null,
      attribution: attribute(key, movedAgainst, ctx),
    });
  }
  const lastLeft = reference.runExecutionData.resultData.lastNodeExecuted;
  const lastRight = candidate.runExecutionData.resultData.lastNodeExecuted;
  const lastNodeExecuted: LastNodeExecuted = {
    n8n: lastLeft,
    libpetri: lastRight,
    equal: lastLeft === lastRight,
    attribution: attributeLastNodeExecuted(
      { n8n: lastLeft, libpetri: lastRight }, { n8n: reference.runData, libpetri: candidate.runData }, ctx),
  };
  const withLast = lastNodeExecuted.attribution === null
    ? differences
    : [...differences, { activation: 'resultData.lastNodeExecuted', n8nRank: null, libpetriRank: null, attribution: lastNodeExecuted.attribution }];
  const novel = new Set<string>();
  for (const d of withLast) {
    if (d.attribution.kind === 'divergence' && d.attribution.novel) novel.add(d.attribution.mechanism);
  }
  return {
    n8n: left,
    libpetri: right,
    equal: differences.length === 0 && lastNodeExecuted.equal,
    differences: withLast,
    unattributed: withLast.filter((d) => d.attribution.kind === 'unattributed').length,
    novelMechanisms: [...novel].sort(),
    lastNodeExecuted,
  };
}
