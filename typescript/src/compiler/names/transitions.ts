/**
 * Transition names: a gadget's fixed local transitions and the indexed ones of its references,
 * attempts, outputs and input arms. Re-exported through `names.ts`, the one import surface of
 * the vocabulary.
 */
import type { Variant } from '../types.js';

/** The fixed local transition names of a gadget. */
export const TRANSITION = {
  start: 'start',
  /** Attempt 1's run, and the only run of a policy-free node. */
  run: 'run',
  done: 'done',
  skip: 'skip',
  retryWait: 'retry_wait',
  exhausted: 'exhausted',
  doneRequest: 'done_req',
  dispatch: 'dispatch',
  collect: 'collect',
  resume: 'resume',
  callsOut: 'calls_out',
  roundsOut: 'rounds_out',
} as const;

/** The start twin reading the `k`-th reference's `skipped`: `start_unmet_${k}`. */
export function startUnmetOf(reference: number): string {
  return `start_unmet_${reference}`;
}

/**
 * An attempt's run transition. Attempt 1 keeps the name `run`, so every consumer that
 * addresses a node's run transition by name is the same with and without a policy.
 */
export function attemptRunOf(attempt: number): string {
  return attempt === 1 ? TRANSITION.run : `run_${attempt}`;
}

/** A split node's per-output routing transition: `route_${o}`. */
export function routeOf(outputIndex: number): string {
  return `route_${outputIndex}`;
}

/** A choose-branch skip for one data/empty combination: `skip_` plus each variant's initial. */
export function skipCombinationOf(combination: readonly Variant[]): string {
  return `skip_${combination.map((v) => v[0]).join('')}`;
}

/** An OR input's round-closing transition: `clear_${i}`. */
export function clearOf(inputIndex: number): string {
  return `clear_${inputIndex}`;
}

/** A join / OR arm for one edge and variant: `arm_e${edgeId}_${variant}`. */
export function armOf(edgeId: number, variant: Variant): string {
  return `arm_e${edgeId}_${variant}`;
}

/** An attempt's deadline funnel `timedout_k → failed_k`: `timeout_${k}`. */
export function deadlineOf(attempt: number): string {
  return `timeout_${attempt}`;
}

/** An attempt's `onFailure` step: `attempt_${k}`. */
export function attemptStepOf(attempt: number): string {
  return `attempt_${attempt}`;
}

/** A `nil` sink for one output: `sink_${o}`. */
export function sinkOf(outputIndex: number): string {
  return `sink_${outputIndex}`;
}
