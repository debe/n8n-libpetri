/**
 * The name vocabulary of the compiled net: every place and transition name `compile.ts` and
 * `gadget.ts` produce, and nothing else.
 *
 * A node's gadget is a `SubnetDef` instantiated at prefix `node.id` (MOD-010), so a place or
 * transition it declares under the local name `L` is `${id}/L` in the flat net (MOD-012) —
 * {@link qualified}. The host places `compile()` creates before composition (the
 * consumer-owned edge places, a producer-less node's synthetic `in`, a referenced node's
 * host-level `skipped`) are named exactly as the consumer's own instance would qualify the
 * port bound to them, so a host place's name is `qualified(consumer.id, port)` whichever file
 * builds it. The local names below are therefore also the port names.
 *
 * Every function is pure and total; the net-identity baseline pins the output byte for byte,
 * because `NetMap`, the marking codec, the verifier's reports and every stored marking address
 * places by these names.
 */
import type { Variant } from './types.js';

/** The flat-net name of a node-local place or transition: `${id}/${local}` (MOD-010, MOD-012). */
export function qualified(id: string, local: string): string {
  return `${id}/${local}`;
}

// ==================== places ====================

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
} as const;

/** The `empty` twin of an edge place or port: `${local}_empty`. */
export function emptyTwinOf(local: string): string {
  return `${local}_empty`;
}

/** A join / OR input's data port for one producer edge: `in${inputIndex}_e${edgeId}`. */
export function edgeInPortOf(inputIndex: number, edgeId: number): string {
  return `in${inputIndex}_e${edgeId}`;
}

/**
 * The consumer port an edge's data place binds to: {@link PLACE}`.in` in the direct form,
 * {@link edgeInPortOf} in a join or OR input. Its {@link emptyTwinOf} is the empty port.
 */
export function consumerPortOf(direct: boolean, inputIndex: number, edgeId: number): string {
  return direct ? PLACE.in : edgeInPortOf(inputIndex, edgeId);
}

/** A producer's output port for one edge: `out_e${edgeId}`. */
export function edgeOutPortOf(edgeId: number): string {
  return `out_e${edgeId}`;
}

/** `X/in`: the direct form's edge place, or the synthetic one of a node with no producer. */
export function inPlaceOf(id: string): string {
  return qualified(id, PLACE.in);
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

/** The read port a `$('Y')` reference binds to `Y/done`: `ref_${k}` (CORE-032). */
export function refDonePortOf(reference: number): string {
  return `ref_${reference}`;
}

/** The read port a start-unmet twin binds to `Y/skipped`: `refskip_${k}`. */
export function refSkippedPortOf(reference: number): string {
  return `refskip_${reference}`;
}

/** An agent's write port into its `k`-th tool's `in_tool`: `tool_${k}`. */
export function toolInPortOf(tool: number): string {
  return `tool_${tool}`;
}

/** A tool's write port into its `k`-th agent's `response`: `resp_${k}`. */
export function agentResponsePortOf(agent: number): string {
  return `resp_${agent}`;
}

// ==================== transitions ====================

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
