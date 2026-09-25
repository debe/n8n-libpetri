/**
 * `FakeHost`: the 30 `SchedulerHost` members with canned `runNode` outputs per node and a
 * recorder of every host call in order (`calls`). The methods mirror what `WorkflowExecute`
 * does at `n8n@2.41.3` closely enough for `runData`, `source` and `pairedItem` to come out
 * in n8n's shape.
 *
 * The mirror is layered in the order n8n's loop calls it: `HostState` holds the run's state
 * and the recorder, `StackHost` the stack and an agent's tool round, `ActivationHost` what
 * the loop asks before a node runs, `OutcomeHost` what it asks after. This class is the node
 * run itself — the canned scripts and the tool results a resumed agent is handed — and the
 * whole host.
 */
import type {
  EngineRequest, EngineResponse, IExecuteData, IRunExecutionData, IRunNodeResponse,
  ITaskDataConnections, ITaskStartedData, IWorkflowExecuteAdditionalData, Workflow, WorkflowExecuteMode,
} from 'n8n-workflow';
import type { SchedulerHost } from '../../n8n/host.js';
import { OutcomeHost } from './outcome-host.js';
import { passThrough, type NodeScript, type ScriptContext } from './scripts.js';
import type { FakeHostOptions } from './host-state.js';
import { collectToolResults } from './tool-slots.js';

export type { FakeHostOptions } from './host-state.js';

export class FakeHost extends OutcomeHost implements SchedulerHost {
  /** Per `runNode` call: the node, its run index, its input, and whether n8n's eighth
   * argument (`subNodeExecutionResults`) was passed — the inner retry loop passes none. */
  readonly runNodeCalls: Array<{
    node: string; runIndex: number; main: ITaskDataConnections['main']; engineResponse: boolean;
  }> = [];
  private readonly counts = new Map<string, number>();

  constructor(
    workflow: Workflow,
    runExecutionData: IRunExecutionData,
    readonly scripts: Readonly<Record<string, NodeScript>>,
    options: FakeHostOptions = {},
  ) {
    super(workflow, runExecutionData, options);
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
    collectToolResults(this.runData, executionData, subNodeExecutionResults);
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
  ): ReturnType<SchedulerHost['processNodeOutput']> {
    this.record('processNodeOutput', executionData.node.name);
    return { nodeSuccessData: runNodeData.data, closeFunction: runNodeData.closeFunction?.() };
  }
}
