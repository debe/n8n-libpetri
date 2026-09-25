/**
 * The one pass over an `engineV2` net's state classes that the `settlement` family reads
 * (`families/v2-settlement.ts`, `tasks/v2-profile-plan.md` decision 18).
 *
 * It is a separate pass from `classify.ts` because the v1 survey classifies quiescent classes
 * against v1's rest roles, under which an `engineV2` net's `arrived` / `live` tokens would come
 * back as stranded work. Here the vocabulary is the settlement gadget's own:
 *
 * - **pending** at rest: `arrived`, `live`, `running`, `ok` — an edge whose consumer was never
 *   decided, a live input nobody started, a step still running, a split outcome never routed;
 * - **residue** at rest: `done`, `skipped`, `ended`, the markers nothing consumes;
 * - **the halted terminal**: `_halt`. A failure stops all planning in v2 (`StepSettledHandler`,
 *   decision 8), so a halted class may hold anything a halt leaves behind, and no claim about
 *   completion is made over it. A place `NetMap` does not know counts as pending: calling work
 *   "residue" is the unsound direction, never the other way.
 *
 * Every map keeps the **first** class that shows a fact, in the BFS order libpetri stored the
 * classes in, so a witness is decoded from one class and only on demand.
 */
import type { Place } from 'libpetri';
import type { StateClass, StateClassGraph } from 'libpetri/verification';
import type { NetMapView, PlaceRole } from '../../compiler/index.js';
import { expandedPrefixLength, isQuiescent, wasExpanded } from './classify.js';

/** The roles a quiescent, halt-free class must not hold a token on. */
export const SETTLEMENT_PENDING_ROLES: ReadonlySet<PlaceRole> = new Set<PlaceRole>(['arrived', 'live', 'running', 'ok']);

/** A start / skip pair that must never be enabled together. */
export interface ExclusivePair {
  readonly node: string;
  /** `node` for an ordinary node, `entry` / `back` for a batch node's two pairs. */
  readonly pair: 'node' | 'entry' | 'back';
  readonly start: string;
  readonly skip: string;
}

/** A node outside every loop: `done + skipped` is its decision count (decision 6). */
export interface DecidedNode {
  readonly node: string;
  readonly done: Place<unknown>;
  /** `null` on the trigger, which nothing skips. */
  readonly skipped: Place<unknown> | null;
}

/** A loop's end marker `B/ended`. */
export interface LoopEnd {
  readonly batch: string;
  readonly ended: Place<unknown>;
}

/** What the survey is asked to watch, read off the net's settlement gadgets. */
export interface SettlementQuestions {
  readonly pairs: readonly ExclusivePair[];
  readonly decided: readonly DecidedNode[];
  readonly loops: readonly LoopEnd[];
}

/** The questions an `engineV2` net's gadgets pose. */
export function settlementQuestionsOf(map: NetMapView): SettlementQuestions {
  const pairs: ExclusivePair[] = [];
  const decided: DecidedNode[] = [];
  const loops: LoopEnd[] = [];
  for (const g of map.settlements) {
    const t = g.transitions;
    if (t.skip !== null) pairs.push({ node: g.node, pair: g.batch === null ? 'node' : 'entry', start: t.start, skip: t.skip });
    if (g.batch !== null) {
      pairs.push({ node: g.node, pair: 'back', start: g.batch.transitions.startBack, skip: g.batch.transitions.skipBack });
      loops.push({ batch: g.node, ended: g.batch.ended });
    }
    if (g.done !== null) decided.push({ node: g.node, done: g.done, skipped: g.skipped });
  }
  return { pairs, decided, loops };
}

/** The key a pair's first co-enabled class is stored under. */
export const pairKey = (p: ExclusivePair): string => `${p.start} ${p.skip}`;

