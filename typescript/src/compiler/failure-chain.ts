/**
 * A node's failure vocabulary, read without the graph: n8n's clamped `retryOnFail` parameters
 * and the `onFailure` chain of ADR 0009, its output names resolved to indexes. `analyse()` calls
 * both per node; the only graph fact the chain needs — which outputs are connected — it is
 * handed.
 *
 * The retry clamps live in `failure-chain/retry-params.ts`, the fields a chain cannot sit beside
 * in `failure-chain/field-conflicts.ts`, and a `route` step's output resolution in
 * `failure-chain/route-target.ts`.
 */
import { assertNever } from '../internal/assert.js';
import { refuseDeadlineWithoutChain, fieldConflictsOf } from './failure-chain/field-conflicts.js';
import { routeTargetOf, type RouteTargets } from './failure-chain/route-target.js';
import { isTerminalAction, PolicyError, positiveInt, type FailureStep } from './policy.js';
import type { FailureChain, NodeDescription, NodeTypeShape, ResolvedStep } from './types.js';

export {
  DEFAULT_MAX_TRIES, MIN_MAX_TRIES, MAX_MAX_TRIES, DEFAULT_WAIT_BETWEEN_TRIES_MS, MAX_WAIT_BETWEEN_TRIES_MS, retryParamsOf,
} from './failure-chain/retry-params.js';

/** One declared step resolved for attempt `i + 1`; `undefined` when its `route` target recorded a problem. */
function resolveStep(step: FailureStep, i: number, targets: RouteTargets): ResolvedStep | undefined {
  const attempt = i + 1;
  switch (step.action) {
    case 'retry': return { attempt, action: 'retry', waitMs: step.waitMs ?? 0, nextAttempt: attempt + 1 };
    case 'route': {
      const outputIndex = routeTargetOf(targets, step.output, `onFailure[${i}]`);
      return outputIndex === undefined ? undefined : { attempt, action: 'route', outputIndex };
    }
    case 'stop':
    case 'continue': return { attempt, action: step.action };
    default: return assertNever(step, 'failure step');
  }
}

/**
 * `parseExecutionPolicy` already truncated at the first terminal, so this is a defence
 * against a hand-built description rather than against a workflow. Checked only once every
 * step resolved: a route step that was dropped is already a problem, and the gap it leaves
 * is not a second one.
 */
function endsTerminal(resolved: readonly ResolvedStep[], declared: number): boolean {
  if (resolved.length !== declared) return true;
  const last = resolved[resolved.length - 1];
  return last !== undefined && isTerminalAction(last.action);
}

function chainDiagnostic(where: string, steps: number, timeoutMs: number | undefined, last: ResolvedStep): string {
  return `${where}: onFailure declares ${steps} attempt(s)` +
    (timeoutMs === undefined ? '' : ` with a ${timeoutMs} ms deadline each`) +
    `, ending in '${last.action}'`;
}

/**
 * A node's declared `onFailure` into a {@link FailureChain}, with output names resolved.
 *
 * Rejects rather than guesses in three places, because each would otherwise run a net the
 * workflow did not describe: `onFailure` beside n8n's own `retryOnFail` / `onError` (the two
 * say the same thing at different resolutions), a `route` to an output the node does not have
 * or nobody wired (the emission rule writes connected outputs only, so the step would have
 * nowhere to put its token), and a `timeoutMs` with no chain to receive the expiry.
 *
 * Every fault is a {@link PolicyError}, and the faults of one chain are accumulated the way
 * `parseExecutionPolicy` accumulates its own, so an author sees every bad target at once
 * rather than one per compile.
 */
export function resolveFailureChain(
  node: NodeDescription,
  shape: NodeTypeShape,
  outputCount: number,
  errorOutputIndex: number | null,
  connectedOutputs: ReadonlySet<number>,
  diagnostics: string[],
): FailureChain | null {
  const policy = node.executionPolicy;
  if (policy === undefined) return null;
  const steps = policy.onFailure;
  const where = `node '${node.name}'`;
  if (steps === undefined) {
    refuseDeadlineWithoutChain(policy.timeoutMs, where);
    return null;
  }
  const problems = fieldConflictsOf(node, where);
  const targets: RouteTargets = { where, shape, outputCount, errorOutputIndex, connectedOutputs, problems };
  const resolved: ResolvedStep[] = [];
  steps.forEach((step, i) => {
    const r = resolveStep(step, i, targets);
    if (r !== undefined) resolved.push(r);
  });
  if (!endsTerminal(resolved, steps.length)) {
    problems.push(`${where}: executionPolicy.onFailure must end with a terminal step`);
  }
  positiveInt(policy.timeoutMs, `${where} timeoutMs`, problems);
  // `last` is undefined only when a step was dropped or the chain is empty, and both recorded
  // a problem; the second test is the same condition, written so the type says so.
  const last = resolved[resolved.length - 1];
  if (problems.length > 0 || last === undefined) throw new PolicyError(where, problems);
  diagnostics.push(chainDiagnostic(where, resolved.length, policy.timeoutMs, last));
  return { steps: resolved, timeoutMs: policy.timeoutMs ?? null };
}
