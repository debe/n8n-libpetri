/**
 * How the `FakeHost` mirror treats a node that failed, as `WorkflowExecute` does at n8n
 * `441970b`: the error `reportNodeExecutionError` hands the loop, the output a failed node
 * continues with, and the item errors `normalizeNodeErrors` turns into json.
 */
import type { ExecutionBaseError, IExecuteData, INode, INodeExecutionData } from 'n8n-workflow';

/** `reportNodeExecutionError`'s value: the thrown error, its message and stack kept. */
export function executionErrorOf(error: unknown): ExecutionBaseError {
  const e = error as Error;
  return { ...e, message: e.message, stack: e.stack } as unknown as ExecutionBaseError;
}

/**
 * The output a failed node continues with, or `undefined` when its failure stops the
 * workflow. A node continues on `continueOnFail` or an `onError` that continues; it hands
 * on its first input.
 *
 * n8n's own two-part tool rule (`workflow-execute.ts`): an `ai_tool` node defaults to
 * continuing on failure so the agent receives the error as its tool response, and an
 * explicit `onError: 'stopWorkflow'` still wins. A failing tool therefore continues with
 * **no** `onError` at all, and what it
 * hands back is the error itself rather than its input passed through. The tag is the one
 * `planEngineRequest` set when it reserved the slot.
 */
export function continuedOutput(
  executionNode: INode, executionData: IExecuteData, executionError: ExecutionBaseError,
  nodeSuccessData: INodeExecutionData[][] | null | undefined,
): { readonly nodeSuccessData: INodeExecutionData[][] | null | undefined } | undefined {
  const node = executionData.node;
  const continues = node.continueOnFail === true || ['continueRegularOutput', 'continueErrorOutput'].includes(node.onError ?? '');
  const isAiToolExecution =
    (executionNode as INode & { rewireOutputLogTo?: string }).rewireOutputLogTo === 'ai_tool';
  const aiToolDefaultsToContinue = isAiToolExecution && node.onError !== 'stopWorkflow';
  if (!continues && !aiToolDefaultsToContinue) return undefined;
  if (isAiToolExecution) return { nodeSuccessData: [[{ json: { error: executionError.message } }]] };
  const main = executionData.data.main;
  if (Object.hasOwn(executionData.data, 'main') && main!.length > 0 && main![0] !== null) {
    return { nodeSuccessData: [main![0]!] };
  }
  return { nodeSuccessData };
}

/** `normalizeNodeErrors`: an item that carries an `error` gets that error's message as its json. */
export function normalizeItemErrors(nodeSuccessData: INodeExecutionData[][]): void {
  for (const execution of nodeSuccessData) {
    for (const lineResult of execution) {
      if (lineResult.error !== undefined) lineResult.json = { error: lineResult.error.message };
    }
  }
}
