/**
 * The bounded verdict's arithmetic: which transitions count as a run of a cyclic node, and the
 * largest number of them every explored run is closed under (`state-class.ts`, "The expanded
 * prefix, and why it is tracked").
 */
import type { StateClass, StateClassGraph } from 'libpetri/verification';
import type { CompiledWorkflow } from '../../compiler/index.js';
import { wasExpanded } from './classify.js';

/**
 * The transitions a **cyclic-node run** is counted in: the `run` transition of every node
 * that lies on a cycle of the workflow's main-connection graph (`analysis.cyclic`, a
 * non-trivial SCC or a self-loop).
 *
 * That is the unit {@link StateSpace.boundedCyclicRuns} quantifies over, and it is
 * deliberately *not* "one iteration of the loop": on a two-node cycle (`Loop -> Body ->
 * Loop`) one pass of the body fires two of these transitions, so a bound of `k` guarantees
 * `floor(k / size)` complete passes and nothing may report it as `k` iterations. A node's
 * `X_run` is the transition whose action is the node's own execution, so what is counted is
 * exactly the node runs a user would count on the canvas.
 */
export function loopTransitions(compiled: CompiledWorkflow): Set<string> {
  const names = new Set<string>();
  // Through `NetMap`'s per-node index rather than a scan of every transition. Not
  // `transitionFor(node, 'run')`, which returns the first match only: a node with an
  // `onFailure` chain has one `run` per attempt (`run`, `run_2`, …, `compiler/gadget.ts`), and
  // every one of them is a run of that node.
  for (const node of compiled.analysis.cyclic) {
    for (const t of compiled.netMap.transitionsOf(node)) {
      if (t.role === 'run') names.add(t.name);
    }
  }
  return names;
}

/**
 * The largest `k >= 1` such that every class reachable by a run firing at most `k` loop
 * transitions lies in the expanded prefix.
 *
 * The argument, which is the whole soundness of the bounded verdict. Let `A` be the
 * expanded prefix and `B` the rest, and let `iter(C)` be the fewest loop firings on any
 * path to `C` **through recorded edges**. Every class in `A` had all its successors
 * recorded, so a run that stays inside `A` is fully represented. Take
 * `k = min{ iter(C) : C in B } - 1` and induct on run length: a run firing at most `k`
 * loop transitions reaches only classes whose `iter` is at most `k`, each is therefore not
 * in `B`, so it is in `A` and its successors are recorded. Hence every run within the
 * bound — and every marking it comes to rest in — was enumerated and classified, and
 * "nothing bad happens within `k` iterations" is a fact rather than an extrapolation.
 */
export function closedCyclicRuns(
  graph: StateClassGraph, loops: ReadonlySet<string>, expandedClasses: number,
): number | null {
  if (graph.isComplete() || loops.size === 0) return null;
  const classes = graph.stateClasses();
  const distances = new LoopDistances(graph, classes, loops);
  if (!distances.run()) return null;
  const frontier = nearestFrontier(classes, distances.iter, expandedClasses);
  if (frontier === null) return null;
  const k = frontier - 1;
  // `k = 0` would only say "nothing goes wrong in runs where the loop never runs", which
  // is not a statement about the loop at all. One cyclic-node run is the floor.
  return k >= 1 ? k : null;
}

/** `iter` of a class no run through recorded edges reaches. */
const UNREACHED = -1;

/** The smallest `iter` of any class outside the expanded prefix; `null` when none has one. */
function nearestFrontier(
  classes: readonly StateClass[], iter: Int32Array, expandedClasses: number,
): number | null {
  let frontier = Number.POSITIVE_INFINITY;
  for (let i = 0; i < classes.length; i++) {
    if (wasExpanded(expandedClasses, i, classes[i]!)) continue;
    const d = iter[i]!;
    // An unexpanded class the recorded edges do not reach cannot bound anything: no run
    // through recorded edges gets there, so it constrains no `k`.
    if (d !== UNREACHED && d < frontier) frontier = d;
  }
  return Number.isFinite(frontier) ? frontier : null;
}

/**
 * `iter` for every class, indexed as `stateClasses()`. It is a shortest path with weights 1
 * (a loop transition) and 0 (everything else), so it is computed by Dial's algorithm: one
 * bucket per distance, and 0-weight successors appended to the bucket being drained.
 */
class LoopDistances {
  readonly iter: Int32Array;
  private readonly graph: StateClassGraph;
  private readonly classes: readonly StateClass[];
  private readonly loops: ReadonlySet<string>;
  private readonly index = new Map<StateClass, number>();
  private readonly buckets: number[][] = [];

  constructor(graph: StateClassGraph, classes: readonly StateClass[], loops: ReadonlySet<string>) {
    this.graph = graph;
    this.classes = classes;
    this.loops = loops;
    for (let i = 0; i < classes.length; i++) this.index.set(classes[i]!, i);
    this.iter = new Int32Array(classes.length).fill(UNREACHED);
  }

  /** Fills {@link iter} from the initial class; `false` when that class is not indexed. */
  run(): boolean {
    const start = this.index.get(this.graph.initialClass);
    if (start === undefined) return false;
    this.iter[start] = 0;
    this.buckets.push([start]);
    for (let d = 0; d < this.buckets.length; d++) this.drain(d);
    return true;
  }

  private drain(d: number): void {
    const bucket = this.buckets[d];
    if (bucket === undefined) return;
    // `bucket` grows while it is drained: a 0-weight successor belongs to this very
    // distance, and appending it here is what makes Dial's algorithm exact for 0/1 weights.
    for (let b = 0; b < bucket.length; b++) {
      const i = bucket[b]!;
      if (this.iter[i] === d) this.relaxFrom(i, d);
    }
  }

  private relaxFrom(i: number, d: number): void {
    for (const [transition, edges] of this.graph.outgoingBranchEdges(this.classes[i]!)) {
      const next = d + (this.loops.has(transition.name) ? 1 : 0);
      for (const edge of edges) this.relax(this.index.get(edge.target), next);
    }
  }

  private relax(j: number | undefined, next: number): void {
    if (j === undefined) return;
    const current = this.iter[j]!;
    if (current !== UNREACHED && next >= current) return;
    this.iter[j] = next;
    (this.buckets[next] ??= []).push(j);
  }
}
