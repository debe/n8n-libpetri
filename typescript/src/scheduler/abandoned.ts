/**
 * The deadline guard of one attempt (ADR 0009 §4): whether the net disowned the firing an
 * action is still running for. The deadline funnel registers the run payload in
 * `state.abandoned`; every point where the action can still write to n8n asks here first.
 */
import type { ExecutionEnv } from './env.js';
import type { RunPayload } from './payloads.js';

/**
 * Whether the net disowned this attempt, **without announcing it**.
 *
 * {@link abandoned} is the announcing form and belongs at the points that decide what to return.
 * A guard that only has to suppress a write wants the question without the diagnostic, or the
 * same abandonment is reported twice for one attempt.
 */
export function isAbandoned(env: ExecutionEnv, payload: RunPayload): boolean {
  return env.state.abandoned.has(payload);
}

/**
 * Whether a deadline abandoned this activation's firing while it was still running.
 *
 * IO-013 discards what an abandoned firing wrote to the marking, but not what our action went
 * on to do to n8n: `postRun`, `record` and the hooks all write. A `runNode` that resolves after
 * the budget expired must therefore stop here, or the execution ends holding task data for an
 * attempt the net disowned and n8n reports a node the workflow already escalated past.
 *
 * Checked at each point the action can still write — after `runNode` resolves, after `postRun`,
 * and on the error path. The residual window is the inside of those awaits, which is the same
 * shape as divergence #15's `waitTill` race and is recorded with it.
 */
export function abandoned(env: ExecutionEnv, payload: RunPayload): boolean {
  if (!isAbandoned(env, payload)) return false;
  env.diagnostic(
    `node '${payload.executionData.node.name}': attempt ${payload.attempt + 1} finished after its ` +
    'deadline abandoned it; the late result is discarded and nothing is recorded for it');
  return true;
}
