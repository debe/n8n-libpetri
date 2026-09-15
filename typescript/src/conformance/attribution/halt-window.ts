/**
 * Divergence #17's halt window: the one test every stop-aware rule of the register asks
 * ({@link inHaltWindow}) — the data rules, the one-sided rules and, through those, the
 * `lastNodeExecuted` rule — so tightening it is one change here.
 */
import type { SchedulerOutcome } from '../../scheduler/index.js';

/**
 * `halted`, `paused` or `cancelled`: the net stopped short of quiescence, so an activation
 * in flight at that moment finished under the net where n8n's `break` left it unrun — the
 * divergence #17 window every stop-aware rule tests for.
 */
export function isStoppedOutcome(outcome: SchedulerOutcome | null | undefined): boolean {
  return outcome === 'halted' || outcome === 'paused' || outcome === 'cancelled';
}

/**
 * Whether divergence #17's halt window can explain a difference in a run that ended with
 * `outcome`. The rule is coarse: in a stopped run, anything the net ran and n8n did not is
 * inside the window. A tighter rule needs the activation's trace start to fall after the
 * halting activation's, and the halting instant is not observable from the trace
 * (`tasks/todo.md`). Every #17 rule asks here, so tightening it is one change.
 */
export function inHaltWindow(outcome: SchedulerOutcome | null | undefined): boolean {
  return isStoppedOutcome(outcome);
}
