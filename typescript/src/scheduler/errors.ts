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

/** AI-agent `EngineRequest` / `EngineResponse` tool dispatch is out of scope for the PetriScheduler. */
export function engineRequestUnsupported(node: INode): SchedulerNodeError {
  return new SchedulerNodeError(
    node,
    `Node "${node.name}" returned an engine request (AI-agent tool dispatch), which the n8n-libpetri ` +
    'PetriScheduler does not support',
    'EngineRequest / EngineResponse handling (collectSubNodeResults, handleEngineRequest) is out of scope for ' +
    'the Petri-net scheduler; run this workflow on the default StackScheduler.',
  );
}
