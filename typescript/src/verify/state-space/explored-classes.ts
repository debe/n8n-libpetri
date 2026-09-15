/**
 * What the explored classes say, whatever the exploration that produced them: the peak token
 * count of every place, which places are marked together, and the strandings — each decoded
 * back into workflow terms on demand. `StateSpace` (`state-class.ts`) adds the run itself:
 * the cap it ran under, how long it took, why it failed or stopped, and the bound it closes.
 */
import type { Place } from 'libpetri';
import type { StateClass, StateClassGraph } from 'libpetri/verification';
import type { NetMapView } from '../../compiler/index.js';
import type { Stranding, Witness } from '../types.js';
import { EMPTY_SURVEY, surveyClasses, type ClassSurvey } from './classify.js';
import { CoMarkings, coMarkedPairs } from './co-markings.js';
import { ClassDecoder } from './decode.js';

/**
 * The answers one classification pass gives about a graph, or none when there is no graph.
 * Every query here is read off the survey (`classify.ts`); only a witness is decoded, and
 * only when asked for.
 */
export class ExploredClasses {
  protected readonly graph: StateClassGraph | null;
  private readonly survey: ClassSurvey;
  private readonly decoder: ClassDecoder | null;

  /** Classes with nothing enabled, plus the time-dead ones inside the expanded prefix. */
  readonly quiescentClasses: number;
  /** Quiescent classes that are designed terminals (paused / halted). */
  readonly terminalClasses: number;
  /** How many classes the BFS expanded: the prefix a bounded claim may be made over. */
  readonly expandedClasses: number;

  protected constructor(graph: StateClassGraph | null, map: NetMapView) {
    this.graph = graph;
    this.survey = graph === null ? EMPTY_SURVEY : surveyClasses(graph, map);
    this.decoder = graph === null ? null : new ClassDecoder(graph, map);
    this.quiescentClasses = this.survey.quiescentClasses;
    this.terminalClasses = this.survey.terminalClasses;
    this.expandedClasses = this.survey.expandedClasses;
  }

  /** Whether the route produced a graph at all. `false` means every caller must fall back. */
  get usable(): boolean {
    return this.graph !== null;
  }

  /** The largest token count any explored class puts on `place`. */
  peak(place: Place<unknown>): number {
    return this.survey.peakTokens.get(place.name) ?? 0;
  }

  /** Whether any explored class marks `place`. */
  everMarked(place: Place<unknown>): boolean {
    return this.peak(place) > 0;
  }

  /** The class achieving {@link peak} on `place`, decoded; `null` when the place never marks. */
  peakWitness(place: Place<unknown>): Witness | null {
    return this.decodeOrNull(this.survey.peakClass.get(place.name));
  }

  /** Which of `places` some explored class marks together. One pass over the classes. */
  coMarkings(places: readonly Place<unknown>[]): CoMarkings {
    const pairs = this.graph === null ? new Map<string, StateClass>() : coMarkedPairs(this.graph.stateClasses(), places);
    return new CoMarkings(pairs, (sc) => this.decode(sc));
  }

  /** The first stranding that leaves work on `place`, decoded; `null` when none does. */
  strandedAt(place: Place<unknown>): Stranding | null {
    return this.decodeOrNull(this.survey.strandedBy.get(place.name));
  }

  /** Every place some stranding leaves work on, in first-seen order. */
  strandedPlaces(): readonly string[] {
    return [...this.survey.strandedBy.keys()];
  }

  /** The strandings found, capped at `MAX_WITNESSES`, decoded on demand. */
  strandings(): readonly Stranding[] {
    return this.survey.strandingClasses.map((sc) => this.decode(sc));
  }

  private decode(sc: StateClass): Stranding {
    return this.decoder!.decode(sc);
  }

  private decodeOrNull(sc: StateClass | undefined): Stranding | null {
    return sc === undefined ? null : this.decode(sc);
  }
}
