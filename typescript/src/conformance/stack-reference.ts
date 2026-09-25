/**
 * The n8n side of the differ: a port of n8n's own scheduler loop
 * (`packages/core/src/execution-engine/stack-scheduler.ts` at the pinned release `n8n@2.41.3`)
 * plus the one `WorkflowExecute` member it drives that `FakeHost` deliberately
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
 * shaped like the original rather than tidied, so a reviewer can diff it against n8n. It is
 * split where n8n's own loop has its seams, each under `reference/`: the main loop stays
 * here, the try loop is `tries.ts` (`stack-scheduler.ts:102-212`), the child enqueue
 * `successors.ts` (271-347), the waiting-node pass `waiting-nodes.ts` (355-518), and the
 * enqueue half of the host — `ReferenceHost`, `addNodeToBeExecuted` and its waiting slots —
 * `reference-host.ts`, `enqueue.ts` and `waiting.ts`, over the shapes in `state.ts`.
 */
import type {
  EngineResponse, ExecutionBaseError, IExecuteData, INode, IRunExecutionData, ITaskDataConnections, Workflow,
} from 'n8n-workflow';
import type { SchedulerHooks, SchedulerHost, WorkflowScheduler } from '../n8n/host.js';
import { makeEngineResponse } from './reference/requests-response.js';
import { enqueueSuccessors } from './reference/successors.js';
import { runTries } from './reference/tries.js';
import { runWaitingNodes } from './reference/waiting-nodes.js';

export { ReferenceHost } from './reference/reference-host.js';
export type { ReferenceExecutionState } from './reference/state.js';

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

      const tries = await runTries(this, {                                              // 102-212
        host, workflow, runExecutionData, executionData, runIndex, taskStartedData, subNodeExecutionResults,
      });
      if (tries.next) continue executionLoop;
      let { nodeSuccessData } = tries;

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

      enqueueSuccessors(host, workflow, executionNode, nodeSuccessData!, runIndex);     // 271-347
      await hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, runExecutionData]);
      await runWaitingNodes(host, workflow, runExecutionData);                          // 355-518
    }
  }
}
