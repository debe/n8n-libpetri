/**
 * The foundation of the `FakeHost` mirror: the run's state — its data, its additional data
 * and mode, its cancellation — and the recorder every member writes, `calls`, which holds
 * every host call in order. The layers above add the `SchedulerHost` members in the order
 * n8n's loop calls them; `FakeHost` is the whole host.
 */
import type { IRunData, IRunExecutionData, IWorkflowExecuteAdditionalData, Workflow, WorkflowExecuteMode } from 'n8n-workflow';
import type { ExecutionDataState } from '../../n8n/host.js';

export interface FakeHostOptions {
  readonly mode?: WorkflowExecuteMode;
  readonly ensureInputData?: boolean;
}

export abstract class HostState {
  /** Every host call and hook, in order: `method(node)` / `method` / `hook:name(node)`. */
  readonly calls: string[] = [];
  readonly additionalData: IWorkflowExecuteAdditionalData;
  readonly mode: WorkflowExecuteMode;
  status: 'running' | 'canceled' = 'running';
  timedOut = false;
  private readonly abortController = new AbortController();

  constructor(
    readonly workflow: Workflow,
    readonly runExecutionData: IRunExecutionData,
    protected readonly options: FakeHostOptions = {},
  ) {
    this.additionalData = {
      currentNodeExecutionIndex: 0,
      currentNodeUsedDynamicCredentials: false,
      currentNodeAttemptedDynamicCredentials: false,
      executionId: 'exec-1',
    } as unknown as IWorkflowExecuteAdditionalData;
    this.mode = options.mode ?? 'manual';
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /** n8n's `setupCancellation` callback: status canceled, then abort. */
  cancel(): void {
    this.status = 'canceled';
    this.abortController.abort();
  }

  protected record(method: string, node?: string): void {
    this.calls.push(node === undefined ? method : `${method}(${node})`);
  }

  /** `executionData`: the stack, the waiting slots and the context, which every run has. */
  protected get exec(): ExecutionDataState {
    return this.runExecutionData.executionData!;
  }

  protected get runData(): IRunData {
    return this.runExecutionData.resultData.runData;
  }
}
