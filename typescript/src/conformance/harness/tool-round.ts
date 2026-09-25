/**
 * An agent's tool round as the `FakeHost` mirror plans it: the stack entries `handleRequest`
 * (`requests-response.ts:238` at `n8n@2.41.3`) builds for an agent's `EngineRequest`, and the
 * slots that plan reserves (`tool-slots.ts`). Pure over its arguments; `FakeHost` records the
 * call and applies the writes.
 */
import type { IConnection, INodeExecutionData, ITaskMetadata } from 'n8n-workflow';
import type { PlannedNode, SchedulerHost } from '../../n8n/host.js';
import { reservationOf, type ToolAction, type ToolReservation } from './tool-slots.js';

export type EngineRequestArgs = Parameters<SchedulerHost['planEngineRequest']>[0];

/** Where the agent's own input came from: the parent output and run the round pairs against. */
interface ParentOutput {
  readonly outputIndex: number;
  readonly runIndex: number;
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

/** The stack entry for one tool: the agent's input item, overlaid with the action's input and call id. */
function plannedToolOf(args: EngineRequestArgs, action: ToolAction, parent: ParentOutput, nodeRunIndex: number): PlannedNode {
  const agentInput = args.executionData.data.main?.[0]?.[0];
  const json = { ...(agentInput?.json ?? {}), ...(action.input ?? {}), toolCallId: action.id };
  return {
    inputConnectionData: { type: action.type, node: action.nodeName, index: 0 },
    parentOutputIndex: 0,
    parentNode: args.currentNode.name,
    parentOutputData: [[{ json, pairedItem: { item: parent.runIndex, input: parent.outputIndex } }]],
    runIndex: args.runIndex,
    nodeRunIndex,
  };
}

/** The agent's own re-entry: resumed, with the actions whose results it will be handed. */
function agentReentry(args: EngineRequestArgs, parentNode: string, actions: unknown[]): PlannedNode {
  return {
    inputConnectionData: { type: 'ai_tool', node: args.currentNode.name, index: 0 } as IConnection,
    parentOutputIndex: 0,
    parentNode,
    parentOutputData: args.executionData.data.main as INodeExecutionData[][],
    runIndex: args.runIndex,
    nodeRunIndex: args.runIndex,
    metadata: {
      nodeWasResumed: true,
      subNodeExecutionData: { actions, metadata: args.request.metadata },
    } as unknown as ITaskMetadata,
  };
}

/**
 * The round `handleRequest` (`requests-response.ts:238`) builds for an agent's
 * `EngineRequest`, and the slots it reserves — computed, not written: one `runData` slot
 * and one `rewireOutputLogTo` tag per action, the agent's re-entry with `nodeWasResumed` and
 * `subNodeExecutionData`, and — under v1 — the actions reversed so a LIFO stack would run them
 * in request order. The agent's own entry comes first, as `unshift` puts it.
 */
export function planToolRound(args: EngineRequestArgs): ToolRound {
  const parentSource = args.executionData.source?.main?.[0];
  // `prepareRequestingNodeForResuming`: no parent, no round (`requests-response.ts:186`).
  if (parentSource?.previousNode === undefined) return { planned: [], reservations: [] };
  const parent = { outputIndex: parentSource.previousNodeOutput ?? 0, runIndex: parentSource.previousNodeRun ?? 0 };
  const source = { previousNode: args.currentNode.name, previousNodeOutput: parent.outputIndex, previousNodeRun: args.runIndex };

  const actions: Array<{ action: unknown; nodeName: string; runIndex: number }> = [];
  const tools: PlannedNode[] = [];
  const reservations: ToolReservation[] = [];
  /** Slots this round has already claimed per node, on top of what `runData` holds. */
  const claimed = new Map<string, number>();
  let error: Error | undefined;
  for (const action of args.request.actions as ToolAction[]) {
    const node = args.workflow.nodes[action.nodeName];
    if (node === undefined) {
      error = new Error(`Workflow does not contain a node with the name of "${action.nodeName}".`);
      break;
    }
    // `initializeNodeRunData`: the slot is reserved *before* the tool runs, which is why
    // running the tools concurrently cannot scramble which slot each one writes.
    const before = claimed.get(action.nodeName) ?? 0;
    claimed.set(action.nodeName, before + 1);
    const nodeRunIndex = (args.runData[action.nodeName]?.length ?? 0) + before;
    reservations.push(reservationOf(action, node, { ...source }));
    tools.push(plannedToolOf(args, action, parent, nodeRunIndex));
    actions.push({ action, nodeName: action.nodeName, runIndex: nodeRunIndex });
  }
  if (args.workflow.settings.executionOrder === 'v1') tools.reverse();
  const planned = [agentReentry(args, parentSource.previousNode, actions), ...tools];
  return { planned, reservations, ...(error === undefined ? {} : { error }) };
}
