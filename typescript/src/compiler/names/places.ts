/**
 * Place names: the shared host places, a gadget's fixed local places, and the indexed places
 * of its inputs, outputs and `onFailure` attempts. Re-exported through `names.ts`, the one
 * import surface of the vocabulary.
 */
import type { Variant } from '../types.js';
import { qualified } from './qualified.js';

/** The shared host places every gadget binds its `budget` / `halt` / `pause` ports to. */
export const SHARED_PLACE = {
  budget: '_budget',
  halt: '_halt',
  pause: '_pause',
} as const;

/** The fixed local place (and port) names of a gadget, one per marker. */
export const PLACE = {
  budget: 'budget',
  halt: 'halt',
  pause: 'pause',
  /** The direct form's single edge place, and a producer-less node's synthetic one. */
  in: 'in',
  /** A tool's only input, written by its agents' `A_dispatch`. */
  inTool: 'in_tool',
  idle: 'idle',
  running: 'running',
  done: 'done',
  waiting: 'waiting',
  stopped: 'stopped',
  skipped: 'skipped',
  /** The generic join's "some input carried data" marker. */
  hasdata: 'hasdata',
  /** The collapsed routing's single "the outcome has been delivered" marker. */
  routed: 'routed',
  retry: 'retry',
  tries: 'tries',
  /**
   * Engine v2's per-node count of live incoming edges (`tasks/v2-profile-plan.md` decision 3): a
   * host place, because every producer writes it. Only the `engineV2` settlement gadget has one.
   */
  live: 'live',
  /**
   * `B/ended`: an `engineV2` batch node's "the loop has ended" marker, written by its terminal
   * pass (`isTerminalStep`, decision 5). Local to the batch node, the only writer.
   */
  ended: 'ended',
} as const;

/** An agent's round places (README "Agent tool dispatch"). */
export const AGENT_PLACE = {
  routedRequest: 'routed_req',
  queue: 'queue',
  calls: 'calls',
  drained: 'drained',
  outstanding: 'outstanding',
  dispatched: 'dispatched',
  rounds: 'rounds',
  response: 'response',
  /**
   * `A/running_failed`: the running place `A_calls_out`'s re-entry lands on, consumed only by
   * `A_run_failed`. It replaces steering the primary run with an inhibitor: the primary run is
   * now structurally unreachable from `A_calls_out`, so a linear ranking can bound the round.
   * It carries the re-entry unit for one step and never rests (`A_run_failed` is always
   * enabled once it holds a token).
   */
  runningFailed: 'running_failed',
} as const;

/** `X/in`: the direct form's edge place, or the synthetic one of a node with no producer. */
export function inPlaceOf(id: string): string {
  return qualified(id, PLACE.in);
}

/**
 * `e${edgeId}/arrived`: engine v2's "this edge's source step has settled" (decision 3). A host
 * place per edge, named after the edge rather than its consumer, since producer and consumer bind
 * it alike. No node gadget declares a local place of that name, so no node prefix collides.
 */
export function arrivedPlaceOf(edgeId: number): string {
  return qualified(`e${edgeId}`, 'arrived');
}

/** `X/live`: the {@link PLACE}`.live` host place of an `engineV2` node. */
export function livePlaceOf(id: string): string {
  return qualified(id, PLACE.live);
}

/** `X/skipped`: written by `X_skip`, or a host-level marker a referencing twin reads. */
export function skippedPlaceOf(id: string): string {
  return qualified(id, PLACE.skipped);
}

/** A join input's free slot: `free_${i}`. */
export function freeOf(inputIndex: number): string {
  return `free_${inputIndex}`;
}

/** A join input's single ready place, or an OR input's round counter: `ready_${i}`. */
export function readyOf(inputIndex: number): string {
  return `ready_${inputIndex}`;
}

/** A required choose-branch input's ready place for one variant: `ready_${i}_${variant}`. */
export function readyVariantOf(inputIndex: number, variant: Variant): string {
  return `ready_${inputIndex}_${variant}`;
}

/** An OR input's "a data arrival is waiting" marker: `hasdata_${i}`. */
export function hasdataOf(inputIndex: number): string {
  return `hasdata_${inputIndex}`;
}

/** An OR input's "this round started a run" marker: `ran_${i}`. */
export function ranOf(inputIndex: number): string {
  return `ran_${inputIndex}`;
}

/** A cyclic producer's `nil` for one output: `nil_${o}`. */
export function nilOf(outputIndex: number): string {
  return `nil_${outputIndex}`;
}

/** A split node's per-output success marker: `ok_${o}`. */
export function okOf(outputIndex: number): string {
  return `ok_${outputIndex}`;
}

/** A split node's per-output routed marker: `routed_${o}`. */
export function routedOf(outputIndex: number): string {
  return `routed_${outputIndex}`;
}

/** An `onFailure` attempt's running place past the first: `running_${k}` (ADR 0009). */
export function runningOf(attempt: number): string {
  return `running_${attempt}`;
}

/** An `onFailure` attempt's failure place: `failed_${k}` (ADR 0009). */
export function failedOf(attempt: number): string {
  return `failed_${attempt}`;
}

/** An `onFailure` attempt's deadline place, funnelled into `failed_${k}`: `timedout_${k}` (IO-013). */
export function timedOutOf(attempt: number): string {
  return `timedout_${attempt}`;
}
