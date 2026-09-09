/**
 * The n8n side of the differ: a port of n8n's own scheduler loop
 * (`packages/core/src/execution-engine/stack-scheduler.ts` at the pinned commit `441970b`)
 * plus the one `WorkflowExecute` member it drives that {@link FakeHost} deliberately
 * refuses, `addNodeToBeExecuted` (`workflow-execute.ts:445-851`). Running it against the
 * same `FakeHost` the `PetriScheduler` runs against is what makes the two engines
 * comparable in one process, on one workflow, with one set of node behaviours.
 *
 * **v1 only.** `workflow.settings.executionOrder === 'v1'` is asserted on entry. That is
 * not a shortcut: the whole `if (!nodeWasWaiting) { … }` ancestor-forcing block of
 * `addNodeToBeExecuted` (`workflow-execute.ts:610-778`) ends every iteration of its inner
 * loop at `if (!this.isLegacyExecutionOrder(workflow)) { continue; }`
 * (`workflow-execute.ts:679`) before it can touch any state, so under v1 the block is
 * observably a no-op and is not ported. v0 is out of scope for the whole project
 * (divergence #3), and `enqueueFn` is therefore always `unshift`.
 *
 * Line numbers in the comments below are of those two n8n files. The port is deliberately
 * shaped like the original rather than tidied, so a reviewer can diff it against n8n.
 */
import type {
  EngineRequest, EngineResponse, ExecutionBaseError, IConnection, IExecuteData, INode, INodeExecutionData,
  IRunData,
  IRunExecutionData, IRunNodeResponse, ITaskDataConnections, ITaskMetadata, Workflow,
} from 'n8n-workflow';
import type { ExecutionDataState, SchedulerHooks, SchedulerHost, WorkflowScheduler } from '../n8n/host.js';
import { FakeHost, type FakeHostOptions, type NodeScript } from './harness.js';

/** `makeEngineResponse()` (`requests-response.ts:296`). */
function makeEngineResponse(): EngineResponse {
  return { actionResponses: [], metadata: {} } as unknown as EngineResponse;
}

/** `isEngineRequest()` (`requests-response.ts:290`). */
function isEngineRequest(value: IRunNodeResponse | EngineRequest): value is EngineRequest {
  return !!value && 'actions' in value;
}

/** `sleep()` from `@n8n/utils/sleep`, as the inner soft-failure loop uses it. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `FakeHost` plus `addNodeToBeExecuted`: the enqueue half of n8n's loop. The
 * `PetriScheduler` must never reach it (the net decides what runs), so it stays fatal
 * unless the host is built for the reference engine — {@link referenceHost} is the only
 * thing that turns it on.
 */
export class ReferenceHost extends FakeHost {
  private enqueueEnabled = false;

  /** Turns `addNodeToBeExecuted` from "must never be called" into n8n's own implementation. */
  enableEnqueue(): this {
    this.enqueueEnabled = true;
    return this;
  }

  private get execData(): ExecutionDataState {
    return this.runExecutionData.executionData!;
  }

  /** `prepareWaitingToExecution` (`workflow-execute.ts:426-442`). */
  private prepareWaitingToExecution(nodeName: string, numberOfConnections: number, runIndex: number): void {
    const executionData = this.execData as unknown as {
      waitingExecution: Record<string, Record<number, { main: Array<INodeExecutionData[] | null> }>>;
      waitingExecutionSource: Record<string, Record<number, { main: Array<unknown | null> }>>;
    };
    executionData.waitingExecution ??= {};
    executionData.waitingExecutionSource ??= {};
    const nodeWaiting = (executionData.waitingExecution[nodeName] ??= []);
    const nodeWaitingSource = (executionData.waitingExecutionSource[nodeName] ??= []);
    nodeWaiting[runIndex] = { main: [] };
    nodeWaitingSource[runIndex] = { main: [] };
    for (let i = 0; i < numberOfConnections; i++) {
      nodeWaiting[runIndex]!.main.push(null);
      nodeWaitingSource[runIndex]!.main.push(null);
    }
  }

