/**
 * The child enqueue of n8n's scheduler (`stack-scheduler.ts:271-347` at the pinned commit
 * `n8n@2.41.3`): queue the successors of the node that just ran. `stack-reference.ts` is the
 * loop that calls it; line numbers are of that n8n file.
 */
import type { IConnection, INode, INodeExecutionData, Workflow } from 'n8n-workflow';
import type { SchedulerHost } from '../../n8n/host.js';

/** A successor about to be queued, with the canvas position the queue order is sorted by. */
interface NodeToAdd {
  position: [number, number];
  connection: IConnection;
  outputIndex: number;
}

/**
 * 326-336: sorted bottom-right first, because the stack is an `unshift`/`shift` pair, so the
 * top-left node ends up in front.
 */
function bottomRightFirst(a: NodeToAdd, b: NodeToAdd): number {
  if (a.position[1] < b.position[1]) return 1;
  if (a.position[1] > b.position[1]) return -1;
  if (a.position[0] > b.position[0]) return -1;
  return 0;
}

/** `stack-scheduler.ts:271-347`: queue the successors of the node that just ran. */
export function enqueueSuccessors(
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

  const nodesToAdd: NodeToAdd[] = [];
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
  nodesToAdd.sort(bottomRightFirst);
  for (const nodeData of nodesToAdd) {
    host.addNodeToBeExecuted(
      workflow, nodeData.connection, nodeData.outputIndex, executionNode.name, nodeSuccessData, runIndex,
    );
  }
}
