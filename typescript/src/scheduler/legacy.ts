/**
 * Step 1 of `PetriScheduler.run()` (see `petri-scheduler.ts`): a workflow whose
 * `executionOrder` is not `v1` runs on the legacy `StackScheduler` — v0's ancestor forcing is
 * out of scope (divergence #3) — and its `executionError` / `closeFunction` are copied over.
 */
import type { IRunExecutionData, Workflow } from 'n8n-workflow';
import type { SchedulerHooks, SchedulerHost, WorkflowScheduler } from '../n8n/host.js';
import type { SchedulerState } from './env.js';

/** Runs `legacy` and takes the contract value it computed into `state`, whether it resolved or rejected. */
export async function runLegacy(
  legacy: WorkflowScheduler,
  state: SchedulerState,
  host: SchedulerHost,
  workflow: Workflow,
  runExecutionData: IRunExecutionData,
  hooks: SchedulerHooks,
): Promise<void> {
  try {
    await legacy.run(host, workflow, runExecutionData, hooks);
  } finally {
    // The legacy scheduler computed the contract value itself; take it whole.
    state.haltError = legacy.executionError;
    state.leftoverError = undefined;
    state.closeFunction = legacy.closeFunction;
  }
}
