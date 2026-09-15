/**
 * The slots an agent's tool round reserves, and the results read back from them: n8n's
 * `initializeNodeRunData` entry and `rewireOutputLogTo` tag per action (n8n `441970b`), and
 * `collectSubNodeResults` reading each tool's result at the index its slot was reserved at.
 * `tool-round.ts` plans the round; `FakeHost` records the calls and applies the writes.
 */
import type { EngineResponse, IConnection, IDataObject, IExecuteData, INode, IRunData, ISourceData, ITaskData } from 'n8n-workflow';

/** One action of an agent's `EngineRequest`: the tool to call, with what, under which call id. */
export interface ToolAction {
  nodeName: string;
  input?: IDataObject;
  type: IConnection['type'];
  id: string;
}

/**
 * One slot a tool round reserves: `initializeNodeRunData`'s `runData` entry for the tool,
 * and the `rewireOutputLogTo` tag on its node.
 */
export interface ToolReservation {
  readonly nodeName: string;
  readonly node: INode;
  readonly type: IConnection['type'];
  readonly slot: ITaskData;
}

/** The slot `initializeNodeRunData` reserves for one action: the action's input, sourced from the agent. */
export function reservationOf(action: ToolAction, node: INode, source: ISourceData): ToolReservation {
  return {
    nodeName: action.nodeName,
    node,
    type: action.type,
    slot: {
      inputOverride: { ai_tool: [[{ json: { ...(action.input ?? {}) } }]] },
      source: [source],
      executionIndex: 0, executionTime: 0, startTime: 0,
    } as unknown as ITaskData,
  };
}

/** Write a round's reservations, in plan order: each `runData` slot and each tag. */
export function reserveToolRound(runData: IRunData, reservations: readonly ToolReservation[]): void {
  for (const r of reservations) {
    (r.node as INode & { rewireOutputLogTo?: string }).rewireOutputLogTo = r.type;
    (runData[r.nodeName] ??= []).push(r.slot);
  }
}

/**
 * The body of `collectSubNodeResults` (`workflow-execute.ts:1833-1850`): fill the
 * `EngineResponse` a resumed agent is handed from the `runData` its round's tools wrote,
 * read by the index each tool's slot was *reserved* at.
 */
export function collectToolResults(
  runData: IRunData, executionData: IExecuteData, subNodeExecutionResults: EngineResponse,
): void {
  const subNodeExecutionData = executionData.metadata?.subNodeExecutionData;
  if (subNodeExecutionData === undefined) return;
  subNodeExecutionResults.metadata = subNodeExecutionData.metadata;
  for (const subNode of subNodeExecutionData.actions) {
    const run = runData[subNode.nodeName]?.[subNode.runIndex];
    if (run !== undefined) {
      subNodeExecutionResults.actionResponses.push({ data: run, action: subNode.action } as never);
    }
  }
}
