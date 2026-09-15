/**
 * A node's failure vocabulary, read without the graph: n8n's clamped `retryOnFail` parameters
 * and the `onFailure` chain of ADR 0009, its output names resolved to indexes. `analyse()` calls
 * both per node; the only graph fact the chain needs — which outputs are connected — it is
 * handed.
 */
import { assertNever } from '../internal/assert.js';
import { isTerminalAction, PolicyError, positiveInt } from './policy.js';
import type { FailureChain, NodeDescription, NodeTypeShape, ResolvedStep, RetryParams } from './types.js';

/**
 * n8n's retry parameters as `WorkflowExecute.getRetryParams` reads them
 * (`workflow-execute.ts` @ `441970b`, lines 1801–1811):
 * `maxTries = min(5, max(2, node.maxTries || 3))`,
 * `waitBetweenTries = min(5000, max(0, node.waitBetweenTries || 1000))`.
 * `0`, `undefined` and `NaN` are falsy and take the default; out-of-range values are
 * clamped; nothing is rejected.
 */
export const DEFAULT_MAX_TRIES = 3;
export const MIN_MAX_TRIES = 2;
export const MAX_MAX_TRIES = 5;
export const DEFAULT_WAIT_BETWEEN_TRIES_MS = 1000;
export const MAX_WAIT_BETWEEN_TRIES_MS = 5000;

/** The clamped retry parameters of a `retryOnFail` node (see the constants above). */
export function retryParamsOf(node: Pick<NodeDescription, 'maxTries' | 'waitBetweenTries'>): RetryParams {
  return {
    maxTries: Math.min(MAX_MAX_TRIES, Math.max(MIN_MAX_TRIES, node.maxTries || DEFAULT_MAX_TRIES)),
    waitBetweenTries: Math.min(MAX_WAIT_BETWEEN_TRIES_MS, Math.max(0, node.waitBetweenTries || DEFAULT_WAIT_BETWEEN_TRIES_MS)),
  };
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
  const problems: string[] = [];

  if (steps === undefined) {
    if (policy.timeoutMs !== undefined) {
      throw new PolicyError(where, [
        `${where}: executionPolicy.timeoutMs needs an onFailure chain to say what an expired ` +
        'attempt does']);
    }
    return null;
  }
  if (node.retryOnFail === true) {
    problems.push(
      `${where}: executionPolicy.onFailure and retryOnFail both set; onFailure is the same ` +
      'policy at a finer resolution, so declare one of them');
  }
  // `continueErrorOutput` is allowed beside a chain, and is the only way to get a second arc
  // out of a node that has one main output: `NodeHelpers.getNodeOutputs` appends the error
  // output purely on this field, which is what makes the editor draw the port and lets a user
  // wire it. So the two divide cleanly — `onError` declares the *shape*, `onFailure` decides
  // the *policy* — and a `route` step can then name `'error'`.
  //
  // `continueRegularOutput` is refused because it declares no port and claims the terminal the
  // chain already owns.
  if (node.onError !== undefined
    && node.onError !== 'stopWorkflow'
    && node.onError !== 'continueErrorOutput') {
    problems.push(
      `${where}: executionPolicy.onFailure and onError '${node.onError}' both set; the chain's ` +
      "last step is this node's error policy, so declare one of them (onError " +
      "'continueErrorOutput' is the exception: it declares the error output the chain routes to)");
  }

  /** An output name or index into a connected output index; `undefined` records a problem. */
  const outputOf = (raw: string | number, at: string): number | undefined => {
    // A node with no outputs at all cannot route anywhere, and the commonest one by far is an
    // `ai_tool` node — whose result is its agent's response, not a main edge — so the message
    // names that rather than leaving the author to work out why an index is out of range.
    if (outputCount === 0) {
      problems.push(
        `${where}: ${at} declares action 'route', but this node has no output to route to ` +
        "(a tool's result goes to its agent rather than down a main edge). Use 'retry', " +
        "'stop' or 'continue'");
      return undefined;
    }
    let index: number;
    if (typeof raw === 'number') {
      index = raw;
    } else if (raw === 'error' && errorOutputIndex !== null) {
      index = errorOutputIndex;
    } else {
      const named = shape.outputNames?.indexOf(raw) ?? -1;
      if (named < 0) {
        problems.push(
          `${where}: ${at} routes to output '${raw}', which this node type does not name` +
          (shape.outputNames === undefined
            ? ' (the node type declares no output names; use an index)'
            : ` (it names ${shape.outputNames.map((n) => `'${n}'`).join(', ')})`));
        return undefined;
      }
      index = named;
    }
    if (index >= outputCount) {
      problems.push(
        `${where}: ${at} routes to output ${index}, but the node has ${outputCount}`);
      return undefined;
    }
    if (!connectedOutputs.has(index)) {
      problems.push(
        `${where}: ${at} routes to output ${index}, which has no connection; wire it or ` +
        "use 'stop' / 'continue'");
      return undefined;
    }
    return index;
  };

  const resolved: ResolvedStep[] = [];
  steps.forEach((step, i) => {
    const at = `onFailure[${i}]`;
    const attempt = i + 1;
    switch (step.action) {
      case 'retry':
        resolved.push({ attempt, action: 'retry', waitMs: step.waitMs ?? 0, nextAttempt: attempt + 1 });
        break;
      case 'route': {
        const outputIndex = outputOf(step.output, at);
        if (outputIndex !== undefined) resolved.push({ attempt, action: 'route', outputIndex });
        break;
      }
      case 'stop':
      case 'continue':
        resolved.push({ attempt, action: step.action });
        break;
      default: assertNever(step, 'failure step');
    }
  });
  // `parseExecutionPolicy` already truncated at the first terminal, so this is a defence
  // against a hand-built description rather than against a workflow. Checked only once every
  // step resolved: a route step that was dropped is already a problem, and the gap it leaves
  // is not a second one.
  const last = resolved[resolved.length - 1];
  if (resolved.length === steps.length && (last === undefined || !isTerminalAction(last.action))) {
    problems.push(`${where}: executionPolicy.onFailure must end with a terminal step`);
  }
  positiveInt(policy.timeoutMs, `${where} timeoutMs`, problems);
  // `last` is undefined only when a step was dropped or the chain is empty, and both recorded
  // a problem; the second test is the same condition, written so the type says so.
  if (problems.length > 0 || last === undefined) throw new PolicyError(where, problems);
  diagnostics.push(
    `${where}: onFailure declares ${resolved.length} attempt(s)` +
    (policy.timeoutMs === undefined ? '' : ` with a ${policy.timeoutMs} ms deadline each`) +
    `, ending in '${last.action}'`);
  return { steps: resolved, timeoutMs: policy.timeoutMs ?? null };
}
