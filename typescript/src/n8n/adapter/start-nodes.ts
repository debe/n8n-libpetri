import type { IRunExecutionData } from 'n8n-workflow';

/**
 * Every node on `nodeExecutionStack` (the first is the primary) plus every node with `runData`,
 * so a resumed execution is compiled from what already ran.
 */
export function startNodesOf(runExecutionData: IRunExecutionData): string[] {
  const names: string[] = [];
  for (const e of runExecutionData.executionData?.nodeExecutionStack ?? []) {
    if (!names.includes(e.node.name)) names.push(e.node.name);
  }
  for (const [name, tasks] of Object.entries(runExecutionData.resultData?.runData ?? {})) {
    if (tasks.length > 0 && !names.includes(name)) names.push(name);
  }
  return names;
}
