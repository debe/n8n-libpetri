/**
 * The host n8n's ported loop runs on: {@link FakeHost} with the scheduling half of
 * `WorkflowExecute` switched on. Line numbers are of `workflow-execute.ts` at the pinned
 * commit `441970b`; `stack-reference.ts` is the port that drives it.
 */
import type {
  EngineRequest, IConnection, IExecuteData, INode, INodeExecutionData, IRunData, ITaskMetadata, Workflow,
} from 'n8n-workflow';
import { FakeHost } from '../harness/fake-host.js';
import { enqueueArrival } from './enqueue.js';
import type { ReferenceExecutionState } from './state.js';

/**
 * `FakeHost` plus `addNodeToBeExecuted`: the enqueue half of n8n's loop. The
 * `PetriScheduler` must never reach it (the net decides what runs), so it stays fatal
 * unless the host is built for the reference engine — {@link enableEnqueue} is the only
 * thing that turns it on, and `runReference` is the only caller.
 */
export class ReferenceHost extends FakeHost {
  private enqueueEnabled = false;

  /** Turns `addNodeToBeExecuted` from "must never be called" into n8n's own implementation. */
  enableEnqueue(): this {
    this.enqueueEnabled = true;
    return this;
  }

  /** {@link FakeHost.exec} in the shape the port indexes. */
  private get state(): ReferenceExecutionState {
    return this.exec as unknown as ReferenceExecutionState;
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
   * doc of `stack-reference.ts` for why the ancestor-forcing block is not ported).
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
    enqueueArrival(this.state, workflow, {
      connectionData, outputIndex, parentNodeName, nodeSuccessData, runIndex, newRunIndex, metadata,
    });
  }
}
