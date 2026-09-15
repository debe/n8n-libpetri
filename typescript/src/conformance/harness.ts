/**
 * The in-process differential harness: a fake n8n `Workflow` built from a compiler
 * `WorkflowDescription`, a `FakeHost` implementing the 30 `SchedulerHost` members with
 * canned `runNode` outputs per node, fake lifecycle hooks, and a recorder of every host
 * call and hook in order (`calls`). The host methods mirror what `WorkflowExecute` does at
 * n8n `441970b` closely enough for `runData`, `source` and `pairedItem` to come out in
 * n8n's shape; the recorder is what the ordering tests and the differ read.
 *
 * It lives under `conformance/` because both engines run on it: the `PetriScheduler`
 * (`src/scheduler`) and the reference loop (`stack-reference.ts`) that the differ compares
 * it against. `tests/scheduler/support.ts` re-exports all of it, so the scheduler suite
 * sees the same names it always did.
 *
 * The pieces live under `harness/`: `workflow.ts` (the fake `Workflow` and `NodeHelpers`),
 * `run-data.ts` (items and the initial `IRunExecutionData`), `scripts.ts` (canned node
 * behaviours), `fake-host.ts` (the `SchedulerHost` mirror) and `hooks.ts` (the lifecycle
 * hooks). This module is their one surface.
 *
 * Not a runtime dependency on n8n: every `n8n-workflow` import in them is type-only.
 */
export { fakeNodeHelpers, fakeWorkflow, type FakeWorkflowOptions } from './harness/workflow.js';
export { items, newRunExecutionData, type RunDataOptions } from './harness/run-data.js';
export { passThrough, sleep, type NodeScript, type ScriptContext } from './harness/scripts.js';
export { FakeHost, type FakeHostOptions } from './harness/fake-host.js';
export { fakeHooks, type HookFailures } from './harness/hooks.js';
