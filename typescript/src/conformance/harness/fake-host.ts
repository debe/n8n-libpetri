/**
 * `FakeHost`: the 30 `SchedulerHost` members with canned `runNode` outputs per node and a
 * recorder of every host call in order (`calls`). The methods mirror what `WorkflowExecute`
 * does at n8n `441970b` closely enough for `runData`, `source` and `pairedItem` to come out
 * in n8n's shape.
 */
import type {
  EngineRequest, EngineResponse, ExecutionBaseError, IConnection, IDataObject, IExecuteData, INode,
  INodeExecutionData, IPairedItemData, IRunData, IRunExecutionData, IRunNodeResponse, ITaskData,
  ITaskDataConnections, ITaskMetadata, ITaskStartedData, IWorkflowExecuteAdditionalData, Workflow,
  WorkflowExecuteMode,
} from 'n8n-workflow';
import type { ExecutionDataState, PlannedNode, SchedulerHooks, SchedulerHost } from '../../n8n/host.js';
import { passThrough, type NodeScript, type ScriptContext } from './scripts.js';

export interface FakeHostOptions {
  readonly mode?: WorkflowExecuteMode;
  readonly ensureInputData?: boolean;
}

type EngineRequestArgs = Parameters<SchedulerHost['planEngineRequest']>[0];

/**
 * One slot a tool round reserves: `initializeNodeRunData`'s `runData` entry for the tool,
 * and the `rewireOutputLogTo` tag on its node.
 */
interface ToolReservation {
  readonly nodeName: string;
  readonly node: INode;
  readonly type: IConnection['type'];
  readonly slot: ITaskData;
}

/** A tool round as `handleRequest` builds it: the entries it returns and the slots it reserves. */
interface ToolRound {
  readonly planned: PlannedNode[];
  readonly reservations: readonly ToolReservation[];
  /**
   * Set when an action names a node the workflow lacks. `handleRequest` walks the actions in
   * order, reserving each before it looks at the next, so the actions before the unknown one
   * keep their slots and tags: the caller reserves {@link reservations}, then throws this.
   */
  readonly error?: Error;
}

/**
 * The round `handleRequest` (`requests-response.ts:238`) builds for an agent's
 * `EngineRequest`, and the slots it reserves — computed, not written: one `runData` slot
 * and one `rewireOutputLogTo` tag per action, the agent's re-entry with `nodeWasResumed` and
 * `subNodeExecutionData`, and — under v1 — the actions reversed so a LIFO stack would run them
 * in request order. The agent's own entry comes first, as `unshift` puts it.
 */
function planToolRound(args: EngineRequestArgs): ToolRound {
  const { workflow, currentNode, request, runIndex, executionData, runData } = args;
  const parentSource = executionData.source?.main?.[0];
  // `prepareRequestingNodeForResuming`: no parent, no round (`requests-response.ts:186`).
  if (parentSource?.previousNode === undefined) return { planned: [], reservations: [] };
  const parentOutputIndex = parentSource.previousNodeOutput ?? 0;
  const parentRunIndex = parentSource.previousNodeRun ?? 0;

  const actions: Array<{ action: unknown; nodeName: string; runIndex: number }> = [];
  const tools: PlannedNode[] = [];
  const reservations: ToolReservation[] = [];
  /** Slots this round has already claimed per node, on top of what `runData` holds. */
  const claimed = new Map<string, number>();
  let error: Error | undefined;
  for (const action of request.actions as Array<{
    nodeName: string; input?: IDataObject; type: IConnection['type']; id: string;
  }>) {
    const node = workflow.nodes[action.nodeName];
    if (node === undefined) {
      error = new Error(`Workflow does not contain a node with the name of "${action.nodeName}".`);
      break;
    }
    const agentInput = executionData.data.main?.[0]?.[0];
    const json = { ...(agentInput?.json ?? {}), ...(action.input ?? {}), toolCallId: action.id };
    const display = { ...(action.input ?? {}) };
    // `initializeNodeRunData`: the slot is reserved *before* the tool runs, which is why
    // running the tools concurrently cannot scramble which slot each one writes.
    const before = claimed.get(action.nodeName) ?? 0;
    claimed.set(action.nodeName, before + 1);
    const nodeRunIndex = (runData[action.nodeName]?.length ?? 0) + before;
    reservations.push({
      nodeName: action.nodeName,
      node,
      type: action.type,
      slot: {
        inputOverride: { ai_tool: [[{ json: display }]] },
        source: [{ previousNode: currentNode.name, previousNodeOutput: parentOutputIndex, previousNodeRun: runIndex }],
        executionIndex: 0, executionTime: 0, startTime: 0,
      } as unknown as ITaskData,
    });
    tools.push({
      inputConnectionData: { type: action.type, node: action.nodeName, index: 0 },
      parentOutputIndex: 0,
      parentNode: currentNode.name,
      parentOutputData: [[{ json, pairedItem: { item: parentRunIndex, input: parentOutputIndex } }]],
      runIndex,
      nodeRunIndex,
    });
    actions.push({ action, nodeName: action.nodeName, runIndex: nodeRunIndex });
  }
  if (workflow.settings.executionOrder === 'v1') tools.reverse();
  const planned: PlannedNode[] = [{
    inputConnectionData: { type: 'ai_tool', node: currentNode.name, index: 0 } as IConnection,
    parentOutputIndex: 0,
    parentNode: parentSource.previousNode,
    parentOutputData: executionData.data.main as INodeExecutionData[][],
    runIndex,
    nodeRunIndex: runIndex,
    metadata: {
      nodeWasResumed: true,
      subNodeExecutionData: { actions, metadata: request.metadata },
    } as unknown as ITaskMetadata,
  }, ...tools];
  return { planned, reservations, ...(error === undefined ? {} : { error }) };
}