/** What one walk over the classes found. */
export class SettlementSurvey {
  /** Classes the BFS expanded (`classify.ts` `expandedPrefixLength`). */
  readonly expandedClasses: number;
  /** Classes nothing can fire from. */
  quiescentClasses = 0;
  /** Of those, the ones holding `_halt`: the halted terminal. */
  haltedClasses = 0;
  /** Of those, the halt-free ones: every completion claim is about these. */
  restClasses = 0;
  /** The largest token count any class puts on a place, by place name. */
  readonly peak = new Map<string, number>();
  /** The first class achieving {@link peak}. */
  readonly peakClass = new Map<string, StateClass>();
  /** The first class in which both transitions of a pair are enabled, by {@link pairKey}. */
  readonly bothEnabled = new Map<string, StateClass>();
  /** The first halt-free quiescent class holding a pending token on a place, by place name. */
  readonly residueBy = new Map<string, StateClass>();
  /** The first halt-free quiescent class holding any pending token. */
  firstResidue: StateClass | null = null;
  /** The first class in which a node's `done + skipped` exceeds 1, by node. */
  readonly overDecided = new Map<string, StateClass>();
  /** The first halt-free quiescent class in which a node's `done + skipped` is not 1, by node. */
  readonly undecided = new Map<string, StateClass>();
  /** The first halt-free quiescent class in which a loop's `B/ended` is not 1, by batch node. */
  readonly notEnded = new Map<string, StateClass>();

  private readonly graph: StateClassGraph;
  private readonly map: NetMapView;
  private readonly questions: SettlementQuestions;
  private readonly halt: Place<unknown>;

  constructor(graph: StateClassGraph, map: NetMapView, questions: SettlementQuestions) {
    this.graph = graph;
    this.map = map;
    this.questions = questions;
    this.halt = map.halt;
    const classes = graph.stateClasses();
    this.expandedClasses = expandedPrefixLength(graph, classes);
    for (let i = 0; i < classes.length; i++) this.visit(classes[i]!, i);
  }

  private visit(sc: StateClass, index: number): void {
    this.observePeaks(sc);
    this.observePairs(sc);
    this.observeDecisions(sc, false);
    if (!isQuiescent(this.graph, sc, wasExpanded(this.expandedClasses, index, sc))) return;
    this.quiescentClasses++;
    if (sc.marking.tokens(this.halt) > 0) {
      this.haltedClasses++;
      return;
    }
    this.restClasses++;
    this.observeResidue(sc);
    this.observeDecisions(sc, true);
    for (const l of this.questions.loops) {
      if (sc.marking.tokens(l.ended) !== 1 && !this.notEnded.has(l.batch)) this.notEnded.set(l.batch, sc);
    }
  }

  private observePeaks(sc: StateClass): void {
    for (const place of sc.marking.placesWithTokens()) {
      const count = sc.marking.tokens(place);
      if (count > (this.peak.get(place.name) ?? 0)) {
        this.peak.set(place.name, count);
        this.peakClass.set(place.name, sc);
      }
    }
  }

  private observePairs(sc: StateClass): void {
    if (sc.enabledTransitions.length < 2) return;
    const enabled = new Set(sc.enabledTransitions.map((t) => t.name));
    for (const p of this.questions.pairs) {
      const key = pairKey(p);
      if (enabled.has(p.start) && enabled.has(p.skip) && !this.bothEnabled.has(key)) this.bothEnabled.set(key, sc);
    }
  }

  /** Everywhere: at most one decision. At halt-free rest: exactly one. */
  private observeDecisions(sc: StateClass, atRest: boolean): void {
    for (const d of this.questions.decided) {
      const count = sc.marking.tokens(d.done) + (d.skipped === null ? 0 : sc.marking.tokens(d.skipped));
      if (!atRest && count > 1 && !this.overDecided.has(d.node)) this.overDecided.set(d.node, sc);
      if (atRest && count !== 1 && !this.undecided.has(d.node)) this.undecided.set(d.node, sc);
    }
  }

  private observeResidue(sc: StateClass): void {
    let pending = false;
    for (const place of sc.marking.placesWithTokens()) {
      const role = this.map.place(place.name)?.role ?? null;
      if (role !== null && !SETTLEMENT_PENDING_ROLES.has(role)) continue;
      pending = true;
      if (!this.residueBy.has(place.name)) this.residueBy.set(place.name, sc);
    }
    if (pending && this.firstResidue === null) this.firstResidue = sc;
  }
}
