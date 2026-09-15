/**
 * Reading one `runNode` result (`stack-scheduler.ts` at `441970b`, patch 0001): whether it is an
 * agent's `EngineRequest`, whether it is a soft failure (lines 98–100), and its output
 * post-processing (lines 163–186).
 */
import type {
  EngineRequest, IExecuteData, INode, INodeExecutionData, IRunNodeResponse, ITaskStartedData,
} from 'n8n-workflow';
import { isAbandoned } from './abandoned.js';
import type { ExecutionEnv } from './env.js';
import { engineRequestUnsupported } from './errors.js';
import type { RunPayload } from './payloads.js';

/** `stack-scheduler.ts:98-100`: an error item on the first output counts as a failed try. */
function isErrorValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false;
}

export function isEngineRequest(data: IRunNodeResponse | EngineRequest): data is EngineRequest {
  return !!data && 'actions' in data;
}

export function checkFailure(data: IRunNodeResponse | EngineRequest): boolean {
  return !isEngineRequest(data) && isErrorValue(data.data?.[0]?.[0]?.json?.error);
}

/**
 * Lines 163–186: the request check and the output post-processing of one `runNode` result.
 * An `EngineRequest` is handled by the caller (`attempt`); reaching here with one is a bug in
 * the run loop, not a user-visible condition.
 */
export async function postRun(
  env: ExecutionEnv,
  executionNode: INode,
  executionData: IExecuteData,
  taskStartedData: ITaskStartedData,
  runIndex: number,
  runNodeData: IRunNodeResponse | EngineRequest,
  /** The attempt this output belongs to, where one can be abandoned by a deadline. */
  payload?: RunPayload,
): Promise<INodeExecutionData[][] | null | undefined> {
  if (isEngineRequest(runNodeData)) throw engineRequestUnsupported(executionNode);
  const nodeOutput = await env.host.processNodeOutput(runNodeData, env.workflow, executionData, taskStartedData, runIndex);
  // `processNodeOutput` is awaited, so an `executionPolicy.timeoutMs` can expire inside it and
  // the attempt be disowned before this line runs. `env.state.closeFunction` is shared
  // execution state: letting a disowned attempt write it lets attempt 1, abandoned at its
  // deadline, replace the close function that the attempt now actually running registered.
  //
  // The cost of guarding it is that a resource the abandoned attempt opened is not closed at
  // the end of the execution. That is the same residual IO-013 already names — abandoning a
  // firing does not cancel the work behind it — and the same one divergence #17 and the
  // per-node cancellation ask in `tasks/todo.md` record. Losing the live attempt's handle is
  // the worse of the two, so the live one wins.
  if (payload !== undefined && isAbandoned(env, payload)) return nodeOutput.nodeSuccessData;
  // Keep the close function of an earlier node if this one registered none (line 185).
  env.state.closeFunction = nodeOutput.closeFunction ?? env.state.closeFunction;
  return nodeOutput.nodeSuccessData;
}
