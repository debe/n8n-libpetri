/**
 * Errors the scheduler raises inside a node run, shaped like n8n's own so
 * `reportNodeExecutionError` (`{ ...e, message, stack }`) and the task data record them the
 * way n8n records a `NodeOperationError` / `ExpressionError`. n8n's classes cannot be
 * imported (n8n-workflow is not a runtime dependency), so these mirror the enumerable
 * fields `ExecutionBaseError` carries: `name`, `description`, `context`, `timestamp`,
 * `functionality`, `level`, plus `node` for the node-scoped one.
 *
 * {@link InternalSchedulerError} is the exception: it is the scheduler's own invariant broken,
 * not something a node did, so it carries none of those fields.
 *
 * The `NodeOperationError` mirror and the node failures raised as one live in
 * `node-failures.ts`; this module exports them as it always has.
 */
import type { ExecutionBaseError } from 'n8n-workflow';

export {
  attemptDeadlineExceeded, engineRequestUnsupported, SchedulerNodeError, toolCallBudgetExceeded,
} from './node-failures.js';

/**
 * n8n's serialisable error shape (`initializeExecution`, `reportNodeExecutionError`):
 * `{ ...e, message, stack }`. What the scheduler stores as the contract value for an error the
 * mirrored loop would have thrown out of `run()` — a hook rejecting, a host helper throwing
 * outside n8n's own `try` — so it reads like every other `executionError` n8n persists.
 */
export function asExecutionError(error: unknown): ExecutionBaseError {
  const e = (typeof error === 'object' && error !== null ? error : { message: String(error) }) as Error;
  return { ...e, message: e.message, stack: e.stack } as unknown as ExecutionBaseError;
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
 * A broken invariant of the scheduler itself (the `internal:` family): the compiled net, the
 * payloads the actions write and the actions that read them disagree. Never the workflow's
 * fault, so it has no code to act on; the message — the text it always was — says which
 * invariant failed. The scheduler's twin of the compiler's `InternalCompilerError`.
 */
export class InternalSchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalSchedulerError';
  }
}
