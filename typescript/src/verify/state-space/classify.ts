/**
 * The one pass over the explored classes that every answer of the route is read from: where
 * the expanded prefix ends, which classes are quiescent, which of those are designed
 * terminals or strandings, and the peak token count of every place (`state-class.ts`,
 * "The expanded prefix, and why it is tracked").
 */
import type { Place } from 'libpetri';
import type { StateClass, StateClassGraph } from 'libpetri/verification';
import type { NetMapView, PlaceRole } from '../../compiler/index.js';
import { restRolesFor, terminalKindOf } from './roles.js';

/** How many stuck markings a report keeps. One witness per stranded place is kept anyway. */
export const MAX_WITNESSES = 8;

/** What the classification pass found. Every map is keyed by place name. */
export interface ClassSurvey {
  /** How many classes the BFS expanded: the prefix a bounded claim may be made over. */
  readonly expandedClasses: number;
  /** Classes with nothing enabled, plus the time-dead ones inside the expanded prefix. */
  readonly quiescentClasses: number;
  /** Quiescent classes that are designed terminals (paused / halted). */
  readonly terminalClasses: number;
  /** The largest token count any explored class puts on the place. */
  readonly peakTokens: ReadonlyMap<string, number>;
  /** The first class achieving that peak. */
  readonly peakClass: ReadonlyMap<string, StateClass>;
  /** The first stranding that leaves work on the place. */
  readonly strandedBy: ReadonlyMap<string, StateClass>;
  /** The strandings found, capped at {@link MAX_WITNESSES}. */
  readonly strandingClasses: readonly StateClass[];
}

/** The survey of a graph that could not be built: nothing explored, nothing found. */
export const EMPTY_SURVEY: ClassSurvey = {
  expandedClasses: 0,
  quiescentClasses: 0,
  terminalClasses: 0,
  peakTokens: new Map(),
  peakClass: new Map(),
  strandedBy: new Map(),
  strandingClasses: [],
};

/**
 * How many classes the BFS expanded. A complete graph expanded all of them; otherwise it is
 * one past the last class that recorded an outgoing edge. Everything before it was popped and
 * expanded (FIFO order); everything after it either has nothing enabled — so it needs no
 * expansion — or is frontier.
 */
export function expandedPrefixLength(graph: StateClassGraph, classes: readonly StateClass[]): number {
  if (graph.isComplete()) return classes.length;
  let lastExpanded = 0;
  for (let i = 0; i < classes.length; i++) {
    if (graph.outgoingBranchEdges(classes[i]!).size > 0) lastExpanded = i + 1;
  }
  return lastExpanded;
}

/**
 * Whether the BFS computed this class's successors. Inside the prefix it did; outside it,
 * only a class with nothing enabled is settled — it has no successors to compute.
 */
export function wasExpanded(expandedClasses: number, index: number, sc: StateClass): boolean {
  return index < expandedClasses || sc.enabledTransitions.length === 0;
}

/**
 * A class nothing can fire from. `enabledTransitions.length === 0` is decisive whatever
 * the BFS did. A class with enabled transitions and no successors is a **time-dead**
 * deadlock — every successor's firing domain was empty — but only where the BFS actually
 * tried; on the frontier the same shape is an unexplored class and evidence of nothing.
 */
export function isQuiescent(graph: StateClassGraph, sc: StateClass, expanded: boolean): boolean {
  if (sc.enabledTransitions.length === 0) return true;
  return expanded && graph.successors(sc).size === 0;
}

/** Classifies every class of `graph` in one walk. */
export function surveyClasses(graph: StateClassGraph, map: NetMapView): ClassSurvey {
  const classes = graph.stateClasses();
  const survey = new Survey(graph, map, expandedPrefixLength(graph, classes));
  for (let i = 0; i < classes.length; i++) survey.visit(classes[i]!, i);
  return survey;
}

/** The walk's running totals; read back through {@link ClassSurvey} once it is done. */
class Survey implements ClassSurvey {
  private readonly graph: StateClassGraph;
  private readonly map: NetMapView;
  readonly expandedClasses: number;
  quiescentClasses = 0;
  terminalClasses = 0;
  readonly peakTokens = new Map<string, number>();
  readonly peakClass = new Map<string, StateClass>();
  readonly strandedBy = new Map<string, StateClass>();
  readonly strandingClasses: StateClass[] = [];

  constructor(graph: StateClassGraph, map: NetMapView, expandedClasses: number) {
    this.graph = graph;
    this.map = map;
    this.expandedClasses = expandedClasses;
  }

  /** Records the class's peaks and, when it is quiescent, what kind of rest it came to. */
  visit(sc: StateClass, index: number): void {
    const marked = sc.marking.placesWithTokens();
    this.observePeaks(sc, marked);
    if (!isQuiescent(this.graph, sc, wasExpanded(this.expandedClasses, index, sc))) return;
    this.quiescentClasses++;
    const kind = terminalKindOf(marked.map((p) => this.roleOf(p)));
    if (kind !== 'none') this.terminalClasses++;
    const rest = restRolesFor(kind);
    this.observeStranding(sc, marked.filter((p) => !rest.has(this.roleOf(p))));
  }

  private observePeaks(sc: StateClass, marked: readonly Place<unknown>[]): void {
    for (const place of marked) {
      const count = sc.marking.tokens(place);
      if (count > (this.peakTokens.get(place.name) ?? 0)) {
        this.peakTokens.set(place.name, count);
        this.peakClass.set(place.name, sc);
      }
    }
  }

  /** A quiescent class holding pending work is a stranding; the first one per place is kept. */
  private observeStranding(sc: StateClass, pending: readonly Place<unknown>[]): void {
    if (pending.length === 0) return;
    if (this.strandingClasses.length < MAX_WITNESSES) this.strandingClasses.push(sc);
    for (const p of pending) if (!this.strandedBy.has(p.name)) this.strandedBy.set(p.name, sc);
  }

  private roleOf(place: Place<unknown>): PlaceRole {
    // A place NetMap does not know cannot be classified as rest, so it counts as pending
    // work: the unsound direction would be calling work "residue", never the other way.
    return this.map.place(place.name)?.role ?? 'running';
  }
}
