/**
 * The stack machinery of the `FakeHost` mirror, with an agent's tool round: the members the
 * `PetriScheduler` never drives except for the up-front pop and the round's plan. They sit
 * on {@link HostState}; `FakeHost` is the whole host.
 */
import type { IConnection, IExecuteData, INode, INodeExecutionData, ITaskMetadata, Workflow } from 'n8n-workflow';
import type { PlannedNode } from '../../n8n/host.js';
import { HostState } from './host-state.js';
import { planToolRound, type EngineRequestArgs } from './tool-round.js';
import { reserveToolRound } from './tool-slots.js';

export abstract class StackHost extends HostState {
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
}
