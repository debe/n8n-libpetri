/**
 * Errors the scheduler raises inside a node run, shaped like n8n's own so
 * `reportNodeExecutionError` (`{ ...e, message, stack }`) and the task data record them the
 * way n8n records a `NodeOperationError` / `ExpressionError`. n8n's classes cannot be
 * imported (n8n-workflow is not a runtime dependency), so these mirror the enumerable
 * fields `ExecutionBaseError` carries: `name`, `description`, `context`, `timestamp`,
 * `functionality`, `level`, plus `node` for the node-scoped one.
 */
import type { INode } from 'n8n-workflow';

/** Mirror of `NodeOperationError` (name, node, description, level `'warning'`). */
export class SchedulerNodeError extends Error {
  readonly node: INode;
  readonly description: string | undefined;
  readonly context: Record<string, unknown> = {};
  readonly timestamp: number = Date.now();
  readonly functionality: 'regular' | 'pairedItem' = 'regular';
  readonly level: 'warning' | 'error' = 'warning';

  constructor(node: INode, message: string, description?: string) {
    super(message);
    Object.defineProperty(this, 'name', { value: 'NodeOperationError', writable: true, enumerable: true, configurable: true });
    this.node = node;
    this.description = description;
  }
}

/**
 * n8n's error for `$('Y')` on a node that has not run (`workflow-data-proxy.ts`, line 496
 * at `441970b`: an `ExpressionError` with the `messageTemplate` below). Raised before
 * `runNode` when the running token came through an `X_start_unmet` twin (README
 * "Expression references"), so the node fails under its own `onError` policy exactly as it
 * would have failed inside the expression.
 */
export const UNMET_REFERENCE_MESSAGE_TEMPLATE =
  'An expression references this node, but the node is unexecuted. Consider re-wiring your nodes or checking ' +
  'for execution first, i.e. {{ $if( $("{{nodeName}}").isExecuted, <action_if_executed>, "") }}';

export class UnmetReferenceError extends Error {
  readonly description: string;
  readonly context: Record<string, unknown>;
  readonly timestamp: number = Date.now();
  readonly functionality: 'pairedItem' = 'pairedItem';
  readonly level: 'warning' = 'warning';

  constructor(referenced: string) {
    super(`Node '${referenced}' hasn't been executed`);
    Object.defineProperty(this, 'name', { value: 'ExpressionError', writable: true, enumerable: true, configurable: true });
    this.description = UNMET_REFERENCE_MESSAGE_TEMPLATE.replace('{{nodeName}}', referenced);
    this.context = {
      messageTemplate: UNMET_REFERENCE_MESSAGE_TEMPLATE,
      nodeCause: referenced,
      descriptionKey: 'pairedItemNoConnection',
      type: 'paired_item_no_connection',
    };
  }
}

/**
 * An `EngineRequest` the compiled net has no dispatch branch for.
 *
 * Tool dispatch *is* supported (README "Agent tool dispatch"): the compiler gives an agent one
 * `A_dispatch` arm per node wired to it over `ai_tool`. An action naming anything else — a node
 * with no such connection, or one the analysis dropped because it also has a `main` producer —
 * cannot be routed, so it fails by name instead of dispatching part of the round.
 *
 * Reaching it with no `tool` names a different fault: `runNode` returned a request from a node
 * the compiler did not classify as an agent at all.
 */
export function engineRequestUnsupported(node: INode, tool?: string): SchedulerNodeError {
  if (tool === undefined) {
    return new SchedulerNodeError(
      node,
      `Node "${node.name}" returned an engine request, but it has no ai_tool connections, so the ` +
      'compiled net has no round to open for it',
      'Wire the tool nodes to the agent over ai_tool, or run this workflow on the default StackScheduler.',
    );
  }
  return new SchedulerNodeError(
    node,
    `Node "${node.name}" asked to run "${tool}" as a tool, but "${tool}" is not connected to it ` +
    'over ai_tool, so the compiled net has no dispatch branch for it',
    `Wire "${tool}" to "${node.name}" over ai_tool. A node that also has a main producer is not ` +
    'compiled as a tool; the compiler reports that as a diagnostic.',
  );
}

/**
 * An agent asked for more tool calls than its budget allows. Raised by the agent's own `X_run`
 * when `A_calls_out` re-enters it, so it is recorded and routed under the node's `onError`
 * policy exactly as `maxIterations` is when n8n's `checkMaxIterations` throws inside the node.
 *
 * The budget is the scheduler's, not n8n's (`DEFAULT_MAX_AGENT_TOOL_CALLS`), so the message
 * says where to raise it.
 */
export function toolCallBudgetExceeded(node: INode, undispatched: number, budget: number): SchedulerNodeError {
  return new SchedulerNodeError(
    node,
    `Tool-call budget (${budget}) reached: "${node.name}" requested ${undispatched} more tool call(s) than ` +
    'it may dispatch in this execution',
    'Raise it with options.maxToolCalls on the agent, or with maxAgentToolCalls when registering the ' +
    'scheduler. The budget counts every tool call across every round of one execution.',
  );
}

/**
 * An attempt overran its `executionPolicy.timeoutMs` and libpetri abandoned the firing
 * (IO-013, ADR 0009 §4).
 *
 * The node itself never threw — it may still be working, because IO-013 is explicit that
 * stopping abandoned work is "a capability, not a guarantee" — so the message says what the
 * engine did rather than blaming the node, and the hint names the knob.
 */
export function attemptDeadlineExceeded(node: INode, timeoutMs: number, attempt: number): SchedulerNodeError {
  return new SchedulerNodeError(
    node,
    `Attempt ${attempt} of "${node.name}" did not finish within ${timeoutMs} ms and was abandoned`,
    'Raise executionPolicy.timeoutMs on this node, or give it an onFailure step that retries. ' +
    'The node\'s own work is not cancelled: only its result is discarded.',
  );
}