/** Write a round's reservations, in plan order: each `runData` slot and each tag. */
function reserveToolRound(runData: IRunData, reservations: readonly ToolReservation[]): void {
  for (const r of reservations) {
    (r.node as INode & { rewireOutputLogTo?: string }).rewireOutputLogTo = r.type;
    (runData[r.nodeName] ??= []).push(r.slot);
  }
}

export class FakeHost implements SchedulerHost {
  /** Every host call and hook, in order: `method(node)` / `method` / `hook:name(node)`. */
  readonly calls: string[] = [];
  /** Per `runNode` call: the node, its run index, its input, and whether n8n's eighth
   * argument (`subNodeExecutionResults`) was passed — the inner retry loop passes none. */
  readonly runNodeCalls: Array<{
    node: string; runIndex: number; main: ITaskDataConnections['main']; engineResponse: boolean;
  }> = [];
  readonly additionalData: IWorkflowExecuteAdditionalData;
  readonly mode: WorkflowExecuteMode;
  status: 'running' | 'canceled' = 'running';
  timedOut = false;
  private readonly abortController = new AbortController();
  private readonly counts = new Map<string, number>();

  constructor(
    readonly workflow: Workflow,
    readonly runExecutionData: IRunExecutionData,
    readonly scripts: Readonly<Record<string, NodeScript>>,
    private readonly options: FakeHostOptions = {},
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

  private record(method: string, node?: string): void {
    this.calls.push(node === undefined ? method : `${method}(${node})`);
  }

  /** `executionData`: the stack, the waiting slots and the context, which every run has. */
  protected get exec(): ExecutionDataState {
    return this.runExecutionData.executionData!;
  }

  private get runData(): IRunData {
    return this.runExecutionData.resultData.runData;
  }

  // ---- stack machinery (never driven by the PetriScheduler except the up-front pop) ----

  addNodeToBeExecuted(
    _workflow: Workflow, connectionData: IConnection, _outputIndex: number, parentNodeName: string,
    _nodeSuccessData: INodeExecutionData[][], _runIndex: number, _newRunIndex?: number, _metadata?: ITaskMetadata,
  ): void {
    this.record('addNodeToBeExecuted', `${parentNodeName}->${connectionData.node}`);
    throw new Error('FakeHost.addNodeToBeExecuted must never be called by the PetriScheduler');
  }

  isExecutionStackNotEmpty(): boolean {
    this.record('isExecutionStackNotEmpty');
    return this.exec.nodeExecutionStack.length !== 0;
  }

  popExecutionStack(): IExecuteData {
    this.record('popExecutionStack');
    return this.exec.nodeExecutionStack.shift() as IExecuteData;
  }

  pushExecutionStack(executionData: IExecuteData): void {
    this.record('pushExecutionStack', executionData.node.name);
    this.exec.nodeExecutionStack.unshift(executionData);
  }

  isLegacyExecutionOrder(workflow: Workflow): boolean {
    this.record('isLegacyExecutionOrder');
    return workflow.settings.executionOrder !== 'v1';
  }

  handleEngineRequest(args: { currentNode: INode }): void {
    this.record('handleEngineRequest', args.currentNode.name);
  }

  /**
   * `handleRequest` without the stack push. The member's name is the `SchedulerHost`
   * contract's, and n8n's own `planEngineRequest` writes as well as plans: it reserves each
   * requested node's `runData` slot and tags `rewireOutputLogTo` before it returns. The mirror
   * keeps the two apart — {@link planToolRound} builds the round and writes nothing,
   * {@link reserveToolRound} applies what it reserved — so the writes happen in the step
   * named for them.
   */
  planEngineRequest(args: EngineRequestArgs): PlannedNode[] {
    this.record('planEngineRequest', args.currentNode.name);
    const round = planToolRound(args);
    reserveToolRound(args.runData, round.reservations);
    if (round.error !== undefined) throw round.error;
    return round.planned;
  }

  // ---- per-node machinery, mirroring workflow-execute.ts ----

  shouldStopExecuting(): boolean {
    this.record('shouldStopExecuting');
    return this.status === 'canceled';
  }

  resetDynamicCredentialsUsage(executionData: IExecuteData): void {
    this.record('resetDynamicCredentialsUsage', executionData.node.name);
  }

  createTaskStartedData(executionData: IExecuteData): ITaskStartedData {
    this.record('createTaskStartedData', executionData.node.name);
    const ad = this.additionalData as unknown as { currentNodeExecutionIndex: number };
    return {
      startTime: Date.now(),
      executionIndex: ad.currentNodeExecutionIndex++,
      source: !executionData.source ? [] : executionData.source.main!,
      hints: [],
    };
  }

  addPairedItemLineage(executionData: IExecuteData): ITaskDataConnections {
    this.record('addPairedItemLineage', executionData.node.name);
    const out: ITaskDataConnections = {};
    for (const type of Object.keys(executionData.data)) {
      out[type] = executionData.data[type]!.map((input, inputIndex) => {
        if (input === null) return input;
        return input.map((item, itemIndex) => ({ ...item, pairedItem: { item: itemIndex, input: inputIndex || undefined } }));
      });
    }
    return out;
  }

  computeRunIndex(executionData: IExecuteData): number {
    this.record('computeRunIndex', executionData.node.name);
    if (executionData.runIndex !== undefined) return executionData.runIndex;
    const name = executionData.node.name;
    return Object.hasOwn(this.runData, name) ? this.runData[name]!.length : 0;
  }

  isNodeFilteredOut(nodeName: string): boolean {
    this.record('isNodeFilteredOut', nodeName);
    const filter = this.runExecutionData.startData?.runNodeFilter;
    return filter !== undefined && !filter.includes(nodeName);
  }

  ensureInputData(_workflow: Workflow, executionNode: INode, _executionData: IExecuteData): boolean {
    this.record('ensureInputData', executionNode.name);
    return this.options.ensureInputData ?? true;
  }

  getRetryParams(executionData: IExecuteData): [number, number] {
    this.record('getRetryParams', executionData.node.name);
    // `metadata.resumeError` postdates n8n-workflow 2.16's typings (it exists at 441970b).
    const isResumedError = (executionData.metadata as { resumeError?: unknown } | undefined)?.resumeError !== undefined;
    if (executionData.node.retryOnFail !== true || isResumedError) return [1, 0];
    return [
      Math.min(5, Math.max(2, executionData.node.maxTries || 3)),
      Math.min(5000, Math.max(0, executionData.node.waitBetweenTries || 1000)),
    ];
  }

  getPinnedOutput(node: INode): INodeExecutionData[][] | undefined {
    this.record('getPinnedOutput', node.name);
    const { pinData } = this.runExecutionData.resultData;
    if (!pinData || node.disabled || pinData[node.name] === undefined) return undefined;
    return [pinData[node.name]!];
  }

  /**
   * `collectSubNodeResults` (`workflow-execute.ts:1833-1850`): fill the `EngineResponse` a
   * resumed agent is handed from the `runData` its round's tools wrote.
   *
   * It mutates the object it is given, as n8n's does — both schedulers create one per
   * activation and pass it into `runNode`. Reading `runData` by the *reserved* index is what
   * makes concurrent tools safe: `initializeNodeRunData` fixed each tool's slot at plan time,
   * so which result lands where is decided by the request and not by the finishing order.
   *
   * This was a no-op stub until the agent round landed, which meant no agent in this harness
   * ever saw its own tool results — the differ could not run one, and a fixture agent had to
   * keep a closure counter to know it had already asked.
   */
  collectSubNodeResults(executionData: IExecuteData, subNodeExecutionResults: EngineResponse): void {
    this.record('collectSubNodeResults', executionData.node.name);
    const subNodeExecutionData = executionData.metadata?.subNodeExecutionData;
    if (subNodeExecutionData === undefined) return;
    subNodeExecutionResults.metadata = subNodeExecutionData.metadata;
    for (const subNode of subNodeExecutionData.actions) {
      const nodeRunData = this.runExecutionData.resultData.runData[subNode.nodeName];
      const run = nodeRunData?.[subNode.runIndex];
      if (run !== undefined) {
        subNodeExecutionResults.actionResponses.push({ data: run, action: subNode.action } as never);
      }
    }
  }

  async runNode(
    _workflow: Workflow, executionData: IExecuteData, runExecutionData: IRunExecutionData, runIndex: number,
    _additionalData?: IWorkflowExecuteAdditionalData, _mode?: WorkflowExecuteMode, _abortSignal?: AbortSignal,
    subNodeExecutionResults?: EngineResponse,
  ): Promise<IRunNodeResponse | EngineRequest> {
    const name = executionData.node.name;
    this.record('runNode', name);
    this.runNodeCalls.push({ node: name, runIndex, main: executionData.data.main!, engineResponse: subNodeExecutionResults !== undefined });
    const call = this.counts.get(name) ?? 0;
    this.counts.set(name, call + 1);
    const ctx: ScriptContext = {
      executionData, runIndex, runExecutionData, host: this, call, response: subNodeExecutionResults,
    };
    if (executionData.node.disabled === true) return passThrough(ctx);
    const script = this.scripts[name] ?? passThrough;
    return await script(ctx);
  }

  async processNodeOutput(
    runNodeData: IRunNodeResponse, _workflow: Workflow, executionData: IExecuteData, _taskStartedData: ITaskStartedData, _runIndex: number,
  ): Promise<{ nodeSuccessData: INodeExecutionData[][] | null | undefined; closeFunction: Promise<void> | undefined }> {
    this.record('processNodeOutput', executionData.node.name);
    return { nodeSuccessData: runNodeData.data, closeFunction: runNodeData.closeFunction?.() };
  }

  reportNodeExecutionError(error: unknown, executionNode: INode, _workflow: Workflow): ExecutionBaseError {
    this.record('reportNodeExecutionError', executionNode.name);
    this.runExecutionData.resultData.lastNodeExecuted = executionNode.name;
    const e = error as Error;
    return { ...e, message: e.message, stack: e.stack } as unknown as ExecutionBaseError;
  }

  assignPairedItems(nodeSuccessData: INodeExecutionData[][] | null | undefined, executionData: IExecuteData): INodeExecutionData[][] | null {
    this.record('assignPairedItems', executionData.node.name);
    if (nodeSuccessData?.length) {
      const main = executionData.data.main!;
      const isSingleInputAndOutput = main.length === 1 && main[0]?.length === 1;
      const isSameNumberOfItems = nodeSuccessData.length === 1 && main.length === 1 && main[0]?.length === nodeSuccessData[0]!.length;
      const isSingleOutput = nodeSuccessData.length === 1 && nodeSuccessData[0]?.length === 1 && main.length === 1 && (main[0]?.length ?? 0) > 1;
      checkOutputData: for (const outputData of nodeSuccessData) {
        if (outputData === null) continue;
        for (const [index, item] of outputData.entries()) {
          if (item.pairedItem === undefined) {
            if (isSingleInputAndOutput) item.pairedItem = { item: 0 };
            else if (isSameNumberOfItems) item.pairedItem = { item: index };
            else if (isSingleOutput) item.pairedItem = { item: 0 };
            else break checkOutputData;
          }
        }
      }
    }
    return nodeSuccessData ?? null;
  }

  ensureAlwaysOutputData(nodeSuccessData: INodeExecutionData[][] | null | undefined, executionData: IExecuteData): INodeExecutionData[][] | null | undefined {
    this.record('ensureAlwaysOutputData', executionData.node.name);
    if (nodeSuccessData?.[0]?.[0]) return nodeSuccessData;
    if (executionData.node.alwaysOutputData !== true) return nodeSuccessData;
    const pairedItem: IPairedItemData[] = [];
    executionData.data.main!.forEach((inputData, inputIndex) => {
      if (!inputData) return;
      inputData.forEach((_item, itemIndex) => pairedItem.push({ item: itemIndex, input: inputIndex }));
    });
    nodeSuccessData ??= [];
    nodeSuccessData[0] = [{ json: {}, pairedItem }];
    return nodeSuccessData;
  }

  createTaskData(taskStartedData: ITaskStartedData, executionData: IExecuteData): ITaskData {
    this.record('createTaskData', executionData.node.name);
    return {
      ...taskStartedData,
      executionTime: Date.now() - taskStartedData.startTime,
      metadata: executionData.metadata,
      executionStatus: this.runExecutionData.waitTill ? 'waiting' : 'success',
    };
  }

  recordDynamicCredentialsUser(): void {
    this.record('recordDynamicCredentialsUser');
  }

  async handleNodeExecutionError(args: {
    executionNode: INode; executionData: IExecuteData; taskData: ITaskData; executionError: ExecutionBaseError;
    nodeSuccessData: INodeExecutionData[][] | null | undefined; runIndex: number; hooks: SchedulerHooks;
  }): Promise<{ continueExecution: boolean; nodeSuccessData: INodeExecutionData[][] | null | undefined }> {
    const { executionNode, executionData, taskData, executionError, runIndex, hooks } = args;
    let { nodeSuccessData } = args;
    this.record('handleNodeExecutionError', executionNode.name);
    taskData.error = executionError as never;
    taskData.executionStatus = 'error';
    const node = executionData.node;
    const continues = node.continueOnFail === true || ['continueRegularOutput', 'continueErrorOutput'].includes(node.onError ?? '');
    // n8n's own two-part tool rule (`workflow-execute.ts`): an `ai_tool` node defaults to
    // continuing on failure so the agent receives the error as its tool response, and an
    // explicit `onError: 'stopWorkflow'` still wins. A failing tool therefore continues with
    // **no** `onError` at all, and what it
    // hands back is the error itself rather than its input passed through. The tag is the one
    // `planEngineRequest` set when it reserved the slot.
    const isAiToolExecution =
      (executionNode as INode & { rewireOutputLogTo?: string }).rewireOutputLogTo === 'ai_tool';
    const aiToolDefaultsToContinue = isAiToolExecution && node.onError !== 'stopWorkflow';
    if (continues || aiToolDefaultsToContinue) {
      if (isAiToolExecution) {
        nodeSuccessData = [[{ json: { error: executionError.message } }]];
      } else if (Object.hasOwn(executionData.data, 'main') && executionData.data.main!.length > 0) {
        if (executionData.data.main![0] !== null) nodeSuccessData = [executionData.data.main![0]!];
      }
      return { continueExecution: true, nodeSuccessData };
    }
    this.upsertTaskData(executionNode.name, runIndex, taskData);
    this.pushExecutionStack(executionData);
    if (!this.abortSignal.aborted) await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, this.runExecutionData]);
    return { continueExecution: false, nodeSuccessData };
  }

  /**
   * `upsertTaskData` (`workflow-execute.ts:2154-2161`). n8n indexes `runData[nodeName]`
   * without a check because its loop created the array just before (`stack-scheduler.ts:216-218`),
   * as the scheduler's run loop does (`src/scheduler/run-loop.ts`); creating it here on a miss
   * is that same behaviour, minus the `TypeError` a caller that skipped the step would
   * otherwise get from the mirror.
   */
  upsertTaskData(nodeName: string, runIndex: number, taskData: ITaskData): void {
    this.record('upsertTaskData', nodeName);
    const nodeRunData = (this.runData[nodeName] ??= []);
    if (nodeRunData[runIndex]) Object.assign(nodeRunData[runIndex], taskData);
    else nodeRunData.push(taskData);
  }

  normalizeNodeErrors(nodeSuccessData: INodeExecutionData[][]): void {
    this.record('normalizeNodeErrors');
    for (const execution of nodeSuccessData) {
      for (const lineResult of execution) {
        if (lineResult.error !== undefined) lineResult.json = { error: lineResult.error.message };
      }
    }
  }

  rewireOutputLog(executionNode: INode, _taskData: ITaskData, _nodeSuccessData: INodeExecutionData[][], _runIndex: number): void {
    this.record('rewireOutputLog', executionNode.name);
  }
}