  /**
   * `handleEngineRequest` (`workflow-execute.ts:1581-1617`): the plan, then one
   * `addNodeToBeExecuted` per entry. `FakeHost` only records the call, because the
   * `PetriScheduler` must never reach it — the net decides when a round's activations run —
   * so the reference engine is the only thing that turns the scheduling half on.
   *
   * With it, the differ can run an agent workflow on both engines and compare: n8n's stack
   * against the net's round.
   */
  override handleEngineRequest(args: {
    workflow: Workflow;
    currentNode: INode;
    request: EngineRequest;
    runIndex: number;
    executionData: IExecuteData;
    runData: IRunData;
  }): void {
    if (!this.enqueueEnabled) {
      super.handleEngineRequest(args);
      return;
    }
    this.calls.push(`handleEngineRequest(${args.currentNode.name})`);
    for (const e of this.planEngineRequest(args)) {
      this.addNodeToBeExecuted(
        args.workflow, e.inputConnectionData, e.parentOutputIndex, e.parentNode,
        e.parentOutputData, e.runIndex, e.nodeRunIndex, e.metadata,
      );
    }
  }

  /**
   * `addNodeToBeExecuted` (`workflow-execute.ts:445-851`), v1 path only (see the module
   * doc for why the ancestor-forcing block is not ported).
   */
  override addNodeToBeExecuted(
    workflow: Workflow,
    connectionData: IConnection,
    outputIndex: number,
    parentNodeName: string,
    nodeSuccessData: INodeExecutionData[][],
    runIndex: number,
    newRunIndex?: number,
    metadata?: ITaskMetadata,
  ): void {
    if (!this.enqueueEnabled) {
      super.addNodeToBeExecuted(
        workflow, connectionData, outputIndex, parentNodeName, nodeSuccessData, runIndex, newRunIndex, metadata,
      );
      return;
    }
    this.calls.push(`addNodeToBeExecuted(${parentNodeName}->${connectionData.node})`);

    const exec = this.execData as unknown as {
      nodeExecutionStack: IExecuteData[];
      waitingExecution: Record<string, Record<number, { main: Array<INodeExecutionData[] | null> }>>;
      waitingExecutionSource: Record<string, Record<number, { main: Array<unknown | null> }>>;
    };
    const nodes = workflow.nodes as unknown as Record<string, INode>;
    const byDestination = workflow.connectionsByDestinationNode as unknown as
      Record<string, { main: Array<IConnection[] | null> }>;

    let stillDataMissing = false;
    let waitingNodeIndex: number | undefined;

    // 484-486: a node with several inputs waits for all of them.
    const numberOfInputs = byDestination[connectionData.node]?.main?.length ?? 0;
    if (numberOfInputs > 1) {
      exec.waitingExecutionSource ??= {};
      let nodeWasWaiting = true;
      if (exec.waitingExecution[connectionData.node] === undefined) {
        exec.waitingExecution[connectionData.node] = {};
        exec.waitingExecutionSource[connectionData.node] = {};
        nodeWasWaiting = false;
      }
      void nodeWasWaiting; // 610: only the ancestor-forcing block reads it (v0 only).

      // 503-524: reuse the first waiting entry whose slot for this input is still free.
      let createNewWaitingEntry = true;
      const waiting = exec.waitingExecution[connectionData.node]!;
      if (Object.keys(waiting).length > 0) {
        for (const index of Object.keys(waiting)) {
          if (!waiting[Number.parseInt(index, 10)]!.main[connectionData.index]) {
            createNewWaitingEntry = false;
            waitingNodeIndex = Number.parseInt(index, 10);
            break;
          }
        }
      }
      if (waitingNodeIndex === undefined) waitingNodeIndex = Object.values(waiting).length;
      if (createNewWaitingEntry) {
        this.prepareWaitingToExecution(connectionData.node, byDestination[connectionData.node]!.main.length, waitingNodeIndex);
      }

      // 526-543: write the arrival into the slot.
      if (nodeSuccessData === null) {
        waiting[waitingNodeIndex]!.main[connectionData.index] = null;
        exec.waitingExecutionSource[connectionData.node]![waitingNodeIndex]!.main[connectionData.index] = null;
      } else {
        waiting[waitingNodeIndex]!.main[connectionData.index] = nodeSuccessData[outputIndex]!;
        exec.waitingExecutionSource[connectionData.node]![waitingNodeIndex]!.main[connectionData.index] = {
          previousNode: parentNodeName,
          previousNodeOutput: outputIndex ?? undefined,
          previousNodeRun: runIndex ?? undefined,
        };
      }

      // 545-608: every slot filled → onto the stack, and drop the waiting entry.
      const slots = waiting[waitingNodeIndex]!.main;
      const allDataFound = slots.every((slot) => slot !== null);
      if (allDataFound) {
        const executionStackItem = {
          node: nodes[connectionData.node],
          data: waiting[waitingNodeIndex],
          source: exec.waitingExecutionSource[connectionData.node]![waitingNodeIndex],
        } as unknown as IExecuteData;
        exec.nodeExecutionStack.unshift(executionStackItem);
        delete waiting[waitingNodeIndex];
        delete exec.waitingExecutionSource[connectionData.node]![waitingNodeIndex];
        if (Object.keys(waiting).length === 0) {
          delete exec.waitingExecution[connectionData.node];
          delete exec.waitingExecutionSource[connectionData.node];
        }
        return;
      }
      stillDataMissing = true;
      // 610-778: the ancestor-forcing block; a no-op under v1 (see the module doc).
    }

    // 780-800: the data array this arrival goes into.
    let connectionDataArray: Array<INodeExecutionData[] | null> | null =
      waitingNodeIndex === undefined
        ? null
        : (exec.waitingExecution[connectionData.node]?.[waitingNodeIndex]?.main ?? null);
    if (connectionDataArray === null) {
      connectionDataArray = [];
      for (let i = connectionData.index; i >= 0; i--) connectionDataArray[i] = null;
    }
    connectionDataArray[connectionData.index] = nodeSuccessData === null ? null : nodeSuccessData[outputIndex]!;

    if (stillDataMissing) {
      // 802-826: back to waiting, keeping the sources the slot already had.
      const index = waitingNodeIndex!;
      const waitingExecutionSource = exec.waitingExecutionSource[connectionData.node]![index]!.main;
      this.prepareWaitingToExecution(connectionData.node, byDestination[connectionData.node]!.main.length, index);
      exec.waitingExecution[connectionData.node]![index] = { main: connectionDataArray };
      exec.waitingExecutionSource[connectionData.node]![index]!.main = waitingExecutionSource;
    } else if (nodes[connectionData.node]) {
      // 827-849: everything is there, so straight onto the stack (v1: `unshift`).
      exec.nodeExecutionStack.unshift({
        node: nodes[connectionData.node],
        data: { main: connectionDataArray },
        source: {
          main: [{
            previousNode: parentNodeName,
            previousNodeOutput: outputIndex ?? undefined,
            previousNodeRun: runIndex ?? undefined,
          }],
        },
        runIndex: newRunIndex,
        metadata,
      } as unknown as IExecuteData);
    }
  }
}

