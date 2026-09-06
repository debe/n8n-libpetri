/**
 * The in-process differential harness: a fake n8n `Workflow` built from a compiler
 * `WorkflowDescription`, a `FakeHost` implementing the 30 `SchedulerHost` members with
 * canned `runNode` outputs per node, fake lifecycle hooks, and a recorder of every host
 * call and hook in order (`calls`). The host methods mirror what `WorkflowExecute` does at
 * n8n `441970b` closely enough for `runData`, `source` and `pairedItem` to come out in
 * n8n's shape; the recorder is what the ordering tests and the differ read.
 *
 * It lives under `conformance/` because both engines run on it: the `PetriScheduler`
 * (`src/scheduler`) and the reference loop (`stack-reference.ts`) that the differ compares
 * it against. `tests/scheduler/support.ts` re-exports all of it, so the scheduler suite
 * sees the same names it always did.
 *
 * Not a runtime dependency on n8n: every `n8n-workflow` import here is type-only.
 */
import type {
  EngineRequest, EngineResponse, ExecutionBaseError, IConnection, IExecuteData, INode, INodeExecutionData,
  INodeParameters, IPairedItemData, IPinData, IRunData, IRunExecutionData, IRunNodeResponse, ITaskData,
  ITaskDataConnections, ITaskMetadata, ITaskStartedData, IWorkflowExecuteAdditionalData, Workflow,
  WorkflowExecuteMode,
} from 'n8n-workflow';
import type { NodeDescription, WorkflowDescription } from '../compiler/index.js';
import type { NodeHelpersLike, SchedulerHooks, SchedulerHost } from '../n8n/host.js';

// ==================== fake Workflow ====================

export interface FakeWorkflowOptions {
  readonly executionOrder?: 'v0' | 'v1';
  /** Node parameters (scanned for `$('X')` references by the adapter). */
  readonly parameters?: Readonly<Record<string, INodeParameters>>;
  /** Extra `INode` fields per node (e.g. `alwaysOutputData`, `continueOnFail`). */
  readonly nodeExtras?: Readonly<Record<string, Partial<INode>>>;
  /** A string `requiredInputs` (expression) per node type name, for the adapter test. */
  readonly requiredInputsExpression?: Readonly<Record<string, string>>;
}

export function toINode(n: NodeDescription, options: FakeWorkflowOptions = {}): INode {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    typeVersion: n.typeVersion,
    position: [n.position[0], n.position[1]],
    parameters: options.parameters?.[n.name] ?? {},
    ...(n.disabled === undefined ? {} : { disabled: n.disabled }),
    ...(n.onError === undefined ? {} : { onError: n.onError }),
    ...(n.retryOnFail === undefined ? {} : { retryOnFail: n.retryOnFail }),
    ...(n.maxTries === undefined ? {} : { maxTries: n.maxTries }),
    ...(n.waitBetweenTries === undefined ? {} : { waitBetweenTries: n.waitBetweenTries }),
    ...(options.nodeExtras?.[n.name] ?? {}),
  };
}

/** A minimal `Workflow` with the members the adapter and the scheduler read. */
export function fakeWorkflow(desc: WorkflowDescription, options: FakeWorkflowOptions = {}): Workflow {
  const nodes: Record<string, INode> = {};
  for (const n of desc.nodes) nodes[n.name] = toINode(n, options);
  const bySource: Record<string, { main: Array<IConnection[] | null> }> = {};
  const byDestination: Record<string, { main: Array<IConnection[] | null> }> = {};
  for (const c of desc.connections) {
    const s = (bySource[c.from] ??= { main: [] });
    while (s.main.length <= c.outputIndex) s.main.push([]);
    s.main[c.outputIndex]!.push({ node: c.to, type: 'main', index: c.inputIndex });
    const d = (byDestination[c.to] ??= { main: [] });
    while (d.main.length <= c.inputIndex) d.main.push([]);
    d.main[c.inputIndex]!.push({ node: c.from, type: 'main', index: c.outputIndex });
  }
  const descriptions = new Map<string, unknown>();
  for (const n of desc.nodes) {
    const shape = desc.nodeTypes(n);
    const expr = options.requiredInputsExpression?.[n.type];
    descriptions.set(n.type, {
      displayName: n.type,
      name: n.type,
      version: n.typeVersion,
      inputs: Array.from({ length: shape.inputCount }, () => 'main'),
      outputs: Array.from({ length: shape.outputCount }, () => 'main'),
      ...(expr !== undefined ? { requiredInputs: expr } : shape.requiredInputs === undefined ? {} : { requiredInputs: shape.requiredInputs }),
      ...(shape.outputNames === undefined ? {} : { outputNames: [...shape.outputNames] }),
      properties: [],
    });
  }
  const workflow = {
    id: desc.id ?? desc.name ?? 'wf',
    name: desc.name,
    nodes,
    connectionsBySourceNode: bySource,
    connectionsByDestinationNode: byDestination,
    settings: { executionOrder: options.executionOrder ?? 'v1' },
    nodeTypes: {
      getByNameAndVersion: (type: string) => {
        const description = descriptions.get(type);
        if (description === undefined) throw new Error(`fakeWorkflow: unknown node type '${type}'`);
        return { description };
      },
    },
    expression: {
      // The one expression the adapter evaluates: Merge's requiredInputs. Canned as
      // `$parameter["mode"] === "chooseBranch" ? [0, 1] : 1`.
      getSimpleParameterValue: (node: INode, value: string) =>
        (typeof value === 'string' && value.startsWith('=') ? (node.parameters.mode === 'chooseBranch' ? [0, 1] : 1) : value),
    },
    getNode: (name: string) => nodes[name] ?? null,
    /**
     * `Workflow.getParentNodes(name)` (n8n-workflow `common/get-connected-nodes.ts`):
     * every transitive ancestor over main connections. n8n's own implementation also
     * fixes an order the reference loop never reads — its single caller, the R6
     * quiescence fallback (`stack-scheduler.ts:404`), only asks `parentNodes.some(...)`
     * — so this returns the same set, sorted, and not n8n's unshift order.
     */
    getParentNodes: (name: string) => {
      const seen = new Set<string>();
      const walk = (current: string): void => {
        for (const input of byDestination[current]?.main ?? []) {
          for (const c of input ?? []) {
            if (seen.has(c.node)) continue;
            seen.add(c.node);
            walk(c.node);
          }
        }
      };
      walk(name);
      return [...seen].sort();
    },
    staticData: {},
  };
  return workflow as unknown as Workflow;
}

