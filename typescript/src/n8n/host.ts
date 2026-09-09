/**
 * Structural mirrors of the n8n contracts the scheduler is plugged into. n8n packages are
 * **not** runtime dependencies of n8n-libpetri: everything n8n-specific is injected by the
 * process that hosts both (the conformance run's vitest setup shim), and `n8n-workflow` is
 * a type-only devDependency. The shapes below mirror
 * `patches/n8n/0001-extract-scheduler-loop.patch` (`workflow-scheduler.ts`) and
 * `0002-scheduler-registry.patch` (`scheduler-registry.ts`) at n8n `441970b`; the
 * conformance run type-checks the real thing against n8n's own `WorkflowExecute`.
 *
 * `SchedulerHost` is the `Pick<WorkflowExecute, …>` of the patch: the 30 members the
 * extracted loop (`stack-scheduler.ts`) uses — 27 methods plus `additionalData`, `mode`
 * and the `abortSignal` getter. Signatures are copied from `workflow-execute.ts`.
 */
import type {
  EngineRequest, EngineResponse, ExecutionBaseError, IConnection, IExecuteData, INode, INodeExecutionData,
  INodeInputConfiguration, INodeOutputConfiguration, INodeTypeDescription, IRunData, IRunExecutionData,
  IRunNodeResponse, ITaskData, ITaskDataConnections, ITaskMetadata, ITaskStartedData,
  IWorkflowExecuteAdditionalData, NodeConnectionType, Workflow, WorkflowExecuteMode,
} from 'n8n-workflow';

/** The members of `WorkflowExecute` a scheduler drives (patch 0001, `SchedulerHost`). */
/**
 * One entry of n8n's `NodeToBeExecuted` (`requests-response.ts`), structurally. Fed straight
 * back to {@link SchedulerHost.addNodeToBeExecuted} so n8n's own construction builds the
 * `IExecuteData` and nothing about `data`, `source`, `runIndex` or `metadata` is mirrored here.
 */
export interface PlannedNode {
  readonly inputConnectionData: IConnection;
  readonly parentOutputIndex: number;
  readonly parentNode: string;
  readonly parentOutputData: INodeExecutionData[][];
  readonly runIndex: number;
  readonly nodeRunIndex: number;
  readonly metadata?: ITaskMetadata;
}

export interface SchedulerHost {
  readonly additionalData: IWorkflowExecuteAdditionalData;
  readonly mode: WorkflowExecuteMode;
  /** Aborted when the execution is cancelled. Every node run listens to it. */
  readonly abortSignal: AbortSignal;

  addNodeToBeExecuted(
    workflow: Workflow,
    connectionData: IConnection,
    outputIndex: number,
    parentNodeName: string,
    nodeSuccessData: INodeExecutionData[][],
    runIndex: number,
    newRunIndex?: number,
    metadata?: ITaskMetadata,
  ): void;
  addPairedItemLineage(executionData: IExecuteData): ITaskDataConnections;
  assignPairedItems(
    nodeSuccessData: INodeExecutionData[][] | null | undefined,
    executionData: IExecuteData,
  ): INodeExecutionData[][] | null;
  collectSubNodeResults(executionData: IExecuteData, subNodeExecutionResults: EngineResponse): void;
  computeRunIndex(executionData: IExecuteData): number;
  createTaskData(taskStartedData: ITaskStartedData, executionData: IExecuteData): ITaskData;
  createTaskStartedData(executionData: IExecuteData): ITaskStartedData;
  ensureAlwaysOutputData(
    nodeSuccessData: INodeExecutionData[][] | null | undefined,
    executionData: IExecuteData,
  ): INodeExecutionData[][] | null | undefined;
  ensureInputData(workflow: Workflow, executionNode: INode, executionData: IExecuteData): boolean;
  getPinnedOutput(node: INode): INodeExecutionData[][] | undefined;
  getRetryParams(executionData: IExecuteData): [number, number];
  /**
   * n8n's `handleRequest` (`requests-response.ts`) **without** the stack push: the planned tool
   * activations plus the agent's own re-entry, in the order `handleEngineRequest` would have
   * added them. It reserves each tool's `runData` slot, tags `node.rewireOutputLogTo` and builds
   * the `preservedSourceOverwrite` metadata, so reusing it is what keeps every `IExecuteData`
   * byte-identical to the stack scheduler's.
   *
   * Returns `[]` when the parent node cannot be found, exactly as n8n does, and the caller then
   * treats the request as producing no output rather than opening a round.
   *
   * The net decides *when* these run; the host only builds them.
   */
  planEngineRequest(args: {
    workflow: Workflow;
    currentNode: INode;
    request: EngineRequest;
    runIndex: number;
    executionData: IExecuteData;
    runData: IRunData;
  }): PlannedNode[];

