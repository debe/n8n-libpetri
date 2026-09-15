/**
 * The {@link SchedulerState} one `PetriScheduler` keeps across its runs: created once, and
 * reset field by field at the start of every `run()`. The deadline bookkeeping (`abandoned`,
 * `startedData`) is keyed on run-payload identity and is never reset: a payload of an earlier
 * run can never be looked up again.
 */
import type { SchedulerState } from './env.js';

/** The state of a scheduler that has not run yet. */
export function initialState(): SchedulerState {
  return {
    haltError: undefined, leftoverError: undefined, closeFunction: undefined, fatal: undefined,
    waitingNode: undefined, waitTillAtStart: undefined,
    inFlight: 0, maxInFlight: 0, abandoned: new WeakSet(), startedData: new WeakMap(),
  };
}

/**
 * Everything a `run()` leaves behind in `state` is reset here, so a second `run()` on one
 * instance starts from nothing: in particular the close function, which n8n awaits at the end
 * of the execution that produced it and must never inherit from an earlier one.
 */
export function resetState(state: SchedulerState, waitTillAtStart: Date | undefined): void {
  state.haltError = undefined;
  state.leftoverError = undefined;
  state.closeFunction = undefined;
  state.fatal = undefined;
  state.waitingNode = undefined;
  state.waitTillAtStart = waitTillAtStart;
  state.inFlight = 0;
  state.maxInFlight = 0;
}