/** `NodeHelpers` as the adapter uses them; `getNodeOutputs` appends the error output like n8n's. */
export const fakeNodeHelpers: NodeHelpersLike = {
  getNodeInputs: (_w, _n, d) => d.inputs as never,
  getNodeOutputs: (_w, node, d) => {
    const outputs = d.outputs as never[];
    return node.onError === 'continueErrorOutput'
      ? [...outputs, { category: 'error', type: 'main', displayName: 'Error' } as never]
      : outputs;
  },
};

// ==================== run data ====================

export const ITEM: INodeExecutionData = { json: { n: 1 } };

export function items(...values: unknown[]): INodeExecutionData[] {
  return values.map((v) => ({ json: (typeof v === 'object' && v !== null ? v : { v }) as INodeExecutionData['json'] }));
}

export interface RunDataOptions {
  readonly startItems?: INodeExecutionData[];
  readonly destinationNode?: string;
  readonly runNodeFilter?: string[];
  readonly pinData?: IPinData;
  /** `metadata` of the start entry (e.g. `{ resumeError }`). */
  readonly stackMetadata?: ITaskMetadata;
  /** Start with an empty `nodeExecutionStack` (n8n's loop never enters). */
  readonly emptyStack?: boolean;
}

export function newRunExecutionData(startNode: INode, options: RunDataOptions = {}): IRunExecutionData {
  const data = {
    version: 1,
    startData: {
      ...(options.destinationNode === undefined ? {} : { destinationNode: { nodeName: options.destinationNode, mode: 'inclusive' } }),
      ...(options.runNodeFilter === undefined ? {} : { runNodeFilter: options.runNodeFilter }),
    },
    resultData: { runData: {}, ...(options.pinData === undefined ? {} : { pinData: options.pinData }) },
    executionData: {
      contextData: {},
      metadata: {},
      nodeExecutionStack: options.emptyStack === true ? [] : [{
        node: startNode, data: { main: [options.startItems ?? [{ json: {} }]] }, source: null,
        ...(options.stackMetadata === undefined ? {} : { metadata: options.stackMetadata }),
      }],
      waitingExecution: {},
      waitingExecutionSource: {},
    },
  };
  return data as unknown as IRunExecutionData;
}

// ==================== fake host ====================

export interface ScriptContext {
  readonly executionData: IExecuteData;
  readonly runIndex: number;
  readonly runExecutionData: IRunExecutionData;
  readonly host: FakeHost;
  /** How many times this node's `runNode` was called before (attempts across retries). */
  readonly call: number;
}

/** A canned node: returns the `runNode` response (or throws, or returns an `EngineRequest`). */
export type NodeScript = (ctx: ScriptContext) => IRunNodeResponse | EngineRequest | Promise<IRunNodeResponse | EngineRequest>;

/** Pass-through: the first input's items become the single output (n8n's disabled-node shape). */
export const passThrough: NodeScript = ({ executionData }) => ({ data: [executionData.data.main?.[0] ?? []] });

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface FakeHostOptions {
  readonly mode?: WorkflowExecuteMode;
  readonly ensureInputData?: boolean;
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

  private get exec() {
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

  collectSubNodeResults(executionData: IExecuteData, _results: EngineResponse): void {
    this.record('collectSubNodeResults', executionData.node.name);
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
    if (executionData.node.disabled === true) return passThrough({ executionData, runIndex, runExecutionData, host: this, call });
    const script = this.scripts[name] ?? passThrough;
    return await script({ executionData, runIndex, runExecutionData, host: this, call });
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
    if (continues) {
      if (Object.hasOwn(executionData.data, 'main') && executionData.data.main!.length > 0) {
        if (executionData.data.main![0] !== null) nodeSuccessData = [executionData.data.main![0]!];
      }
      return { continueExecution: true, nodeSuccessData };
    }
    this.upsertTaskData(executionNode.name, runIndex, taskData);
    this.pushExecutionStack(executionData);
    if (!this.abortSignal.aborted) await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, this.runExecutionData]);
    return { continueExecution: false, nodeSuccessData };
  }

  upsertTaskData(nodeName: string, runIndex: number, taskData: ITaskData): void {
    this.record('upsertTaskData', nodeName);
    const nodeRunData = this.runData[nodeName]!;
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

// ==================== hooks ====================

/** Per hook, an error to reject with for a given node (`undefined` = the hook succeeds). */
export type HookFailures = Partial<Record<'nodeExecuteBefore' | 'nodeExecuteAfter', (node: string) => Error | undefined>>;

export function fakeHooks(calls: string[], failures: HookFailures = {}): SchedulerHooks {
  const hooks = {
    runHook: async (name: string, params: unknown[]) => {
      const node = String((params as [string])[0]);
      calls.push(`hook:${name}(${node})`);
      const error = failures[name as keyof HookFailures]?.(node);
      if (error !== undefined) throw error;
    },
  };
  return hooks as unknown as SchedulerHooks;
}

