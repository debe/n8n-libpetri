/**
 * A state class back in workflow terms: the firing path that reaches it from the initial
 * class, its marking by node and role, and which of those tokens are pending work.
 */
import type { Transition } from 'libpetri';
import type { StateClass, StateClassGraph } from 'libpetri/verification';
import type { NetMapView } from '../../compiler/index.js';
import { decodeMarking, decodeStep } from '../counterexample.js';
import type { Counterexample, CounterexampleStep, Stranding, Witness } from '../types.js';
import { restRolesFor, terminalKindOf } from './roles.js';

/** How the BFS first reached a class: from which class, by which transition. */
interface Parent {
  readonly from: StateClass;
  readonly transition: Transition;
}

/** A {@link Witness} in the shape the report already renders. */
export function witnessCounterexample(witness: Witness): Counterexample {
  const nodePath: string[] = [];
  for (const step of witness.path) {
    if (step.node !== null && !nodePath.includes(step.node)) nodePath.push(step.node);
  }
  return {
    nodePath,
    steps: witness.path,
    stuckMarking: witness.marking,
    // A path in the state-class graph *is* a firing sequence of the timed net
    // (Berthomieu-Diaz), so unlike an SMT derivation set it needs no replay to be ordered.
    confirmed: true,
    ordered: true,
  };
}

/** Decodes the classes of one graph; the BFS parents are built once, on first use. */
export class ClassDecoder {
  private readonly graph: StateClassGraph;
  private readonly map: NetMapView;
  private parents: Map<StateClass, Parent> | null = null;

  constructor(graph: StateClassGraph, map: NetMapView) {
    this.graph = graph;
    this.map = map;
  }

  /** The class as a stranding: its firing path, its marking, and the tokens left pending. */
  decode(sc: StateClass): Stranding {
    const path = this.pathTo(sc);
    const marking = decodeMarking(sc.marking, this.map);
    const kind = terminalKindOf(marking.map((p) => p.role));
    const rest = restRolesFor(kind);
    return {
      stranded: marking.filter((p) => p.role === null || !rest.has(p.role)),
      marking,
      path,
      terminal: kind,
    };
  }

  /** The firing path from the initial class to `sc`, one decoded step per transition. */
  private pathTo(sc: StateClass): CounterexampleStep[] {
    this.parents ??= buildParents(this.graph);
    const steps: CounterexampleStep[] = [];
    let cursor: StateClass | undefined = sc;
    while (cursor !== undefined && cursor !== this.graph.initialClass) {
      const parent: Parent | undefined = this.parents.get(cursor);
      if (parent === undefined) break;
      steps.push(decodeStep(parent.transition.name, this.map));
      cursor = parent.from;
    }
    return steps.reverse();
  }
}

/** BFS parents from the initial class, built once, for the firing paths. */
function buildParents(graph: StateClassGraph): Map<StateClass, Parent> {
  const parents = new Map<StateClass, Parent>();
  const seen = new Set<StateClass>([graph.initialClass]);
  // An index cursor rather than `shift()`: the graph can hold `maxClasses` entries, and a
  // shifting queue over 200 000 of them is a needless O(n^2) risk.
  const queue: StateClass[] = [graph.initialClass];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    for (const [transition, edges] of graph.outgoingBranchEdges(current)) {
      for (const edge of edges) {
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        parents.set(edge.target, { from: current, transition });
        queue.push(edge.target);
      }
    }
  }
  return parents;
}