  handleEngineRequest(args: {
    workflow: Workflow;
    currentNode: INode;
    request: EngineRequest;
    runIndex: number;
    executionData: IExecuteData;
    runData: IRunData;
  }): void;
  handleNodeExecutionError(args: {
    executionNode: INode;
    executionData: IExecuteData;
    taskData: ITaskData;
    executionError: ExecutionBaseError;
    nodeSuccessData: INodeExecutionData[][] | null | undefined;
    runIndex: number;
    hooks: SchedulerHooks;
  }): Promise<{ continueExecution: boolean; nodeSuccessData: INodeExecutionData[][] | null | undefined }>;
  isExecutionStackNotEmpty(): boolean;
  isLegacyExecutionOrder(workflow: Workflow): boolean;
  isNodeFilteredOut(nodeName: string): boolean;
  normalizeNodeErrors(nodeSuccessData: INodeExecutionData[][]): void;
  popExecutionStack(): IExecuteData;
  processNodeOutput(
    runNodeData: IRunNodeResponse,
    workflow: Workflow,
    executionData: IExecuteData,
    taskStartedData: ITaskStartedData,
    runIndex: number,
  ): Promise<{ nodeSuccessData: INodeExecutionData[][] | null | undefined; closeFunction: Promise<void> | undefined }>;
  pushExecutionStack(executionData: IExecuteData): void;
  recordDynamicCredentialsUser(): void;
  reportNodeExecutionError(error: unknown, executionNode: INode, workflow: Workflow): ExecutionBaseError;
  resetDynamicCredentialsUsage(executionData: IExecuteData): void;
  rewireOutputLog(executionNode: INode, taskData: ITaskData, nodeSuccessData: INodeExecutionData[][], runIndex: number): void;
  runNode(
    workflow: Workflow,
    executionData: IExecuteData,
    runExecutionData: IRunExecutionData,
    runIndex: number,
    additionalData: IWorkflowExecuteAdditionalData,
    mode: WorkflowExecuteMode,
    abortSignal?: AbortSignal,
    subNodeExecutionResults?: EngineResponse,
  ): Promise<IRunNodeResponse | EngineRequest>;
  shouldStopExecuting(): boolean;
  upsertTaskData(nodeName: string, runIndex: number, taskData: ITaskData): void;
}

/**
 * The two lifecycle hooks the loop runs (`ExecutionLifecycleHooks.runHook` in n8n-core),
 * as a structural mirror: `nodeExecuteBefore(nodeName, taskStartedData)` and
 * `nodeExecuteAfter(nodeName, taskData, runExecutionData)`.
 */
export interface SchedulerHooks {
  runHook(hookName: 'nodeExecuteBefore', parameters: [nodeName: string, data: ITaskStartedData]): Promise<void>;
  runHook(
    hookName: 'nodeExecuteAfter',
    parameters: [nodeName: string, data: ITaskData, executionData: IRunExecutionData],
  ): Promise<void>;
}

/**
 * Mirror of patch 0001's `WorkflowScheduler`: `processRunExecutionData()` creates one per
 * execution, calls `run()` once and reads `executionError` / `closeFunction` afterwards
 * (`closeFunction` also when `run()` rejected, to deactivate the trigger).
 */
export interface WorkflowScheduler {
  /** The error of the node that stopped the execution, if one did. */
  readonly executionError: ExecutionBaseError | undefined;
  /** The close function of the last node that registered one, e.g. a manual trigger. */
  readonly closeFunction: Promise<void> | undefined;
  run(host: SchedulerHost, workflow: Workflow, runExecutionData: IRunExecutionData, hooks: SchedulerHooks): Promise<void>;
}

/** Mirror of patch 0002's `WorkflowSchedulerFactory`. */
export type WorkflowSchedulerFactory = () => WorkflowScheduler;

/** Mirror of patch 0002's `setWorkflowSchedulerFactory`. */
export type SetWorkflowSchedulerFactory = (next: WorkflowSchedulerFactory) => void;

/**
 * The two `NodeHelpers` functions the adapter needs from `n8n-workflow` (`node-helpers.ts`):
 * they evaluate a node type's dynamic `inputs` / `outputs` expressions against the node's
 * parameters, and `getNodeOutputs` appends the error output under `continueErrorOutput`.
 */
export interface NodeHelpersLike {
  getNodeInputs(
    workflow: Workflow,
    node: INode,
    nodeTypeData: INodeTypeDescription,
  ): Array<NodeConnectionType | INodeInputConfiguration>;
  getNodeOutputs(
    workflow: Workflow,
    node: INode,
    nodeTypeData: INodeTypeDescription,
  ): Array<NodeConnectionType | INodeOutputConfiguration>;
}

/** `IRunExecutionData.executionData`, made non-optional. */
export type ExecutionDataState = NonNullable<IRunExecutionData['executionData']>;
