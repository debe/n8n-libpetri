/**
 * **Happens-before**, a gate: every data dependency the run realised is respected inside each
 * engine, and every one n8n ordered is ordered the same way under the net — the net's partial
 * order is a *weakening* of n8n's total order, never a reordering of it.
 */
import type { EngineName, EngineRun } from '../engines.js';
import type { Activation, DependencyEdge } from '../trace.js';

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

type Activations = ReadonlyMap<string, Activation>;

/**
 * How one edge stands in one engine. `unfinished`: the producer has a start and no finish
 * (its `runNode` never returned), which is a non-terminating activation and not an
 * inversion — `finish = Infinity` is not an instant the consumer started before.
 */
type EdgeVerdict = 'ok' | 'inverted' | 'absent' | 'unfinished';

function ordered(activations: Activations, edge: DependencyEdge): EdgeVerdict {
  const from = activations.get(edge.from);
  const to = activations.get(edge.to);
  if (from === undefined || to === undefined) return 'absent';
  if (!Number.isFinite(from.finish)) return 'unfinished';
  return from.finish < to.start ? 'ok' : 'inverted';
}

/** What a violation of each kind says about its edge. */
const VIOLATION_DETAIL: Readonly<Record<Exclude<EdgeVerdict, 'ok'>, (activations: Activations, edge: DependencyEdge) => string>> = {
  inverted: (activations, { from, to }) =>
    `finish(${from})=${activations.get(from)!.finish} is not before start(${to})=${activations.get(to)!.start}`,
  unfinished: (_activations, { from, to }) =>
    `${from} never finished (its runNode has a start and no finish observation), so ${from} → ${to} could not be ordered`,
  absent: (activations, { from, to }) =>
    `${[from, to].filter((k) => activations.get(k) === undefined).join(' and ')} left no runNode observation, so ${from} → ${to} could not be ordered`,
};

/** The edges one engine's own run did not order, and how many of them it left unobservable. */
interface EngineCheck {
  readonly violations: readonly HappensBeforeViolation[];
  readonly absent: number;
}

function checkWithinEngine(run: EngineRun): EngineCheck {
  const violations: HappensBeforeViolation[] = [];
  let absent = 0;
  for (const edge of run.edges) {
    const verdict = ordered(run.activations, edge);
    if (verdict === 'ok') continue;
    if (verdict !== 'inverted') absent++;
    violations.push({ engine: run.engine, edge, detail: VIOLATION_DETAIL[verdict](run.activations, edge) });
  }
  return { violations, absent };
}

const edgeId = (e: DependencyEdge): string => `${e.from}->${e.to}@${e.inputIndex}`;

/** n8n's edges the net realised and ordered the other way, and how many it never realised. */
function checkWeakening(reference: EngineRun, candidate: EngineRun): { readonly violations: HappensBeforeViolation[]; readonly unmatched: number } {
  const candidateEdges = new Set(candidate.edges.map(edgeId));
  const matched = reference.edges.filter((edge) => candidateEdges.has(edgeId(edge)));
  const violations = matched
    .filter((edge) => ordered(candidate.activations, edge) === 'inverted')
    .map((edge): HappensBeforeViolation => ({
      engine: 'weakening',
      edge,
      detail: `n8n orders ${edge.from} before ${edge.to} by a real dependency; the net does not`,
    }));
  return { violations, unmatched: reference.edges.length - matched.length };
}

/**
 * Every realised dependency is respected inside each engine, and every dependency n8n
 * ordered is ordered the same way under the net. Independent activations are free to be
 * unordered under the net — that is the concurrency, and it is not checked here.
 */
export function checkHappensBefore(reference: EngineRun, candidate: EngineRun): HappensBefore {
  const inReference = checkWithinEngine(reference);
  const inCandidate = checkWithinEngine(candidate);
  const weakening = checkWeakening(reference, candidate);
  const violations = [...inReference.violations, ...inCandidate.violations, ...weakening.violations];
  return {
    respected: violations.length === 0,
    violations,
    checkedEdges: reference.edges.length + candidate.edges.length,
    unmatchedEdges: weakening.unmatched,
    absentEdges: inReference.absent + inCandidate.absent,
  };
}
