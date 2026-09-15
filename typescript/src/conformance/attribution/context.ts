/**
 * What the ordering rules read besides the activation itself: gathered once per run by
 * `compareOrdering` and shared by the move, one-sided and `lastNodeExecuted` rules.
 */
import type { SchedulerOutcome } from '../../scheduler/index.js';
import type { EngineName } from '../engines.js';

export interface AttributionContext {
  readonly effectiveBudget: number;
  /** Node names whose runs came out permuted: divergence #11's signature. */
  readonly permutedNodes: readonly string[];
  /** Nodes the net stranded an arrival on, plus everything downstream: divergence #2. */
  readonly strandedNodes: readonly string[];
  /** Nodes n8n left in `waitingExecution`, plus everything downstream: divergence #1. */
  readonly starvedNodes?: readonly string[];
  /** Activations whose recorded `source` has more than one input: multi-input joins. */
  readonly joinActivations: ReadonlySet<string>;
  /** `reachableOf` over both engines' realised edges. */
  readonly reachable: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Activations only one engine ran, and which one. They did not *move* — there is no rank
   * to compare — so the concurrency rule must not claim them: "no dependency either way with
   * the activations it passed" is vacuously true over an empty `movedAgainst`, and saying
   * `concurrency` about an activation that exists once is a false correctness claim.
   */
  readonly oneSided?: ReadonlyMap<string, EngineName>;
  /** `PetriScheduler.outcome` of the net's run: a stopped run is the divergence #17 window. */
  readonly candidateOutcome?: SchedulerOutcome | null;
  /** `startData.destinationNode.nodeName`, when the run had one: divergence #13. */
  readonly destinationNode?: string | undefined;
  /** Nodes with more than one producer edge into one input: the divergence #20 gadget. */
  readonly orInputNodes?: ReadonlySet<string>;
}