/** A `ReferenceHost` with the enqueue half enabled: the host n8n's own loop needs. */
export function referenceHost(
  workflow: Workflow,
  runExecutionData: IRunExecutionData,
  scripts: Readonly<Record<string, NodeScript>>,
  options: FakeHostOptions = {},
): ReferenceHost {
  return new ReferenceHost(workflow, runExecutionData, scripts, options).enableEnqueue();
}

/**
 * n8n's `StackScheduler.run` (`stack-scheduler.ts:33-519`), v1 only. Every branch is the
 * original's; `Logger.debug` calls are dropped and n8n's `UserError` / `UnexpectedError`
 * become plain `Error`s with the same messages.
 */
export class StackReferenceScheduler implements WorkflowScheduler {
  executionError: ExecutionBaseError | undefined;
  closeFunction: Promise<void> | undefined;

  /**
   * A safety valve the original does not have: n8n's own loop spins forever on a workflow
   * whose cycle never stops producing (its endless-loop guard only catches the *deferred*
   * `ensureInputData` case), and a hung differ is worse than a loud one. Not part of the
   * ported semantics — a fixture that trips it is a fixture bug.
   */
  constructor(private readonly maxActivations = 10_000) {}

  async run(
    host: SchedulerHost,
    workflow: Workflow,
    runExecutionData: IRunExecutionData,
    hooks: SchedulerHooks,
  ): Promise<void> {
    if ((workflow.settings as { executionOrder?: string }).executionOrder !== 'v1') {
      throw new Error('StackReferenceScheduler: v1 only (v0 is divergence #3, out of scope)');
    }
    let executionData: IExecuteData;
    let subNodeExecutionResults: EngineResponse = makeEngineResponse();
    let executionNode: INode;
    let runIndex: number;
    let currentExecutionTry = '';
    let lastExecutionTry = '';
    let activations = 0;

    executionLoop: while (host.isExecutionStackNotEmpty()) {
      if (++activations > this.maxActivations) {
        throw new Error(`StackReferenceScheduler: more than ${this.maxActivations} activations (non-terminating workflow?)`);
      }
      if (host.shouldStopExecuting()) return;                                          // 49-51
      subNodeExecutionResults = makeEngineResponse();
      let nodeSuccessData: INodeExecutionData[][] | null | undefined = null;
      this.executionError = undefined;
      executionData = host.popExecutionStack();
      executionNode = executionData.node;
      host.resetDynamicCredentialsUsage(executionData);
      const taskStartedData = host.createTaskStartedData(executionData);
      executionData.data = host.addPairedItemLineage(executionData);
      runIndex = host.computeRunIndex(executionData);

      currentExecutionTry = `${executionNode.name}:${runIndex}`;                        // 69-72
      if (currentExecutionTry === lastExecutionTry) {
        throw new Error('Stopped execution because it seems to be in an endless loop');
      }
      if (host.isNodeFilteredOut(executionNode.name)) continue;                         // 74-76
      if (!host.ensureInputData(workflow, executionNode, executionData)) {              // 78-82
        lastExecutionTry = currentExecutionTry;
        continue executionLoop;
      }
      if (!(executionData.metadata as { nodeWasResumed?: boolean } | undefined)?.nodeWasResumed) {
        await hooks.runHook('nodeExecuteBefore', [executionNode.name, taskStartedData]);
      }
      const isErrorValue = (v: unknown): boolean => v !== undefined && v !== null && v !== false;
      const checkFailure = (data: IRunNodeResponse | EngineRequest): boolean =>
        !isEngineRequest(data) && isErrorValue(data.data?.[0]?.[0]?.json?.error);
      const [maxTries, waitBetweenTries] = host.getRetryParams(executionData);

      for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {                         // 102
        try {
          if (tryIndex !== 0) {                                                        // 104-118
            this.executionError = undefined;
            if (waitBetweenTries !== 0) await sleep(waitBetweenTries);
          }
          const pinnedOutput = host.getPinnedOutput(executionNode);
          if (pinnedOutput) {
            nodeSuccessData = pinnedOutput;
          } else {
            host.collectSubNodeResults(executionData, subNodeExecutionResults);
            let runNodeData = await host.runNode(
              workflow, executionData, runExecutionData, runIndex,
              host.additionalData, host.mode, host.abortSignal, subNodeExecutionResults,
            );
            // 144-160: a *soft* failure (an error in the first item's json) re-runs the
            // node without the engine response, inside the same try index.
            let nodeFailed = checkFailure(runNodeData);
            while (nodeFailed && tryIndex !== maxTries - 1) {
              await sleep(waitBetweenTries);
              runNodeData = await host.runNode(
                workflow, executionData, runExecutionData, runIndex,
                host.additionalData, host.mode, host.abortSignal,
              );
              nodeFailed = checkFailure(runNodeData);
              tryIndex++;
            }
            if (isEngineRequest(runNodeData)) {                                        // 163-174
              host.handleEngineRequest({
                workflow, currentNode: executionNode, request: runNodeData, runIndex, executionData,
                runData: runExecutionData.resultData.runData,
              });
              continue executionLoop;
            }
            const nodeOutput = await host.processNodeOutput(
              runNodeData, workflow, executionData, taskStartedData, runIndex,
            );
            nodeSuccessData = nodeOutput.nodeSuccessData;
            this.closeFunction = nodeOutput.closeFunction ?? this.closeFunction;
          }
          nodeSuccessData = host.assignPairedItems(nodeSuccessData, executionData);     // 193
          if (nodeSuccessData) runExecutionData.resultData.lastNodeExecuted = executionData.node.name;
          nodeSuccessData = host.ensureAlwaysOutputData(nodeSuccessData, executionData);
          if (nodeSuccessData === null && !runExecutionData.waitTill) continue executionLoop; // 201-206
          break;
        } catch (error) {
          this.executionError = host.reportNodeExecutionError(error, executionNode, workflow);
        }
      }

      if (!Object.hasOwn(runExecutionData.resultData.runData, executionNode.name)) {     // 216-218
        runExecutionData.resultData.runData[executionNode.name] = [];
      }
      const taskData = host.createTaskData(taskStartedData, executionData);
      host.recordDynamicCredentialsUser();

      if (this.executionError !== undefined) {                                          // 224-236
        const outcome = await host.handleNodeExecutionError({
          executionNode, executionData, taskData, executionError: this.executionError,
          nodeSuccessData, runIndex, hooks,
        });
        nodeSuccessData = outcome.nodeSuccessData;
        if (!outcome.continueExecution) break;
      }

      host.normalizeNodeErrors(nodeSuccessData!);
      taskData.data = { main: nodeSuccessData } as ITaskDataConnections;
      host.rewireOutputLog(executionNode, taskData, nodeSuccessData!, runIndex);
      host.upsertTaskData(executionNode.name, runIndex, taskData);

      if (runExecutionData.waitTill) {                                                  // 252-259
        await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, runExecutionData]);
        host.pushExecutionStack(executionData);
        break;
      }
      if (runExecutionData?.startData?.destinationNode?.nodeName === executionNode.name) { // 261-267
        await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, runExecutionData]);
        continue;
      }

      this.enqueueSuccessors(host, workflow, executionNode, nodeSuccessData!, runIndex); // 271-347
      await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, runExecutionData]);
      await this.runWaitingNodes(host, workflow, runExecutionData);                      // 355-518
    }
  }

  /** `stack-scheduler.ts:271-347`: queue the successors of the node that just ran. */
  private enqueueSuccessors(
    host: SchedulerHost,
    workflow: Workflow,
    executionNode: INode,
    nodeSuccessData: INodeExecutionData[][],
    runIndex: number,
  ): void {
    const bySource = workflow.connectionsBySourceNode as unknown as
      Record<string, { main?: Array<IConnection[] | null> }>;
    if (!Object.hasOwn(bySource, executionNode.name)) return;
    const outputs = bySource[executionNode.name]!;
    if (!Object.hasOwn(outputs, 'main')) return;

    const nodesToAdd: Array<{ position: [number, number]; connection: IConnection; outputIndex: number }> = [];
    for (const outputIndex of Object.keys(outputs.main!)) {
      for (const connectionData of outputs.main![Number.parseInt(outputIndex, 10)] ?? []) {
        if (!Object.hasOwn(workflow.nodes, connectionData.node)) {
          throw new Error('Destination node not found');
        }
        const produced = nodeSuccessData[Number.parseInt(outputIndex, 10)];
        // 306-310: enqueue only an output that produced items (v1: the second clause,
        // `connectionData.index > 0 && isLegacyExecutionOrder`, is false).
        if (produced && (produced.length !== 0 || (connectionData.index > 0 && host.isLegacyExecutionOrder(workflow)))) {
          const nodeToAdd = workflow.getNode(connectionData.node);
          nodesToAdd.push({
            position: nodeToAdd?.position ?? [0, 0],
            connection: connectionData,
            outputIndex: Number.parseInt(outputIndex, 10),
          });
        }
      }
    }
    // 326-336: sorted bottom-right first, because the stack is an `unshift`/`shift` pair,
    // so the top-left node ends up in front.
    nodesToAdd.sort((a, b) => {
      if (a.position[1] < b.position[1]) return 1;
      if (a.position[1] > b.position[1]) return -1;
      if (a.position[0] > b.position[0]) return -1;
      return 0;
    });
    for (const nodeData of nodesToAdd) {
      host.addNodeToBeExecuted(
        workflow, nodeData.connection, nodeData.outputIndex, executionNode.name, nodeSuccessData, runIndex,
      );
    }
  }

  /**
   * `stack-scheduler.ts:355-518` — R6: once the stack is empty, run the multi-input nodes
   * that are still waiting with whatever data they have, one at a time.
   */
  private async runWaitingNodes(
    host: SchedulerHost,
    workflow: Workflow,
    runExecutionData: IRunExecutionData,
  ): Promise<void> {
    const exec = runExecutionData.executionData! as unknown as {
      nodeExecutionStack: IExecuteData[];
      waitingExecution: Record<string, Record<number, { main: Array<INodeExecutionData[] | null> }>>;
      waitingExecutionSource: Record<string, Record<number, unknown>>;
    };
    let waitingNodes: string[] = Object.keys(exec.waitingExecution);
    if (exec.nodeExecutionStack.length !== 0 || waitingNodes.length === 0) return;

    for (let i = 0; i < waitingNodes.length; i++) {
      const nodeName = waitingNodes[i]!;
      const checkNode = workflow.getNode(nodeName);
      if (!checkNode) continue;
      const nodeType = workflow.nodeTypes.getByNameAndVersion(checkNode.type, checkNode.typeVersion);
      const inputCount = (nodeType.description.inputs as unknown[]).length;

      // 384-402: a node all of whose inputs are required is not run with partial data.
      let requiredInputs = nodeType.description.requiredInputs as number | number[] | string | undefined;
      if (requiredInputs !== undefined) {
        if (typeof requiredInputs === 'string') {
          requiredInputs = workflow.expression.getSimpleParameterValue(
            checkNode, requiredInputs, host.mode, { $version: checkNode.typeVersion }, undefined, [],
          ) as number[];
        }
        if ((Array.isArray(requiredInputs) && requiredInputs.length === inputCount) || requiredInputs === inputCount) {
          continue;
        }
      }

      // 404-410: wait while a parent is itself waiting.
      const parentNodes = (workflow as unknown as { getParentNodes: (n: string) => string[] }).getParentNodes(nodeName);
      if (parentNodes.some((value) => waitingNodes.includes(value))) continue;

      const runIndexes = Object.keys(exec.waitingExecution[nodeName]!).sort();
      const firstRunIndex = Number.parseInt(runIndexes[0]!, 10);
      const slots = exec.waitingExecution[nodeName]![firstRunIndex]!.main;
      const inputsWithData = slots
        .map((data, index) => (data === null ? null : index))
        .filter((data) => data !== null);

      // 425-446: the required inputs must be among the ones that did arrive.
      if (requiredInputs !== undefined) {
        if (Array.isArray(requiredInputs)) {
          if (requiredInputs.some((required) => !inputsWithData.includes(required))) continue;
        } else if (inputsWithData.length < requiredInputs) {
          continue;
        }
      }

      // 448-451: a slot that never arrived becomes `[]` — the substitution divergence #2 is about.
      const taskDataMain = slots.map((data) => (data === null ? [] : data));
      const found = taskDataMain.filter((data) => data.length).length !== 0;
      if (found) {
        while (taskDataMain.length < inputCount) taskDataMain.push([]);
        exec.nodeExecutionStack.push({
          node: workflow.nodes[nodeName],
          data: { main: taskDataMain },
          source: exec.waitingExecutionSource[nodeName]![firstRunIndex],
        } as unknown as IExecuteData);
      }
      delete exec.waitingExecution[nodeName]![firstRunIndex];
      delete exec.waitingExecutionSource[nodeName]![firstRunIndex];
      if (Object.keys(exec.waitingExecution[nodeName]!).length === 0) {
        delete exec.waitingExecution[nodeName];
        delete exec.waitingExecutionSource[nodeName];
      }
      if (found) break;                                                                 // 505-507
      // 508-514: an empty entry was dropped, so start the scan again.
      waitingNodes = Object.keys(exec.waitingExecution);
      i = -1;
    }
  }
}
