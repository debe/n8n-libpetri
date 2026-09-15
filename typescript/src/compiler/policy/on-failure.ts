/**
 * `executionPolicy.onFailure`, layer 1 into layer 2: each step checked on its own, then the
 * chain as a whole cut at its first terminal step. Problems and diagnostics accumulate on the
 * caller's lists, so `parseExecutionPolicy` reports a chain's every fault in one error.
 */
import { assertNever } from '../../internal/assert.js';
import type { FailureStep } from '../policy.js';
import { FAILURE_ACTIONS, isFailureAction, isTerminalAction } from './failure-action.js';
import { isRecord, nonNegativeInt } from './values.js';

const KNOWN_STEP_KEYS: ReadonlySet<string> = new Set(['waitMs', 'action', 'output']);

/** A `route` step's target: an output name, or a non-negative integer index. */
function parseRouteStep(output: unknown, at: string, problems: string[]): FailureStep | undefined {
  if (typeof output !== 'string' && typeof output !== 'number') {
    problems.push(`${at}.output is required by action 'route' (an output name or index)`);
    return undefined;
  }
  if (typeof output === 'number' && (!Number.isInteger(output) || output < 0)) {
    problems.push(`${at}.output must be a non-negative integer index, got ${JSON.stringify(output)}`);
    return undefined;
  }
  return { action: 'route', output };
}

function parseStep(
  raw: unknown, index: number, problems: string[], diagnostics: string[], where: string,
): FailureStep | undefined {
  const at = `${where}.onFailure[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${at} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_STEP_KEYS.has(key)) diagnostics.push(`${at}: unknown key '${key}'; ignored`);
  }

  const action = raw['action'];
  if (!isFailureAction(action)) {
    problems.push(`${at}.action must be one of ${FAILURE_ACTIONS.join(', ')}, got ${JSON.stringify(action)}`);
    return undefined;
  }

  const waitMs = nonNegativeInt(raw['waitMs'], `${at}.waitMs`, problems);
  if (waitMs !== undefined && action !== 'retry') {
    diagnostics.push(`${at}: waitMs is meaningful only on 'retry'; ignored for '${action}'`);
  }

  // `output` is required by `route` and rejected elsewhere: a `stop` carrying an output is a
  // policy whose author expected routing, and honouring the stop silently would hide that.
  const output = raw['output'];
  if (action === 'route') return parseRouteStep(output, at, problems);
  if (output !== undefined) {
    problems.push(`${at}.output is only valid on action 'route', not '${action}'`);
    return undefined;
  }

  switch (action) {
    case 'retry': return waitMs === undefined ? { action } : { waitMs, action };
    case 'stop':
    case 'continue': return { action };
    default: return assertNever(action, 'failure action');
  }
}

/**
 * The chain runs to its first terminal step. A chain of nothing but `retry` never ends
 * an activation and would strand the last attempt's failure, so it is an error. Steps
 * *after* the first terminal are merely unreachable, which is a diagnostic: rejecting
 * them would refuse a workflow whose author simply listed one escalation too many.
 */
function throughFirstTerminal(
  steps: readonly FailureStep[], where: string, problems: string[], diagnostics: string[],
): FailureStep[] | undefined {
  const terminal = steps.findIndex((step) => isTerminalAction(step.action));
  const terminalStep = steps[terminal];
  if (terminalStep === undefined) {
    problems.push(
      `${where}.onFailure is all 'retry', so the last attempt's failure has nowhere to go; ` +
      "end the chain with 'route', 'stop' or 'continue'");
    return undefined;
  }
  if (terminal < steps.length - 1) {
    const first = terminal + 1;
    const last = steps.length - 1;
    const which = first === last ? `step ${first}` : `steps ${first}..${last}`;
    diagnostics.push(
      `${where}.onFailure: step ${terminal} ('${terminalStep.action}') ends the ` +
      `activation, so ${which} cannot be reached; ignored`);
  }
  return steps.slice(0, terminal + 1);
}

/**
 * `raw.onFailure` into its steps, cut at the first terminal one; `undefined` when absent or when
 * a problem was recorded. The chain is judged only once every step parsed: a step that did not
 * is already a problem, and the gap it leaves is not a second one.
 */
export function parseOnFailure(
  rawSteps: unknown, where: string, problems: string[], diagnostics: string[],
): FailureStep[] | undefined {
  if (rawSteps === undefined) return undefined;
  if (!Array.isArray(rawSteps)) {
    problems.push(`${where}.onFailure must be an array of steps`);
    return undefined;
  }
  if (rawSteps.length === 0) {
    problems.push(`${where}.onFailure must name at least one step`);
    return undefined;
  }
  const steps: FailureStep[] = [];
  rawSteps.forEach((step: unknown, i) => {
    const parsed = parseStep(step, i, problems, diagnostics, where);
    if (parsed !== undefined) steps.push(parsed);
  });
  if (steps.length !== rawSteps.length) return undefined;
  return throughFirstTerminal(steps, where, problems, diagnostics);
}
